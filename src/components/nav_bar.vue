<script setup>
import { ref, computed, watch, inject, onMounted, onUnmounted } from "vue";
import Button from "primevue/button";
import ServerBar from "./server_bar.vue";
import { CAPS, availablePanels, isWeb } from "../lib/platform.js";
import logoUrl from "../../app-icon.svg";

import CameraPanel from "../windows/camera_panel.vue";
import GraphPanel from "../windows/graph_panel.vue";
import ControlPanel from "../windows/control_panel.vue";
import DebugPanel from "../windows/debug_panel.vue";
import FlightPanel from "../windows/flight_panel.vue";
import DeviceSummaryPanel from "../windows/device_summary.vue";

// Which panels this build exposes, in nav order. Driven by platform.js so
// re-enabling a panel for the pad is a one-line change there.
const PANELS = {
  control: { label: "Control",     component: ControlPanel },
  graph:   { label: "Data",        component: GraphPanel },
  camera:  { label: "Camera View", component: CameraPanel },
  devices: { label: "Devices",     component: DeviceSummaryPanel },
  debug:   { label: "Debug",       component: DebugPanel },
  flight:  { label: "Flight",      component: FlightPanel },
};

const navPanels = availablePanels().map((key) => ({ key, ...PANELS[key] }));

const canCommand    = CAPS.commands;
const canAddWindows = CAPS.nativeWindows;

const emit = defineEmits(["navigate", "open-settings", "open-about", "resize"]);

// ── Responsive sizing ───────────────────────────────────────────────────────
//
// A fixed 180px sidebar is fine on a monitor and ruinous on a phone, where it
// eats half the viewport before the panel gets a pixel. Three tiers:
//
//   desktop — 180px, in flow, drag-resizable (unchanged).
//   tablet  — 140px, in flow. Enough for the labels, less stolen from the P&ID.
//   phone   — starts as an icon rail; expanding floats it *over* the panel as a
//             drawer rather than squeezing it, so the content keeps full width.
//
// Breakpoints are matchMedia rather than CSS-only because the width has to be
// reported up to App.vue, which owns the grid column.

// The tablet/phone widths are tighter than a naive scale-down because the type
// shrinks too (see --nav-scale in the styles) — the same labels fit in less.
const COLLAPSE_THRESHOLD = 100;  // below TABLET_WIDTH, so a small drag can't snap it shut
const MIN_WIDTH          = 52;   // desktop/tablet icon rail
const PHONE_RAIL         = 56;   // clears the 34px tap-target floor plus padding
const DEFAULT_WIDTH      = 180;
const TABLET_WIDTH       = 128;
const DRAWER_WIDTH       = 190;

const PHONE_QUERY  = "(max-width: 700px)";
const TABLET_QUERY = "(max-width: 1200px)";

/**
 * Reactive matchMedia, torn down with the component.
 *
 * Also re-reads on window resize: the MediaQueryList's `change` event is not
 * dependable in every embedding (an iframe resized by attribute updates
 * `mql.matches` without ever dispatching `change`), and a nav stuck in the
 * wrong tier after a rotation is worse than one redundant read.
 */
function useMedia(query) {
  const mql     = window.matchMedia(query);
  const matches = ref(mql.matches);
  const sync    = () => { matches.value = mql.matches; };
  mql.addEventListener("change", sync);
  window.addEventListener("resize", sync);
  onUnmounted(() => {
    mql.removeEventListener("change", sync);
    window.removeEventListener("resize", sync);
  });
  return matches;
}

const isPhone  = useMedia(PHONE_QUERY);
const isTablet = useMedia(TABLET_QUERY);

const collapsedWidth = () => (isPhone.value ? PHONE_RAIL : MIN_WIDTH);
const expandedWidth  = () => {
  if (isPhone.value)  return DRAWER_WIDTH;
  if (isTablet.value) return TABLET_WIDTH;
  return DEFAULT_WIDTH;
};

const navbarWidth = ref(0);
const isCollapsed = ref(false);

function applyDefaults() {
  isCollapsed.value = isPhone.value;
  navbarWidth.value = isPhone.value ? collapsedWidth() : expandedWidth();
}
applyDefaults();

function collapse() {
  isCollapsed.value = true;
  navbarWidth.value = collapsedWidth();
}

// What App.vue reserves in the grid. On a phone the open drawer is positioned
// over the panel, so the column stays at the rail — widening it would defeat
// the point of the drawer.
const gridWidth = computed(() =>
  isPhone.value ? collapsedWidth() : navbarWidth.value
);

watch(gridWidth, (w) => emit("resize", w));
onMounted(() => emit("resize", gridWidth.value));

// Rotating a tablet or resizing a browser window can cross a tier; re-derive
// rather than stranding a 210px drawer in a desktop layout.
watch([isPhone, isTablet], applyDefaults);

// ── Resize drag ─────────────────────────────────────────────────────────────
//
// Pointer events, not mouse events, so the handle also works under touch and
// stylus on a tablet. It is hidden entirely on phones, where the drawer toggle
// is the only sensible control.

let isResizing      = false;
let resizeStartX    = 0;
let resizeStartWidth = 0;

function onResizeStart(e) {
  isResizing      = true;
  resizeStartX    = e.clientX;
  resizeStartWidth = navbarWidth.value;
  e.currentTarget.setPointerCapture?.(e.pointerId);
  document.addEventListener("pointermove",   onResizeMove);
  document.addEventListener("pointerup",     onResizeEnd);
  document.addEventListener("pointercancel", onResizeEnd);
  e.preventDefault();
}

function onResizeMove(e) {
  if (!isResizing) return;
  const min      = collapsedWidth();
  const newWidth = Math.max(min, resizeStartWidth + (e.clientX - resizeStartX));
  if (newWidth < COLLAPSE_THRESHOLD) {
    isCollapsed.value  = true;
    navbarWidth.value  = min;
  } else {
    isCollapsed.value  = false;
    navbarWidth.value  = newWidth;
  }
}

function onResizeEnd() {
  isResizing = false;
  document.removeEventListener("pointermove",   onResizeMove);
  document.removeEventListener("pointerup",     onResizeEnd);
  document.removeEventListener("pointercancel", onResizeEnd);
}

onUnmounted(() => {
  document.removeEventListener("pointermove",   onResizeMove);
  document.removeEventListener("pointerup",     onResizeEnd);
  document.removeEventListener("pointercancel", onResizeEnd);
  clearInterval(timerInterval);
});

// ── Extra window spawning ─────────────────────────────────────────────────────

let _extraWindowCount = 0;

// Desktop only — the control is hidden in the web build (see canAddWindows).
// A browser tab is not a second window in any useful sense: the pad client is
// view-only, so a duplicate tab just doubles the telemetry subscription over
// the wifi link the test depends on and gives the engineer nothing new. The
// BroadcastChannel sync in App.vue keeps server IP, settings and test state
// consistent across the native windows this does spawn.
async function addWindow() {
  _extraWindowCount++;

  const label = `extra-${_extraWindowCount}`;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const win = new WebviewWindow(label, {
    url:   '/',
    title: `prop-control-gui — Window ${_extraWindowCount + 1}`,
    width:  1280,
    height: 800,
  });
  win.once('tauri://error', (e) => {
    console.error(`[NavBar] Failed to create window ${label}:`, e);
  });
}

// ── Full screen ──────────────────────────────────────────────────────────────
//
// Chrome's address bar and gesture strip cost a serious slice of a phone's
// height, on panels that are mostly diagram. The desktop build owns a real
// window and needs no such control, so this is web-only.
//
// Feature-detected rather than assumed: iOS exposes no element fullscreen — and
// Chrome on iOS is WebKit underneath, so it inherits that — meaning the button
// hides itself there instead of failing on tap. `fullscreenEnabled` is also
// false when embedded without an allowfullscreen grant, which is the same
// answer for the same reason.
const canFullscreen = isWeb() && Boolean(document.fullscreenEnabled);
const isFullscreen  = ref(false);

// Fullscreen can end without touching this button — Esc, the back gesture, a
// task switch — so the icon follows the browser rather than our own last
// action, which would otherwise get stuck showing "exit".
function syncFullscreen() {
  isFullscreen.value = Boolean(document.fullscreenElement);
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
  } catch (err) {
    // Rejects if the gesture was not user-initiated, or the platform refuses.
    console.error("[NavBar] fullscreen toggle failed:", err);
  }
}

onMounted(() => document.addEventListener("fullscreenchange", syncFullscreen));
onUnmounted(() => document.removeEventListener("fullscreenchange", syncFullscreen));

function toggleCollapse() {
  if (isCollapsed.value) {
    isCollapsed.value = false;
    navbarWidth.value = expandedWidth();
  } else {
    collapse();
  }
}

// On a phone the drawer covers the panel, so leaving it open after a tap would
// hide the very thing the tap asked for.
function onNavigate(component) {
  emit("navigate", component);
  if (isPhone.value) collapse();
}

function onOpenSettings() {
  emit("open-settings");
  if (isPhone.value) collapse();
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
  <!-- Tapping outside the phone drawer closes it — on a small screen there is
       no spare chrome to reach for, so the panel itself is the dismiss target.
       Teleported because #navbar is a grid item: left as a sibling root it
       would claim a grid column of its own and shove the layout sideways. -->
  <Teleport to="body">
    <div
      v-if="isPhone && !isCollapsed"
      class="nav-backdrop"
      @click="collapse"
    ></div>
  </Teleport>

  <div
    id="navbar"
    :class="{ 'nav-phone': isPhone, 'nav-open': !isCollapsed }"
    :style="{ width: navbarWidth + 'px' }"
  >
    <div id="menu-buttons" :class="{ collapsed: isCollapsed }">
      <div id="helm-button" @click="emit('open-about')" title="About HELM">
        <img :src="logoUrl" alt="HELM" class="helm-icon" />
      </div>
      <div id="menu-button" @click="toggleCollapse" title="Toggle menu">
        <i class="pi pi-bars"></i>
      </div>
      <div id="gear-button" @click="onOpenSettings" title="Settings">
        <i class="pi pi-cog"></i>
      </div>
      <div
        v-if="canAddWindows"
        id="screens-button"
        @click="addWindow"
        title="Add window"
      >
        <i class="pi pi-plus-circle"></i>
      </div>
      <div
        v-if="canFullscreen"
        id="fullscreen-button"
        @click="toggleFullscreen"
        :title="isFullscreen ? 'Exit full screen' : 'Full screen'"
      >
        <i :class="isFullscreen ? 'pi pi-window-minimize' : 'pi pi-window-maximize'"></i>
      </div>
    </div>

    <div id="collapse" v-show="!isCollapsed">
      <div id="nav-upper">
        <Button
          v-for="panel in navPanels"
          :key="panel.key"
          :label="panel.label"
          @click="onNavigate(panel.component)"
        />
      </div>

      <div id="nav-lower">
        <ServerBar :server-ip="serverIp" />
        <!-- Starting a test broadcasts STREAM to the whole stand and drives the
             local CSV recorder; neither is available to the view-only build. -->
        <button
          v-if="canCommand"
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
        <div v-else class="view-only-badge" title="Commands are issued from launch control">
          <i class="pi pi-eye" />
          <span>View only</span>
        </div>
      </div>
    </div>

    <!-- Dragging to resize has no meaning at phone width, where the nav is
         either a rail or a full-height drawer. -->
    <div
      v-if="!isPhone"
      class="nav-resize-handle"
      @pointerdown="onResizeStart"
    ></div>
  </div>
</template>

<style scoped>
/* Everything inside the nav is sized in `em` off this one font-size, so the
   whole sidebar — labels, icons, padding, the server bar — shrinks together
   with the viewport instead of keeping desktop-sized type in a 140px column.
   Only --nav-scale changes per tier. */
#navbar {
  --nav-scale: 1;
  font-size: calc(14px * var(--nav-scale));

  position: relative;
  background-color: var(--bg-primary);
  border-top: var(--border-color) 2px solid;
  border-left: var(--border-color) 2px solid;
  border-bottom: var(--border-color) 2px solid;
  border-radius: 10px 0 0 10px;
  overflow: hidden;
  padding: 0.7em;
  text-align: left;
  display: flex;
  flex-direction: column;
}

@media (max-width: 1200px) {
  #navbar { --nav-scale: 0.9; }
}

@media (max-width: 700px) {
  #navbar { --nav-scale: 0.85; }
}

#navbar :deep(button) {
  width: 100%;
  margin-top: 0.15em;
  margin-bottom: 0.15em;
  font-size: 0.95em;
  padding: 0.55em 0.8em;
}

#menu-buttons {
  display: flex;
  align-items: center;
  gap: 0.45em;
  margin-bottom: 0.3em;
}

#menu-buttons.collapsed {
  flex-direction: column;
  align-items: stretch;
  gap: 0.45em;
}

#helm-button,
#menu-button,
#gear-button,
#screens-button,
#fullscreen-button {
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.15em;
  height: 2.15em;
  flex: none;
  color: var(--text-secondary);
  border-radius: 4px;
}

#menu-buttons .pi {
  font-size: 1.7em;
}

#menu-button:hover,
#gear-button:hover,
#screens-button:hover,
#fullscreen-button:hover { color: var(--text-primary); }

/* The About button is an image, so it dims rather than recolouring on hover.
   Sized in em with its siblings so it tracks --nav-scale on phone and tablet. */
.helm-icon {
  width: 1.85em;
  height: 1.85em;
  display: block;
  opacity: 0.85;
}

#helm-button:hover .helm-icon { opacity: 1; }

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
  gap: 0.45em;
  padding-top: 0.6em;
  border-top: 1px solid var(--border-color);
  margin-top: 0.6em;
}

/* Test button */
.test-btn {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.15em;
  padding: 0.6em 0.45em;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font-family: inherit;
  font-weight: 700;
  font-size: 0.82em;
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

/* Relative to .test-btn's own 0.82em, not to the nav root — nesting these as
   fractions of the root would compound the two scales. */
.test-btn-label {
  font-size: 1em;
  font-weight: 700;
}

.test-btn-timer {
  font-size: 0.88em;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.08em;
  opacity: 0.9;
}

/* Replaces the Start/Stop Test button in the view-only build, so the space
   reads as deliberately empty rather than as a missing control. */
.view-only-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.45em;
  padding: 0.6em 0.45em;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  font-size: 0.78em;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.view-only-badge .pi {
  font-size: 1.1em;
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

/* Without this a touch-drag on the handle scrolls the page instead of
   resizing — the browser claims the gesture before pointermove arrives. */
.nav-resize-handle {
  touch-action: none;
}

/* ── Phone ──────────────────────────────────────────────────────────────────
   App.vue holds the grid column at the rail width (see gridWidth), while the
   open drawer is simply wider than its column and overflows across the panel.
   The nav deliberately stays *in flow* — taking it out with position:fixed
   drops it as a grid item, and the panel then slides up into column 1. The
   z-index is what puts the overflow on top rather than under the panel. */

#navbar.nav-phone {
  z-index: 1000;
  border-radius: 0;
  border-left: none;
}

#navbar.nav-phone.nav-open {
  box-shadow: 4px 0 16px rgba(0, 0, 0, 0.4);
}

.nav-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: rgba(0, 0, 0, 0.45);
}

@media (max-width: 700px) {
  /* Type keeps scaling down with --nav-scale, but a *tap target* has a hard
     floor no matter how small the labels get — 2.15em would land near 25px
     here, which is not reliably hittable with a thumb. PHONE_RAIL is sized to
     clear this inside #navbar's padding. */
  #menu-button,
  #gear-button,
  #screens-button {
    min-width: 34px;
    min-height: 34px;
  }

  #navbar :deep(button) {
    min-height: 34px;
  }
}

#navbar,
#helm-button,
#menu-button,
#gear-button,
#screens-button,
#fullscreen-button {
  transition: var(--theme-transition);
}
</style>
