<script setup>
// N2O saturation readout for the control view's P&ID.
//
// Purely informational (this is the whole design constraint): it states the
// curve, the operating point and the numbers, and renders no verdict. No state
// word, no thresholds, no warning colour, and no interaction at all - the card
// deliberately does not carry the .pid-overlay class, so it stays
// pointer-events:none and the drawing underneath keeps taking clicks.
//
// The derivation lives in useN2oSaturation.js so it can be driven from
// saturation_harness.js without stubbing the control layer.

import { computed, inject, ref } from 'vue'
import N2oSaturationChart from './n2o_saturation_chart.vue'
import {
  useN2oSaturation,
  N2O_TANK_PT,
} from '../composables/useN2oSaturation.js'

const props = defineProps({
  /** 'compact' drops a row and shortens the chart for the shallower hot-fire P&ID. */
  layout: { type: String, default: 'full' },
})

const sensorData = inject('sensorData', ref({}))
const devices = inject('devices', ref([]))

const {
  thermistorCount,
  thermistorTotal,
  tankTempC,
  tempSpreadC,
  pressurePsig,
  tSatC,
  pSatPsig,
  deltaTC,
  deltaPPsi,
  hasAnySource,
} = useN2oSaturation(sensorData, devices)

const compact = computed(() => props.layout === 'compact')

// Same rule as control_panel.vue's getLiveValue, so a pressure shown here reads
// digit-for-digit the same as the one on the PT202 card a few centimetres away.
function fmt(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs >= 1000) return v.toFixed(0)
  if (abs >= 10) return v.toFixed(1)
  return v.toFixed(2)
}

/** Signed, so which side of the curve the tank is on is readable at a glance. */
function fmtSigned(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  return (v > 0 ? '+' : '') + fmt(v)
}

const hasPt = computed(() => pressurePsig.value != null)
const hasTemp = computed(() => tankTempC.value != null)
const countLabel = computed(() => `${thermistorCount.value}/${thermistorTotal}`)
</script>

<template>
  <div v-if="hasAnySource" class="n2o-card">
    <div class="n2o-header">
      N₂O Saturation
      <span v-if="!hasPt" class="lock-badge">NO {{ N2O_TANK_PT }}</span>
      <span v-else-if="!hasTemp" class="lock-badge">NO THERMISTORS</span>
    </div>

    <N2oSaturationChart
      class="n2o-chart"
      :temp-c="tankTempC"
      :pressure-psig="pressurePsig"
      :height="compact ? 72 : 104"
    />

    <!-- Four columns: what was measured, then what the saturation curve makes of
         it. Each derived value sits in the row of the reading it was computed
         from - T_sat from pressure, P_sat from temperature - so a row reads
         "this reading implies that". Every pressure here is gauge, matching the
         PT202 card on the drawing; the maths behind them is absolute. -->
    <div class="n2o-rows">
      <div class="n2o-row">
        <span class="row-label">{{ N2O_TANK_PT }}</span>
        <span class="row-value">{{ fmt(pressurePsig) }}<span class="row-unit">psig</span></span>
        <span class="derived-label">T_sat</span>
        <span class="derived-value">{{ fmt(tSatC) }}<span class="row-unit">°C</span></span>
      </div>

      <div class="n2o-row">
        <span class="row-label">T wall avg</span>
        <span class="row-value">{{ fmt(tankTempC) }}<span class="row-unit">°C</span></span>
        <span class="derived-label">P_sat</span>
        <span class="derived-value">{{ fmt(pSatPsig) }}<span class="row-unit">psig</span></span>
      </div>

      <div class="n2o-meta">
        {{ countLabel }}<template v-if="tempSpreadC != null"> · spread {{ fmt(tempSpreadC) }} °C</template>
      </div>

      <!-- Labelled literally rather than as a bare delta. The two carry opposite
           signs by construction, and with no state word on the card these labels
           are the only thing that keeps that readable. -->
      <div class="n2o-row">
        <span class="row-label">T − T_sat</span>
        <span class="row-value">{{ fmtSigned(deltaTC) }}<span class="row-unit">°C</span></span>
        <span class="derived-label">P − P_sat</span>
        <span class="derived-value">{{ fmtSigned(deltaPPsi) }}<span class="row-unit">psi</span></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Sized in fixed px like every other P&ID card, and shrunk on tablets by the
   same --pid-card-scale (declared on #control-panel, inherited here). */
.n2o-card {
  zoom: var(--pid-card-scale, 1);
  width: 208px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  padding: 0 0 3px;
  cursor: default;
  user-select: none;
}

.n2o-header {
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-muted);
  padding: 4px 6px 3px;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

/* Same treatment the sensor cards give an absent channel: a statement that
   something is not there, not an alarm. */
.lock-badge {
  font-size: 6px;
  font-weight: 600;
  letter-spacing: 0.2px;
  border-radius: 2px;
  padding: 0 2px;
  white-space: nowrap;
  line-height: 1.1;
  color: var(--text-muted);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
}

.n2o-chart {
  width: 196px;
  margin: 3px 6px 1px;
}

/* One grid for the whole block rather than a flex row each, so the derived
   column lines up down the card. The row wrappers stay in the template for
   readability and hand their children to the grid via display: contents. */
.n2o-rows {
  display: grid;
  grid-template-columns: auto auto auto auto;
  align-items: baseline;
  column-gap: 4px;
  padding: 0 6px;
  line-height: 1.5;
}

.n2o-row {
  display: contents;
}

.row-label {
  font-size: 8px;
  color: var(--text-muted);
  white-space: nowrap;
}

/* Tabular figures everywhere: these update ~15x a second, and proportional
   digits make the card visibly breathe (and churn the overlay layout pass). */
.row-value {
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
  white-space: nowrap;
  text-align: right;
}

.row-unit {
  font-size: 7px;
  font-weight: 400;
  color: var(--text-muted);
  margin-left: 2px;
}

/* Lighter than the measured column: derived, not read. */
.derived-label {
  font-size: 7px;
  color: var(--text-muted);
  white-space: nowrap;
  text-align: right;
  padding-left: 6px;
}

.derived-value {
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  white-space: nowrap;
  text-align: right;
}

.n2o-meta {
  grid-column: 1 / -1;
  font-size: 7px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  white-space: nowrap;
}
</style>
