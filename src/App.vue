<script setup>
import { onMounted, onUnmounted, provide, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useServerApi } from "./composables/useServerApi.js";
import { useLogStream } from "./composables/useLogStream.js";
import "primeicons/primeicons.css";

import NavBar from "./components/nav_bar.vue";

import CameraPanel from "./windows/camera_panel.vue";
import GraphPanel from "./windows/graph_panel.vue";
import ControlPanel from "./windows/control_panel.vue";
import DebugPanel from "./windows/debug_panel.vue";
import FlightPanel from "./windows/flight_panel.vue";

import SettingsModal from "./components/settings_modal.vue";

const window_content = shallowRef(ControlPanel);
function setActive(component) {
  window_content.value = component;
}

const navbarWidth = ref(180);
function onNavResize(w) {
  navbarWidth.value = w;
}

// ── Server connection ────────────────────────────────────────────────────────

const server_ip = ref("");
provide('serverIp', server_ip);

const serverConfig = ref(null);
provide('serverConfig', serverConfig);

const pidConfig = ref(localStorage.getItem('qret-pid-config') || 'rocket-launch');
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

const {
  fetchConfig,
  fetchStatus,
  sendCommand,
  fetchKasaDevices,
  discoverKasaDevices,
  controlKasaDevice,
  startAudioRecording,
  stopAudioRecording,
  listAudioFiles,
  getAudioFileUrl,
} = useServerApi(server_ip);
let refreshConfigPromise = null;
let syncStreamPromise = null;
let requestStatusPromise = null;
let statusRefreshTimer = null;
let configRefreshTimer = null;
const STATUS_REFRESH_MS = 10_000;
const CONFIG_REFRESH_MS =  5_000;
const VOICE_WINDOW_LABEL = "voice-client";
const VOICE_POLL_MS = 5000;
let voicePollTimer = null;
let voiceSyncPromise = null;

function getServerHost(ip) {
  const raw = String(ip ?? "").trim();
  if (!raw) return "";
  return raw === "localhost" ? "127.0.0.1" : raw;
}

function getVoiceUrl(ip) {
  const host = getServerHost(ip);
  if (!host) return "";
  return `http://${host}:8080`;
}

async function isVoiceAvailable(ip) {
  const host = getServerHost(ip);
  if (!host) return false;

  try {
    await fetch(`http://${host}:8080`, {
      mode: "no-cors",
      signal: AbortSignal.timeout(2000),
      cache: "no-store",
    });
    return true;
  } catch {
    return false;
  }
}

async function closeVoiceWindow() {
  const existing = await WebviewWindow.getByLabel(VOICE_WINDOW_LABEL);
  if (!existing) return;
  try {
    await existing.close();
  } catch {
    // Window may already be closing.
  }
}

async function configureVoiceWindow(win, voiceUrl, minimizeAfterConfigure) {
  const routeScript = `(() => {
    const target = ${JSON.stringify(voiceUrl)};
    if (!String(window.location.href).startsWith(target)) {
      window.location.replace(target);
    }
  })();`;

  try {
    await win.eval(routeScript);
  } catch {
    // Ignore races while the webview is still loading.
  }

  if (!minimizeAfterConfigure) return;
  try {
    await win.minimize();
  } catch {
    // Ignore if minimize is unsupported in the current state.
  }
}

async function ensureVoiceWindow(ip, minimizeWhenCreated = false) {
  const voiceUrl = getVoiceUrl(ip);
  if (!voiceUrl) {
    await closeVoiceWindow();
    return;
  }

  const available = await isVoiceAvailable(ip);
  if (!available) {
    await closeVoiceWindow();
    return;
  }

  const existing = await WebviewWindow.getByLabel(VOICE_WINDOW_LABEL);
  if (existing) {
    await configureVoiceWindow(existing, voiceUrl, false);
    return;
  }

  const win = new WebviewWindow(VOICE_WINDOW_LABEL, {
    url: voiceUrl,
    title: "Voice Client",
    width: 420,
    height: 280,
    center: true,
  });

  win.once("tauri://created", async () => {
    await configureVoiceWindow(win, voiceUrl, minimizeWhenCreated);
  });

  win.once("tauri://error", (err) => {
    console.error("[App] Failed to create Voice window:", err);
  });
}

function stopVoicePolling() {
  if (!voicePollTimer) return;
  clearInterval(voicePollTimer);
  voicePollTimer = null;
}

function startVoicePolling() {
  stopVoicePolling();
  if (!server_ip.value) return;

  const sync = async (minimizeWhenCreated = false) => {
    if (!server_ip.value) return;
    if (voiceSyncPromise) return voiceSyncPromise;
    voiceSyncPromise = (async () => {
      try {
        await ensureVoiceWindow(server_ip.value, minimizeWhenCreated);
      } finally {
        voiceSyncPromise = null;
      }
    })();
    return voiceSyncPromise;
  };

  sync(true);
  voicePollTimer = setInterval(() => {
    sync(false);
  }, VOICE_POLL_MS);
}

async function refreshServerConfig() {
  if (!server_ip.value) return;
  if (refreshConfigPromise) return refreshConfigPromise;

  refreshConfigPromise = (async () => {
    try {
      const cfg = await fetchConfig();
      serverConfig.value = cfg;
      _settingsChannel.postMessage({ type: 'serverConfig', value: cfg });
    } catch (err) {
      console.error('[App] refresh server config failed:', err);
    } finally {
      refreshConfigPromise = null;
    }
  })();

  return refreshConfigPromise;
}

function stopConfigRefresh() {
  if (!configRefreshTimer) return;
  clearInterval(configRefreshTimer);
  configRefreshTimer = null;
}

function startConfigRefresh() {
  stopConfigRefresh();
  if (!server_ip.value) return;
  configRefreshTimer = setInterval(refreshServerConfig, CONFIG_REFRESH_MS);
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
      const valveStateBits = {};
      for (const [name, isOpen] of Object.entries(valveStates.value)) {
        valveStateBits[name] = isOpen ? 1 : 0;
      }
      const auxiliaryStateBits = {};
      for (const [name, isClosed] of Object.entries(auxiliaryStates.value)) {
        auxiliaryStateBits[name] = isClosed ? 1 : 0;
      }
      const kasaStateBits = {};
      const kasaAliasCounts = {};
      for (const device of kasaDevices.value) {
        const aliasBase = String(device?.alias ?? '').trim();
        const fallback = String(device?.host ?? '').trim();
        const rawBase = aliasBase || fallback;
        const sanitizedBase = rawBase.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '');
        if (!sanitizedBase) continue;

        const count = (kasaAliasCounts[sanitizedBase] ?? 0) + 1;
        kasaAliasCounts[sanitizedBase] = count;
        const key = count === 1 ? sanitizedBase : `${sanitizedBase}_${count}`;

        kasaStateBits[key] = device?.active ? 1 : 0;
      }

      invoke('write_sensor_batch', {
        timestamp,
        readings: taredReadings,
        valveStates: valveStateBits,
        auxiliaryStates: auxiliaryStateBits,
        kasaStates: kasaStateBits,
      }).catch((err) =>
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
  let csvStarted = false;
  let audioStarted = false;
  try {
    await sendCommand('STOP', []);
    await sendCommand('STREAM', ['100']);
    await invoke('start_recording', {
      mode:     pidConfig.value,
      datetime: formatDatetime(),
    });
    csvStarted = true;

    const audioStart = await startAudioRecording();
    if (audioStart?.error) {
      throw new Error(audioStart.error);
    }
    if (audioStart?.status !== 'started') {
      throw new Error(`Audio start returned unexpected response: ${JSON.stringify(audioStart)}`);
    }
    audioStarted = true;

    testActive.value    = true;
    testStartTime.value = Date.now();
  } catch (err) {
    if (audioStarted) {
      try {
        await stopAudioRecording();
      } catch (rollbackErr) {
        console.error('[App] rollback audio stop failed:', rollbackErr);
      }
    }

    if (csvStarted) {
      try {
        await invoke('stop_recording');
      } catch (rollbackErr) {
        console.error('[App] rollback CSV stop failed:', rollbackErr);
      }
    }

    try {
      await sendCommand('STOP', []);
      await sendCommand('STREAM', ['10']);
    } catch {
      // Ignore cleanup errors while preserving the primary failure in logs.
    }

    console.error('[App] startTest failed:', err);
  }
}

async function stopTest() {
  if (!testActive.value) return;
  testActive.value    = false;
  testStartTime.value = null;
  let stopError = null;
  try {
    await sendCommand('STOP', []);
  } catch (err) {
    stopError = stopError ?? err;
    console.error('[App] stopTest STOP failed:', err);
  }

  try {
    await invoke('stop_recording');
  } catch (err) {
    stopError = stopError ?? err;
    console.error('[App] stopTest CSV stop failed:', err);
  }

  try {
    const audioStop = await stopAudioRecording();
    if (audioStop?.error) {
      throw new Error(audioStop.error);
    }
    if (audioStop?.status !== 'stopped') {
      throw new Error(`Audio stop returned unexpected response: ${JSON.stringify(audioStop)}`);
    }
    if (audioStop?.file) {
      const listed = await listAudioFiles();
      const files = Array.isArray(listed?.files) ? listed.files : [];
      const stoppedFile = String(audioStop.file ?? '').trim();
      const matched = files.find((item) => {
        if (!item || typeof item !== 'object') return false;
        const filename = typeof item.filename === 'string' ? item.filename.trim() : '';
        const basename = filename.replace(/\.[^/.]+$/, '');
        const hasDownloadPath = typeof item.download_path === 'string' && item.download_path.trim();
        return hasDownloadPath && (filename === stoppedFile || basename === stoppedFile);
      });

      if (!matched) {
        throw new Error(`No downloadable audio file found for ${stoppedFile} in /v1/audio/files response`);
      }
      if (typeof matched.filename !== 'string' || !matched.filename.trim()) {
        throw new Error(`Matched audio file is missing a valid filename: ${JSON.stringify(matched)}`);
      }

      const audioFileUrl = getAudioFileUrl(matched.download_path);
      const audioRes = await fetch(audioFileUrl, { cache: 'no-store' });
      if (!audioRes.ok) {
        const text = await audioRes.text().catch(() => audioRes.statusText);
        throw new Error(`Failed to download audio file ${matched.filename}: ${audioRes.status} ${text}`);
      }

      const bytes = Array.from(new Uint8Array(await audioRes.arrayBuffer()));
      const localPath = await invoke('save_audio_recording_file', {
        filename: matched.filename,
        data: bytes,
      });

      console.log(`[App] Audio saved on server: ${matched.filename}`);
      console.log(`[App] Audio copied to local file: ${localPath}`);
    }
  } catch (err) {
    stopError = stopError ?? err;
    console.error('[App] stopTest audio stop failed:', err);
  }

  // Restart preview stream after test ends
  if (server_ip.value) {
    try {
      await sendCommand('STREAM', ['10']);
    } catch (err) {
      stopError = stopError ?? err;
      console.error('[App] stopTest preview STREAM failed:', err);
    }
  }

  if (stopError) {
    console.error('[App] stopTest completed with one or more failures.');
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
    stopConfigRefresh();
    serverConfig.value = null;
    kasaDevices.value = [];
    _settingsChannel.postMessage({ type: 'serverConfig', value: null });
    return;
  }
  try {
    const cfg = await fetchConfig();
    serverConfig.value = cfg;
    _settingsChannel.postMessage({ type: 'serverConfig', value: cfg });
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
  startConfigRefresh();
});

watch(server_ip, async (ip) => {
  if (!ip) {
    stopVoicePolling();
    await closeVoiceWindow();
    return;
  }
  startVoicePolling();
}, { immediate: true });

// ── Cross-window IP sync via BroadcastChannel ─────────────────────────────────
// All Tauri windows share the same Rust process, so invoke("fetch_server_ip")
// already returns the correct IP when a new window opens. BroadcastChannel
// covers the real-time case: IP changed in one window while others are open.

const _ipChannel = new BroadcastChannel('qret-server-ip');
let _receivingBroadcast = false;

// When our IP changes (from settings), tell other windows
watch(server_ip, (ip) => {
  if (!_receivingBroadcast) _ipChannel.postMessage(ip);
});

// When another window changes the IP, update ours — which automatically
// triggers the existing watch(server_ip) for reconnecting useLogStream etc.
_ipChannel.onmessage = (e) => {
  if (server_ip.value === e.data) return;
  _receivingBroadcast = true;
  server_ip.value = e.data;
  _receivingBroadcast = false;
};

// ── Settings sync (pidConfig) across windows ──────────────────────────────────
// darkMode is handled in settings_modal.vue; pidConfig lives here in App.vue.
// Both use the same 'qret-settings' channel with typed messages.

const _settingsChannel = new BroadcastChannel('qret-settings');

watch(pidConfig, (cfg) => {
  localStorage.setItem('qret-pid-config', cfg);
  _settingsChannel.postMessage({ type: 'pidConfig', value: cfg });
});

_settingsChannel.onmessage = (e) => {
  if (e.data.type === 'pidConfig')    pidConfig.value    = e.data.value;
  if (e.data.type === 'serverConfig') serverConfig.value = e.data.value;
  // darkMode messages are handled by settings_modal.vue's own channel instance
};

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
  stopConfigRefresh();
  stopVoicePolling();
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

      <!-- KeepAlive preserves CameraPanel's WebRTC streams across SPA navigation -->
      <KeepAlive include="CameraPanel">
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
