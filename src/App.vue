<script setup>
import { onMounted, provide, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useServerApi } from "./composables/useServerApi.js";
import { useLogStream } from "./composables/useLogStream.js";
import "primeicons/primeicons.css";

import NavBar from "./components/nav_bar.vue";

//import the windows as they are defined in their own vue files
import WelcomePanel from "./windows/welcome_panel.vue";
import CameraPanel from "./windows/camera_panel.vue";
import GraphPanel from "./windows/graph_panel.vue";
import ControlPanel from "./windows/control_panel.vue";
import DebugPanel from "./windows/debug_panel.vue";
import FlightPanel from "./windows/flight_panel.vue";

//import complex components to clean up code.
//to note, if componetns are to be used in the <template> below, they must be imported
//in pascal case, and then used in kebab-case.
import ServerBar from "./components/server_bar.vue";
import SettingsModal from "./components/settings_modal.vue";

const window_content = shallowRef(WelcomePanel);
function setActive(component) {
  window_content.value = component;
}

// Synced from NavBar's @resize emit so the grid column tracks the drag
const navbarWidth = ref(180);
function onNavResize(w) {
  navbarWidth.value = w;
}

const server_ip = ref("");
provide('serverIp', server_ip);

const serverConfig = ref(null);
provide('serverConfig', serverConfig);

const pidConfig = ref('rocket-launch');
provide('pidConfig', pidConfig);

const { fetchConfig, sendCommand } = useServerApi(server_ip);
const { logLines, wsStatus, clearLogs } = useLogStream(server_ip);
provide('logLines', logLines);
provide('wsStatus', wsStatus);
provide('clearLogs', clearLogs);
watch(server_ip, async (ip) => {
  if (!ip) { serverConfig.value = null; return }
  try {
    serverConfig.value = await fetchConfig()
    await sendCommand('STREAM', ['100'])
  } catch (err) {
    console.error('[App] server setup failed:', err)
    serverConfig.value = null
  }
});

function get_ip(new_ip) {
  console.log("Received new IP from settings:", new_ip);
  server_ip.value = new_ip;
}

const settingsOpen = ref(false);

onMounted(() => {
  invoke("fetch_server_ip")
    .then((ip) => { if (ip) server_ip.value = ip })
    .catch(() => {}); // no-op outside Tauri context
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

    <server-bar :server-ip="server_ip"></server-bar>

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
  /* grid-template-columns is set dynamically by App.vue via :style */
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