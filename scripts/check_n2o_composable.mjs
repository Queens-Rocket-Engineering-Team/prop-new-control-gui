// Checks the sensor-selection and unit handling in useN2oSaturation.js, the
// parts most likely to be quietly wrong: which thermistors count, how raw
// server unit strings are read, and the gauge-to-absolute seam.
//
//   node scripts/check_n2o_composable.mjs
//
// Vue's reactivity runs fine outside a component, so the composable is driven
// here directly - it takes refs as arguments rather than injecting for exactly
// this reason.

import assert from 'node:assert/strict'
import { ref } from 'vue'
import { useN2oSaturation } from '../src/composables/useN2oSaturation.js'
import { pSatFromT, PSI_PER_ATM } from '../src/lib/n2oSaturation.js'

let checks = 0
function ok(cond, what) {
  checks++
  assert.ok(cond, what)
}
function close(actual, expected, tol, what) {
  checks++
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
    `${what}: got ${actual}, expected ${expected} +/- ${tol}`,
  )
}

const sensorData = ref({})
const devices = ref([])
const sat = useN2oSaturation(sensorData, devices)

/** @param {Record<string, [number, string]>} readings name -> [value, unit] */
function publish(readings, { connected = true } = {}) {
  const next = {}
  const sensors = []
  for (const [name, [value, unit]] of Object.entries(readings)) {
    next[name] = { value, unit, sensorType: '', ts: [], vs: [], lastSourceT: 1 }
    sensors.push({ name, unit })
  }
  sensorData.value = next
  devices.value = [{ name: 'HEATER1', connected, sensors }]
}

const TH = (i) => `HEATER1TH${i}`

// ── Nothing at all ───────────────────────────────────────────────────────────
publish({})
ok(sat.hasAnySource.value === false, 'no sensors -> card does not render')
ok(sat.tankTempC.value === null, 'no thermistors -> null, not 0')
ok(sat.pressurePsia.value === null, 'no PT -> null')
ok(sat.deltaTC.value === null, 'no inputs -> no delta')

// ── Averaging over whatever is connected ─────────────────────────────────────
publish({ [TH(1)]: [10, 'CELSIUS'], [TH(3)]: [20, 'CELSIUS'] })
close(sat.tankTempC.value, 15, 1e-9, 'averages only the thermistors present')
ok(sat.thermistorCount.value === 2, 'reports 2/4')
close(sat.tempSpreadC.value, 10, 1e-9, 'spread across the connected pair')
ok(sat.hasAnySource.value === true, 'thermistors alone are enough to render')

publish({ [TH(1)]: [20, 'CELSIUS'] })
ok(sat.tempSpreadC.value === null, 'spread needs two channels')
ok(sat.thermistorCount.value === 1, 'reports 1/4')

publish({ [TH(1)]: [10, 'C'], [TH(2)]: [20, 'C'], [TH(3)]: [30, 'C'], [TH(4)]: [40, 'C'] })
close(sat.tankTempC.value, 25, 1e-9, 'averages all four')
ok(sat.thermistorCount.value === 4, 'reports 4/4')

// ── Rejection rules ──────────────────────────────────────────────────────────
publish({ [TH(1)]: [-999, 'CELSIUS'], [TH(2)]: [20, 'CELSIUS'], [TH(3)]: [22, 'CELSIUS'] })
close(sat.tankTempC.value, 21, 1e-9, 'a railed channel is dropped, not averaged in')
ok(sat.thermistorCount.value === 2, 'railed channel does not count toward the total')

publish({ [TH(1)]: [NaN, 'CELSIUS'], [TH(2)]: [20, 'CELSIUS'] })
close(sat.tankTempC.value, 20, 1e-9, 'non-finite value dropped')

publish({ [TH(1)]: [20, 'CELSIUS'], [TH(2)]: [22, 'CELSIUS'] }, { connected: false })
ok(sat.tankTempC.value === null, 'device marked down -> every channel rejected')
ok(sat.thermistorCount.value === 0, 'and the count says so')

// Exact matching: a longer name that merely starts with a wanted one must not
// be picked up. This is why the composable does not reuse control_panel.vue's
// bidirectional startsWith matcher.
publish({ HEATER1TH12: [999, 'CELSIUS'], [TH(2)]: [20, 'CELSIUS'] })
close(sat.tankTempC.value, 20, 1e-9, 'HEATER1TH12 is not HEATER1TH1')
ok(sat.thermistorCount.value === 1, 'and does not inflate the count')

// ...but punctuation is not part of the name. The stand's channels are HEATER1TH1;
// the drawing and older configs write HEATER_1_TH1. normalizeId strips separators,
// so both resolve, and neither spelling needs a second entry in the constant.
publish({ HEATER_1_TH1: [10, 'CELSIUS'], 'heater-1-th2': [20, 'CELSIUS'] })
close(sat.tankTempC.value, 15, 1e-9, 'separators in the stream name are ignored')
ok(sat.thermistorCount.value === 2, 'both punctuated spellings counted')

// ── Temperature units ────────────────────────────────────────────────────────
for (const [unit, value] of [['CELSIUS', 20], ['C', 20], ['°C', 20], ['degC', 20], ['K', 293.15], ['F', 68]]) {
  publish({ [TH(1)]: [value, unit] })
  close(sat.tankTempC.value, 20, 0.01, `${unit} normalises to 20 C`)
}

// ── Pressure: the gauge/absolute seam ────────────────────────────────────────
publish({ 'PT-202': [718.1, 'PSI'] })
close(sat.pressurePsig.value, 718.1, 1e-9, 'gauge reading passes through as reported')
close(sat.pressurePsia.value, 718.1 + PSI_PER_ATM, 1e-9, 'PSI is gauge -> atmosphere added')
close(sat.tSatC.value, 20, 0.02, 'T_sat of a 718 psig tank is 20 C')

// The hyphen/normalizeId path: the drawing says PT-202, the stream may say PT202.
publish({ PT202: [718.1, 'PSI'] })
close(sat.pressurePsia.value, 718.1 + PSI_PER_ATM, 1e-9, 'PT202 and PT-202 are the same sensor')

// Same physical tank, reported absolute: must NOT gain a second atmosphere.
publish({ PT202: [718.1 + PSI_PER_ATM, 'PSIA'] })
close(sat.pressurePsia.value, 718.1 + PSI_PER_ATM, 1e-9, 'PSIA is not re-offset')
close(sat.tSatC.value, 20, 0.02, 'and lands on the same T_sat')

// 'bar' follows the same rule as 'PSI': a magnitude in bar, gauge unless the
// unit says otherwise, so it is converted first and then offset.
publish({ PT202: [718.1 / 14.5037738, 'bar'] })
close(sat.pressurePsia.value, 718.1 + PSI_PER_ATM, 0.01, 'bar is gauge, converted then offset')
publish({ PT202: [(718.1 + PSI_PER_ATM) / 14.5037738, 'bara'] })
close(sat.pressurePsia.value, 718.1 + PSI_PER_ATM, 0.01, 'bara is absolute, converted only')

// ── Deviation signs ──────────────────────────────────────────────────────────
// The two deltas must always disagree in sign - that is what lets an operator
// use one instrument to check the other.
const restingPsig = pSatFromT(20) - PSI_PER_ATM

publish({ PT202: [restingPsig, 'PSI'], [TH(1)]: [20, 'CELSIUS'] })
close(sat.deltaTC.value, 0, 0.02, 'at equilibrium T - T_sat is ~0')
close(sat.deltaPPsi.value, 0, 0.5, 'at equilibrium P - P_sat is ~0')

publish({ PT202: [900, 'PSI'], [TH(1)]: [20, 'CELSIUS'] })
ok(sat.deltaTC.value < 0, 'held above vapour pressure -> T - T_sat negative')
ok(sat.deltaPPsi.value > 0, 'and P - P_sat positive')

publish({ PT202: [500, 'PSI'], [TH(1)]: [20, 'CELSIUS'] })
ok(sat.deltaTC.value > 0, 'boiling -> T - T_sat positive')
ok(sat.deltaPPsi.value < 0, 'and P - P_sat negative')

// ── Gauge display values ─────────────────────────────────────────────────────
// The card shows gauge throughout while the maths stays absolute, so every
// displayed pressure is one atmosphere below its internal counterpart.
publish({ PT202: [718.1, 'PSI'], [TH(1)]: [20, 'CELSIUS'] })
close(sat.pSatPsig.value, sat.pSatPsia.value - PSI_PER_ATM, 1e-12, 'pSatPsig is pSatPsia less one atmosphere')
close(sat.pSatPsig.value, 718.1, 0.5, 'at equilibrium P_sat in gauge equals the PT202 reading')
close(sat.pressurePsig.value, 718.1, 1e-9, 'and PT202 displays what it reported')

publish({ PT202: [718.1, 'PSI'] })
ok(sat.pSatPsig.value === null, 'no thermistors -> no P_sat, in gauge either')

// The deviation is a difference, so the atmosphere cancels: the same physical
// tank reported as PSI or PSIA must produce the identical number. This is the
// assertion that stops someone "fixing" deltaPPsi with a conversion later.
publish({ PT202: [718.1, 'PSI'], [TH(1)]: [16.9, 'CELSIUS'] })
const deltaGauge = sat.deltaPPsi.value
publish({ PT202: [718.1 + PSI_PER_ATM, 'PSIA'], [TH(1)]: [16.9, 'CELSIUS'] })
close(sat.deltaPPsi.value, deltaGauge, 1e-9, 'P - P_sat is the same in gauge and absolute')

// ── Out of range ─────────────────────────────────────────────────────────────
publish({ PT202: [1100, 'PSI'], [TH(1)]: [40, 'CELSIUS'] })
ok(sat.pSatPsig.value === null, 'above T-crit -> P_sat is null in gauge too')
ok(sat.tSatC.value === null, 'supercritical pressure -> T_sat is null (renders as a dash)')
ok(sat.pSatPsia.value === null, 'above T-crit -> P_sat is null')
ok(sat.deltaTC.value === null, 'and neither delta is invented')
ok(sat.deltaPPsi.value === null, 'and neither delta is invented')
ok(sat.pressurePsia.value !== null, 'but the measured pressure is still reported')

// One source missing does not suppress what the other can still say.
publish({ PT202: [718.1, 'PSI'] })
ok(sat.tSatC.value !== null, 'PT alone still yields T_sat')
ok(sat.pSatPsia.value === null, 'but not P_sat')
publish({ [TH(1)]: [20, 'CELSIUS'] })
ok(sat.pSatPsia.value !== null, 'thermistors alone still yield P_sat')
ok(sat.tSatC.value === null, 'but not T_sat')

console.log(`useN2oSaturation: ${checks} checks passed`)
