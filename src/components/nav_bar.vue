<script setup>
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import Button from 'primevue/button'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

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

const emit = defineEmits(['navigate', 'open-settings', 'open-about', 'resize'])

const COLLAPSE_THRESHOLD = 130
const MIN_WIDTH = 52
const DEFAULT_WIDTH = 180

const navbarWidth = ref(DEFAULT_WIDTH)
const isCollapsed = ref(false)

watch(navbarWidth, (width) => emit('resize', width))
onMounted(() => emit('resize', navbarWidth.value))

let isResizing = false
let resizeStartX = 0
let resizeStartWidth = 0

function onResizeStart(event) {
  isResizing = true
  resizeStartX = event.clientX
  resizeStartWidth = navbarWidth.value
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', onResizeEnd)
  event.preventDefault()
}

function onResizeMove(event) {
  if (!isResizing) return
  const newWidth = Math.max(MIN_WIDTH, resizeStartWidth + (event.clientX - resizeStartX))
  if (newWidth < COLLAPSE_THRESHOLD) {
    isCollapsed.value = true
    navbarWidth.value = MIN_WIDTH
  } else {
    isCollapsed.value = false
    navbarWidth.value = newWidth
  }
}

function onResizeEnd() {
  isResizing = false
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
}

let extraWindowCount = 0

function addWindow() {
  extraWindowCount += 1
  const label = `extra-${extraWindowCount}`
  const win = new WebviewWindow(label, {
    url: '/',
    title: `prop-control-gui — Window ${extraWindowCount + 1}`,
    width: 1280,
    height: 800,
  })
  win.once('tauri://error', (event) => {
    console.error(`[NavBar] Failed to create window ${label}:`, event)
  })
}

function toggleCollapse() {
  if (isCollapsed.value) {
    isCollapsed.value = false
    navbarWidth.value = DEFAULT_WIDTH
  } else {
    isCollapsed.value = true
    navbarWidth.value = MIN_WIDTH
  }
}

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
  <div id="navbar" :style="{ width: navbarWidth + 'px' }">
    <div id="menu-buttons" :class="{ collapsed: isCollapsed }">
      <button id="helm-button" type="button" title="About HELM" aria-label="About HELM" @click="emit('open-about')">
        <img :src="logoUrl" alt="" aria-hidden="true" class="helm-icon" />
      </button>
      <button id="menu-button" type="button" title="Toggle menu" aria-label="Toggle menu" @click="toggleCollapse">
        <i class="pi pi-bars" aria-hidden="true" />
      </button>
      <button id="gear-button" type="button" title="Settings" aria-label="Settings" @click="emit('open-settings')">
        <i class="pi pi-cog" aria-hidden="true" />
      </button>
      <button id="screens-button" type="button" title="Add window" aria-label="Add window" @click="addWindow">
        <i class="pi pi-plus-circle" aria-hidden="true" />
      </button>
    </div>

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
        v-if="recordingMode === 'local-only'"
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
        v-if="recordingMode === 'server-only' && localRecorderAvailable"
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
        <Button label="Control" @click="emit('navigate', ControlPanel)" />
        <Button label="Data" @click="emit('navigate', GraphPanel)" />
        <Button label="Camera View" @click="emit('navigate', CameraPanel)" />
        <Button label="Sessions" @click="emit('navigate', SessionsPanel)" />
        <Button label="Devices" @click="emit('navigate', DeviceSummaryPanel)" />
        <Button label="Debug" @click="emit('navigate', DebugPanel)" />
        <Button label="Flight" @click="emit('navigate', FlightPanel)" />
      </div>

      <div id="nav-lower">
        <ServerBar :server-ip="serverIp" />

        <section class="recording-control">
          <button
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
            v-if="recordingMode === 'local-only'"
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
            v-if="recordingMode === 'server-only' && localRecorderAvailable"
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

    <div class="nav-resize-handle" @mousedown="onResizeStart" />
  </div>
</template>

<style scoped>
#navbar {
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 10px;
  text-align: left;
  background-color: var(--bg-primary);
  border: var(--border-color) 2px solid;
  border-right: 0;
  border-radius: 10px 0 0 10px;
}

#nav-upper :deep(button) {
  width: 100%;
  margin: 2pt 0;
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

#helm-button,
#menu-button,
#gear-button,
#screens-button {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--text-secondary);
  background: transparent;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
  transition: var(--theme-transition);
}

#menu-button i,
#gear-button i,
#screens-button i {
  font-size: 24px;
}

#menu-button:hover,
#gear-button:hover,
#screens-button:hover { color: var(--text-primary); }

.helm-icon {
  display: block;
  width: 26px;
  height: 26px;
  opacity: 0.85;
}

#helm-button:hover .helm-icon { opacity: 1; }

#helm-button:focus-visible,
#menu-button:focus-visible,
#gear-button:focus-visible,
#screens-button:focus-visible {
  outline: 2px solid var(--border-accent);
  outline-offset: 1px;
}

.collapsed-recording-controls {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 30px;
  margin-top: auto;
}

#navbar .collapsed-recording-status,
#navbar .collapsed-recovery-action {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  margin: 0;
  padding: 0;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-family: inherit;
}

#navbar .collapsed-recording-status {
  height: 30px;
}

#navbar .collapsed-recovery-action {
  height: 26px;
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
  gap: 6px;
  padding-top: 8px;
  margin-top: 8px;
  border-top: 1px solid var(--border-color);
}

.recording-control {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.recording-action {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-height: 34px;
  margin: 0;
  padding: 5px 7px;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
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
.nav-resize-handle:active { background: rgba(45, 88, 104, 0.45); }
</style>
