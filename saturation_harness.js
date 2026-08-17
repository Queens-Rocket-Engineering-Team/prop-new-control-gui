// Throwaway dev harness for the N2O saturation card: real component, fake
// telemetry, no server. `npm run dev` then open /saturation_harness.html
//
// The card was split out of control_panel.vue partly so this could exist -
// mounting the control panel would mean stubbing the whole injected control
// layer, which the card does not use.
import { createApp } from 'vue'
import './src/main.css'
import Harness from './saturation_harness.vue'

createApp(Harness).mount('#app')
