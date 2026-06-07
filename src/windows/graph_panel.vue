<script setup>
import { ref, inject, computed } from 'vue'
import Chart from 'primevue/chart'

const sensorData    = inject('sensorData',    ref({}))
const tares         = inject('tares',         ref({}))
const setTare       = inject('setTare',       () => {})
const testFrequency = inject('testFrequency', ref(190))
const testActive    = inject('testActive',    ref(false))

const WINDOW_SEC = 30  // rolling window displayed on every chart (seconds)

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

// ── Chart options ────────────────────────────────────────────────────────────

const chartOptions = {
  animation: false,
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      mode: 'index',
      intersect: false,
      callbacks: { title: (items) => `t = ${items[0]?.label ?? ''}s` },
    },
  },
  scales: {
    x: {
      ticks: { maxTicksLimit: 4, font: { size: 8 }, color: 'rgba(128,128,128,0.8)' },
      grid:  { color: 'rgba(128,128,128,0.12)' },
    },
    y: {
      ticks: { maxTicksLimit: 4, font: { size: 8 }, color: 'rgba(128,128,128,0.8)' },
      grid:  { color: 'rgba(128,128,128,0.12)' },
      // Ratchet: afterDataLimits runs on every chart.update() call.
      // Chart.js has already computed scale.min/max from visible data;
      // we store the running extremes on the chart instance and only
      // allow bounds to expand, never shrink. This prevents the y-axis
      // from oscillating as points enter/leave the rolling window.
      afterDataLimits(scale) {
        if (!isFinite(scale.min) || !isFinite(scale.max)) return
        const r = scale.chart._yRatchet
        if (!r) {
          scale.chart._yRatchet = { min: scale.min, max: scale.max }
        } else {
          r.min = Math.min(r.min, scale.min)
          r.max = Math.max(r.max, scale.max)
          scale.min = r.min
          scale.max = r.max
        }
      },
    },
  },
  elements: {
    point: { radius: 0 },
    line:  { borderWidth: 1.5 },
  },
}

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

    const h      = info.history
    const maxT   = h.length > 0 ? h[h.length - 1].t : 0
    const cutoff = maxT - WINDOW_SEC
    const windowed = h.filter((p) => p.t >= cutoff)

    const color  = TYPE_MAP[typeKey].color
    const offset = tares.value[name] ?? 0

    // Keep the label array at a constant length equal to a full 30 s window.
    // Without this, the array grows from 0 → ~600 entries during the first
    // 30 s after connect, causing Chart.js to recalculate tick positions on
    // every frame (visible axis oscillation). Padding with equally-spaced
    // timestamps and null values fills from the left so real data enters
    // from the right, and tick positions are stable from the first frame.
    const spacing  = windowed.length > 1
      ? (windowed[windowed.length - 1].t - windowed[0].t) / (windowed.length - 1)
      : 0.05  // fallback: 20 Hz
    const leadGap  = windowed.length > 0 ? Math.max(0, windowed[0].t - cutoff) : WINDOW_SEC
    const padCount = spacing > 0 ? Math.round(leadGap / spacing) : 0

    const labels = [
      ...Array.from({ length: padCount }, (_, i) => (cutoff + (i + 1) * spacing).toFixed(1)),
      ...windowed.map((p) => p.t.toFixed(1)),
    ]
    const values = [
      ...Array(padCount).fill(null),
      ...windowed.map((p) => p.v - offset),
    ]

    groups[typeKey].push({
      name,
      typeKey,
      unit:     info.unit,
      rawValue: info.value,
      value:    info.value - offset,
      data: {
        labels,
        datasets: [{
          data:            values,
          borderColor:     color,
          backgroundColor: color + '18',
          fill:            true,
          borderWidth:     1.5,
          pointRadius:     0,
          tension:         0.1,
          spanGaps:        false,
        }],
      },
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

      <span class="window-label">{{ WINDOW_SEC }}s window</span>
    </div>

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
              class="tare-btn"
              :class="{ 'tare-active': (tares[s.name] ?? 0) !== 0 }"
              @click="setTare(s.name, s.rawValue)"
              title="Tare (zero at current value)"
            >T</button>
          </div>
          <div class="chart-body">
            <Chart type="line" :data="s.data" :options="chartOptions" />
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
  margin-left: auto;
  font-size: 0.68rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
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

/* ── Chart canvas ── */

.chart-body {
  height: 110px;
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
}

.chart-body :deep(.p-chart) {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.chart-body :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
}
</style>
