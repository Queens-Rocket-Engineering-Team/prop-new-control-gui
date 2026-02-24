<script setup>
import { onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import "primeicons/primeicons.css";

import NavBar from "./components/nav_bar.vue";
import ServerBar from "./components/server_bar.vue";
import SettingsModal from "./components/settings_modal.vue";

import WelcomePanel from "./windows/welcome_panel.vue";

const window_content = ref(WelcomePanel);
function setActive(component) {
  window_content.value = component;
}

// Synced from NavBar's @resize emit so the grid column tracks the drag
const navbarWidth = ref(180);
function onNavResize(w) {
  navbarWidth.value = w;
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
      @close="settingsOpen = false"
      @update-ip="get_ip"
    ></settings-modal>
  </main>
</template>
