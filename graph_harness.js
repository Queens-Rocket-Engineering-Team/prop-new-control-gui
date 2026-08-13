// Throwaway dev harness: mounts GraphPanel inside the *exact* height chain
// App.vue uses (.container > #grid-container > .swap-container), with fake
// telemetry, so layout/scrolling can be inspected without a live server.
import { createApp, h, provide, ref } from 'vue'
import PrimeVue from 'primevue/config'
import Aura from '@primeuix/themes/aura'
import 'primeicons/primeicons.css'
import GraphPanel from './src/windows/graph_panel.vue'

const GROUPS = {
  rocket_position:     ['Lat', 'Lon', 'Alt', 'Accel', 'Chamber', 'Sats'],
  rocket_nodes:        ['UCM', 'LCM', 'ALT', 'GPS', 'PWR'],
  rocket_link:         ['RSSI', 'SNR', 'FreqErr', 'Packets', 'LinkAge'],
  rocket_radio_config: ['Freq', 'BW', 'SF', 'CR'],
  ground_station:      ['BattV', 'SysCurrent', 'AmbTemp'],
  voltage_sense:       ['RocketBatt'],
  pressure_transducer: ['PT-01', 'PT-02', 'PT-03'],
  load_cell:           ['LC-01'],
}

const devices = ref([
  {
    name: 'GREG', connected: true,
    sensors: Object.entries(GROUPS).flatMap(([g, names]) =>
      names.map((n) => ({ name: n, sensor_type: g, unit: 'x' }))
    ),
  },
])

function history(seed) {
  const pts = []
  for (let i = 0; i < 300; i += 1) {
    const t = i / 10
    pts.push({ t, v: Math.sin(t + seed) * 10 + seed })
  }
  return pts
}

const sensorData = ref(Object.fromEntries(
  Object.values(GROUPS).flat().map((name, i) => {
    const h = history(i)
    return [name, {
      value: h[h.length - 1].v,
      unit: 'x',
      history: h,
      windowStart: 0,
      windowEnd: 30,
    }]
  })
))

const Harness = {
  setup() {
    provide('sensorData', sensorData)
    provide('devices', devices)
    provide('tares', ref({}))
    provide('setTare', () => {})
    provide('testFrequency', ref(190))
    provide('testActive', ref(false))
    provide('telemetryStats', ref(null))

    return () => h('main', { class: 'container' }, [
      h('div', { id: 'grid-container', style: { gridTemplateColumns: '180px 1fr' } }, [
        h('div', { style: 'background:#222' }),
        h(GraphPanel, { class: 'swap-container' }),
      ]),
    ])
  },
}

const app = createApp(Harness)
app.use(PrimeVue, { theme: { preset: Aura, options: { prefix: 'p', darkModeSelector: '.dark-mode', cssLayer: false } } })
app.mount('#app')
