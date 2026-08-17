// Derives the N2O tank's saturation state from live telemetry: tank pressure
// from PT202, tank temperature from whichever heater thermistors are currently
// connected, and where those two sit relative to the NIST saturation line.
//
// Pure derivation, no Vue plumbing beyond computed() - it takes refs as
// arguments rather than injecting, so the harness can drive it directly.

import { computed } from 'vue'
import { normalizeId } from './useSensorGroups.js'
import {
  pSatFromT,
  tSatFromP,
  PSI_PER_ATM,
} from '../lib/n2oSaturation.js'

/** Tank pressure transducer. Reads GAUGE - see pressurePsia below. */
export const N2O_TANK_PT = 'PT202'

/**
 * Tank thermistors. Not all four are always fitted or wired, so the average is
 * taken over whichever ones are actually reporting - see `thermistors`.
 */
export const N2O_TANK_THERMISTORS = [
  'HEATER_1_TH1',
  'HEATER_1_TH2',
  'HEATER_1_TH3',
  'HEATER_1_TH4',
]

/**
 * Range a tank thermistor has to be inside to count. A disconnected NTC does
 * not vanish from the stream - it rails to whatever the divider reads open or
 * shorted, or to a sentinel - and one railed channel drags an average of four
 * somewhere useless. Tune once real HEATER_1 hardware has been on the stand.
 */
const PLAUSIBLE_TEMP_C = [-60, 120]

/** Units that already include the atmosphere. Everything else is gauge. */
const ABSOLUTE_PRESSURE_UNITS = new Set(['PSIA', 'BARA', 'KPAA', 'ATMA'])

/** Server unit strings are raw and inconsistent ("PSI", "CELSIUS", "C", "°C"). */
function unitKey(s) {
  return String(s ?? '').trim().toUpperCase().replace(/[°\s_]/g, '')
}

function toCelsius(v, unit) {
  const k = unitKey(unit)
  if (k === 'K' || k === 'KELVIN') return v - 273.15
  if (k === 'F' || k === 'DEGF' || k === 'FAHRENHEIT') return (v - 32) * 5 / 9
  return v // C | CELSIUS | DEGC | unknown -> assumed Celsius
}

/** Magnitude only. Whether it is gauge or absolute is decided separately. */
function toPsi(v, unit) {
  const k = unitKey(unit)
  if (k === 'BAR' || k === 'BARA') return v * 14.5037738
  if (k === 'KPA' || k === 'KPAA') return v * 0.145037738
  if (k === 'MPA') return v * 145.037738
  if (k === 'PA') return v * 0.000145037738
  return v // PSI | PSIG | PSIA | unknown -> already psi
}

/**
 * @param {import('vue').Ref<Record<string, object>>} sensorData
 * @param {import('vue').Ref<object[]>} devices
 */
export function useN2oSaturation(sensorData, devices) {
  // Exact normalized match, deliberately not the bidirectional startsWith that
  // control_panel.vue's isSensorEnabled uses: that would make HEATER_1_TH1
  // match a future HEATER_1_TH12 and quietly average the wrong channel.
  const byId = computed(() => {
    const map = new Map()
    for (const [name, info] of Object.entries(sensorData.value ?? {})) {
      map.set(normalizeId(name), info)
    }
    return map
  })

  const infoFor = (name) => byId.value.get(normalizeId(name)) ?? null

  // Same walk as control_panel.vue's normalizedSensorLookup. A device the state
  // stream has marked down is the only authoritative "this is disconnected"
  // signal available - telemetry values latch forever once received.
  const deviceOf = computed(() => {
    const map = new Map()
    for (const dev of devices.value ?? []) {
      for (const s of dev.sensors ?? []) map.set(normalizeId(s.name), dev)
    }
    return map
  })

  /** Sensor is reporting and nothing says its device is down. */
  function isLive(name) {
    const dev = deviceOf.value.get(normalizeId(name))
    return !(dev && dev.connected === false)
  }

  // ── Temperature ────────────────────────────────────────────────────────────

  // Considered and rejected as liveness signals, all for reasons that would bite
  // later rather than now:
  //   - lastSourceT: a device-side clock, not comparable to local time. Usable
  //     only as "has it advanced since last look", which needs polling state.
  //   - msSinceLastTelemetry(): App.vue destructures it but never provides it,
  //     and it is not reactive.
  //   - info.ts.length === 0: works today only because GraphPanel is absent from
  //     App.vue's KeepAlive include, so it releases retention on unmount. That is
  //     a coupling nothing declares. Cheapest future upgrade if per-sensor
  //     staleness is ever wanted.
  const thermistors = computed(() => {
    const out = []
    for (const name of N2O_TANK_THERMISTORS) {
      const info = infoFor(name)
      if (!info || !Number.isFinite(info.value)) continue
      if (!isLive(name)) continue
      const tC = toCelsius(info.value, info.unit)
      if (tC < PLAUSIBLE_TEMP_C[0] || tC > PLAUSIBLE_TEMP_C[1]) continue
      out.push({ name, tC })
    }
    return out
  })

  const thermistorCount = computed(() => thermistors.value.length)
  const thermistorTotal = N2O_TANK_THERMISTORS.length

  /** Mean wall temperature, or null with nothing connected - never 0. */
  const tankTempC = computed(() => {
    const xs = thermistors.value
    if (!xs.length) return null
    let sum = 0
    for (const x of xs) sum += x.tC
    return sum / xs.length
  })

  /**
   * Spread across the connected thermistors. Reported as a plain number, not
   * flagged: a wide spread means a stratified tank and a mean that does not
   * describe anything, and the operator is better placed to judge that than a
   * threshold is.
   */
  const tempSpreadC = computed(() => {
    const xs = thermistors.value
    if (xs.length < 2) return null
    let lo = xs[0].tC
    let hi = xs[0].tC
    for (const x of xs) {
      if (x.tC < lo) lo = x.tC
      if (x.tC > hi) hi = x.tC
    }
    return hi - lo
  })

  // ── Pressure ───────────────────────────────────────────────────────────────

  const ptInfo = computed(() => infoFor(N2O_TANK_PT))

  /** As the transducer reports it, for cross-checking against its P&ID card. */
  const pressurePsig = computed(() => {
    const info = ptInfo.value
    if (!info || !Number.isFinite(info.value)) return null
    return toPsi(info.value, info.unit)
  })

  // PT202 reads GAUGE and the saturation table is absolute, so the atmosphere is
  // added here and nowhere else. Driven by the unit string rather than assumed,
  // because double-adding it is a silent 14.7 psi error - about 0.7 C of T_sat
  // near ambient, wrong by little enough to look plausible.
  //
  // Values arrive already tared from the server. Never subtract an offset here
  // (see control_panel.vue's getLiveValue).
  const pressurePsia = computed(() => {
    const psi = pressurePsig.value
    if (psi == null) return null
    return ABSOLUTE_PRESSURE_UNITS.has(unitKey(ptInfo.value?.unit)) ? psi : psi + PSI_PER_ATM
  })

  // ── Saturation state ───────────────────────────────────────────────────────

  /** Temperature the tank would sit at if it were saturated at this pressure. */
  const tSatC = computed(() => (pressurePsia.value == null ? null : tSatFromP(pressurePsia.value)))

  /** Pressure the tank would sit at if it were saturated at this temperature. */
  const pSatPsia = computed(() => (tankTempC.value == null ? null : pSatFromT(tankTempC.value)))

  // The same fact stated twice, in each axis's units. Both are shown so the two
  // instruments can be checked against each other: they must disagree in
  // magnitude but agree about which side of the curve the tank is on, so
  // matching signs mean one of them is lying.
  //
  // Negative T - T_sat (equivalently positive P - P_sat) is a tank held above
  // its own vapour pressure - inert pad pressure, or a temperature read lagging
  // a fast fill. Positive is a tank boiling back up to the curve, normal on a
  // vent. Both are ordinary; the card states the number and stops there.
  const deltaTC = computed(() =>
    tankTempC.value != null && tSatC.value != null ? tankTempC.value - tSatC.value : null)

  const deltaPPsi = computed(() =>
    pressurePsia.value != null && pSatPsia.value != null ? pressurePsia.value - pSatPsia.value : null)

  /** Nothing to show at all - the card does not render on stands without either. */
  const hasAnySource = computed(() => ptInfo.value != null || thermistorCount.value > 0)

  return {
    thermistors,
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
    hasPressure: computed(() => pressurePsia.value != null),
    hasAnySource,
  }
}
