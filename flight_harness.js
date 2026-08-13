// Throwaway dev harness: mounts FlightPanel inside the *exact* height chain
// App.vue uses (.container > #grid-container > .swap-container) and drives the
// real useFlightTrack composable with a simulated 4 Hz GPS trajectory, so the
// map can be exercised with no server and no GPS hardware. Runs in a plain
// browser, where tileSource.js falls back to online OSM tiles.
import { createApp, h, provide, ref } from 'vue'
import PrimeVue from 'primevue/config'
import Aura from '@primeuix/themes/aura'
import 'primeicons/primeicons.css'
import FlightPanel from './src/windows/flight_panel.vue'
import { useFlightTrack } from './src/composables/useFlightTrack.js'

// Same GREG mock as graph_harness.js
const GROUPS = {
  rocket_position: ['Lat', 'Lon', 'Alt', 'Accel', 'Chamber', 'Sats'],
  rocket_nodes:    ['UCM', 'LCM', 'ALT', 'GPS', 'PWR'],
  rocket_link:     ['RSSI', 'SNR', 'FreqErr', 'Packets', 'LinkAge'],
}

const devices = ref([
  {
    name: 'GREG', connected: true,
    sensors: Object.entries(GROUPS).flatMap(([g, names]) =>
      names.map((n) => ({ name: n, sensor_type: g, unit: 'x' }))
    ),
  },
])

// ── Trajectory simulator ──────────────────────────────────────────────────────
// Pad hold (GPS noise) → boost → coast → drogue → main → landed.

const PAD = { lat: 43.27, lon: -79.925 }
const TICK_SEC = 0.25 // 4 Hz, matching the display batch cadence
const AZIMUTH_RAD = (60 * Math.PI) / 180 // downrange direction

const phase = ref('pad')
const sensorData = ref({})
const testActive = ref(false)

const sim = {
  t: 0,          // elapsed sim seconds
  phaseStart: 0, // sim.t at the last phase transition
  alt: 0,
  vv: 0,         // vertical velocity m/s
  downrange: 0,  // meters from pad along AZIMUTH
  crosswind: 0,  // meters of wind drift (east)
}

function setPhase(p) {
  phase.value = p
  sim.phaseStart = sim.t
}

function metersToLatLon(downrange, crosswind) {
  const north = downrange * Math.cos(AZIMUTH_RAD)
  const east = downrange * Math.sin(AZIMUTH_RAD) + crosswind
  const lat = PAD.lat + north / 111320
  const lon = PAD.lon + east / (111320 * Math.cos((PAD.lat * Math.PI) / 180))
  return { lat, lon }
}

function stepSim() {
  sim.t += TICK_SEC
  const noise = () => (Math.random() - 0.5) * 1.0 // ±0.5 m

  switch (phase.value) {
    case 'pad':
      break
    case 'boost': // 7 s burn, vv capped 370 m/s → apogee ≈ 3050 m (~10,000 ft)
      sim.vv = Math.min(sim.vv + 100 * TICK_SEC, 370)
      sim.alt += sim.vv * TICK_SEC
      sim.downrange += sim.vv * 0.06 * TICK_SEC
      if (sim.t - sim.phaseStart > 7) setPhase('coast')
      break
    case 'coast': // decelerate to apogee
      sim.vv -= 60 * TICK_SEC
      sim.alt += sim.vv * TICK_SEC
      sim.downrange += Math.max(sim.vv, 0) * 0.06 * TICK_SEC
      if (sim.vv <= 0) setPhase('drogue')
      break
    case 'drogue': // fast descent, strong wind drift
      sim.vv = -25
      sim.alt += sim.vv * TICK_SEC
      sim.crosswind += 15 * TICK_SEC
      if (sim.alt <= 300) setPhase('main')
      break
    case 'main': // slow descent, light drift
      sim.vv = -6
      sim.alt += sim.vv * TICK_SEC
      sim.crosswind += 4 * TICK_SEC
      if (sim.alt <= 0) {
        sim.alt = 0
        setPhase('landed')
      }
      break
    case 'landed':
      break
  }

  const { lat, lon } = metersToLatLon(sim.downrange + noise(), sim.crosswind + noise())

  // Snapshot shaped exactly like useTelemetryStream publishes: replaced
  // wholesale, one entry per sensor, history carrying sourceT.
  const entry = (value, unit, sensorType = 'rocket_position') => ({
    value,
    unit,
    sensorType,
    history: [{ t: sim.t, sourceT: sim.t, v: value }],
    windowStart: sim.t - 30,
    windowEnd: sim.t,
  })

  // Board liveness, mirroring the ground station's `rocket_nodes` group:
  // 1 alive, 0 dead, -1 nothing heard over LoRa yet. On the pad everything is
  // -1 so the "never connected" grey state is what you see first; PWR stays
  // dead throughout and GPS drops at drogue, so a single run exercises all
  // three LED colours. The sensorType matters — rocket_pane rejects any stream
  // not in this group, which is what stops `ALT` binding to `Alt`.
  const node = (value) => entry(value, 'state', 'rocket_nodes')
  const live = phase.value !== 'pad' ? 1 : -1
  const nodes = {
    UCM: node(live),
    LCM: node(live),
    ALT: node(live),
    GPS: node(phase.value === 'drogue' || phase.value === 'main' || phase.value === 'landed' ? 0 : live),
    PWR: node(phase.value !== 'pad' ? 0 : -1),
  }

  sensorData.value = {
    Lat: entry(lat, 'deg'),
    Lon: entry(lon, 'deg'),
    Alt: entry(Math.round(sim.alt), 'm'),
    Sats: entry(12, ''),
    ...nodes,
  }
}

setInterval(stepSim, TICK_SEC * 1000)

function launch() {
  sim.alt = 0
  sim.vv = 0
  sim.downrange = 0
  sim.crosswind = 0
  setPhase('boost')
}

// Exercises the "ground station gone" path: the node values keep their last
// reading, so this is the only way to see whether the LEDs correctly fall back
// to unknown instead of latching green.
function toggleGroundStation() {
  const gs = devices.value[0]
  devices.value = [{ ...gs, connected: !gs.connected }]
}

function resetFlight() {
  setPhase('pad')
  sim.alt = 0
  sim.vv = 0
  sim.downrange = 0
  sim.crosswind = 0
  // Rising edge of testActive exercises useFlightTrack's reset watcher, the
  // same path a real Start Test takes.
  testActive.value = false
  setTimeout(() => { testActive.value = true }, 50)
}

// ── App ───────────────────────────────────────────────────────────────────────

const Harness = {
  setup() {
    const flightTrack = useFlightTrack(sensorData, { testActive })

    provide('flightTrack', flightTrack)
    provide('sensorData', sensorData)
    provide('devices', devices)
    provide('mapSitesDisabled', ref([]))
    provide('mapsDir', ref(''))
    provide('testActive', testActive)
    provide('telemetryStats', ref(null))

    return () => h('main', { class: 'container' }, [
      h('div', { id: 'grid-container', style: { gridTemplateColumns: '180px 1fr' } }, [
        h('div', { class: 'harness-controls' }, [
          h('strong', 'Flight sim'),
          h('span', `phase: ${phase.value}`),
          h('button', { onClick: launch }, 'Launch'),
          h('button', { onClick: resetFlight }, 'Reset (test edge)'),
          h('button', { onClick: toggleGroundStation },
            devices.value[0].connected ? 'Drop GREG' : 'Restore GREG'),
        ]),
        h(FlightPanel, { class: 'swap-container' }),
      ]),
    ])
  },
}

const app = createApp(Harness)
app.use(PrimeVue, { theme: { preset: Aura, options: { prefix: 'p', darkModeSelector: '.dark-mode', cssLayer: false } } })
app.mount('#app')
