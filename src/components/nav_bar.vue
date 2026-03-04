<script setup>
import { ref, watch, inject, onMounted, onUnmounted, nextTick } from "vue";
import Button from "primevue/button";
import ServerBar from "./server_bar.vue";
import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition } from "@tauri-apps/api/dpi";

import CameraPanel from "../windows/camera_panel.vue";
import GraphPanel from "../windows/graph_panel.vue";
import ControlPanel from "../windows/control_panel.vue";
import DebugPanel from "../windows/debug_panel.vue";
import FlightPanel from "../windows/flight_panel.vue";
import DeviceSummaryPanel from "../windows/device_summary.vue";

const emit = defineEmits(["navigate", "open-settings", "resize"]);

const COLLAPSE_THRESHOLD = 130;
const MIN_WIDTH          = 52;
const DEFAULT_WIDTH      = 180;

const navbarWidth  = ref(DEFAULT_WIDTH);
const isCollapsed  = ref(false);

watch(navbarWidth, (w) => emit("resize", w));
onMounted(() => {
  emit("resize", navbarWidth.value);
  // Auto-spawn windows on all monitors at startup.
  // Guard: only the main window should do this — screen-* windows also mount
  // NavBar and must not trigger another round of spawning.
  if (getCurrentWindow().label === 'main') {
    nextTick(() => openOnAllScreens());
  }
});

// ── Resize drag ─────────────────────────────────────────────────────────────

let isResizing      = false;
let resizeStartX    = 0;
let resizeStartWidth = 0;

function onResizeStart(e) {
  isResizing      = true;
  resizeStartX    = e.clientX;
  resizeStartWidth = navbarWidth.value;
  document.addEventListener("mousemove", onResizeMove);
  document.addEventListener("mouseup",   onResizeEnd);
  e.preventDefault();
}

function onResizeMove(e) {
  if (!isResizing) return;
  const newWidth = Math.max(MIN_WIDTH, resizeStartWidth + (e.clientX - resizeStartX));
  if (newWidth < COLLAPSE_THRESHOLD) {
    isCollapsed.value  = true;
    navbarWidth.value  = MIN_WIDTH;
  } else {
    isCollapsed.value  = false;
    navbarWidth.value  = newWidth;
  }
}

function onResizeEnd() {
  isResizing = false;
  document.removeEventListener("mousemove", onResizeMove);
  document.removeEventListener("mouseup",   onResizeEnd);
}

onUnmounted(() => {
  document.removeEventListener("mousemove", onResizeMove);
  document.removeEventListener("mouseup",   onResizeEnd);
  clearInterval(timerInterval);
});

// ── Multi-monitor window spawning ────────────────────────────────────────────

async function openOnAllScreens() {
  const monitors   = await availableMonitors();
  const currentWin = getCurrentWindow();

  console.log(`[NavBar] Detected ${monitors.length} monitor(s):`, monitors.map(m => ({
    name: m.name,
    size: `${m.size.width}x${m.size.height}`,
    position: `(${m.position.x}, ${m.position.y})`,
    scaleFactor: m.scaleFactor,
  })));

  // Maximise the main window on whatever screen it started on
  await currentWin.maximize();

  if (monitors.length <= 1) return;

  // Spawn one window on each monitor beyond the first (index 0).
  // Using index-based selection avoids relying on currentMonitor() which can
  // return null before the window is fully positioned (e.g. at startup).
  for (let i = 1; i < monitors.length; i++) {
    const monitor = monitors[i];
    const label   = `screen-${i}`;

    const win = new WebviewWindow(label, {
      url:   '/',
      title: `prop-control-gui — Screen ${i + 1}`,
    });

    win.once('tauri://created', async () => {
      console.log(`[NavBar] Window ${label} created, positioning on monitor ${i}`);
      await win.setPosition(new PhysicalPosition(monitor.position.x, monitor.position.y));
      await win.maximize();
    });

    // Silently ignore "already exists" errors; log anything else
    win.once('tauri://error', (e) => {
      if (!String(e).includes('already exists')) {
        console.error(`[NavBar] Failed to create window ${label}:`, e);
      }
    });
  }
}

function toggleCollapse() {
  if (isCollapsed.value) {
    isCollapsed.value = false;
    navbarWidth.value = DEFAULT_WIDTH;
  } else {
    isCollapsed.value = true;
    navbarWidth.value = MIN_WIDTH;
  }
}

// ── Test controls ───────────────────────────────────────────────────────────

const serverIp      = inject('serverIp',      ref(''));
const testActive    = inject('testActive',    ref(false));
const testStartTime = inject('testStartTime', ref(null));
const startTest     = inject('startTest',     () => {});
const stopTest      = inject('stopTest',      () => {});

const elapsed       = ref(0);
let   timerInterval = null;

watch(testActive, (active) => {
  if (active) {
    timerInterval = setInterval(() => {
      elapsed.value = Date.now() - testStartTime.value;
    }, 1000);
  } else {
    clearInterval(timerInterval);
    timerInterval = null;
    elapsed.value = 0;
  }
}, { immediate: true });

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
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
      <div id="screens-button" @click="openOnAllScreens" title="Open on all screens">
        <i class="pi pi-clone" style="font-size: 24px"></i>
      </div>
    </div>

    <div id="collapse" v-show="!isCollapsed">
      <div id="nav-upper">
        <Button @click="emit('navigate', ControlPanel)" label="Control" />
        <Button @click="emit('navigate', GraphPanel)"   label="Data" />
        <Button @click="emit('navigate', CameraPanel)"  label="Camera View" />
        <Button @click="emit('navigate', DeviceSummaryPanel)" label="Devices" />
        <Button @click="emit('navigate', DebugPanel)"   label="Debug" />
        <Button @click="emit('navigate', FlightPanel)"  label="Flight" />
      </div>

      <div id="nav-lower">
        <ServerBar :server-ip="serverIp" />
        <button
          class="test-btn"
          :class="testActive ? 'test-btn--active' : 'test-btn--idle'"
          @click="testActive ? stopTest() : startTest()"
        >
          <span class="test-btn-label">
            {{ testActive ? 'Stop Test' : 'Start Test' }}
          </span>
          <span v-if="testActive" class="test-btn-timer">
            {{ formatElapsed(elapsed) }}
          </span>
        </button>
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
  display: flex;
  flex-direction: column;
}

#navbar :deep(button) {
  width: 100%;
  margin-top: 2pt;
  margin-bottom: 2pt;
}

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

#menu-button:hover { color: var(--text-primary); }

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

#gear-button:hover { color: var(--text-primary); }

#screens-button {
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  color: var(--text-secondary);
  border-radius: 4px;
}

#screens-button:hover { color: var(--text-primary); }

/* Nav sections */
#collapse {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

#nav-upper {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

#nav-lower {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
  margin-top: 8px;
}

/* Test button */
.test-btn {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 8px 6px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font-family: inherit;
  font-weight: 700;
  font-size: 0.82rem;
  letter-spacing: 0.03em;
  transition: filter 0.15s, background 0.2s;
}

.test-btn:hover { filter: brightness(1.1); }
.test-btn:active { filter: brightness(0.95); }

.test-btn--idle {
  background: #2ecc71;
  color: #fff;
}

.test-btn--active {
  background: #e74c3c;
  color: #fff;
}

.test-btn-label {
  font-size: 0.82rem;
  font-weight: 700;
}

.test-btn-timer {
  font-size: 0.72rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.08em;
  opacity: 0.9;
}

/* Drag handle */
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

#navbar,
#menu-button,
#gear-button,
#screens-button {
  transition: var(--theme-transition);
}
</style>
