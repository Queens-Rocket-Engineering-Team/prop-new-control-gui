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
  pressurePsia,
  tSatC,
  pSatPsia,
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
      :pressure-psia="pressurePsia"
      :height="compact ? 72 : 104"
    />

    <div class="n2o-rows">
      <div class="n2o-row">
        <span class="row-label">{{ N2O_TANK_PT }}</span>
        <span class="row-value">{{ fmt(pressurePsia) }}<span class="row-unit">psia</span></span>
        <span class="row-aside">{{ fmt(pressurePsig) }} psig</span>
      </div>

      <div class="n2o-row">
        <span class="row-label">T wall avg</span>
        <span class="row-value">{{ fmt(tankTempC) }}<span class="row-unit">°C</span></span>
        <span class="row-aside">
          {{ countLabel }}<template v-if="tempSpreadC != null"> · sp {{ fmt(tempSpreadC) }}</template>
        </span>
      </div>

      <div class="n2o-row">
        <span class="row-label">T_sat(P)</span>
        <span class="row-value">{{ fmt(tSatC) }}<span class="row-unit">°C</span></span>
        <span v-if="compact" class="row-aside">{{ fmt(pSatPsia) }} psia</span>
      </div>

      <div v-if="!compact" class="n2o-row">
        <span class="row-label">P_sat(T)</span>
        <span class="row-value">{{ fmt(pSatPsia) }}<span class="row-unit">psia</span></span>
      </div>

      <!-- Labelled literally rather than as a bare delta. The two carry opposite
           signs by construction, and with no state word on the card these labels
           are the only thing that keeps that readable. -->
      <div class="n2o-row">
        <span class="row-label">T − T_sat</span>
        <span class="row-value">{{ fmtSigned(deltaTC) }}<span class="row-unit">°C</span></span>
        <span class="row-aside">P − P_sat {{ fmtSigned(deltaPPsi) }}</span>
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

.n2o-rows {
  padding: 0 6px;
}

.n2o-row {
  display: flex;
  align-items: baseline;
  gap: 4px;
  line-height: 1.5;
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
  margin-left: auto;
  white-space: nowrap;
}

.row-unit {
  font-size: 7px;
  font-weight: 400;
  color: var(--text-muted);
  margin-left: 2px;
}

.row-aside {
  font-size: 7px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  white-space: nowrap;
  min-width: 52px;
  text-align: right;
}
</style>
