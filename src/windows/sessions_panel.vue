<script setup>
import { computed, inject, onActivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { isTauri } from '../lib/platform.js'
import { downloadSessionZip } from '../lib/desktop.js'

import { normalizeSessionComponents } from '../utils/session.js'

defineOptions({ name: 'SessionsPanel' })

const serverIp = inject('serverIp', ref(''))
const liveSession = inject('session', ref(null))
const sessionWarning = inject('sessionWarning', ref(null))
const stateStreamStatus = inject('stateStreamStatus', ref('disconnected'))
const listSessions = inject('listSessions', async () => ({ sessions: [], free_bytes: null }))
const getSession = inject('getSession', async () => ({}))
const sessionDownloadUrl = inject('sessionDownloadUrl', () => '#')

const sessions = ref([])
const freeBytes = ref(null)
const loading = ref(false)
const loadError = ref('')
const expandedId = ref(null)
const detailsById = ref({})
const detailErrors = ref({})
const loadingDetailId = ref(null)
const downloadingId = ref(null)
const downloadMessage = ref('')
const downloadMessageTitle = ref('')
const downloadError = ref('')

let listRequestId = 0
let detailRequestId = 0
let downloadMessageTimer = null

const latestCompleted = computed(() =>
  sessions.value.find((item) => item?.status === 'completed' && item?.id !== liveSession.value?.id) ?? null
)

function errorMessage(error) {
  if (typeof error === 'string') return error
  if (error?.message) return String(error.message)
  if (error?.kind || error?.status) {
    return [error.kind, error.status, error.message].filter(Boolean).join(': ')
  }
  try { return JSON.stringify(error) } catch { return String(error) }
}

function formatBytes(value) {
  if (value == null || value === '') return 'Unknown'
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let amount = bytes
  let unitIndex = -1
  do {
    amount /= 1024
    unitIndex += 1
  } while (amount >= 1024 && unitIndex < units.length - 1)
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unitIndex]}`
}

function formatStarted(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return 'Unknown start time'
  return new Date(seconds * 1000).toLocaleString()
}

function statusInfo(item) {
  if (item?.id && item.id === liveSession.value?.id) {
    if (stateStreamStatus.value !== 'connected') {
      return { label: 'Recording unconfirmed', className: 'status-stale' }
    }
    return { label: 'Recording', className: 'status-live' }
  }
  if (item?.status === 'active') {
    return { label: 'Incomplete / stale', className: 'status-stale' }
  }
  if (item?.status === 'completed') {
    return { label: 'Completed', className: 'status-completed' }
  }
  return { label: 'Unknown', className: 'status-unknown' }
}

function componentEntries(item) {
  return Object.entries(normalizeSessionComponents(item?.components))
}

function displayedSession(item) {
  const detail = detailsById.value[item?.id] ?? item ?? {}
  if (!item?.id || liveSession.value?.id !== item.id) return detail
  const detailComponents = normalizeSessionComponents(detail.components)
  const liveComponents = normalizeSessionComponents(liveSession.value.components)
  const componentNames = new Set([
    ...Object.keys(detailComponents),
    ...Object.keys(liveComponents),
  ])
  const components = Object.fromEntries([...componentNames].map((name) => [name, {
    status: liveComponents[name]?.status ?? detailComponents[name]?.status ?? 'unknown',
    detail: liveComponents[name]?.detail ?? detailComponents[name]?.detail ?? null,
  }]))
  return {
    ...detail,
    ...liveSession.value,
    components,
  }
}

function componentClass(status) {
  const normalized = String(status ?? '').toLowerCase()
  if (normalized === 'ok') return 'component-ok'
  if (['failed', 'failure', 'error'].includes(normalized)) return 'component-failed'
  if (['skipped', 'warning', 'degraded', 'starting', 'stopping'].includes(normalized)) {
    return 'component-warning'
  }
  return 'component-unknown'
}

function componentDetailText(detail) {
  if (detail == null || detail === '') return ''
  if (typeof detail === 'string') return detail
  try { return JSON.stringify(detail) } catch { return String(detail) }
}

function warningText(warning) {
  if (!warning) return ''
  if (typeof warning === 'string') return warning
  return warning.message ?? warning.detail ?? warning.warning ?? JSON.stringify(warning)
}

function showDownloadMessage(message, title = message) {
  if (downloadMessageTimer !== null) window.clearTimeout(downloadMessageTimer)
  downloadMessage.value = message
  downloadMessageTitle.value = title
  downloadMessageTimer = window.setTimeout(() => {
    downloadMessage.value = ''
    downloadMessageTitle.value = ''
    downloadMessageTimer = null
  }, 6000)
}

async function refreshSessions() {
  const server = String(serverIp.value ?? '').trim()
  if (!server) return
  const requestId = ++listRequestId
  loading.value = true
  loadError.value = ''
  try {
    const payload = await listSessions()
    if (requestId !== listRequestId || server !== String(serverIp.value ?? '').trim()) return
    const items = Array.isArray(payload?.sessions) ? payload.sessions : []
    sessions.value = [...items].sort(
      (left, right) => Number(right?.started_unix ?? 0) - Number(left?.started_unix ?? 0)
    )
    freeBytes.value = payload?.free_bytes ?? null

    const expandedItem = sessions.value.find((item) => item?.id === expandedId.value)
    detailRequestId += 1
    loadingDetailId.value = null
    detailsById.value = {}
    detailErrors.value = {}
    if (expandedItem) {
      expandedId.value = null
      void toggleDetails(expandedItem)
    } else if (expandedId.value) {
      expandedId.value = null
    }
  } catch (error) {
    if (requestId === listRequestId) loadError.value = errorMessage(error)
  } finally {
    if (requestId === listRequestId) loading.value = false
  }
}

async function toggleDetails(item) {
  if (!item?.id) return
  if (expandedId.value === item.id) {
    expandedId.value = null
    return
  }
  expandedId.value = item.id
  if (detailsById.value[item.id] || loadingDetailId.value === item.id) return

  const requestId = ++detailRequestId
  const server = String(serverIp.value ?? '').trim()
  loadingDetailId.value = item.id
  detailErrors.value = { ...detailErrors.value, [item.id]: '' }
  try {
    const detail = await getSession(item.id)
    if (requestId !== detailRequestId || server !== String(serverIp.value ?? '').trim()) return
    detailsById.value = { ...detailsById.value, [item.id]: detail }
  } catch (error) {
    if (requestId === detailRequestId) {
      detailErrors.value = { ...detailErrors.value, [item.id]: errorMessage(error) }
    }
  } finally {
    if (requestId === detailRequestId && loadingDetailId.value === item.id) loadingDetailId.value = null
  }
}

function openBrowserDownload(item) {
  const anchor = document.createElement('a')
  anchor.href = sessionDownloadUrl(item.id)
  anchor.download = `${item.id}.zip`
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

async function downloadSession(item) {
  if (!item?.id || downloadingId.value) return
  downloadingId.value = item.id
  downloadMessage.value = ''
  downloadMessageTitle.value = ''
  downloadError.value = ''
  try {
    if (isTauri()) {
      const result = await downloadSessionZip(item.id)
      const savedPath = typeof result === 'string'
        ? result
        : result?.path ?? result?.saved_path ?? result?.message
      const label = item.name || item.id
      showDownloadMessage(
        `Saved ${label}`,
        savedPath ? `Saved ${label} to ${savedPath}` : `Saved ${label}`,
      )
    } else {
      openBrowserDownload(item)
      showDownloadMessage(`Download started for ${item.name || item.id}`)
    }
  } catch (error) {
    downloadError.value = errorMessage(error)
  } finally {
    downloadingId.value = null
  }
}

onMounted(refreshSessions)
onActivated(refreshSessions)
onUnmounted(() => {
  if (downloadMessageTimer !== null) window.clearTimeout(downloadMessageTimer)
})

watch(serverIp, () => {
  listRequestId += 1
  detailRequestId += 1
  loading.value = false
  loadingDetailId.value = null
  sessions.value = []
  freeBytes.value = null
  expandedId.value = null
  detailsById.value = {}
  loadError.value = ''
  downloadMessage.value = ''
  downloadMessageTitle.value = ''
  downloadError.value = ''
  void refreshSessions()
})

watch(liveSession, (next, previous) => {
  if (next?.id === previous?.id) return
  const previousWasExpanded = !!previous?.id && expandedId.value === previous.id
  if (previous?.id) {
    detailRequestId += 1
    if (loadingDetailId.value === previous.id) loadingDetailId.value = null
    const nextDetails = { ...detailsById.value }
    const nextErrors = { ...detailErrors.value }
    delete nextDetails[previous.id]
    delete nextErrors[previous.id]
    detailsById.value = nextDetails
    detailErrors.value = nextErrors
  }
  void refreshSessions()
  if (previousWasExpanded) {
    expandedId.value = null
    void toggleDetails({ id: previous.id })
  }
})
</script>

<template>
  <div class="sessions-panel">
    <header class="sessions-toolbar">
      <div class="toolbar-heading">
        <h1 class="panel-title">Sessions</h1>
        <span class="session-count" :aria-label="`${sessions.length} sessions`">
          {{ sessions.length }}
        </span>
      </div>

      <span class="disk-space" title="Sessions are never automatically pruned from the server">
        <i class="pi pi-database" aria-hidden="true" />
        {{ formatBytes(freeBytes) }} free
      </span>

      <div class="toolbar-actions">
        <button
          class="toolbar-button"
          type="button"
          :disabled="!latestCompleted || !!downloadingId"
          :aria-label="latestCompleted ? `Download latest completed session: ${latestCompleted.name || latestCompleted.id}` : 'No completed session available to download'"
          title="Download latest completed session"
          @click="downloadSession(latestCompleted)"
        >
          <i
            class="pi"
            :class="downloadingId === latestCompleted?.id ? 'pi-spinner pi-spin' : 'pi-download'"
            aria-hidden="true"
          />
          <span class="toolbar-button-label">Latest ZIP</span>
        </button>
        <button
          class="toolbar-button toolbar-button-icon"
          type="button"
          :disabled="!serverIp || loading"
          :aria-label="loading ? 'Refreshing recording sessions' : 'Refresh recording sessions'"
          :title="loading ? 'Refreshing sessions' : 'Refresh sessions'"
          @click="refreshSessions"
        >
          <i class="pi" :class="loading ? 'pi-spinner pi-spin' : 'pi-refresh'" aria-hidden="true" />
        </button>
      </div>
    </header>

    <div class="status-strips" aria-live="polite">
      <div v-if="sessionWarning" class="status-strip status-strip-warning">
        <i class="pi pi-exclamation-triangle" aria-hidden="true" />
        <span>{{ warningText(sessionWarning) }}</span>
      </div>
      <div
        v-if="liveSession && stateStreamStatus !== 'connected'"
        class="status-strip status-strip-warning"
      >
        <i class="pi pi-exclamation-triangle" aria-hidden="true" />
        <span>State connection lost; the displayed live session is last-known and unconfirmed.</span>
      </div>
      <div v-if="loadError" class="status-strip status-strip-error">
        <i class="pi pi-times-circle" aria-hidden="true" />
        <span>{{ loadError }}</span>
      </div>
      <div v-if="downloadError" class="status-strip status-strip-error">
        <i class="pi pi-times-circle" aria-hidden="true" />
        <span>{{ downloadError }}</span>
      </div>
      <div
        v-if="downloadMessage"
        class="status-strip status-strip-success"
        :title="downloadMessageTitle || downloadMessage"
      >
        <i class="pi pi-check-circle" aria-hidden="true" />
        <span>{{ downloadMessage }}</span>
      </div>
      <div v-if="downloadingId" class="status-strip status-strip-progress" role="status">
        <i class="pi pi-spinner pi-spin" aria-hidden="true" />
        <span>Downloading session ZIP… Files are streamed, so progress is indeterminate.</span>
      </div>
    </div>

    <div class="sessions-scroll">
      <div v-if="!loading && sessions.length === 0" class="empty-state">
        <i :class="serverIp ? 'pi pi-folder-open' : 'pi pi-server'" aria-hidden="true" />
        <strong>{{ serverIp ? 'No sessions yet' : 'Server not configured' }}</strong>
        <span>
          {{ serverIp
            ? 'Completed recording sessions will appear here.'
            : 'Choose a server in settings to browse recording sessions.' }}
        </span>
      </div>

      <div v-else class="session-list">
        <article
          v-for="item in sessions"
          :key="item.id"
          class="session-card"
          :class="{
            'session-card-live': statusInfo(item).className === 'status-live',
            'session-card-stale': statusInfo(item).className === 'status-stale',
            'session-card-expanded': expandedId === item.id,
          }"
        >
          <div class="session-summary">
            <button
              class="session-expand"
              type="button"
              :aria-expanded="expandedId === item.id"
              :aria-controls="`session-details-${item.id}`"
              @click="toggleDetails(item)"
            >
              <i
                class="expand-icon pi"
                :class="expandedId === item.id ? 'pi-chevron-down' : 'pi-chevron-right'"
                aria-hidden="true"
              />
              <span class="session-identity">
                <span class="session-name">{{ item.name || item.id }}</span>
                <span class="session-id">{{ item.id }}</span>
              </span>
            </button>

            <div class="session-facts">
              <span class="session-status" :class="statusInfo(item).className">
                <span class="status-dot" aria-hidden="true" />
                {{ statusInfo(item).label }}
              </span>
              <span class="session-started">{{ formatStarted(item.started_unix) }}</span>
              <span class="session-size">{{ formatBytes(item.size_bytes) }}</span>
            </div>

            <button
              class="download-button"
              type="button"
              :disabled="!!downloadingId || item.id === liveSession?.id"
              :aria-label="item.id === liveSession?.id
                ? `${item.name || item.id} is still recording; its ZIP is available after it stops`
                : `Download ${item.name || item.id} as a ZIP`"
              :title="item.id === liveSession?.id
                ? 'Available after recording stops'
                : `Download ${item.name || item.id} as ZIP`"
              @click="downloadSession(item)"
            >
              <i
                class="pi"
                :class="downloadingId === item.id ? 'pi-spinner pi-spin' : 'pi-download'"
                aria-hidden="true"
              />
            </button>
          </div>

          <div
            v-if="expandedId === item.id"
            :id="`session-details-${item.id}`"
            class="session-details"
          >
            <div v-if="loadingDetailId === item.id" class="detail-loading" role="status">
              <i class="pi pi-spinner pi-spin" aria-hidden="true" />
              Loading session metadata…
            </div>
            <div v-else-if="detailErrors[item.id]" class="detail-error">
              <i class="pi pi-times-circle" aria-hidden="true" />
              <span>{{ detailErrors[item.id] }}</span>
            </div>
            <template v-else>
              <section class="detail-section">
                <h2 class="detail-title">
                  Components
                  <span class="detail-count">
                    {{ componentEntries(displayedSession(item)).length }}
                  </span>
                </h2>
                <div
                  v-if="componentEntries(displayedSession(item)).length"
                  class="component-grid"
                >
                  <div
                    v-for="([name, component]) in componentEntries(displayedSession(item))"
                    :key="name"
                    class="component-card"
                  >
                    <div class="component-heading" :class="componentClass(component.status)">
                      <span class="component-dot" aria-hidden="true" />
                      <span class="component-name">{{ name }}</span>
                      <span class="component-status">{{ component.status }}</span>
                    </div>
                    <span v-if="componentDetailText(component.detail)" class="component-detail">
                      {{ componentDetailText(component.detail) }}
                    </span>
                  </div>
                </div>
                <p v-else class="detail-empty">No component status metadata available.</p>
              </section>

              <section class="detail-section">
                <h2 class="detail-title">Session details</h2>
                <dl class="metadata-grid">
                  <div class="metadata-item metadata-item-id">
                    <dt>Session ID</dt>
                    <dd class="metadata-mono">{{ displayedSession(item).id || item.id }}</dd>
                  </div>
                  <div class="metadata-item">
                    <dt>Status</dt>
                    <dd>{{ statusInfo(item).label }}</dd>
                  </div>
                  <div class="metadata-item">
                    <dt>Started</dt>
                    <dd>{{ formatStarted(displayedSession(item).started_unix ?? item.started_unix) }}</dd>
                  </div>
                  <div class="metadata-item">
                    <dt>Size</dt>
                    <dd>{{ formatBytes(displayedSession(item).size_bytes ?? item.size_bytes) }}</dd>
                  </div>
                </dl>
              </section>

              <details class="raw-metadata">
                <summary>Raw session metadata</summary>
                <pre>{{ JSON.stringify(displayedSession(item), null, 2) }}</pre>
              </details>
            </template>
          </div>
        </article>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sessions-panel {
  container-name: sessions-panel;
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  box-sizing: border-box;
  color: var(--text-primary);
  background: var(--bg-primary);
}

/* ── Toolbar ── */

.sessions-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 6px 10px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
  flex-shrink: 0;
}

.toolbar-heading,
.toolbar-actions,
.disk-space,
.toolbar-button {
  display: inline-flex;
  align-items: center;
}

.toolbar-heading {
  gap: 7px;
  min-width: 0;
}

.panel-title {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}

.session-count,
.detail-count {
  padding: 0 6px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-surface);
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 600;
  line-height: 17px;
}

.disk-space {
  gap: 5px;
  margin-left: auto;
  padding: 2px 7px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-surface);
  color: var(--text-muted);
  font-size: 0.68rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.disk-space .pi {
  font-size: 0.65rem;
}

.toolbar-actions {
  gap: 5px;
}

.toolbar-button,
.download-button {
  justify-content: center;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.toolbar-button {
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  font-size: 0.68rem;
}

.toolbar-button-icon,
.download-button {
  width: 28px;
  padding: 0;
}

.toolbar-button:hover:not(:disabled),
.download-button:hover:not(:disabled) {
  border-color: var(--border-accent);
  background: var(--bg-primary);
  color: var(--text-primary);
}

.toolbar-button:focus-visible,
.download-button:focus-visible,
.session-expand:focus-visible,
.raw-metadata summary:focus-visible {
  outline: 2px solid var(--border-accent);
  outline-offset: 2px;
}

.toolbar-button:disabled,
.download-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* ── Notices and activity ── */

.status-strips {
  flex-shrink: 0;
}

.status-strip,
.detail-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-color);
  font-size: 0.7rem;
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.status-strip-warning {
  color: var(--text-secondary);
  background: color-mix(in srgb, #f39c12 10%, transparent);
}

.status-strip-error,
.detail-error {
  color: var(--text-secondary);
  background: color-mix(in srgb, #e74c3c 9%, transparent);
}

.status-strip-success {
  color: var(--text-secondary);
  background: color-mix(in srgb, #2ecc71 9%, transparent);
}

.status-strip-warning > .pi { color: #b26b00; }
.status-strip-error > .pi,
.detail-error > .pi { color: #e74c3c; }
.status-strip-success > .pi { color: #178a49; }

.status-strip-progress {
  color: var(--text-secondary);
  background: var(--bg-secondary);
}

/* ── Scroll area and empty state ── */

.sessions-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  box-sizing: border-box;
}

.session-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 180px;
  padding: 24px 16px;
  box-sizing: border-box;
  color: var(--text-muted);
  text-align: center;
  font-size: 0.72rem;
  gap: 3px;
}

.empty-state .pi {
  margin-bottom: 7px;
  font-size: 1.7rem;
  opacity: 0.72;
}

.empty-state strong {
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.empty-state span {
  max-width: 340px;
  opacity: 0.8;
}

/* ── Session list rows ── */

.session-card {
  border: 1px solid var(--border-color);
  border-left-width: 3px;
  border-radius: 5px;
  background: var(--bg-secondary);
  overflow: hidden;
  transition: border-color 0.15s, background 0.15s;
}

.session-card-live {
  border-left-color: #e74c3c;
}

.session-card-stale {
  border-left-color: #f39c12;
}

.session-card-expanded {
  border-color: var(--border-accent);
}

.session-summary {
  display: grid;
  grid-template-columns: minmax(190px, 1fr) auto 28px;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 5px 8px;
  box-sizing: border-box;
  transition: background 0.15s;
}

.session-summary:hover {
  background: color-mix(in srgb, var(--bg-surface) 38%, transparent);
}

.session-expand {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.expand-icon {
  width: 10px;
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 0.58rem;
}

.session-identity {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.session-name {
  color: var(--text-primary);
  font-size: 0.78rem;
  font-weight: 700;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-id {
  color: var(--text-muted);
  font-family: monospace;
  font-size: 0.64rem;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-facts {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 9px;
  min-width: 0;
  color: var(--text-muted);
  font-size: 0.65rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.session-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary);
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.025em;
  text-transform: uppercase;
}

.status-dot,
.component-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
}

.status-live .status-dot {
  background: #e74c3c;
  box-shadow: 0 0 4px rgba(231, 76, 60, 0.65);
}
.status-completed .status-dot,
.component-ok .component-dot { background: #2ecc71; }
.status-stale .status-dot,
.component-warning .component-dot { background: #f39c12; }
.component-failed .component-dot { background: #e74c3c; }

.session-started,
.session-size {
  color: var(--text-muted);
}

.session-size {
  min-width: 56px;
  text-align: right;
}

.download-button {
  height: 28px;
  font-size: 0.68rem;
}

/* ── Expanded session details ── */

.session-details {
  padding: 10px 12px 11px;
  border-top: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--bg-primary) 58%, var(--bg-secondary));
}

.detail-loading {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 0.7rem;
}

.detail-error {
  padding: 5px 7px;
  border: 1px solid color-mix(in srgb, #e74c3c 45%, var(--border-color));
  border-radius: 4px;
}

.detail-section + .detail-section {
  margin-top: 11px;
}

.detail-title {
  display: flex;
  align-items: center;
  margin: 0 0 6px;
  gap: 6px;
  color: var(--text-secondary);
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.055em;
  text-transform: uppercase;
}

.detail-count {
  padding: 0 5px;
  font-size: 9px;
  line-height: 14px;
}

.component-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 5px;
}

.component-card {
  min-width: 0;
  padding: 5px 7px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-secondary);
}

.component-heading {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--text-secondary);
  font-size: 0.68rem;
  line-height: 1.25;
}

.component-name {
  overflow: hidden;
  color: var(--text-primary);
  font-weight: 700;
  text-overflow: ellipsis;
  text-transform: capitalize;
  white-space: nowrap;
}

.component-status {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.035em;
  text-transform: uppercase;
}

.component-detail {
  display: block;
  margin: 3px 0 0 11px;
  color: var(--text-muted);
  font-size: 0.65rem;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.detail-empty {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.66rem;
}

.metadata-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 5px;
  margin: 0;
}

.metadata-item {
  min-width: 0;
  padding: 5px 7px;
  border-left: 2px solid var(--border-color);
}

.metadata-item-id {
  grid-column: span 2;
}

.metadata-item dt {
  margin-bottom: 1px;
  color: var(--text-muted);
  font-size: 0.63rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.metadata-item dd {
  margin: 0;
  color: var(--text-primary);
  font-size: 0.66rem;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.metadata-mono {
  font-family: monospace;
}

.raw-metadata {
  margin-top: 10px;
  border-top: 1px solid var(--border-color);
  padding-top: 7px;
}

.raw-metadata summary {
  width: fit-content;
  color: var(--text-muted);
  font-size: 0.62rem;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}

.raw-metadata pre {
  max-height: 320px;
  overflow: auto;
  margin: 7px 0 0;
  padding: 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 0.62rem;
  line-height: 1.4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Respond to the panel's own width so detached windows resize correctly. */
@container sessions-panel (max-width: 720px) {
  .session-summary {
    grid-template-columns: minmax(0, 1fr) 28px;
    grid-template-areas:
      "identity download"
      "facts facts";
    gap: 3px 8px;
    padding-block: 6px;
  }

  .session-expand { grid-area: identity; }
  .download-button { grid-area: download; }
  .session-facts {
    grid-area: facts;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
}

@container sessions-panel (max-width: 560px) {
  .sessions-toolbar {
    flex-wrap: wrap;
    row-gap: 5px;
  }

  .toolbar-heading {
    flex: 1 1 auto;
  }

  .toolbar-actions {
    margin-left: auto;
  }

  .disk-space {
    order: 3;
    margin-left: 0;
  }

  .sessions-scroll {
    padding: 7px;
  }

  .session-facts {
    justify-content: flex-start;
  }

  .session-started {
    flex: 1 1 auto;
  }

  .metadata-item-id {
    grid-column: auto;
  }
}

@container sessions-panel (max-width: 380px) {
  .toolbar-button:not(.toolbar-button-icon) {
    width: 28px;
    padding: 0;
  }

  .toolbar-button-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .session-size {
    min-width: 0;
  }

  .component-grid,
  .metadata-grid {
    grid-template-columns: 1fr;
  }
}
</style>
