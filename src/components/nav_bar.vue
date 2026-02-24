<script setup>
import { ref, watch, onMounted, onUnmounted } from "vue";
import Button from "primevue/button";

import WelcomePanel from "../windows/welcome_panel.vue";
import CameraPanel from "../windows/camera_panel.vue";
import GraphPanel from "../windows/graph_panel.vue";
import ControlPanel from "../windows/control_panel.vue";
import DebugPanel from "../windows/debug_panel.vue";
import FlightPanel from "../windows/flight_panel.vue";

const emit = defineEmits(["navigate", "open-settings", "resize"]);

const COLLAPSE_THRESHOLD = 130; // px — auto-collapse when dragged below this
const MIN_WIDTH = 52;           // px — narrowest the bar can be dragged
const DEFAULT_WIDTH = 180;      // px — restored width when expanding via hamburger

const navbarWidth = ref(DEFAULT_WIDTH);
const isCollapsed = ref(false);

// Keep parent's grid column in sync with our width
watch(navbarWidth, (w) => emit("resize", w));
onMounted(() => emit("resize", navbarWidth.value));

// ── Resize drag handle ─────────────────────────────────────
let isResizing = false;
let resizeStartX = 0;
let resizeStartWidth = 0;

function onResizeStart(e) {
  isResizing = true;
  resizeStartX = e.clientX;
  resizeStartWidth = navbarWidth.value;
  document.addEventListener("mousemove", onResizeMove);
  document.addEventListener("mouseup", onResizeEnd);
  e.preventDefault();
}

function onResizeMove(e) {
  if (!isResizing) return;
  const newWidth = Math.max(MIN_WIDTH, resizeStartWidth + (e.clientX - resizeStartX));
  if (newWidth < COLLAPSE_THRESHOLD) {
    isCollapsed.value = true;
    navbarWidth.value = MIN_WIDTH;
  } else {
    isCollapsed.value = false;
    navbarWidth.value = newWidth;
  }
}

function onResizeEnd() {
  isResizing = false;
  document.removeEventListener("mousemove", onResizeMove);
  document.removeEventListener("mouseup", onResizeEnd);
}

onUnmounted(() => {
  document.removeEventListener("mousemove", onResizeMove);
  document.removeEventListener("mouseup", onResizeEnd);
});

// ── Hamburger toggle ───────────────────────────────────────
function toggleCollapse() {
  if (isCollapsed.value) {
    isCollapsed.value = false;
    navbarWidth.value = DEFAULT_WIDTH;
  } else {
    isCollapsed.value = true;
    navbarWidth.value = MIN_WIDTH;
  }
}
</script>

<template>
  <div id="navbar" :style="{ width: navbarWidth + 'px' }">
    <div id="menu-buttons" :class="{ collapsed: isCollapsed }">
      <div id="menu-button" @click="toggleCollapse" title="Toggle menu">
        <i class="pi pi-bars" style="font-size: 24px"></i>
      </div>
      <div id="gear-button" @click="emit('open-settings')" title="Settings">
        <i class="pi pi-cog" style="font-size: 24px"></i>
      </div>
    </div>

    <div id="collapse" v-show="!isCollapsed">
      <div id="nav-upper">
        <Button @click="emit('navigate', ControlPanel)" label="Control" />
        <Button @click="emit('navigate', GraphPanel)" label="Data" />
        <Button @click="emit('navigate', CameraPanel)" label="Camera View" />
        <Button @click="emit('navigate', DebugPanel)" label="Debug" />
        <Button @click="emit('navigate', FlightPanel)" label="Flight" />
        <Button @click="emit('navigate', WelcomePanel)" label="Welcome" />
      </div>
    </div>

    <div class="nav-resize-handle" @mousedown="onResizeStart"></div>
  </div>
</template>
