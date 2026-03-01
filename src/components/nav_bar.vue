<script setup>
import { ref, watch, onMounted, onUnmounted } from "vue";
import Button from "primevue/button";

import WelcomePanel from "../windows/welcome_panel.vue";
import CameraPanel from "../windows/camera_panel.vue";
import GraphPanel from "../windows/graph_panel.vue";
import ControlPanel from "../windows/control_panel.vue";
import DebugPanel from "../windows/debug_panel.vue";
import FlightPanel from "../windows/flight_panel.vue";
import DeviceSummaryPanel from "../windows/device_summary.vue";

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
        <Button @click="emit('navigate', DeviceSummaryPanel)" label="Devices" />
        <Button @click="emit('navigate', DebugPanel)" label="Debug" />
        <Button @click="emit('navigate', FlightPanel)" label="Flight" />
        <Button @click="emit('navigate', WelcomePanel)" label="Welcome" />
      </div>
    </div>

    <div class="nav-resize-handle" @mousedown="onResizeStart"></div>
  </div>
</template>

<style scoped>
#navbar {
  position: relative;
  background-color: var(--bg-primary);
  border-top: var(--border-color) 2px solid;
  border-left: var(--border-color) 2px solid;
  border-bottom: var(--border-color) 2px solid;
  border-radius: 10px 0 0 10px;
  overflow: hidden;
  padding: 10px;
  text-align: left;
}

#navbar :deep(button) {
  width: 100%;
  margin-top: 2pt;
  margin-bottom: 2pt;
}

/* Hamburger + gear icon row */
#menu-buttons {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

#menu-buttons.collapsed {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}

#menu-button {
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  color: var(--text-secondary);
}

#menu-button:hover {
  color: var(--text-primary);
}

#gear-button {
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  color: var(--text-secondary);
  border-radius: 4px;
}

#gear-button:hover {
  color: var(--text-primary);
}

/* Drag handle on the right edge */
.nav-resize-handle {
  position: absolute;
  top: 0;
  right: 0;
  width: 5px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
}

.nav-resize-handle:hover,
.nav-resize-handle:active {
  background: rgba(45, 88, 104, 0.45);
}

/* Theme transition for dark/light switch */
#navbar,
#menu-button,
#gear-button {
  transition: var(--theme-transition);
}
</style>