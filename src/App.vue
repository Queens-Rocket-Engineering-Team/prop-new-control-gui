<script setup>
import { onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

import WelcomePanel from "./windows/welcome_panel.vue";
import CameraPanel from "./windows/camera_panel.vue";
import GraphPanel from "./windows/graph_panel.vue";
import ControlPanel from "./windows/control_panel.vue";
import DebugPanel from "./windows/debug_panel.vue";
import FlightPanel from "./windows/flight_panel.vue";

import ServerBar from "./components/server_bar.vue";
import SettingsModal from "./components/settings_modal.vue";

const window_content = ref(WelcomePanel);
function setActive(component) {
  window_content.value = component;
}

function collapseNavbar() {
  const collapseDiv = document.getElementById("collapse");
  if (collapseDiv.style.display === "none" || collapseDiv.style.display === "") {
    collapseDiv.style.display = "block";
  } else {
    collapseDiv.style.display = "none";
  }
}

const server_ip = ref("");
function get_ip(new_ip) {
  console.log("Received new IP from settings:", new_ip);
  server_ip.value = new_ip;
}

const settingsOpen = ref(false);

onMounted(() => {
  invoke("fetch_server_ip").then((ip) => {
    if (ip) server_ip.value = ip;
  });
});
</script>

<template>
  <main class="container">
    <div id="grid-container">
      <div id="navbar">
        <div id="menu-buttons">
          <div id="menu-button" @click="collapseNavbar()">
            <img src="./assets/dropdown.svg" width="30px" />
          </div>
          <div id="gear-button" @click="settingsOpen = true" title="Settings">
            <svg xmlns="http://www.w3.org/2000/svg" width="24px" height="24px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </div>
        </div>
        <div id="collapse">
          <div id="nav-upper">
            <button @click="setActive(ControlPanel)">Control</button>
            <button @click="setActive(GraphPanel)">Data</button>
            <button @click="setActive(CameraPanel)">Camera View</button>
            <button @click="setActive(DebugPanel)">Debug</button>
            <button @click="setActive(FlightPanel)">Flight</button>
          </div>
          <div id="nav-lower">
            <button @click="setActive(WelcomePanel)">Welcome</button>
          </div>
        </div>
      </div>
      <component :is="window_content" class="swap-container"></component>
    </div>

    <server-bar :server-ip="server_ip"></server-bar>

    <settings-modal
      :is-open="settingsOpen"
      :current-ip="server_ip"
      @close="settingsOpen = false"
      @update-ip="get_ip"
    ></settings-modal>
  </main>
</template>
