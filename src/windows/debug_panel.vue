<script setup>
import { inject, ref, watch, nextTick, computed, reactive, onUnmounted } from 'vue'

// ── Log source ─────────────────────────────────────────────────────────────────
const logLines  = inject('logLines',  ref([]))
const wsStatus  = inject('wsStatus',  ref('disconnected'))
const clearLogs = inject('clearLogs', () => {})
const serverIp  = inject('serverIp',  ref(''))

// Log levels emitted by the new /ws/logs format: [LEVEL] <data>
const LEVELS = [
  { key: 'DEBUG',    label: 'Debug'    },
  { key: 'INFO',     label: 'Info'     },
  { key: 'WARNING',  label: 'Warning'  },
  { key: 'ERROR',    label: 'Error'    },
  { key: 'CRITICAL', label: 'Critical' },
]

// ── Tab management ─────────────────────────────────────────────────────────────
const views = reactive([
  { id: 'v1', name: 'View 1', filters: LEVELS.map(l => l.key) }
])

const activeId = ref('v1')
let viewCounter = 2

const activeView = computed(() =>
  views.find(v => v.id === activeId.value) ?? views[0] ?? null
)

// ── Level helpers ──────────────────────────────────────────────────────────────

function extractLevel(line) {
  const m = line.match(/^\[([A-Z]+)\]/)
  if (!m) return null
  const lvl = m[1]
  // Accept any of our known levels
  return LEVELS.find(l => l.key === lvl)?.key ?? null
}

function getLineClass(line) {
  const lvl = extractLevel(line)
  return lvl ? `log-line-${lvl.toLowerCase()}` : ''
}

function toggleLevel(view, key) {
  const idx = view.filters.indexOf(key)
  if (idx === -1) view.filters.push(key)
  else view.filters.splice(idx, 1)
}

// ── Filtered lines for the active view ───────────────────────────────────────
const filteredLines = computed(() => {
  const v = activeView.value
  if (!v) return []
  if (v.filters.length === LEVELS.length) return logLines.value
  return logLines.value.filter(line => {
    const lvl = extractLevel(line)
    return lvl !== null && v.filters.includes(lvl)
  })
})

// ── Auto-scroll ───────────────────────────────────────────────────────────────
const logEl = ref(null)
watch(filteredLines, async () => {
  await nextTick()
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
}, { deep: true })

// ── Add / Remove views ────────────────────────────────────────────────────────
function addView() {
  const id = `v${Date.now()}`
  views.push({ id, name: `View ${viewCounter++}`, filters: LEVELS.map(l => l.key) })
  activeId.value = id
}

function removeView(id) {
  if (views.length <= 1) return
  const idx = views.findIndex(v => v.id === id)
  if (idx !== -1) views.splice(idx, 1)
  if (activeId.value === id) activeId.value = views[0]?.id ?? null
}

// ── Rename ────────────────────────────────────────────────────────────────────
const editingId   = ref(null)
const editingName = ref('')

function startRename(v) {
  editingId.value   = v.id
  editingName.value = v.name
}

function commitRename(v) {
  if (editingName.value.trim()) v.name = editingName.value.trim()
  editingId.value = null
}

// ── WS status ──────────────────────────────────────────────────────────────────
const statusClass = computed(() => {
  const s = wsStatus
  return (s && typeof s === 'object' && 'value' in s) ? s.value : s
})

// ── Server metrics tab ─────────────────────────────────────────────────────────
// Pinned tab that polls /v1/metrics every second while active. recent_events
// renders as a scrollable table; every other section is flattened into sorted
// path→value tables.
const METRICS_TAB_ID = '__metrics__'

const metricsData      = ref(null)
const metricsError     = ref(null)
const metricsFetchedAt = ref(null)
let metricsTimer = null

const metricsHost = computed(() => {
  const ip = serverIp.value
  if (!ip) return null
  return ip === 'localhost' ? '127.0.0.1' : ip
})

async function fetchMetrics() {
  if (!metricsHost.value) {
    metricsError.value = 'No server IP set'
    return
  }
  try {
    const res = await fetch(`http://${metricsHost.value}:8000/v1/metrics`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    metricsData.value = await res.json()
    metricsError.value = null
    metricsFetchedAt.value = Date.now()
  } catch (e) {
    metricsError.value = String(e?.message ?? e)
  }
}

function stopMetricsPolling() {
  if (metricsTimer !== null) {
    clearInterval(metricsTimer)
    metricsTimer = null
  }
}

function startMetricsPolling() {
  stopMetricsPolling()
  fetchMetrics()
  metricsTimer = setInterval(fetchMetrics, 1000)
}

watch(activeId, (id) => {
  if (id === METRICS_TAB_ID) startMetricsPolling()
  else stopMetricsPolling()
}, { immediate: true })
onUnmounted(stopMetricsPolling)

function flattenMetrics(obj, prefix, rows) {
  for (const [key, value] of Object.entries(obj ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flattenMetrics(value, path, rows)
    } else {
      rows.push([path, value])
    }
  }
}

const metricsSections = computed(() => {
  const data = metricsData.value
  if (!data) return []
  const sections = []
  for (const [name, value] of Object.entries(data)) {
    if (name === 'recent_events') continue
    const rows = []
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flattenMetrics(value, '', rows)
    } else {
      rows.push(['value', value])
    }
    rows.sort((a, b) => a[0].localeCompare(b[0]))
    sections.push({ name, rows })
  }
  sections.sort((a, b) => a.name.localeCompare(b.name))
  return sections
})

// Newest first — the server appends chronologically.
const recentEvents = computed(() => {
  const events = metricsData.value?.recent_events
  if (!Array.isArray(events)) return []
  return [...events].reverse()
})

function fmtEventTime(ms) {
  if (!Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  return `${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

function fmtMetricValue(path, v) {
  if (typeof v === 'number') {
    if (path.endsWith('_unix_ms')) return new Date(v).toLocaleString()
    if (Number.isInteger(v)) return String(v)
    return Math.abs(v) >= 1000 ? v.toFixed(1) : v.toPrecision(4)
  }
  if (Array.isArray(v)) return v.join(', ')
  if (v == null) return '—'
  return String(v)
}

const EVENT_FIXED_KEYS = new Set(['at_unix_ms', 'kind', 'severity', 'message'])
function eventExtras(ev) {
  return Object.entries(ev)
    .filter(([k]) => !EVENT_FIXED_KEYS.has(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
}
</script>

<template>
  <div class="debug-panel">

    <!-- ── Tab bar ── -->
    <div class="tab-bar">
      <div
        v-for="v in views"
        :key="v.id"
        class="tab"
        :class="{ 'tab-active': v.id === activeId }"
        @click="activeId = v.id"
      >
        <input
          v-if="editingId === v.id"
          class="tab-rename-input"
          v-model="editingName"
          @blur="commitRename(v)"
          @keydown.enter="commitRename(v)"
          @keydown.escape="editingId = null"
          @click.stop
        />
        <span
          v-else
          class="tab-name"
          @dblclick.stop="startRename(v)"
          title="Double-click to rename"
        >{{ v.name }}</span>

        <button
          v-if="views.length > 1"
          class="tab-close"
          @click.stop="removeView(v.id)"
          title="Remove view"
        >x</button>
      </div>

      <button class="add-tab-btn" @click="addView" title="Add view">+</button>

      <div
        class="tab metrics-tab"
        :class="{ 'tab-active': activeId === METRICS_TAB_ID }"
        @click="activeId = METRICS_TAB_ID"
      >
        <span class="tab-name">Metrics</span>
      </div>
    </div>

    <!-- ── Server metrics view ── -->
    <template v-if="activeId === METRICS_TAB_ID">
      <div class="debug-toolbar">
        <span class="ws-status" :class="metricsError ? 'error' : 'connected'">
          <span class="ws-led" />
          {{ metricsError ? metricsError : (metricsFetchedAt ? `updated ${fmtEventTime(metricsFetchedAt)}` : 'loading…') }}
        </span>
      </div>

      <div class="metrics-body">
        <div class="metrics-section">
          <h3 class="metrics-heading">recent_events</h3>
          <div class="events-scroll">
            <table class="metrics-table">
              <thead>
                <tr><th>Time</th><th>Severity</th><th>Kind</th><th>Message</th><th>Details</th></tr>
              </thead>
              <tbody>
                <tr v-if="recentEvents.length === 0">
                  <td colspan="5" class="metrics-muted">No recent events</td>
                </tr>
                <tr
                  v-for="(ev, i) in recentEvents"
                  :key="`${ev.at_unix_ms}-${i}`"
                  :class="`event-${ev.severity}`"
                >
                  <td class="metrics-mono">{{ fmtEventTime(ev.at_unix_ms) }}</td>
                  <td>{{ ev.severity }}</td>
                  <td class="metrics-mono">{{ ev.kind }}</td>
                  <td>{{ ev.message }}</td>
                  <td class="metrics-muted">{{ eventExtras(ev) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-for="section in metricsSections" :key="section.name" class="metrics-section">
          <h3 class="metrics-heading">{{ section.name }}</h3>
          <table class="metrics-table">
            <thead>
              <tr><th>Metric</th><th>Value</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in section.rows" :key="row[0]">
                <td class="metrics-mono">{{ row[0] }}</td>
                <td class="metrics-mono metrics-value">{{ fmtMetricValue(row[0], row[1]) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="!metricsData && !metricsError" class="metrics-muted">Waiting for first metrics fetch…</div>
      </div>
    </template>

    <!-- ── Filter toolbar ── -->
    <div v-if="activeId !== METRICS_TAB_ID" class="debug-toolbar">
      <span class="ws-status" :class="statusClass">
        <span class="ws-led" />
        {{ statusClass }}
      </span>

      <div class="level-filter">
        <button
          v-for="lvl in LEVELS"
          :key="lvl.key"
          class="level-pill"
          :class="[`lvl-${lvl.key.toLowerCase()}`, { 'lvl-active': activeView && activeView.filters.includes(lvl.key) }]"
          @click="activeView && toggleLevel(activeView, lvl.key)"
        >{{ lvl.label }}</button>
      </div>

      <button class="clear-btn" @click="clearLogs()">Clear</button>
    </div>

    <!-- ── Log output ── -->
    <div v-if="activeId !== METRICS_TAB_ID" class="log-output" ref="logEl">
      <div v-if="filteredLines.length === 0" class="log-empty">
        No log output yet…
      </div>
      <div
        v-for="(line, i) in filteredLines"
        :key="i"
        :class="['log-line', getLineClass(line)]"
      >{{ line }}</div>
    </div>

  </div>
</template>

<style scoped>
.debug-panel {
  display: flex;
  flex-direction: column;
  height: 100vh;
  max-height: 100vh;
  background: var(--bg-primary);
  font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
  color: var(--text-primary, #c9d1d9);
}

/* ── Tab bar ── */
.tab-bar {
  display: flex;
  align-items: stretch;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
  flex-shrink: 0;
  scrollbar-width: none;
}
.tab-bar::-webkit-scrollbar { display: none; }

.tab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px 5px 10px;
  font-size: 0.72rem;
  color: var(--text-muted);
  cursor: pointer;
  white-space: nowrap;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, background 0.15s;
  user-select: none;
}
.tab:hover { color: var(--text-primary); background: var(--bg-secondary); }
.tab-active { color: var(--text-primary); background: var(--bg-primary, #0d1117); border-bottom-color: #58a6ff; }

.tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
  color: var(--text-primary);
}

.tab-rename-input {
  font-family: inherit;
  font-size: inherit;
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid #58a6ff;
  border-radius: 3px;
  padding: 1px 4px;
  width: 90px;
  outline: none;
}

.tab-close {
  background: none;
  border: none;
  color: var(--text-muted, #8b949e);
  cursor: pointer;
  font-size: 0.9rem;
  line-height: 1;
  padding: 0 2px;
  border-radius: 3px;
  opacity: 0.5;
  transition: opacity 0.15s, color 0.15s;
}
.tab-close:hover { opacity: 1; color: #e74c3c; }

.add-tab-btn {
  display: flex;
  align-items: center;
  padding: 0 10px;
  background: none;
  border: none;
  color: var(--text-muted, #8b949e);
  font-size: 1rem;
  cursor: pointer;
  transition: color 0.15s;
  flex-shrink: 0;
}
.add-tab-btn:hover { color: #58a6ff; }

/* ── Toolbar ── */
.debug-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border-color, #30363d);
  background: var(--bg-secondary, #161b22);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.ws-status {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted, #8b949e);
  flex-shrink: 0;
}
.ws-led { width: 7px; height: 7px; border-radius: 50%; background: #555; }
.ws-status.connected   { color: #2ecc71; }
.ws-status.connected .ws-led   { background: #2ecc71; box-shadow: 0 0 4px #2ecc71; }
.ws-status.connecting  { color: #f39c12; }
.ws-status.connecting .ws-led  { background: #f39c12; }
.ws-status.error       { color: #e74c3c; }
.ws-status.error .ws-led       { background: #e74c3c; }
.ws-status.disconnected .ws-led { background: #555; }

/* ── Level filter pills ── */
.level-filter {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.level-pill {
  font-family: inherit;
  font-size: 0.7rem;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.level-pill:hover { border-color: #8b949e; color: #c9d1d9; }

.lvl-debug.lvl-active    { color: var(--text-muted); border-color: #8b949e; }
.lvl-info.lvl-active     { color: #2ecc71;  border-color: #2ecc71; }
.lvl-warning.lvl-active  { color: #f39c12;  border-color: #f39c12; }
.lvl-error.lvl-active    { color: #e74c3c;  border-color: #e74c3c; }
.lvl-critical.lvl-active { color: #e74c3c;  border-color: #e74c3c; font-weight: 700; }

/* ── Clear ── */
.clear-btn {
  font-size: 0.7rem;
  padding: 2px 9px;
  background: transparent;
  color: var(--text-muted, #8b949e);
  border: 1px solid var(--border-color, #30363d);
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
  flex-shrink: 0;
  transition: color 0.12s, border-color 0.12s;
  margin-left: auto;
}
.clear-btn:hover { color: #e74c3c; border-color: #e74c3c; }

/* ── Log output ── */
.log-output {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 8px 10px;
  font-size: 0.78rem;
  line-height: 1.6;
  background: var(--bg-primary, #0d1117);
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: #30363d transparent;
}

.log-empty { color: var(--text-muted, #8b949e); font-style: italic; }

.log-line {
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-primary, #c9d1d9);
  padding: 1px 4px;
  border-radius: 2px;
}
.log-line:hover { background: var(--bg-secondary, #161b22); }

/* Per-level colours */
.log-line-debug    { color: var(--text-muted, #8b949e); }
.log-line-info     { color: #2ecc71; }
.log-line-warning  { color: #f39c12; }
.log-line-error    { color: #e74c3c; font-weight: 600; }
.log-line-critical { color: #e74c3c; font-weight: 700; background: rgba(231,76,60,0.08); }

/* ── Server metrics tab ── */
.metrics-tab {
  margin-left: auto;
  border-left: 1px solid var(--border-color, #30363d);
}

.metrics-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 10px 12px;
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: #30363d transparent;
}

.metrics-section { margin-bottom: 16px; }

.metrics-heading {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #58a6ff;
  margin: 0 0 4px 0;
}

.metrics-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.72rem;
  line-height: 1.5;
}

.metrics-table th {
  text-align: left;
  font-weight: 600;
  color: var(--text-muted, #8b949e);
  padding: 3px 10px 3px 4px;
  border-bottom: 1px solid var(--border-color, #30363d);
  position: sticky;
  top: 0;
  background: var(--bg-primary, #0d1117);
  white-space: nowrap;
}

.metrics-table td {
  padding: 2px 10px 2px 4px;
  border-bottom: 1px solid rgba(48, 54, 61, 0.5);
  vertical-align: top;
  word-break: break-word;
}
.metrics-table tbody tr:hover { background: var(--bg-secondary, #161b22); }

.metrics-mono  { font-family: inherit; white-space: nowrap; }
.metrics-value { text-align: right; white-space: nowrap; }
.metrics-table td.metrics-value { width: 1%; }
.metrics-muted { color: var(--text-muted, #8b949e); font-style: italic; }

/* recent_events: bounded, independently scrollable table */
.events-scroll {
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid var(--border-color, #30363d);
  border-radius: 4px;
  scrollbar-width: thin;
  scrollbar-color: #30363d transparent;
}
.events-scroll .metrics-table td { white-space: normal; }
.events-scroll .metrics-table td.metrics-mono { white-space: nowrap; }

.event-warning  td { color: #f39c12; }
.event-error    td { color: #e74c3c; }
.event-critical td { color: #e74c3c; font-weight: 700; }
</style>
