<script setup>
import { ref, computed, watch, inject, onMounted, onUnmounted } from "vue";
import Button from "primevue/button";
import { CAPS, availablePanels, isWeb } from "../lib/platform.js";

import logoUrl from '../../app-icon.svg'
import { normalizeSessionComponents } from '../utils/session.js'
import ServerBar from './server_bar.vue'

import CameraPanel from '../windows/camera_panel.vue'
import GraphPanel from '../windows/graph_panel.vue'
import ControlPanel from '../windows/control_panel.vue'
import DebugPanel from '../windows/debug_panel.vue'
import FlightPanel from '../windows/flight_panel.vue'
import DeviceSummaryPanel from '../windows/device_summary.vue'
import SessionsPanel from '../windows/sessions_panel.vue'

// Which panels this build exposes, in nav order. Driven by platform.js so
// re-enabling a panel for the pad is a one-line change there.
const PANELS = {
  control:  { label: "Control",     component: ControlPanel },
  graph:    { label: "Data",        component: GraphPanel },
  camera:   { label: "Camera View", component: CameraPanel },
  sessions: { label: "Sessions",    component: SessionsPanel },
  devices:  { label: "Devices",     component: DeviceSummaryPanel },
  debug:    { label: "Debug",       component: DebugPanel },
  flight:   { label: "Flight",      component: FlightPanel },
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

let isResizing = false
let resizeStartX = 0
let resizeStartWidth = 0

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
    isCollapsed.value = false
    navbarWidth.value = newWidth
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
  if (timerInterval !== null) clearInterval(timerInterval);
});

// ── Extra window spawning ─────────────────────────────────────────────────────

let _extraWindowCount = 0;

// Desktop only — the control is hidden in the web build (see canAddWindows).
// A browser tab is not a second window in any useful sense: the pad client is
// view-only, so a duplicate tab just doubles the telemetry subscription over
// the wifi link the test depends on and gives the engineer nothing new. The
// BroadcastChannel sync in App.vue keeps server IP, settings and test state
// consistent across the native windows this does spawn.
//
// The import is lazy for the same reason desktop.js exists: a static
// @tauri-apps import here would be evaluated in the web bundle too.
async function addWindow() {
  _extraWindowCount++;

  const label = `extra-${_extraWindowCount}`;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const win = new WebviewWindow(label, {
    url: '/',
    title: `prop-control-gui — Window ${_extraWindowCount + 1}`,
    width: 1280,
    height: 800,
  })
  win.once('tauri://error', (event) => {
    console.error(`[NavBar] Failed to create window ${label}:`, event)
  })
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

// iPadOS paints its own exit-fullscreen control over the top-left of the page.
// It is browser UI, not content: a page cannot hide, restyle or reposition it,
// and `navigationUI: "hide"` is only a hint that WebKit ignores. Our button row
// sits exactly underneath it.
//
// So move ours rather than trying to dodge a fixed offset — bottom of the
// sidebar clears the overlay whatever size it turns out to be, and costs
// nothing on the platforms that draw no overlay because they never get here.
//
// iPadOS reports itself as a Mac, so touch points are the reliable tell.
const isAppleTouch =
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const controlsAtBottom = computed(() => isFullscreen.value && isAppleTouch);

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

// ── Recording status and controls ────────────────────────────────────────────

// Recording state is supplied by App. Safe defaults keep this component usable
// in previews and isolated component tests.
const serverIp = inject('serverIp', ref(''))
const testActive = inject('testActive', ref(false))
const testStartTime = inject('testStartTime', ref(null))
const session = inject('session', ref(null))
const sessionWarning = inject('sessionWarning', ref(null))
const stateStreamStatus = inject('stateStreamStatus', ref('disconnected'))
const recordingMode = inject('recordingMode', ref('idle'))
const localRecorderAvailable = inject('localRecorderAvailable', ref(false))
const localRecordingActive = inject('localRecordingActive', ref(false))
const lifecycleBusy = inject('lifecycleBusy', ref(false))
const lifecycleError = inject('lifecycleError', ref(''))

const startTest = inject('startTest', async () => {})
const stopTest = inject('stopTest', async () => {})
const retryServerSession = inject('retryServerSession', async () => {})
const startLocalBackup = inject('startLocalBackup', async () => {})
const stopLocalBackup = inject('stopLocalBackup', async () => {})

const elapsed = ref(0)
let timerInterval = null

function updateElapsed() {
  const started = Number(testStartTime.value)
  elapsed.value = testActive.value && testStartTime.value != null && Number.isFinite(started)
    ? Math.max(0, Date.now() - started)
    : 0
}

function resetTimer() {
  if (timerInterval !== null) clearInterval(timerInterval)
  timerInterval = null
  updateElapsed()
  if (testActive.value) timerInterval = window.setInterval(updateElapsed, 1000)
}

watch([testActive, testStartTime], resetTimer, { immediate: true })

function formatElapsed(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
}

const componentEntries = computed(() =>
  Object.entries(normalizeSessionComponents(session.value?.components))
)

function isHealthyStatus(status) {
  return String(status).toLowerCase() === 'ok'
}

function detailText(value) {
  if (value == null || value === '') return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

function warningText(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  const knownText = value.message ?? value.detail ?? value.warning
  if (knownText != null) return detailText(knownText)
  return detailText(value)
}

const unhealthyComponents = computed(() =>
  componentEntries.value.filter(([, item]) => !isHealthyStatus(item.status))
)

const componentIssueMessages = computed(() => unhealthyComponents.value.map(([name, component]) => {
  const detail = detailText(component.detail)
  const summary = `${name}: ${component.status || 'unknown'}`
  return detail ? `${summary} — ${detail}` : summary
}))

const baseModeLabel = computed(() => ({
  idle: 'Ready',
  redundant: 'Server + laptop',
  'server-only': localRecorderAvailable.value ? 'Server only' : 'Server recording',
  'local-only': 'Laptop only',
}[recordingMode.value] ?? 'Unknown'))

const serverStateUnconfirmed = computed(() =>
  !!session.value && stateStreamStatus.value !== 'connected'
)

const modeLabel = computed(() => serverStateUnconfirmed.value
  ? `${baseModeLabel.value} — unconfirmed`
  : baseModeLabel.value
)

const aggregateState = computed(() => {
  if (lifecycleError.value) return 'error'
  if (recordingMode.value === 'idle') return sessionWarning.value ? 'warning' : 'idle'
  if (serverStateUnconfirmed.value) return 'warning'
  if (sessionWarning.value || componentEntries.value.some(([, item]) => !isHealthyStatus(item.status))) {
    return 'warning'
  }
  if (recordingMode.value === 'local-only') return 'warning'
  if (recordingMode.value === 'server-only' && localRecorderAvailable.value) return 'warning'
  return 'healthy'
})

const mainActionLabel = computed(() => {
  if (lifecycleBusy.value) return 'Working…'
  if (recordingMode.value === 'local-only') return 'Stop Laptop'
  if (testActive.value) return 'Stop Test'
  return 'Start Test'
})

const recordingMeta = computed(() => {
  if (recordingMode.value === 'idle') return ''
  const sessionName = session.value?.name || session.value?.id
  return sessionName ? `${modeLabel.value} · ${sessionName}` : modeLabel.value
})

const attentionMessages = computed(() => {
  const messages = []
  if (lifecycleError.value) messages.push(lifecycleError.value)
  if (sessionWarning.value) messages.push(warningText(sessionWarning.value))
  if (serverStateUnconfirmed.value) {
    messages.push('State connection lost; server recording status is unconfirmed')
  }
  messages.push(...componentIssueMessages.value)
  return messages.filter(Boolean)
})

const compactAttentionText = computed(() => {
  if (!attentionMessages.value.length) return ''
  const remainder = attentionMessages.value.length - 1
  return remainder
    ? `${attentionMessages.value[0]} (+${remainder} more)`
    : attentionMessages.value[0]
})

const attentionTitle = computed(() => attentionMessages.value.join('\n'))
const hasAttention = computed(() => attentionMessages.value.length > 0)

const aggregateTitle = computed(() => {
  const stateLabel = {
    idle: 'No recording active',
    healthy: 'Recording healthy',
    warning: 'Recording needs attention',
    error: 'Recording lifecycle error',
  }[aggregateState.value]
  const lines = [`${stateLabel}: ${modeLabel.value}`]

  if (session.value) {
    lines.push(`Session: ${session.value.name || session.value.id}`)
    if (testActive.value) lines.push(`Elapsed: ${formatElapsed(elapsed.value)}`)
  }
  if (localRecorderAvailable.value) {
    lines.push(`Laptop CSV: ${localRecordingActive.value ? 'armed' : 'not armed'}`)
  }
  if (componentEntries.value.length) {
    lines.push(`Components: ${componentEntries.value.map(([name, component]) => {
      const detail = detailText(component.detail)
      return `${name} ${component.status || 'unknown'}${detail ? ` (${detail})` : ''}`
    }).join(', ')}`)
  }
  if (attentionTitle.value) lines.push(attentionTitle.value)
  return lines.join('\n')
})

async function runMainAction() {
  if (lifecycleBusy.value) return
  if (recordingMode.value === 'local-only') {
    await stopLocalBackup()
  } else if (testActive.value) {
    await stopTest()
  } else {
    await startTest()
  }
}

onUnmounted(() => {
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
  if (timerInterval !== null) clearInterval(timerInterval)
})
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
    :class="{ 'nav-phone': isPhone, 'nav-open': !isCollapsed, 'fs-controls-bottom': controlsAtBottom }"
    :style="{ width: navbarWidth + 'px' }"
  >
    <div id="menu-buttons" :class="{ collapsed: isCollapsed }">
      <button id="helm-button" type="button" title="About HELM" aria-label="About HELM" @click="emit('open-about')">
        <img :src="logoUrl" alt="" aria-hidden="true" class="helm-icon" />
      </button>
      <button id="menu-button" type="button" title="Toggle menu" aria-label="Toggle menu" @click="toggleCollapse">
        <i class="pi pi-bars" aria-hidden="true" />
      </button>
      <button id="gear-button" type="button" title="Settings" aria-label="Settings" @click="onOpenSettings">
        <i class="pi pi-cog" aria-hidden="true" />
      </button>
      <button
        v-if="canAddWindows"
        id="screens-button"
        type="button"
        title="Add window"
        aria-label="Add window"
        @click="addWindow"
      >
        <i class="pi pi-plus-circle" aria-hidden="true" />
      </button>
      <button
        v-if="canFullscreen"
        id="fullscreen-button"
        type="button"
        :title="isFullscreen ? 'Exit full screen' : 'Full screen'"
        :aria-label="isFullscreen ? 'Exit full screen' : 'Full screen'"
        @click="toggleFullscreen"
      >
        <i :class="isFullscreen ? 'pi pi-window-minimize' : 'pi pi-window-maximize'" aria-hidden="true" />
      </button>
    </div>

    <!-- Collapsed rail. The status light stays in both builds — knowing whether
         the run is on the record is exactly what the pad is here to see — but
         the recovery actions are launch control's, so they are gated. -->
    <div v-if="isCollapsed" class="collapsed-recording-controls">
      <div
        class="collapsed-recording-status"
        :class="`aggregate-${aggregateState}`"
        :title="aggregateTitle"
        :aria-label="aggregateTitle"
        role="status"
      >
        <i v-if="lifecycleBusy" class="pi pi-spinner pi-spin status-spinner" />
        <span v-else class="aggregate-led" />
        <span v-if="hasAttention && !lifecycleBusy" class="attention-badge" aria-hidden="true" />
      </div>

      <button
        v-if="canCommand && recordingMode === 'local-only'"
        class="collapsed-recovery-action"
        type="button"
        title="Retry the server session"
        aria-label="Retry the server session"
        :disabled="lifecycleBusy"
        @click="retryServerSession"
      >
        <i class="pi pi-refresh" />
      </button>
      <button
        v-if="canCommand && recordingMode === 'server-only' && localRecorderAvailable"
        class="collapsed-recovery-action"
        type="button"
        title="Start the laptop CSV backup"
        aria-label="Start the laptop CSV backup"
        :disabled="lifecycleBusy"
        @click="startLocalBackup"
      >
        <i class="pi pi-plus-circle" />
      </button>

      <span v-if="hasAttention" class="visually-hidden" role="status" aria-live="polite">
        {{ compactAttentionText }}
      </span>
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

        <!-- Status is for everyone; the buttons are not. Starting or stopping a
             test broadcasts STREAM/STOP to the whole stand and drives the local
             CSV recorder, so those are launch control's alone — but whether the
             run is being recorded, and whether a component is unhealthy, is
             precisely what the pad needs to know without asking over radio. -->
        <section class="recording-control">
          <div
            v-if="!canCommand"
            class="recording-status"
            :class="`aggregate-${aggregateState}`"
            :title="aggregateTitle"
            :aria-label="aggregateTitle"
            role="status"
          >
            <span class="aggregate-led" />
            <span class="recording-action-label">{{ modeLabel }}</span>
            <span v-if="testActive" class="recording-elapsed">{{ formatElapsed(elapsed) }}</span>
            <i class="pi pi-eye view-only-icon" title="Commands are issued from launch control" />
          </div>
          <button
            v-else
            class="recording-action"
            type="button"
            :class="`aggregate-${aggregateState}`"
            :title="aggregateTitle"
            :aria-label="mainActionLabel"
            aria-describedby="recording-status-description"
            :disabled="lifecycleBusy"
            @click="runMainAction"
          >
            <i v-if="lifecycleBusy" class="pi pi-spinner pi-spin status-spinner" />
            <span v-else class="aggregate-led" />
            <span class="recording-action-label">{{ mainActionLabel }}</span>
            <span v-if="testActive" class="recording-elapsed">{{ formatElapsed(elapsed) }}</span>
            <i
              v-if="hasAttention && !lifecycleBusy"
              class="pi pi-exclamation-triangle recording-attention-icon"
              aria-hidden="true"
            />
          </button>

          <div v-if="recordingMeta" class="recording-meta" :title="recordingMeta">
            {{ recordingMeta }}
          </div>

          <span id="recording-status-description" class="visually-hidden">
            {{ aggregateTitle }}
          </span>

          <div
            v-if="hasAttention"
            class="recording-alert"
            :class="{ 'recording-alert--error': aggregateState === 'error' }"
            :title="attentionTitle"
            role="status"
            aria-live="polite"
          >
            <i class="pi pi-exclamation-triangle" aria-hidden="true" />
            <span>{{ compactAttentionText }}</span>
          </div>

          <button
            v-if="canCommand && recordingMode === 'local-only'"
            class="recovery-btn"
            type="button"
            title="Retry the server session while keeping the laptop CSV recorder running"
            :disabled="lifecycleBusy"
            @click="retryServerSession"
          >
            <i class="pi pi-refresh" />
            Retry server
          </button>
          <button
            v-if="canCommand && recordingMode === 'server-only' && localRecorderAvailable"
            class="recovery-btn"
            type="button"
            title="Start the laptop CSV backup for this running server session"
            :disabled="lifecycleBusy"
            @click="startLocalBackup"
          >
            <i class="pi pi-plus-circle" />
            Start laptop CSV
          </button>
        </section>
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
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0.7em;
  text-align: left;
  background-color: var(--bg-primary);
  border: var(--border-color) 2px solid;
  border-right: 0;
  border-radius: 10px 0 0 10px;
}

@media (max-width: 1200px) {
  #navbar { --nav-scale: 0.9; }
}

@media (max-width: 700px) {
  #navbar { --nav-scale: 0.85; }
}

/* Scoped to #nav-upper rather than the whole nav: the recording widget and the
   icon row are buttons too, and a blanket width:100% deforms them. */
#nav-upper :deep(button) {
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

/* See controlsAtBottom in the script: iPadOS overlays its own exit-fullscreen
   button on the top-left while fullscreen, right on top of this row, and the
   page has no way to move or hide it. Ours moves instead. `order` rather than a
   padding guess, because the overlay's size is not ours to know. */
#navbar.fs-controls-bottom #menu-buttons {
  order: 2;
  margin-top: 0.3em;
  margin-bottom: 0;
}

#helm-button,
#menu-button,
#gear-button,
#screens-button,
#fullscreen-button {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 2.15em;
  height: 2.15em;
  padding: 0;
  color: var(--text-secondary);
  background: transparent;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
  transition: var(--theme-transition);
}

#menu-buttons .pi {
  font-size: 1.7em;
}

/* Four icon buttons have to share the sidebar once the fullscreen control is
   present, and the tablet tier is the tightest fit by a distance: a 128px
   sidebar leaves ~110px of content, while four buttons at desktop size want
   ~125px — so the last one clipped off the edge. Shrink the buttons and close
   the gaps here rather than losing one.
   `wrap` is a backstop, not the mechanism: if a fifth button ever lands, it
   drops to a second row instead of silently disappearing under overflow:hidden. */
@media (max-width: 1200px) {
  #menu-buttons {
    gap: 0.28em;
    flex-wrap: wrap;
  }

  #helm-button,
  #menu-button,
  #gear-button,
  #screens-button,
  #fullscreen-button {
    width: 1.9em;
    height: 1.9em;
  }

  #menu-buttons .pi {
    font-size: 1.45em;
  }

  .helm-icon {
    width: 1.6em;
    height: 1.6em;
  }
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

#helm-button:focus-visible,
#menu-button:focus-visible,
#gear-button:focus-visible,
#screens-button:focus-visible,
#fullscreen-button:focus-visible {
  outline: 2px solid var(--border-accent);
  outline-offset: 1px;
}

.collapsed-recording-controls {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 2.15em;
  margin-top: auto;
}

/* Sized in em with the icon buttons above so the rail scales as one on tablet
   and phone rather than leaving a desktop-sized chip below shrunken icons. */
#navbar .collapsed-recording-status,
#navbar .collapsed-recovery-action {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.15em;
  margin: 0;
  padding: 0;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-family: inherit;
}

#navbar .collapsed-recording-status {
  height: 2.15em;
}

#navbar .collapsed-recovery-action {
  height: 1.85em;
  color: #f39c12;
  cursor: pointer;
  font-size: 0.72rem;
}

#navbar .collapsed-recovery-action:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-secondary);
  border-color: var(--btn-border-hover);
}

#navbar .collapsed-recovery-action:hover:not(:disabled) {
  color: #f39c12;
  border-color: #f39c12;
}

#navbar .collapsed-recovery-action:disabled {
  cursor: wait;
  opacity: 0.6;
}

.attention-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 6px;
  height: 6px;
  background: #f39c12;
  border-radius: 50%;
  box-shadow: 0 0 0 1px var(--bg-surface);
}

.aggregate-error .attention-badge {
  background: #e74c3c;
}

#collapse {
  display: flex;
  flex: 1;
  flex-direction: column;
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

.recording-control {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

/* Same four columns — LED, label, elapsed, trailing icon — whether this is the
   button launch control presses or the read-only chip the pad sees, so the two
   builds line up identically and only the interaction differs. */
.recording-action,
.recording-status {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 0.36em;
  width: 100%;
  min-height: 2.4em;
  margin: 0;
  padding: 0.36em 0.5em;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-family: inherit;
  text-align: left;
}

.recording-action {
  cursor: pointer;
}

.recording-action:hover:not(:disabled) {
  background: var(--bg-secondary);
  border-color: var(--btn-border-hover);
}

.recording-action:focus-visible,
.recovery-btn:focus-visible,
.collapsed-recovery-action:focus-visible {
  outline: 2px solid var(--border-accent);
  outline-offset: 1px;
}

.recording-action:disabled,
.recovery-btn:disabled {
  cursor: wait;
  opacity: 0.6;
}

.recording-action-label {
  min-width: 0;
  overflow: hidden;
  font-size: 0.72rem;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aggregate-led {
  display: inline-block;
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.aggregate-idle .aggregate-led {
  background: #666;
}

.aggregate-healthy .aggregate-led {
  background: #2ecc71;
  box-shadow: 0 0 4px #2ecc71;
}

.aggregate-warning .aggregate-led {
  background: #f39c12;
  box-shadow: 0 0 4px #f39c12;
}

.aggregate-error .aggregate-led {
  background: #e74c3c;
  box-shadow: 0 0 4px #e74c3c;
}

.status-spinner {
  width: 7px;
  color: var(--text-secondary);
  font-size: 0.7rem;
}

.recording-elapsed {
  color: var(--text-secondary);
  font-family: monospace;
  font-size: 0.67rem;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.recording-attention-icon {
  color: #f39c12;
  font-size: 0.68rem;
}

.aggregate-error .recording-attention-icon {
  color: #e74c3c;
}

.recording-meta {
  min-width: 0;
  overflow: hidden;
  padding: 0 2px;
  color: var(--text-muted);
  font-size: 0.68rem;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recording-alert {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 1px 2px;
  color: var(--text-secondary);
  font-size: 0.68rem;
  line-height: 1.3;
}

.recording-alert i {
  flex: none;
  color: #b26b00;
  font-size: 0.65rem;
}

.recording-alert span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recording-alert--error {
  color: var(--text-secondary);
}

.recording-alert--error i {
  color: #e74c3c;
}

.recovery-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: 100%;
  min-height: 26px;
  margin: 0;
  padding: 3px 6px;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: 5px;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.67rem;
  font-weight: 600;
}

.recovery-btn i {
  color: #f39c12;
  font-size: 0.7rem;
}

.recovery-btn:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-secondary);
  border-color: #f39c12;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  white-space: nowrap;
  border: 0;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
}

/* Marks the status chip as deliberately inert in the view-only build, so the
   absent Start/Stop reads as a decision rather than a missing control. */
.view-only-icon {
  color: var(--text-muted);
  font-size: 0.72rem;
}

/* Drag handle */
.nav-resize-handle {
  position: absolute;
  z-index: 10;
  top: 0;
  right: 0;
  width: 5px;
  height: 100%;
  cursor: col-resize;
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
  #screens-button,
  #fullscreen-button {
    min-width: 34px;
    min-height: 34px;
  }

  #nav-upper :deep(button),
  .recording-action,
  .recording-status {
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
