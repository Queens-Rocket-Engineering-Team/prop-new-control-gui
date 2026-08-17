<script setup>
// Controls + fixtures for the N2O saturation card. See saturation_harness.js.
//
// Publishes the *current* sensorData shape ({ value, unit, sensorType, ts, vs,
// lastSourceT, windowStart, windowEnd }) rather than the `history: [{t,v}]`
// shape graph_harness.js and flight_harness.js still emit - those are stale
// relative to useTelemetryStream.js. The card reads info.value only, so this
// stays correct either way.

import { computed, provide, ref, watchEffect } from 'vue'
import N2oSaturationCard from './src/components/n2o_saturation_card.vue'
import { pSatFromT, PSI_PER_ATM } from './src/lib/n2oSaturation.js'
import { N2O_TANK_THERMISTORS } from './src/composables/useN2oSaturation.js'

const ptAttached = ref(true)
const ptPsig = ref(718.1)
const ptUnit = ref('PSI')
const deviceUp = ref(true)
const layout = ref('full')
const dark = ref(true)
const tempUnit = ref('CELSIUS')

const thermistors = ref(
  N2O_TANK_THERMISTORS.map((name) => ({ name, attached: true, c: 20 })),
)

// Deliberately hyphenated: the real drawing calls it PT-202 and the stream calls
// it PT202, so this exercises normalizeId rather than assuming it away.
const PT_KEY = 'PT-202'

function outValue(c) {
  if (tempUnit.value === 'K') return c + 273.15
  if (tempUnit.value === 'F') return c * 9 / 5 + 32
  return c
}

function outPressure(psig) {
  // The unit selector changes the label, not the physical reading, except for
  // PSIA - where the same tank reads one atmosphere higher.
  if (ptUnit.value === 'PSIA') return psig + PSI_PER_ATM
  if (ptUnit.value === 'BAR') return psig / 14.5037738
  return psig
}

const sensorData = ref({})
const devices = ref([])

watchEffect(() => {
  const t = performance.now() / 1000
  const entry = (value, unit, sensorType) => ({
    value, unit, sensorType,
    ts: [], vs: [], lastSourceT: t, windowStart: t - 30, windowEnd: t,
  })

  const next = {}
  const sensors = []
  if (ptAttached.value) {
    next[PT_KEY] = entry(outPressure(ptPsig.value), ptUnit.value, 'pressure_transducer')
    sensors.push({ name: PT_KEY, sensor_type: 'pressure_transducer', unit: ptUnit.value })
  }
  for (const th of thermistors.value) {
    if (!th.attached) continue
    next[th.name] = entry(outValue(th.c), tempUnit.value, 'thermocouple')
    sensors.push({ name: th.name, sensor_type: 'thermocouple', unit: tempUnit.value })
  }

  // Replaced wholesale, like publishSnapshot does - not mutated in place.
  sensorData.value = next
  devices.value = [{ name: 'HEATER1', connected: deviceUp.value, sensors }]
})

watchEffect(() => {
  document.documentElement.classList.toggle('dark-mode', dark.value)
  document.documentElement.style.colorScheme = dark.value ? 'dark' : 'light'
})

provide('sensorData', sensorData)
provide('devices', devices)

const equilibriumPsig = computed(() => pSatFromT(20) - PSI_PER_ATM)

function setTemps(list) {
  thermistors.value = N2O_TANK_THERMISTORS.map((name, i) => ({
    name,
    attached: list[i] != null,
    c: list[i] ?? 20,
  }))
}

const PRESETS = [
  {
    label: 'Equilibrium @20 °C',
    note: 'marker sits on the curve, both deltas ≈ 0',
    run: () => { ptAttached.value = true; ptPsig.value = +equilibriumPsig.value.toFixed(1); setTemps([20, 20, 20, 20]) },
  },
  {
    label: 'Ullage-pressurised',
    note: 'marker above the curve · T−T_sat < 0, P−P_sat > 0',
    run: () => { ptAttached.value = true; ptPsig.value = 900; setTemps([20, 20, 20, 20]) },
  },
  {
    label: 'Venting',
    note: 'marker below the curve · T−T_sat > 0, P−P_sat < 0',
    run: () => { ptAttached.value = true; ptPsig.value = 500; setTemps([20, 20, 20, 20]) },
  },
  {
    label: 'Supercritical',
    note: 'T_sat and P_sat both —, marker clamps to the top as a chevron',
    run: () => { ptAttached.value = true; ptPsig.value = 1100; setTemps([40, 40, 40, 40]) },
  },
  {
    label: 'Vented / empty',
    note: 'marker bottom-left, a big positive T−T_sat prints plainly',
    run: () => { ptAttached.value = true; ptPsig.value = 0; setTemps([20, 20, 20, 20]) },
  },
  {
    label: 'Heater on (stratified)',
    note: '4/4 with a 27 °C spread, stated not flagged',
    run: () => { ptAttached.value = true; ptPsig.value = 718; setTemps([45, 18, 18, 18]) },
  },
  {
    label: 'Partial — TH1 + TH3',
    note: 'reads 2/4 and averages only those two',
    run: () => { ptAttached.value = true; ptPsig.value = 718; setTemps([20, null, 24, null]) },
  },
  {
    label: 'No thermistors',
    note: 'T_sat still shown; no marker, no vertical guide',
    run: () => { ptAttached.value = true; ptPsig.value = 718; setTemps([null, null, null, null]) },
  },
  {
    label: 'No PT202',
    note: 'P_sat still shown; no marker, no horizontal guide',
    run: () => { ptAttached.value = false; setTemps([20, 20, 20, 20]) },
  },
  {
    label: 'Railed thermistor (−999)',
    note: 'implausible channel dropped — count falls to 3/4',
    run: () => { ptAttached.value = true; ptPsig.value = 718; setTemps([-999, 20, 20, 20]) },
  },
]
</script>

<template>
  <div class="harness">
    <aside class="panel">
      <h1>N₂O saturation card</h1>

      <section>
        <h2>Presets</h2>
        <button v-for="p in PRESETS" :key="p.label" class="preset" @click="p.run()">
          <strong>{{ p.label }}</strong>
          <em>{{ p.note }}</em>
        </button>
      </section>

      <section>
        <h2>PT202</h2>
        <label class="chk">
          <input v-model="ptAttached" type="checkbox">
          attached <small>(unchecked removes the key entirely)</small>
        </label>
        <label class="fld">
          <span>{{ ptPsig.toFixed(1) }} psig</span>
          <input v-model.number="ptPsig" type="range" min="0" max="1150" step="1">
        </label>
        <label class="fld">
          <span>reported unit</span>
          <select v-model="ptUnit">
            <option>PSI</option><option>PSIG</option><option>PSIA</option><option>BAR</option>
          </select>
        </label>
      </section>

      <section>
        <h2>Thermistors</h2>
        <label class="fld">
          <span>reported unit</span>
          <select v-model="tempUnit">
            <option>CELSIUS</option><option>C</option><option>°C</option>
            <option>K</option><option>F</option>
          </select>
        </label>
        <div v-for="th in thermistors" :key="th.name" class="th-row">
          <input v-model="th.attached" type="checkbox">
          <span class="th-name">{{ th.name.replace('HEATER1', '') }}</span>
          <input v-model.number="th.c" type="number" step="1" :disabled="!th.attached">
          <span class="th-unit">°C</span>
        </div>
        <label class="chk">
          <input v-model="deviceUp" type="checkbox">
          device connected <small>(off ⇒ all four rejected)</small>
        </label>
      </section>

      <section>
        <h2>View</h2>
        <label class="chk"><input v-model="dark" type="checkbox"> dark mode</label>
        <label class="fld">
          <span>layout</span>
          <select v-model="layout"><option>full</option><option>compact</option></select>
        </label>
      </section>
    </aside>

    <main class="stage">
      <div class="stage-col">
        <h3>desktop — <code>--pid-card-scale: 1</code></h3>
        <div class="scale-1"><N2oSaturationCard :layout="layout" /></div>
      </div>
      <div class="stage-col">
        <h3>tablet — <code>--pid-card-scale: 0.72</code></h3>
        <div class="scale-72"><N2oSaturationCard :layout="layout" /></div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.harness {
  display: grid;
  grid-template-columns: 300px 1fr;
  height: 100vh;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: Inter, system-ui, sans-serif;
}

.panel {
  overflow-y: auto;
  padding: 12px;
  border-right: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

h1 { font-size: 13px; margin: 0 0 10px; }
h2 { font-size: 9px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-muted); margin: 14px 0 5px; }
h3 { font-size: 10px; font-weight: 500; color: var(--text-muted); margin: 0 0 8px; }

.preset {
  display: block;
  width: 100%;
  text-align: left;
  margin-bottom: 3px;
  padding: 4px 6px;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font: inherit;
  cursor: pointer;
}
.preset:hover { border-color: var(--text-muted); }
.preset strong { display: block; font-size: 10px; font-weight: 600; }
.preset em { display: block; font-size: 8px; font-style: normal; color: var(--text-muted); }

.chk, .fld { display: flex; align-items: center; gap: 6px; font-size: 10px; margin: 4px 0; }
.fld span { min-width: 80px; color: var(--text-muted); }
.fld input[type="range"] { flex: 1; }
.chk small { color: var(--text-muted); font-size: 8px; }

.th-row { display: flex; align-items: center; gap: 6px; font-size: 10px; margin: 3px 0; }
.th-name { width: 34px; font-variant-numeric: tabular-nums; }
.th-row input[type="number"] { width: 66px; }
.th-unit { color: var(--text-muted); font-size: 9px; }

.stage { display: flex; gap: 40px; padding: 24px; align-items: flex-start; }
.stage-col { display: flex; flex-direction: column; }
.scale-1 { --pid-card-scale: 1; }
.scale-72 { --pid-card-scale: 0.72; }
</style>
