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

import "primeicons/primeicons.css";

const window_content = ref(WelcomePanel);
function setActive(component) {
  window_content.value = component;
}

function collapseNavbar() {
  const collapseDiv = document.getElementById("collapse");
  const menuButtons = document.getElementById("menu-buttons");
  if (collapseDiv.style.display === "none" || collapseDiv.style.display === "") {
    collapseDiv.style.display = "block";
    menuButtons.classList.remove("collapsed");
  } else {
    collapseDiv.style.display = "none";
    menuButtons.classList.add("collapsed");
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
            <i class="pi pi-bars" style="font-size: 24px"></i>
          </div>
          <div id="gear-button" @click="settingsOpen = true" title="Settings">
            <i class="pi pi-cog" style="font-size: 24px"></i>
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
