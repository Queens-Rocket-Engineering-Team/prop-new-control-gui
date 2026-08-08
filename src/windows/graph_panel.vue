<script setup>
import { ref, reactive, inject, computed, onUnmounted } from 'vue'
import UPlotChart from '../components/uplot_chart.vue'
import { TELEMETRY_WINDOW_SEC } from '../composables/useTelemetryStream.js'
import { CAPS } from '../lib/platform.js'

const sensorData    = inject('sensorData',    ref({}))
const devices       = inject('devices',       ref([]))
const tares         = inject('tares',         ref({}))
const setTare       = inject('setTare',       () => Promise.resolve())
const clearTare     = inject('clearTare',     () => Promise.resolve())

// Tares are server state and are applied to what every client displays, so a
// pad tablet setting one would silently change the numbers launch control reads
// off its screen. The view-only build shows tared values but cannot change them.
const canTare = CAPS.tares
const testFrequency = inject('testFrequency', ref(190))
const testActive    = inject('testActive',    ref(false))
const telemetryStats = inject('telemetryStats', ref(null))

const WINDOW_SEC = TELEMETRY_WINDOW_SEC  // rolling window displayed on every chart (seconds)

// ── Type metadata (defines display order) ───────────────────────────────────

const TYPES = [
  { key: 'PT',    label: 'Pressure',    color: '#3498db' },
  { key: 'TC',    label: 'Temperature', color: '#e74c3c' },
  { key: 'LC',    label: 'Load Cell',   color: '#2ecc71' },
  { key: 'OTHER', label: 'Other',       color: '#9b59b6' },
]

const TYPE_MAP   = Object.fromEntries(TYPES.map((t) => [t.key, t]))
const TYPE_ORDER = Object.fromEntries(TYPES.map((t, i) => [t.key, i]))

function getTypeKey(name) {
  const u = name.toUpperCase()
  if (u.startsWith('PT')) return 'PT'
  if (u.startsWith('TC')) return 'TC'
  if (u.startsWith('LC')) return 'LC'
  return 'OTHER'
}

// ── Filter state ─────────────────────────────────────────────────────────────

const selectedTypes = ref(new Set(['PT', 'TC', 'LC', 'OTHER']))

function toggleType(key) {
  const s = new Set(selectedTypes.value)
  if (s.has(key)) { if (s.size > 1) s.delete(key) }
  else s.add(key)
  selectedTypes.value = s
}

function fmtHz(v) {
  return Number.isFinite(v) && v > 0 ? v.toFixed(1) : '--'
}

const telemetryRateLabel = computed(() => {
  const stats = telemetryStats.value
  if (!stats?.updatedAt) return 'display -- Hz / pts -- Hz'
  return `display ${fmtHz(stats.displayBatchHz)} Hz / pts ${fmtHz(stats.displayPointHzAvg)} Hz`
})

const telemetryRateTitle = computed(() => {
  const stats = telemetryStats.value
  if (!stats?.updatedAt) return 'Waiting for telemetry display batches'
  return [
    `Display batches: ${fmtHz(stats.displayBatchHz)} Hz`,
    `Plotted points per sensor: avg ${fmtHz(stats.displayPointHzAvg)} Hz, max ${fmtHz(stats.displayPointHzMax)} Hz`,
    `Unique point timestamps per sensor: avg ${fmtHz(stats.displayTimestampHzAvg)} Hz, max ${fmtHz(stats.displayTimestampHzMax)} Hz`,
    `Incoming points per sensor: avg ${fmtHz(stats.incomingPointHzAvg)} Hz, max ${fmtHz(stats.incomingPointHzMax)} Hz`,
    `Incoming points per sensor per batch: ${stats.incomingPointsPerSensorBatchAvg.toFixed(2)}`,
    `Raw stream (CSV, Rust-side): ${testActive.value ? 'active' : 'inactive'}`,
    `Stats window: ${stats.statsWindowSec.toFixed(0)}s`,
  ].join('\n')
})

const telemetryRateWarn = computed(() => {
  const stats = telemetryStats.value
  return Boolean(stats?.updatedAt && stats.displayPointHzAvg > 36)
})

// ── Sensor list — grouped by type with spacers for odd-count groups ──────────
//
// Grid is 2 columns.  Each type group occupies complete rows: if a group has
// an odd number of sensors the last cell in that group is a blank spacer so
// the next type always starts at the left column.

const slots = computed(() => {
  // 1. Group sensors by type, filter to selectedTypes
  const groups = {}
  for (const typeEntry of TYPES) groups[typeEntry.key] = []

  for (const [name, info] of Object.entries(sensorData.value)) {
    const typeKey = getTypeKey(name)
    if (!selectedTypes.value.has(typeKey)) continue

    const h = Array.isArray(info.history) ? info.history : []
    const windowEnd = Number.isFinite(info.windowEnd)
      ? info.windowEnd
      : (h.length > 0 ? h[h.length - 1].t : 0)
    const windowStart = Number.isFinite(info.windowStart)
      ? info.windowStart
      : windowEnd - WINDOW_SEC
    const windowed = h.filter((p) => p.t >= windowStart && p.t <= windowEnd)

    // Points arrive already tared from the server — never subtract an offset here.
    const color = TYPE_MAP[typeKey].color
    const x = []
    const y = []
    for (const p of windowed) {
      x.push(p.t - windowEnd)
      y.push(p.v)
    }

    groups[typeKey].push({
      name,
      typeKey,
      unit:  info.unit,
      value: info.value,
      tared: (tares.value[name] ?? 0) !== 0,
      color,
      fill: color + '18',
      plotData: [x, y],
    })
  }

  // 2. Sort within each group alphabetically
  for (const items of Object.values(groups)) {
    items.sort((a, b) => a.name.localeCompare(b.name))
  }

  // 3. Build slot list in type order; pad odd-count groups with a spacer
  const result = []
  for (const { key } of TYPES) {
    const items = groups[key]
    if (!items || items.length === 0) continue
    result.push(...items)
    if (items.length % 2 === 1) {
      result.push({ spacer: true, key: `spacer-${key}` })
    }
  }

  return result
})

function fmt(v) {
  if (v == null) return '—'
  const abs = Math.abs(v)
  if (abs >= 1000) return v.toFixed(0)
  if (abs >= 10)   return v.toFixed(1)
  return v.toFixed(2)
}

// ── Tare ─────────────────────────────────────────────────────────────────────
//
// Tares live on the server: it captures the offset by averaging its own recent
// raw samples, applies it before fanning telemetry out, and broadcasts the
// change to every connected GUI over /ws/state. So these handlers only fire the
// request — `tares` updates itself, and the T-button state follows.
//
// Clicking an inactive T captures a tare; clicking an active one clears it,
// which matters more than it used to: the server keeps offsets across a device
// disconnect (deliberately, so flight handoff carries them), so nothing removes
// an offset automatically any more.

const tarePending = reactive({})   // sensorName → true while a request is in flight
const tareNotice  = ref(null)      // { text, kind: 'ok'|'error' }
const tareChoice  = ref(null)      // { name, candidates: string[] } — 409 device picker

let noticeTimer = null

function notify(text, kind = 'ok') {
  tareNotice.value = { text, kind }
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { tareNotice.value = null }, 6000)
}

onUnmounted(() => clearTimeout(noticeTimer))

function errText(err) {
  const d = err?.detail
  if (typeof d === 'string') return d
  if (d) return JSON.stringify(d)
  return err?.message ?? String(err)
}

// Connected devices reporting this exact sensor name. The server matches names
// exactly, so this mirrors the set it considers ambiguous.
function candidateDevices(sensorName) {
  const names = []
  for (const dev of devices.value) {
    if (dev.connected === false) continue
    if ((dev.sensors ?? []).some(s => s.name === sensorName)) names.push(dev.name)
  }
  return names
}

async function runTare(name, opts) {
  if (tarePending[name]) return
  tarePending[name] = true
  try {
    const info    = await setTare(name, opts)
    const applies = Array.isArray(info?.applies_to) ? info.applies_to : []
    tareChoice.value = null
    notify(applies.length ? `Tared ${name} on ${applies.join(', ')}` : `Tared ${name}`)
  } catch (err) {
    // 409 covers both "sensor not reported in the last 2 s" and "two devices
    // report this name". Only the latter is recoverable, and only by asking —
    // picking the wrong device would capture the offset off the wrong sensor.
    if (err?.status === 409) {
      const candidates = candidateDevices(name)
      if (candidates.length > 1) {
        tareChoice.value = { name, candidates }
        notify(`${name} is reported by ${candidates.join(' and ')} — choose which to tare from`, 'error')
        return
      }
    }
    notify(`Tare ${name} failed — ${errText(err)}`, 'error')
  } finally {
    delete tarePending[name]
  }
}

async function runClearTare(name) {
  if (tarePending[name]) return
  tarePending[name] = true
  try {
    await clearTare(name)
    tareChoice.value = null
    notify(`Cleared tare on ${name}`)
  } catch (err) {
    notify(`Clearing tare on ${name} failed — ${errText(err)}`, 'error')
  } finally {
    delete tarePending[name]
  }
}

function onTareClick(s) {
  if (tareChoice.value?.name === s.name) { tareChoice.value = null; return }
  return s.tared ? runClearTare(s.name) : runTare(s.name)
}

function tareTitle(s) {
  if (!s.tared) return 'Tare — server captures and zeroes at the current value'
  return `Tared (offset ${fmt(tares.value[s.name])}) — click to clear`
}
</script>

<template>
  <div class="graph-panel">
    <!-- ── Type filter chips ── -->
    <div class="graph-toolbar">
      <span class="toolbar-label">Filter:</span>
      <button
        v-for="t in TYPES"
        :key="t.key"
        class="type-chip"
        :class="{ active: selectedTypes.has(t.key) }"
        :style="selectedTypes.has(t.key) ? { '--chip-color': t.color } : {}"
        @click="toggleType(t.key)"
      >
        <span class="chip-dot" :style="{ background: t.color }" />
        {{ t.label }}
      </button>

      <!-- ── Centred frequency badge ── -->
      <div class="freq-badge" :class="{ 'freq-badge--active': testActive }">
        <span class="freq-badge-value">{{ testFrequency }}</span>
        <span class="freq-badge-unit"> Hz</span>
      </div>

      <span
        class="telemetry-rate"
        :class="{ 'telemetry-rate--warn': telemetryRateWarn }"
        :title="telemetryRateTitle"
      >{{ telemetryRateLabel }}</span>
      <span class="window-label">{{ WINDOW_SEC }}s window</span>
    </div>

    <!-- Tare result / failure — server-side tares affect every connected GUI,
         so the outcome is worth stating rather than logging to the console. -->
    <div
      v-if="tareNotice"
      class="tare-notice"
      :class="{ 'tare-notice--error': tareNotice.kind === 'error' }"
    >{{ tareNotice.text }}</div>

    <!-- ── Empty state ── -->
    <div v-if="slots.length === 0" class="no-data">
      No sensor data yet — connect to a server and start a test.
    </div>

    <!-- ── 2-column grid ── -->
    <div v-else class="charts-grid">
      <template v-for="s in slots" :key="s.spacer ? s.key : s.name">

        <!-- Blank spacer keeps odd groups from bleeding into the next type row -->
        <div v-if="s.spacer" class="chart-spacer" />

        <!-- Chart card -->
        <div v-else class="chart-card">
          <div class="chart-header" :style="{ borderLeftColor: TYPE_MAP[s.typeKey].color }">
            <span class="chart-name">{{ s.name }}</span>
            <span class="chart-value">
              {{ fmt(s.value) }}<span class="chart-unit"> {{ s.unit }}</span>
            </span>
            <button
              v-if="canTare"
              class="tare-btn"
              :class="{ 'tare-active': s.tared }"
              :disabled="!!tarePending[s.name]"
              :title="tareTitle(s)"
              @click="onTareClick(s)"
            >T</button>
          </div>

          <!-- Two devices report this sensor name (flight handoff) — the server
               will not guess which one to sample, so the operator picks. -->
          <div v-if="tareChoice?.name === s.name" class="tare-choice">
            <span class="tare-choice-label">Tare from</span>
            <button
              v-for="d in tareChoice.candidates"
              :key="d"
              class="tare-choice-btn"
              @click="runTare(s.name, { deviceName: d })"
            >{{ d }}</button>
            <button class="tare-choice-btn tare-choice-cancel" @click="tareChoice = null">✕</button>
          </div>

          <div class="chart-body">
            <UPlotChart :data="s.plotData" :color="s.color" :fill="s.fill" :window-sec="WINDOW_SEC" />
          </div>
        </div>

      </template>
    </div>
  </div>
</template>

<style scoped>
.graph-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  box-sizing: border-box;
}

/* ── Toolbar ── */

.graph-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  flex-wrap: wrap;
  position: relative;
}

.toolbar-label {
  font-size: 0.72rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.window-label {
  font-size: 0.68rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.telemetry-rate {
  margin-left: auto;
  font-size: 0.68rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.telemetry-rate--warn {
  color: #e67e22;
  font-weight: 700;
}

/* ── Centred test-frequency badge ── */

.freq-badge {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: baseline;
  gap: 1px;
  pointer-events: none;
  white-space: nowrap;
}

.freq-badge-value {
  font-size: 0.72rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  letter-spacing: 0.02em;
}

.freq-badge-unit {
  font-size: 0.65rem;
  color: var(--text-muted);
}

.freq-badge--active .freq-badge-value,
.freq-badge--active .freq-badge-unit {
  color: #3498db;
}

.type-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  color: var(--text-muted);
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  font-family: inherit;
}

.type-chip.active {
  background: color-mix(in srgb, var(--chip-color) 15%, transparent);
  border-color: var(--chip-color);
  color: var(--text-primary);
}

.chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* ── Empty state ── */

.no-data {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  font-size: 0.85rem;
  color: var(--text-muted);
  font-style: italic;
}

/* ── 2-column grid ── */

.charts-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  padding: 8px;
  overflow-y: auto;
  flex: 1;
  align-content: start;
  box-sizing: border-box;
}

/* Spacer occupies one grid cell but is invisible */
.chart-spacer {
  visibility: hidden;
}

/* ── Chart card ── */

.chart-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 5px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.chart-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 4px 8px 3px 7px;
  border-bottom: 1px solid var(--border-color);
  border-left: 3px solid transparent;
  flex-shrink: 0;
}

.chart-name {
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-primary);
  text-transform: uppercase;
}

.chart-value {
  font-size: 0.8rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}

.chart-unit {
  font-size: 0.6rem;
  font-weight: 400;
  color: var(--text-muted);
}

/* ── Tare button ── */

.tare-btn {
  padding: 0 4px;
  height: 14px;
  border-radius: 2px;
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  color: var(--text-muted);
  font-size: 8px;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  letter-spacing: 0.05em;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.tare-btn:hover {
  background: var(--bg-primary);
  color: var(--text-primary);
}

.tare-btn.tare-active {
  border-color: #e67e22;
  color: #e67e22;
}

.tare-btn:disabled {
  opacity: 0.5;
  cursor: progress;
}

/* ── Tare notice + ambiguity picker ── */

.tare-notice {
  flex-shrink: 0;
  padding: 4px 10px;
  font-size: 0.7rem;
  font-weight: 600;
  color: #2ecc71;
  background: color-mix(in srgb, #2ecc71 10%, transparent);
  border-bottom: 1px solid var(--border-color);
}

.tare-notice--error {
  color: #e67e22;
  background: color-mix(in srgb, #e67e22 12%, transparent);
}

.tare-choice {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  padding: 4px 7px;
  border-bottom: 1px solid var(--border-color);
  background: color-mix(in srgb, #e67e22 10%, transparent);
}

.tare-choice-label {
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.tare-choice-btn {
  padding: 1px 6px;
  border-radius: 2px;
  border: 1px solid #e67e22;
  background: var(--bg-surface);
  color: #e67e22;
  font-size: 0.62rem;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
}

.tare-choice-btn:hover {
  background: #e67e22;
  color: var(--bg-primary);
}

.tare-choice-cancel {
  margin-left: auto;
  border-color: var(--border-color);
  color: var(--text-muted);
}

.tare-choice-cancel:hover {
  background: var(--bg-primary);
  color: var(--text-primary);
}

/* ── Chart canvas ── */

.chart-body {
  height: 110px;
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
}

.chart-body :deep(.uplot-chart) {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.chart-body :deep(canvas) {
  display: block;
}
</style>
