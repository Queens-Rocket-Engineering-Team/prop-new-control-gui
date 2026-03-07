<script setup>
import { onMounted, onUnmounted, provide, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useServerApi } from "./composables/useServerApi.js";
import { useLogStream } from "./composables/useLogStream.js";
import { useKeyBindings } from "./composables/useKeyBindings.js";
import "primeicons/primeicons.css";

import NavBar from "./components/nav_bar.vue";

import CameraPanel from "./windows/camera_panel.vue";
import GraphPanel from "./windows/graph_panel.vue";
import ControlPanel from "./windows/control_panel.vue";
import DebugPanel from "./windows/debug_panel.vue";
import FlightPanel from "./windows/flight_panel.vue";

import SettingsModal from "./components/settings_modal.vue";

const window_content = shallowRef(ControlPanel);

// expose keybinding utilities globally so panels/modal can access them
const {
  controlKeyMap,
  idToKey,
  buildDefaultBindings,
  loadKeyBindings,
  knownValves,
  knownAux,
  knownKasa,
  userBindings,
} = useKeyBindings();

provide('controlKeyMap', controlKeyMap);
provide('idToKey', idToKey);
provide('buildDefaultBindings', buildDefaultBindings);
provide('knownValves', knownValves);
provide('knownAux', knownAux);
provide('knownKasa', knownKasa);
provide('userBindings', userBindings);
function setActive(component) {
  window_content.value = component;
}

const navbarWidth = ref(180);
function onNavResize(w) {
  navbarWidth.value = w;
}

// ── Server connection ────────────────────────────────────────────────────────
// load any previously-saved keybindings
onMounted(() => {
  loadKeyBindings();
});

const server_ip = ref("");
provide('serverIp', server_ip);

const serverConfig = ref(null);
provide('serverConfig', serverConfig);

const pidConfig = ref('rocket-launch');
provide('pidConfig', pidConfig);

// ── Persistent control panel state ───────────────────────────────────────────
// Lifted here so state survives navigation away from the control panel.

const valveStates     = ref({});
const auxiliaryStates = ref({});
const valveStatusByControl = ref({});
let valveStatusSeq = 0;
provide('valveStates',     valveStates);
provide('auxiliaryStates', auxiliaryStates);
provide('valveStatusByControl', valveStatusByControl);

// Clear valve states whenever the P&ID diagram is switched (keys become stale).
watch(pidConfig, () => {
  valveStates.value = {};
  requestStatusSnapshot();
});

const { fetchConfig, fetchStatus, sendCommand, fetchKasaDevices, discoverKasaDevices, controlKasaDevice } = useServerApi(server_ip);
let refreshConfigPromise = null;
let syncStreamPromise = null;
let requestStatusPromise = null;
let statusRefreshTimer = null;
const STATUS_REFRESH_MS = 10_000;

async function refreshServerConfig() {
  if (!server_ip.value) return;
  if (refreshConfigPromise) return refreshConfigPromise;

  refreshConfigPromise = (async () => {
    try {
      serverConfig.value = await fetchConfig();
    } catch (err) {
      console.error('[App] refresh server config failed:', err);
    } finally {
      refreshConfigPromise = null;
    }
  })();

  return refreshConfigPromise;
}

async function syncStreamForCurrentMode() {
  if (!server_ip.value) return;
  if (syncStreamPromise) return syncStreamPromise;

  syncStreamPromise = (async () => {
    const rate = testActive.value ? '100' : '10';
    try {
      await sendCommand('STREAM', [rate]);
    } catch (err) {
      console.error(`[App] sync STREAM ${rate} failed:`, err);
    } finally {
      syncStreamPromise = null;
    }
  })();

  return syncStreamPromise;
}

async function requestStatusSnapshot() {
  if (!server_ip.value) return;
  if (requestStatusPromise) return requestStatusPromise;

  requestStatusPromise = (async () => {
    try {
      await fetchStatus();
    } catch (err) {
      console.error('[App] request status snapshot failed:', err);
    } finally {
      requestStatusPromise = null;
    }
  })();

  return requestStatusPromise;
}

function stopStatusRefresh() {
  if (!statusRefreshTimer) return;
  clearInterval(statusRefreshTimer);
  statusRefreshTimer = null;
}

function startStatusRefresh() {
  stopStatusRefresh();
  if (!server_ip.value) return;
  statusRefreshTimer = setInterval(() => {
    requestStatusSnapshot();
  }, STATUS_REFRESH_MS);
}

function normalizeDeviceName(name) {
  return String(name ?? '').trim().toLowerCase();
}

function toMatchToken(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function removeDisconnectedDevices(deviceKeysToRemove) {
  const cfg = serverConfig.value;
  if (!cfg?.configs) return;
  if (!deviceKeysToRemove?.length) return;

  const removeSet = new Set(deviceKeysToRemove);
  const nextConfigs = {};
  let removed = false;

  for (const [deviceKey, deviceCfg] of Object.entries(cfg.configs)) {
    if (removeSet.has(deviceKey)) {
      removed = true;
      continue;
    }
    nextConfigs[deviceKey] = deviceCfg;
  }

  if (!removed) return;

  serverConfig.value = {
    ...cfg,
    count: Object.keys(nextConfigs).length,
    configs: nextConfigs,
  };
}

function getDisconnectedDeviceKeys(message) {
  const cfg = serverConfig.value;
  if (!cfg?.configs) return [];

  const raw = String(message ?? '').trim();
  if (!/\bDISCONNECTED\b/i.test(raw)) return [];

  const messageToken = toMatchToken(raw);
  const keys = [];

  for (const [deviceKey, deviceCfg] of Object.entries(cfg.configs)) {
    const keyToken = toMatchToken(deviceKey);
    const nameToken = toMatchToken(deviceCfg?.deviceName);

    if (keyToken && messageToken.includes(`${keyToken}disconnected`)) {
      keys.push(deviceKey);
      continue;
    }
    if (nameToken && messageToken.includes(`${nameToken}disconnected`)) {
      keys.push(deviceKey);
    }
  }

  return keys;
}

function isConnectedMessage(message) {
  const raw = String(message ?? '').trim();
  if (!raw) return false;
  return /\bCONNECTED\b/i.test(raw) && !/\bDISCONNECTED\b/i.test(raw);
}

function parseValveStatusMessage(message) {
  const raw = String(message ?? '').trim();
  const match = raw.match(/^(.+?)\s+STATUS\s+(\S+)\s+(OPEN|CLOSED)\s*$/i);
  if (!match) return null;

  const [, deviceName, valveName, state] = match;
  return {
    deviceName: deviceName.trim(),
    valveName: valveName.trim(),
    state: state.toUpperCase(),
  };
}

// ── Kasa smart plugs ──────────────────────────────────────────────────────────

const kasaDevices = ref([]);
provide('kasaDevices', kasaDevices);

async function discoverKasa() {
  try {
    kasaDevices.value = await discoverKasaDevices();
  } catch (err) {
    console.error('[App] discoverKasa failed:', err);
  }
}
provide('discoverKasa', discoverKasa);

async function setKasaState(host, active) {
  const idx = kasaDevices.value.findIndex(d => d.host === host);
  if (idx !== -1) kasaDevices.value[idx] = { ...kasaDevices.value[idx], active };
  try {
    const updated = await controlKasaDevice(host, active);
    const i = kasaDevices.value.findIndex(d => d.host === host);
    if (i !== -1) kasaDevices.value[i] = updated;
  } catch (err) {
    console.error(`[App] setKasaState ${host} failed:`, err);
    if (idx !== -1) kasaDevices.value[idx] = { ...kasaDevices.value[idx], active: !active };
  }
}
provide('setKasaState', setKasaState);

// ── Test state ───────────────────────────────────────────────────────────────

const testActive    = ref(false);
const testStartTime = ref(null);
provide('testActive',    testActive);
provide('testStartTime', testStartTime);

// ── Tare offsets ─────────────────────────────────────────────────────────────
// { [sensorName]: rawOffset } — subtracted from displayed values and CSV writes.

const tares = ref({});
provide('tares', tares);

function setTare(name, rawValue) {
  tares.value[name] = rawValue;
}
provide('setTare', setTare);

// ── Log stream + sensor data ─────────────────────────────────────────────────

const { logLines, wsStatus, sensorData, clearLogs, clearSensorData } =
  useLogStream(server_ip, {
    onBatch(timestamp, readings) {
      if (!testActive.value) return;
      // Apply tare offsets before writing to CSV
      const taredReadings = {};
      for (const [name, val] of Object.entries(readings)) {
        taredReadings[name] = val - (tares.value[name] ?? 0);
      }
      invoke('write_sensor_batch', { timestamp, readings: taredReadings }).catch((err) =>
        console.error('[App] CSV write failed:', err)
      );
    },
    onLog(channel, message) {
      const ch = String(channel ?? '').toLowerCase();
      if (ch !== 'log' && ch !== 'syslog') return;

      if (ch === 'log') {
        const valveStatus = parseValveStatusMessage(message);
        if (valveStatus) {
          const key = toMatchToken(valveStatus.valveName);
          valveStatusSeq += 1;
          valveStatusByControl.value = {
            ...valveStatusByControl.value,
            [key]: {
              ...valveStatus,
              seq: valveStatusSeq,
            },
          };
        }
      }

      if (isConnectedMessage(message)) {
        (async () => {
          await refreshServerConfig();
          await syncStreamForCurrentMode();
          await requestStatusSnapshot();
        })();
        return;
      }

      const keys = getDisconnectedDeviceKeys(message);
      if (keys.length === 0) return;
      removeDisconnectedDevices(keys);
    },
  });

function formatDatetime() {
  const d   = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${date}-${time}`;
}

async function startTest() {
  if (testActive.value) return;
  clearSensorData();
  try {
    await sendCommand('STOP', []);
    await sendCommand('STREAM', ['100']);
    await invoke('start_recording', {
      mode:     pidConfig.value,
      datetime: formatDatetime(),
    });
    testActive.value    = true;
    testStartTime.value = Date.now();
  } catch (err) {
    console.error('[App] startTest failed:', err);
  }
}

async function stopTest() {
  if (!testActive.value) return;
  testActive.value    = false;
  testStartTime.value = null;
  try {
    await sendCommand('STOP', []);
    await invoke('stop_recording');
  } catch (err) {
    console.error('[App] stopTest failed:', err);
  }
  // Restart preview stream after test ends
  if (server_ip.value) {
    try { await sendCommand('STREAM', ['10']); } catch { /* ignore */ }
  }
}

provide('startTest', startTest);
provide('stopTest',  stopTest);

provide('logLines',   logLines);
provide('wsStatus',   wsStatus);
provide('clearLogs',  clearLogs);
provide('sensorData', sensorData);

// ── Config fetch on connect ──────────────────────────────────────────────────

watch(server_ip, async (ip) => {
  // Stop any active test when IP changes
  if (testActive.value) {
    await stopTest();
  } else {
    // Stop any preview stream running on the old IP
    try { await sendCommand('STOP', []); } catch { /* ignore */ }
  }

  tares.value         = {};
  auxiliaryStates.value = {};
  valveStatusSeq = 0;
  valveStatusByControl.value = {};

  if (!ip) {
    stopStatusRefresh();
    serverConfig.value = null;
    kasaDevices.value = [];
    return;
  }
  try {
    serverConfig.value = await fetchConfig();
  } catch (err) {
    console.error('[App] fetchConfig failed:', err);
    serverConfig.value = null;
  }
  try {
    kasaDevices.value = await fetchKasaDevices();
  } catch (err) {
    console.error('[App] fetchKasaDevices failed:', err);
    kasaDevices.value = [];
  }
  // Start 10 Hz preview stream so data is visible before a test begins
  try { await sendCommand('STREAM', ['10']); } catch (err) {
    console.error('[App] preview STREAM failed:', err);
  }
  await requestStatusSnapshot();
  startStatusRefresh();
});

// ── Settings ─────────────────────────────────────────────────────────────────

function get_ip(new_ip) {
  server_ip.value = new_ip;
}

const settingsOpen = ref(false);

onMounted(() => {
  invoke("fetch_server_ip")
    .then((ip) => { if (ip) server_ip.value = ip; })
    .catch(() => {});
});

onUnmounted(() => {
  stopStatusRefresh();
});
</script>

<template>
  <main class="container">
    <div
      id="grid-container"
      :style="{ gridTemplateColumns: navbarWidth + 'px 1fr' }"
    >
      <nav-bar
        @navigate="setActive"
        @open-settings="settingsOpen = true"
        @resize="onNavResize"
      ></nav-bar>

      <KeepAlive>
        <component :is="window_content" class="swap-container"></component>
      </KeepAlive>
    </div>

    <settings-modal
      :is-open="settingsOpen"
      :current-ip="server_ip"
      :pid-config="pidConfig"
      @close="settingsOpen = false"
      @update-ip="get_ip"
      @update-pid-config="pidConfig = $event"
    ></settings-modal>
  </main>
</template>

<style scoped>
.container {
  margin: 0;
  display: flex;
  flex-direction: column;
  height: 100vh;
}

#grid-container {
  display: grid;
  gap: 0;
  flex: 1;
  min-height: 0;
}

.swap-container {
  background-color: var(--bg-primary);
  border: var(--border-color) 2px solid;
  border-radius: 0 10px 10px 0;
  padding: 10px;
  text-align: left;
}
</style>
