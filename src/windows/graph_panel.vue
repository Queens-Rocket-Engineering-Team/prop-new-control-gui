<script setup>
import { ref, reactive, inject, computed, watch, onMounted, onUnmounted } from 'vue'
import UPlotChart from '../components/uplot_chart.vue'
import { TELEMETRY_WINDOW_SEC, TELEMETRY_WINDOW_OPTIONS } from '../composables/useTelemetryStream.js'
import { CAPS } from '../lib/platform.js'
import { useSensorGroups } from '../composables/useSensorGroups.js'

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
const localRecordingActive = inject('localRecordingActive', ref(false))
const telemetryStats = inject('telemetryStats', ref(null))

// Rolling window displayed on every chart (seconds). Owned by App.vue because it
// also controls stream retention; written here by the toolbar picker.
const windowSec = inject('telemetryWindowSec', ref(TELEMETRY_WINDOW_SEC))

// ── Stream groups (ordered; group key comes from each device's QLCP config) ──

const { groups } = useSensorGroups(sensorData, devices)

// ── Filter state ─────────────────────────────────────────────────────────────
//
// Stored as *hidden* sets so streams that appear later (a device connecting
// mid-test) default to visible.  A group and an individual stream can each be
// hidden independently: a stream shows only when neither is hidden.

const STORAGE_KEY = 'qret-graph-stream-filter'

function loadHidden() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return {
      groups:  new Set(Array.isArray(raw.hiddenGroups)  ? raw.hiddenGroups  : []),
      streams: new Set(Array.isArray(raw.hiddenStreams) ? raw.hiddenStreams : []),
    }
  } catch {
    return { groups: new Set(), streams: new Set() }
  }
}

const _persisted    = loadHidden()
const hiddenGroups  = ref(_persisted.groups)
const hiddenStreams = ref(_persisted.streams)

watch([hiddenGroups, hiddenStreams], () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    hiddenGroups:  [...hiddenGroups.value],
    hiddenStreams: [...hiddenStreams.value],
  }))
})

function isVisible(name, groupKey) {
  return !hiddenGroups.value.has(groupKey) && !hiddenStreams.value.has(name)
}

// 'all' | 'some' | 'none' — drives the group checkbox glyph
function groupState(group) {
  if (hiddenGroups.value.has(group.key)) return 'none'
  const shown = group.streams.filter((s) => !hiddenStreams.value.has(s)).length
  if (shown === 0)                    return 'none'
  if (shown === group.streams.length) return 'all'
  return 'some'
}

/**
 * Show/hide an explicit set of streams within a group.  `names` may be a subset
 * of the group (a single row, or only the streams matching the search box), so
 * the group-level flag is expanded to per-stream flags first and collapsed back
 * again once every stream in the group ends up hidden.
 */
function setVisibility(groupKey, names, visible) {
  const full     = groups.value.find((g) => g.key === groupKey)
  const allNames = full ? full.streams : names
  const g = new Set(hiddenGroups.value)
  const s = new Set(hiddenStreams.value)

  if (g.has(groupKey)) {
    g.delete(groupKey)
    for (const n of allNames) s.add(n)
  }

  for (const n of names) {
    if (visible) s.delete(n)
    else         s.add(n)
  }

  if (allNames.length > 0 && allNames.every((n) => s.has(n))) {
    g.add(groupKey)
    for (const n of allNames) s.delete(n)
  }

  hiddenGroups.value  = g
  hiddenStreams.value = s
}

function toggleGroup(group) {
  setVisibility(group.key, group.streams, groupState(group) !== 'all')
}

function toggleStream(name, group) {
  setVisibility(group.key, [name], !isVisible(name, group.key))
}

function showAll() {
  hiddenGroups.value  = new Set()
  hiddenStreams.value = new Set()
}

function hideAll() {
  hiddenGroups.value  = new Set(groups.value.map((g) => g.key))
  hiddenStreams.value = new Set()
}

const totalStreamCount = computed(() =>
  groups.value.reduce((n, g) => n + g.streams.length, 0)
)

const visibleStreamCount = computed(() =>
  groups.value.reduce(
    (n, g) => n + g.streams.filter((s) => isVisible(s, g.key)).length,
    0
  )
)

// ── Chart tiling (height + column count) ─────────────────────────────────────
//
// Charts keep a fixed pixel height and the grid scrolls, so adding streams makes
// the list longer instead of squashing every plot.  Larger sizes deliberately
// overflow the panel — that's what forces the scroll.

const HEIGHT_KEY  = 'qret-graph-chart-height'
const COLUMNS_KEY = 'qret-graph-columns'

const CHART_HEIGHTS = [
  { label: 'S',  px: 160 },
  { label: 'M',  px: 260 },
  { label: 'L',  px: 380 },
  { label: 'XL', px: 560 },
]

const COLUMN_OPTIONS = [1, 2, 3, 4]

const DEFAULT_CHART_HEIGHT = 260
const DEFAULT_COLUMNS      = 2

function loadChartHeight() {
  const stored = Number(localStorage.getItem(HEIGHT_KEY))
  return CHART_HEIGHTS.some((h) => h.px === stored) ? stored : DEFAULT_CHART_HEIGHT
}

function loadColumns() {
  const stored = Number(localStorage.getItem(COLUMNS_KEY))
  return COLUMN_OPTIONS.includes(stored) ? stored : DEFAULT_COLUMNS
}

const chartHeight = ref(loadChartHeight())
const columns     = ref(loadColumns())

watch(chartHeight, (px) => localStorage.setItem(HEIGHT_KEY, String(px)))
watch(columns,     (n)  => localStorage.setItem(COLUMNS_KEY, String(n)))

// ── Stream picker dropdown ───────────────────────────────────────────────────

const pickerOpen = ref(false)
const pickerRoot = ref(null)
const query      = ref('')

const filteredGroups = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return groups.value
  return groups.value
    .map((g) => ({ ...g, streams: g.streams.filter((s) => s.toLowerCase().includes(q)) }))
    .filter((g) => g.streams.length > 0)
})

function onDocumentPointerDown(e) {
  if (!pickerOpen.value) return
  if (pickerRoot.value && !pickerRoot.value.contains(e.target)) pickerOpen.value = false
}

function onDocumentKeydown(e) {
  if (e.key === 'Escape') pickerOpen.value = false
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentPointerDown)
  document.addEventListener('keydown', onDocumentKeydown)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
})

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
    `Raw stream (CSV, Rust-side): ${localRecordingActive.value ? 'armed' : 'inactive'}`,
    `Stats window: ${stats.statsWindowSec.toFixed(0)}s`,
  ].join('\n')
})

const telemetryRateWarn = computed(() => {
  const stats = telemetryStats.value
  return Boolean(stats?.updatedAt && stats.displayPointHzAvg > 36)
})

// ── Sensor list — grouped with spacers to keep groups on whole rows ──────────
//
// Each group occupies complete rows: if a group does not fill its last row the
// remaining cells are blank spacers, so the next group always starts at the
// left column.

const slots = computed(() => {
  const result = []

  for (const group of groups.value) {
    const items = []

    for (const name of group.streams) {
      if (!isVisible(name, group.key)) continue
      const info = sensorData.value[name]
      if (!info) continue

      const h = Array.isArray(info.history) ? info.history : []
      const windowEnd = Number.isFinite(info.windowEnd)
        ? info.windowEnd
        : (h.length > 0 ? h[h.length - 1].t : 0)
      const windowStart = Number.isFinite(info.windowStart)
        ? info.windowStart
        : windowEnd - windowSec.value
      const windowed = h.filter((p) => p.t >= windowStart && p.t <= windowEnd)

      // Points arrive already tared from the server — never subtract an offset
      // here. `tared` only says whether an offset exists, for the button state.
      const x = []
      const y = []
      for (const p of windowed) {
        x.push(p.t - windowEnd)
        y.push(p.v)
      }

      items.push({
        name,
        groupKey:   group.key,
        groupLabel: group.label,
        unit:     info.unit,
        value:    info.value,
        tared:    (tares.value[name] ?? 0) !== 0,
        color:    group.color,
        fill:     group.color + '18',
        plotData: [x, y],
      })
    }

    if (items.length === 0) continue
    result.push(...items)

    const cols = columns.value
    const pad  = (cols - (items.length % cols)) % cols
    for (let i = 0; i < pad; i += 1) {
      result.push({ spacer: true, key: `spacer-${group.key}-${i}` })
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
  <div
    class="graph-panel"
    :style="{ '--chart-height': chartHeight + 'px', '--chart-columns': columns }"
  >
    <!-- ── Stream picker ── -->
    <div class="graph-toolbar">
      <span class="toolbar-label">Streams:</span>

      <div ref="pickerRoot" class="stream-picker">
        <button
          class="picker-trigger"
          :class="{ open: pickerOpen }"
          @click="pickerOpen = !pickerOpen"
        >
          <i class="pi pi-sliders-h" />
          <span>{{ visibleStreamCount }} / {{ totalStreamCount }}</span>
          <i class="pi" :class="pickerOpen ? 'pi-chevron-up' : 'pi-chevron-down'" />
        </button>

        <div v-if="pickerOpen" class="picker-panel">
          <div class="picker-head">
            <input
              v-model="query"
              class="picker-search"
              type="text"
              placeholder="Search streams…"
            />
            <button class="picker-action" @click="showAll">All</button>
            <button class="picker-action" @click="hideAll">None</button>
          </div>

          <div class="picker-body">
            <p v-if="filteredGroups.length === 0" class="picker-empty">
              {{ totalStreamCount === 0 ? 'No streams yet.' : 'No streams match.' }}
            </p>

            <div v-for="g in filteredGroups" :key="g.key" class="picker-group">
              <button class="picker-row picker-group-row" @click="toggleGroup(g)">
                <span
                  class="picker-check"
                  :class="`check-${groupState(g)}`"
                  :style="{ '--check-color': g.color }"
                >
                  <i
                    v-if="groupState(g) !== 'none'"
                    class="pi"
                    :class="groupState(g) === 'all' ? 'pi-check' : 'pi-minus'"
                  />
                </span>
                <span class="chip-dot" :style="{ background: g.color }" />
                <span class="picker-group-label">{{ g.label }}</span>
                <span class="picker-count">{{ g.streams.length }}</span>
              </button>

              <button
                v-for="name in g.streams"
                :key="name"
                class="picker-row picker-stream-row"
                @click="toggleStream(name, g)"
              >
                <span
                  class="picker-check"
                  :class="isVisible(name, g.key) ? 'check-all' : 'check-none'"
                  :style="{ '--check-color': g.color }"
                >
                  <i v-if="isVisible(name, g.key)" class="pi pi-check" />
                </span>
                <span class="picker-stream-name">{{ name }}</span>
                <span class="picker-unit">{{ sensorData[name]?.unit }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <span class="toolbar-label seg-label">Height:</span>
      <div class="seg-group">
        <button
          v-for="h in CHART_HEIGHTS"
          :key="h.px"
          class="seg-btn"
          :class="{ active: chartHeight === h.px }"
          :title="`${h.px}px tall charts`"
          @click="chartHeight = h.px"
        >{{ h.label }}</button>
      </div>

      <span class="toolbar-label seg-label">Cols:</span>
      <div class="seg-group">
        <button
          v-for="n in COLUMN_OPTIONS"
          :key="n"
          class="seg-btn"
          :class="{ active: columns === n }"
          :title="`${n} chart${n > 1 ? 's' : ''} per row`"
          @click="columns = n"
        >{{ n }}</button>
      </div>

      <span class="toolbar-label seg-label">Window:</span>
      <div class="seg-group">
        <button
          v-for="sec in TELEMETRY_WINDOW_OPTIONS"
          :key="sec"
          class="seg-btn"
          :class="{ active: windowSec === sec }"
          :title="`Show the last ${sec}s (widening fills in over time)`"
          @click="windowSec = sec"
        >{{ sec }}s</button>
      </div>

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
      <template v-if="totalStreamCount === 0">
        No sensor data yet — connect to a server and start a test.
      </template>
      <template v-else>
        All {{ totalStreamCount }} streams hidden — pick some in the Streams menu.
      </template>
    </div>

    <!-- ── 2-column grid ── -->
    <div v-else class="charts-grid">
      <template v-for="s in slots" :key="s.spacer ? s.key : s.name">

        <!-- Blank spacer keeps odd groups from bleeding into the next type row -->
        <div v-if="s.spacer" class="chart-spacer" />

        <!-- Chart card -->
        <div v-else class="chart-card">
          <div class="chart-header" :style="{ borderLeftColor: s.color }" :title="s.groupLabel">
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
            <UPlotChart :data="s.plotData" :color="s.color" :fill="s.fill" :window-sec="windowSec" />
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
  /* Guard: if the parent ever resolves to an auto height, height:100% collapses
     to auto and .charts-grid would grow past the window instead of scrolling.
     24px = .swap-container's padding (10px x2) + border (2px x2) in App.vue. */
  max-height: calc(100vh - 24px);
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

/* ── Tiling controls (chart height, column count) ── */

.seg-label {
  margin-left: 6px;
}

.seg-group {
  display: flex;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  overflow: hidden;
}

.seg-btn {
  min-width: 22px;
  padding: 3px 7px;
  border: none;
  border-right: 1px solid var(--border-color);
  background: var(--bg-surface);
  color: var(--text-muted);
  font-size: 0.65rem;
  font-weight: 700;
  font-family: inherit;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.seg-btn:last-child {
  border-right: none;
}

.seg-btn:hover {
  background: var(--bg-primary);
  color: var(--text-primary);
}

.seg-btn.active {
  background: var(--btn-primary-bg, #3498db);
  color: #fff;
}

/* ── Stream picker dropdown ── */

.stream-picker {
  position: relative;
}

.picker-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-weight: 600;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.picker-trigger:hover,
.picker-trigger.open {
  background: var(--bg-primary);
  color: var(--text-primary);
  border-color: var(--border-accent);
}

.picker-trigger .pi {
  font-size: 0.6rem;
}

.picker-panel {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 40;
  width: 260px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 5px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.picker-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.picker-search {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  border-radius: 3px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 0.72rem;
  font-family: inherit;
  outline: none;
}

.picker-search:focus {
  border-color: var(--border-accent);
}

.picker-action {
  padding: 3px 7px;
  border-radius: 3px;
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  color: var(--text-muted);
  font-size: 0.65rem;
  font-weight: 700;
  font-family: inherit;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.picker-action:hover {
  background: var(--bg-primary);
  color: var(--text-primary);
}

.picker-body {
  max-height: 340px;
  overflow-y: auto;
  padding: 4px 0 6px;
}

.picker-empty {
  margin: 0;
  padding: 10px;
  font-size: 0.72rem;
  color: var(--text-muted);
  font-style: italic;
  text-align: center;
}

.picker-group + .picker-group {
  border-top: 1px solid var(--border-color);
  margin-top: 3px;
  padding-top: 3px;
}

.picker-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 8px;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 0.72rem;
  text-align: left;
  cursor: pointer;
}

.picker-row:hover {
  background: var(--bg-surface);
}

.picker-group-row {
  font-weight: 700;
  color: var(--text-primary);
}

.picker-group-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-count {
  font-size: 0.62rem;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 0 5px;
  font-variant-numeric: tabular-nums;
}

.picker-stream-row {
  padding-left: 22px;
}

.picker-stream-name {
  flex: 1;
  min-width: 0;
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-unit {
  font-size: 0.62rem;
  color: var(--text-muted);
  white-space: nowrap;
}

/* Checkbox */

.picker-check {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  border-radius: 2px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  flex-shrink: 0;
  transition: background 0.12s, border-color 0.12s;
}

.picker-check .pi {
  font-size: 8px;
  color: #fff;
}

.picker-check.check-all,
.picker-check.check-some {
  background: var(--check-color);
  border-color: var(--check-color);
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
  grid-template-columns: repeat(var(--chart-columns, 2), 1fr);
  /* Rows are sized by their content (header + the fixed-height chart body) and
     never stretched or shrunk to fit the viewport — the grid scrolls instead. */
  grid-auto-rows: max-content;
  align-content: start;
  align-items: start;
  gap: 8px;
  padding: 8px;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;        /* let the grid scroll instead of growing past the panel */
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
  height: var(--chart-height, 260px);
  min-height: var(--chart-height, 260px);   /* never squashed by flex/grid sizing */
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
