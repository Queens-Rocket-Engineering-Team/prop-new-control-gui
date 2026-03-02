<script setup>
import { onMounted, provide, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useServerApi } from "./composables/useServerApi.js";
import { useLogStream } from "./composables/useLogStream.js";
import "primeicons/primeicons.css";

import NavBar from "./components/nav_bar.vue";

import WelcomePanel from "./windows/welcome_panel.vue";
import CameraPanel from "./windows/camera_panel.vue";
import GraphPanel from "./windows/graph_panel.vue";
import ControlPanel from "./windows/control_panel.vue";
import DebugPanel from "./windows/debug_panel.vue";
import FlightPanel from "./windows/flight_panel.vue";

import SettingsModal from "./components/settings_modal.vue";

const window_content = shallowRef(WelcomePanel);
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

const pidConfig = ref('rocket-launch');
provide('pidConfig', pidConfig);

const { fetchConfig, sendCommand } = useServerApi(server_ip);

// ── Test state ───────────────────────────────────────────────────────────────

const testActive    = ref(false);
const testStartTime = ref(null);
provide('testActive',    testActive);
provide('testStartTime', testStartTime);

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
}

provide('startTest', startTest);
provide('stopTest',  stopTest);

// ── Log stream + sensor data ─────────────────────────────────────────────────

const { logLines, wsStatus, sensorData, clearLogs, clearSensorData } =
  useLogStream(server_ip, {
    onBatch(timestamp, readings) {
      if (!testActive.value) return;
      invoke('write_sensor_batch', { timestamp, readings }).catch((err) =>
        console.error('[App] CSV write failed:', err)
      );
    },
  });

provide('logLines',   logLines);
provide('wsStatus',   wsStatus);
provide('clearLogs',  clearLogs);
provide('sensorData', sensorData);

// ── Config fetch on connect ──────────────────────────────────────────────────

watch(server_ip, async (ip) => {
  // Stop any active test when IP changes
  if (testActive.value) await stopTest();

  if (!ip) { serverConfig.value = null; return; }
  try {
    serverConfig.value = await fetchConfig();
  } catch (err) {
    console.error('[App] fetchConfig failed:', err);
    serverConfig.value = null;
  }
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

      <component :is="window_content" class="swap-container"></component>
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
