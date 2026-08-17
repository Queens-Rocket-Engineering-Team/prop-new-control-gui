<script setup>
// The P&ID half of the Control panel: which cards the drawing contains, where
// they sit, and the live sensor readouts beside them.
//
// Commanding the stand is *not* here — it lives in useControlLayer.js, one
// instance per window, created by App.vue and injected below. That split exists
// because this component is unmounted the moment the operator navigates to
// another view, and the switch panel driving the stand is a keyboard-emulating
// HID: keeping the keyboard alive means keeping it above the view swap. What
// stayed behind is what genuinely needs the parsed SVG.

import { ref, inject, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import ToggleSwitch from 'primevue/toggleswitch'
import PidDiagram from '../components/PidDiagram.vue'
import N2oSaturationCard from '../components/n2o_saturation_card.vue'
import { useKeyBindings, targetId } from '../composables/useKeyBindings.js'

const devices      = inject('devices',      ref([]))
const pidConfig    = inject('pidConfig',    ref('rocket-launch'))
const sensorData   = inject('sensorData',   ref({}))
const kasaDevices  = inject('kasaDevices',  ref([]))
const setKasaState = inject('setKasaState', () => {})

const {
  readOnly,
  showEstopConfirm,
  normalizeId,
  isValveEnabled,
  getValveDefaultState,
  getDisplayedOpen,
  auxiliaryControls,
  variableControls,
  getAuxDisplayed,
  getVariableValue,
  isControlOffline,
  isControlPending,
  isControlLocked,
  isControlWarning,
  isControlError,
  isAuxOffline,
  isAuxPending,
  isAuxLocked,
  isAuxWarning,
  isAuxError,
  onValveToggle,
  onAuxToggle,
  openVariableEditor,
  variableInput,
  toggleVariableEditor,
  cancelVariableEditor,
  submitVariableControl,
  syncOpen,
  outOfSync,
  reviewOpen,
  setPanelActive,
} = inject('controlLayer')

// Variable-control keys only act while this panel is up, because their editor is
// a popover anchored to a card in the aux panel. Telling the layer when that is
// true is the whole reason it needs to know this component exists.
onMounted(() => setPanelActive(true))
onBeforeUnmount(() => setPanelActive(false))

// ── SVG URL mapping ──────────────────────────────────────────────────────────

const SVG_URLS = {
  'hot-fire':      '/P&IDs/Hot-Fire-P&ID-26-05-2026.svg',
  'rocket-launch': '/P&IDs/Rocket-P&ID-06-08-2026-V2.svg',
}

const svgUrl = computed(() => SVG_URLS[pidConfig.value] ?? SVG_URLS['rocket-launch'])

// Preferred face for cards whose default placement reads badly on a specific
// P&ID. This only sets the starting side — the overlay layout still relocates
// a card if that face turns out to be blocked, so a stale hint can't hide a
// readout. Keyed by P&ID because the same tag sits differently on each drawing.
const SIDE_HINTS = {
  'rocket-launch': {
    'AV-102': 'top',   // directly above its valve
    'AV-201': 'top',   // the clear band between the two pipe runs
    'PT-102': 'bottom',
    // Outside the shell outline, in the empty band beside the vehicle. Left, not
    // right: the outline's far line sits ~18px from the edge of the drawing.
    'CLAMSHELL': 'left',
  },
}

function sideFor(id, fallback) {
  return SIDE_HINTS[pidConfig.value]?.[id] ?? fallback
}

/** Hinted cards are placed first, so neighbours route around them. */
function isPinned(id) {
  return SIDE_HINTS[pidConfig.value]?.[id] ? true : null
}

// The saturation card sits in the drawing's empty top-left corner, and that
// corner is far shallower on hot-fire (empty to y≈164 of 844) than on the rocket
// drawing (y≈310 of 994), so it runs a shorter layout there. Keyed by P&ID for
// the same reason SIDE_HINTS is: the same overlay sits differently on each.
const PID_SAT_LAYOUT = {
  'hot-fire': 'compact',
}

const satLayout = computed(() => PID_SAT_LAYOUT[pidConfig.value] ?? 'full')

// ── Dynamic element lists (populated from parsed SVG cells) ──────────────────

// Actuated elements the drawing doesn't give a valve glyph. The clamshell is the
// dotted shell outline around the onboard tank, but it is commanded exactly like
// a valve — same card, same OPEN/CLOSED wording — so it joins the valve list
// rather than growing a shape of its own.
const ACTUATED_IDS = ['CLAMSHELL']

const valves     = ref([])    // drawio IDs starting with AV, plus ACTUATED_IDS
const sensors    = ref([])    // [{ id, unit }, ...]
const mvs        = ref([])
const tanks      = ref([])
const regulators = ref([])

function onCellsParsed(cells) {
  const newValves = [], newSensors = [], newMvs = [], newTanks = [], newRegs = []

  for (const id of Object.keys(cells)) {
    const up = id.toUpperCase()
    if      (up.startsWith('AV'))         newValves.push(id)
    else if (ACTUATED_IDS.some(a => up.startsWith(a))) newValves.push(id)
    else if (up.startsWith('PT'))         newSensors.push({ id, unit: 'psi' })
    else if (up.startsWith('TC'))         newSensors.push({ id, unit: '°C'  })
    else if (up.startsWith('LC'))         newSensors.push({ id, unit: 'kg'  })
    else if (up.startsWith('MV'))         newMvs.push(id)
    else if (up.includes('TANK'))         newTanks.push(id)
    else if (up.startsWith('REGULATOR'))  newRegs.push(id)
  }

  valves.value     = newValves
  sensors.value    = newSensors
  mvs.value        = newMvs
  tanks.value      = newTanks
  regulators.value = newRegs
}

watch(pidConfig, () => {
  valves.value     = []
  sensors.value    = []
  mvs.value        = []
  tanks.value      = []
  regulators.value = []
})

// ── Sensor index (flat map keyed by normalizeId) ─────────────────────────────
// The control-side equivalents live in useControlLayer.js; sensors stay here
// because only the drawing asks about them.

// Map: normalizeId(sensor.name) → sensor object
const normalizedSensorLookup = computed(() => {
  const map = new Map()
  for (const dev of devices.value) {
    for (const s of (dev.sensors ?? [])) {
      map.set(normalizeId(s.name), s)
    }
  }
  return map
})

// ── Server-enabled sensors ────────────────────────────────────────────────────

function isSensorEnabled(drawioId) {
  const norm = normalizeId(drawioId)
  for (const [key] of normalizedSensorLookup.value) {
    if (key.startsWith(norm) || norm.startsWith(key)) return true
  }
  return false
}

// ── Live sensor value lookup ──────────────────────────────────────────────────

const normalizedSensorMap = computed(() => {
  const map = {}
  for (const [name, info] of Object.entries(sensorData.value)) {
    map[normalizeId(name)] = info
  }
  return map
})

// Values arrive already tared from the server — never subtract an offset here.
function getLiveValue(drawioId) {
  const info = normalizedSensorMap.value[normalizeId(drawioId)]
  if (!info) return '—'
  const v   = info.value
  const abs = Math.abs(v)
  if (abs >= 1000) return v.toFixed(0)
  if (abs >= 10)   return v.toFixed(1)
  return v.toFixed(2)
}

// ── Bindable targets ─────────────────────────────────────────────────────────
// What the settings editor is allowed to list. This is the one part of the
// keybinding feature that has to stay with the drawing: a valve target is a
// drawio ID, so nothing but the parsed P&ID can enumerate them. Acting on a
// binding happens in useControlLayer.js, above the view swap.
//
// `targets` is module-level and is not cleared on unmount, and Control is the
// default view in every window, so the editor stays populated after the
// operator navigates away.

const { keyForTarget, registerTargets } = useKeyBindings()

// Publish what can be bound so the settings editor has something to list.
// Valves come from the parsed P&ID rather than from the device list, because a
// valve card is a drawio ID that may drive several server controls at once —
// binding the card is what matches the thing on screen.
watch([valves, auxiliaryControls, variableControls, kasaDevices], () => {
  const rows = []
  for (const id of valves.value) {
    rows.push({ target: { type: 'valve', id, action: 'open'  }, label: id, action: 'OPEN',  group: 'Valves' })
    rows.push({ target: { type: 'valve', id, action: 'close' }, label: id, action: 'CLOSE', group: 'Valves' })
  }
  // Relay wording follows the cards: CLOSED is energised, OPEN is not. Ordered
  // OPEN then CLOSE like the valves, so a control occupies the same column here
  // and in the switch-sync prompt.
  for (const ctrl of auxiliaryControls.value) {
    rows.push({ target: { type: 'aux', key: ctrl.key, action: 'open'  }, label: ctrl.label, action: 'OPEN',  group: 'Aux Controls' })
    rows.push({ target: { type: 'aux', key: ctrl.key, action: 'close' }, label: ctrl.label, action: 'CLOSE', group: 'Aux Controls' })
  }
  // No open/close pair: a numeric control has no two states to bind, so its key
  // opens the editor and the value is still typed and confirmed by hand.
  for (const ctrl of variableControls.value) {
    rows.push({ target: { type: 'variable', key: ctrl.key }, label: ctrl.label, action: 'SET', group: 'Variable Controls' })
  }
  for (const dev of kasaDevices.value) {
    const label = dev.alias || dev.host
    rows.push({ target: { type: 'kasa', host: dev.host, action: 'on'  }, label, action: 'ON',  group: 'Smart Plugs' })
    rows.push({ target: { type: 'kasa', host: dev.host, action: 'off' }, label, action: 'OFF', group: 'Smart Plugs' })
  }
  rows.push({ target: { type: 'estop' }, label: 'E-STOP', action: 'CONFIRM', group: 'Emergency' })
  registerTargets(rows)
}, { immediate: true })

// The one hint still drawn on the panel — see the note by .estop-keybind.
const estopKey = computed(() => keyForTarget.value[targetId({ type: 'estop' })])

</script>

<template>
  <div id="control-panel">
    <PidDiagram :svg-url="svgUrl" @cells-parsed="onCellsParsed">
      <template #default="{ positionOf, positionBeside }">

        <!-- ── Fixed top-left stack: aux controls, then the saturation card ──
             A column rather than two absolutely-positioned overlays so the card
             follows the aux panel's height, and rises to the corner on its own
             when the stand has no aux hardware.

             Neither child carries data-pid-cell, so the overlay solver ignores
             both (it selects [data-pid-cell] only). The wrapper omits
             .pid-overlay so it stays pointer-events:none over its whole
             footprint; the aux panel opts back in because its toggles need
             clicks. The saturation card deliberately does not - it is a passive
             readout, and leaving the class off is the whole implementation of
             that. -->
        <div class="tl-stack" data-pid-obstacle>

          <!-- ── Auxiliary controls panel ── -->
          <div
            v-if="auxiliaryControls.length > 0 || variableControls.length > 0 || kasaDevices.length > 0"
            class="pid-overlay aux-panel"
          >
            <div class="aux-header">Aux Controls</div>
            <div
              v-for="ctrl in auxiliaryControls"
              :key="ctrl.key"
              class="aux-row"
              :class="{ offline: isAuxOffline(ctrl.key) }"
            >
              <span class="aux-label">{{ ctrl.label }}</span>
              <span class="card-badge">{{ ctrl.defaultState }}</span>
              <span
                class="state-indicator"
                :class="
                  isAuxOffline(ctrl.key) ? 'relay-offline' :
                  isAuxPending(ctrl.key) ? 'relay-pending' :
                  isAuxError(ctrl.key)   ? 'relay-error' :
                  isAuxWarning(ctrl.key) ? 'relay-warning' :
                  getAuxDisplayed(ctrl.key) ? 'relay-closed' : 'relay-open'
                "
              >
                <span class="state-led" />
                <span v-if="isAuxOffline(ctrl.key)">{{ getAuxDisplayed(ctrl.key) ? 'CLOSED' : 'OPEN' }}</span>
                <span v-else-if="isAuxPending(ctrl.key)">PENDING…</span>
                <span v-else-if="isAuxError(ctrl.key)">ERROR</span>
                <span v-else-if="isAuxWarning(ctrl.key)">WARN</span>
                <span v-else>{{ getAuxDisplayed(ctrl.key) ? 'CLOSED' : 'OPEN' }}</span>
              </span>
              <ToggleSwitch
                :modelValue="getAuxDisplayed(ctrl.key)"
                :disabled="isAuxOffline(ctrl.key) || isAuxLocked(ctrl.key) || readOnly"
                @update:modelValue="onAuxToggle(ctrl.key, $event)"
                class="aux-toggle"
              />
            </div>

            <!-- Variable (numeric) controls -->
            <template v-if="variableControls.length > 0">
              <div class="aux-section-sep" v-if="auxiliaryControls.length > 0" />
              <div class="aux-section-label">Variable Controls</div>
              <div
                v-for="ctrl in variableControls"
                :key="ctrl.key"
                class="aux-row variable-row"
                :class="{ offline: isAuxOffline(ctrl.key) }"
              >
                <span class="aux-label">{{ ctrl.label }}</span>
                <span class="card-badge">{{ ctrl.defaultState }}<span v-if="ctrl.unit" class="variable-unit">{{ ctrl.unit }}</span></span>
                <span
                  class="state-indicator"
                  :class="{
                    'relay-offline': isAuxOffline(ctrl.key),
                    'relay-pending': isAuxPending(ctrl.key) && !isAuxOffline(ctrl.key),
                    'relay-error':   isAuxError(ctrl.key)   && !isAuxPending(ctrl.key) && !isAuxOffline(ctrl.key),
                    'relay-warning': isAuxWarning(ctrl.key) && !isAuxError(ctrl.key) && !isAuxPending(ctrl.key) && !isAuxOffline(ctrl.key),
                  }"
                >
                  <span class="state-led" />
                  <span v-if="isAuxOffline(ctrl.key)">{{ getVariableValue(ctrl.key) }}<span v-if="ctrl.unit" class="variable-unit">{{ ctrl.unit }}</span></span>
                  <span v-else-if="isAuxPending(ctrl.key)">PENDING…</span>
                  <span v-else-if="isAuxError(ctrl.key)">ERROR</span>
                  <span v-else-if="isAuxWarning(ctrl.key)">WARN</span>
                  <span v-else>{{ getVariableValue(ctrl.key) }}<span v-if="ctrl.unit" class="variable-unit">{{ ctrl.unit }}</span></span>
                </span>
                <button
                  class="variable-edit-btn"
                  :disabled="isAuxOffline(ctrl.key) || isAuxLocked(ctrl.key) || readOnly"
                  @click="toggleVariableEditor(ctrl.key)"
                  :title="readOnly ? 'Controls are issued from launch control' : isAuxOffline(ctrl.key) ? 'Device offline' : 'Set value'"
                >
                  <i class="pi pi-pencil" />
                </button>

                <!-- Numeric input popover -->
                <div v-if="openVariableEditor === ctrl.key" class="variable-popover">
                  <div class="variable-popover-caret" />
                  <div class="variable-popover-row">
                    <div class="variable-input-wrap">
                      <input
                        v-model="variableInput"
                        type="number"
                        step="any"
                        class="variable-input"
                        :class="{ 'has-unit': ctrl.unit }"
                        autofocus
                        @keydown.enter="submitVariableControl(ctrl.key)"
                        @keydown.esc="cancelVariableEditor"
                      />
                      <span v-if="ctrl.unit" class="variable-input-unit">{{ ctrl.unit }}</span>
                    </div>
                    <button
                      class="variable-confirm-btn"
                      :disabled="variableInput === '' || Number.isNaN(Number(variableInput))"
                      title="Confirm"
                      @click="submitVariableControl(ctrl.key)"
                    ><i class="pi pi-check" /></button>
                    <button class="variable-cancel-btn" title="Cancel" @click="cancelVariableEditor">
                      <i class="pi pi-times" />
                    </button>
                  </div>
                </div>
              </div>
            </template>

            <!-- Kasa Smart Plugs -->
            <template v-if="kasaDevices.length > 0">
              <div class="aux-section-sep" v-if="auxiliaryControls.length > 0 || variableControls.length > 0" />
              <div class="aux-section-label">Smart Plugs</div>
              <div
                v-for="dev in kasaDevices"
                :key="dev.host"
                class="aux-row"
                :class="{ offline: dev.connected === false }"
              >
                <span class="aux-label">{{ dev.alias || dev.host }}</span>
                <span
                  class="state-indicator"
                  :class="dev.connected === false ? 'relay-offline' : dev.active ? 'relay-closed' : 'relay-open'"
                >
                  <span class="state-led" />
                  {{ dev.active ? 'ON' : 'OFF' }}
                </span>
                <ToggleSwitch
                  :modelValue="dev.active"
                  :disabled="dev.connected === false || readOnly"
                  @update:modelValue="setKasaState(dev.host, $event)"
                  class="aux-toggle"
                />
              </div>
            </template>
          </div>

          <N2oSaturationCard :layout="satLayout" />
        </div>

        <!-- ── Actuated valve cards ── -->
        <div
          v-for="id in valves"
          :key="id"
          :style="positionBeside(id, sideFor(id, 'bottom'), 8)"
          :data-pid-cell="id"
          :data-pid-pinned="isPinned(id)"
          class="pid-overlay"
        >
          <div
            class="valve-card"
            :class="{
              open:    getDisplayedOpen(id),
              locked:  !isValveEnabled(id),
              offline: isControlOffline(id),
              pending: isControlPending(id) && !isControlOffline(id),
              warning: isControlWarning(id) && !isControlOffline(id),
              error:   isControlError(id)   && !isControlOffline(id),
            }"
          >
            <div class="card-id">
              {{ id }}
              <span v-if="!isValveEnabled(id)" class="lock-badge">NO CTRL</span>
              <span v-else-if="isControlOffline(id)" class="offline-badge">OFFLINE</span>
              <span v-else-if="isControlError(id)" class="err-badge">ERR</span>
              <span v-else-if="isControlWarning(id)" class="warn-badge">WARN</span>
            </div>
            <div class="valve-card-body">
              <div class="valve-toggle-col">
                <ToggleSwitch
                  :modelValue="getDisplayedOpen(id)"
                  :disabled="!isValveEnabled(id) || isControlOffline(id) || isControlLocked(id) || readOnly"
                  @update:modelValue="onValveToggle(id, $event)"
                />
              </div>
              <div class="valve-info">
                <div class="card-row">
                  <span class="card-detail">Default</span>
                  <span class="card-badge">{{ getValveDefaultState(id) }}</span>
                </div>
                <div class="card-row">
                  <span class="card-detail">State</span>
                  <!-- Offline wins over every other status: a dropped device's
                       PENDING/ERROR/WARN is frozen at whatever it was when the
                       link died, so only the last-known state is worth showing
                       (greyed, to read as stale rather than current truth). -->
                  <span
                    class="state-indicator"
                    :class="{
                      open:          getDisplayedOpen(id) && !isControlOffline(id) && !isControlPending(id) && !isControlWarning(id) && !isControlError(id),
                      'ctrl-offline': isControlOffline(id),
                      'ctrl-pending': isControlPending(id) && !isControlOffline(id),
                      'ctrl-error':   isControlError(id) && !isControlPending(id) && !isControlOffline(id),
                      'ctrl-warning': isControlWarning(id) && !isControlError(id) && !isControlOffline(id),
                    }"
                  >
                    <span class="state-led" />
                    <span v-if="isControlOffline(id)">{{ getDisplayedOpen(id) ? 'OPEN' : 'CLOSED' }}</span>
                    <span v-else-if="isControlPending(id)">PENDING…</span>
                    <span v-else-if="isControlError(id)">ERROR</span>
                    <span v-else-if="isControlWarning(id)">WARN</span>
                    <span v-else>{{ getDisplayedOpen(id) ? 'OPEN' : 'CLOSED' }}</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ── Sensor cards (PT / TC / LC) ── -->
        <div
          v-for="sensor in sensors"
          :key="sensor.id"
          :style="positionBeside(sensor.id, sideFor(sensor.id, 'bottom'), 8)"
          :data-pid-cell="sensor.id"
          :data-pid-pinned="isPinned(sensor.id)"
          class="pid-overlay"
        >
          <div class="sensor-card" :class="{ locked: !isSensorEnabled(sensor.id) }">
            <div class="card-id">
              {{ sensor.id }}
              <span v-if="!isSensorEnabled(sensor.id)" class="lock-badge">NO SENSOR</span>
            </div>
            <div class="sensor-reading">
              <span class="reading-value">{{ getLiveValue(sensor.id) }}</span>
              <span class="reading-unit">{{ sensor.unit }}</span>
            </div>
          </div>
        </div>

        <!-- ── Manual valve name cards (below) ── -->
        <div
          v-for="id in mvs"
          :key="id"
          :style="positionBeside(id, sideFor(id, 'bottom'), 8)"
          :data-pid-cell="id"
          class="pid-overlay"
        >
          <div class="info-card">{{ id }}</div>
        </div>

        <!-- ── Tank name cards (centred) ── -->
        <div
          v-for="id in tanks"
          :key="id"
          :style="positionOf(id)"
          :data-pid-cell="id"
          class="pid-overlay"
        >
          <div class="info-card">{{ id }}</div>
        </div>

        <!-- ── Regulator name cards (right) ── -->
        <div
          v-for="id in regulators"
          :key="id"
          :style="positionBeside(id, sideFor(id, 'right'), 8)"
          :data-pid-cell="id"
          class="pid-overlay"
        >
          <div class="info-card">{{ id }}</div>
        </div>

      </template>
    </PidDiagram>

    <!-- ── E-STOP button (fixed top-right) ── -->
    <button v-if="!readOnly" class="estop-btn" @click="showEstopConfirm = true">
      E-STOP
      <span v-if="estopKey" class="estop-keybind">[{{ estopKey }}]</span>
    </button>

    <!-- ── Switches left unreconciled after a prompt was dismissed ── -->
    <button
      v-if="!readOnly && !syncOpen && outOfSync.length > 0"
      class="sync-chip"
      @click="reviewOpen = true"
    >
      <i class="pi pi-exclamation-triangle" />
      {{ outOfSync.length }} switch{{ outOfSync.length === 1 ? '' : 'es' }} out of sync
      <span class="sync-chip-action">Review</span>
    </button>

    <!-- The reconciliation prompt and the E-STOP confirmation dialog live in
         App.vue — both can be raised by a key press from any view, so neither
         can be owned by a component that unmounts when the view changes. -->
  </div>
</template>

<style scoped>
#control-panel {
  position: relative;
  width: 100%;
  height: 100vh;
  overflow: hidden;
}

/* ── Popup card shared base ── */

/* Overlay cards are sized in fixed px while the P&ID itself scales to fit its
   container, so on a tablet they eat a far larger share of the diagram than they
   do on a desktop monitor. One variable drives every card type; 1 leaves desktop
   untouched.
   `zoom` — not `transform: scale()` — is what shrinks them: zoom changes a card's
   *used layout size*, so the collision pass in usePidOverlay measures and reserves
   the smaller box. A transform is visual only, and the solver would keep spacing
   cards as if they were still full size. It has to stay on the card rather than on
   .pid-overlay: the wrapper carries JS-computed left/top in px, which zoom would
   scale along with everything else and throw the anchoring off. */
#control-panel {
  --pid-card-scale: 1;
}

/* iPad Pro 12.9" landscape (1366) and most laptops below it. */
@media (max-width: 1400px) {
  #control-panel { --pid-card-scale: 0.85; }
}

/* iPad 10.2"/11" landscape (1024–1194) and anything narrower. */
@media (max-width: 1200px) {
  #control-panel { --pid-card-scale: 0.72; }
}

.valve-card,
.sensor-card,
.info-card {
  zoom: var(--pid-card-scale);
}

.valve-card,
.sensor-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 4px 6px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  min-width: 0;
  cursor: default;
  user-select: none;
}

.card-id {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 0px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

/* ── Out-of-sync switch chip ── */
/* Bottom-left, clear of the E-STOP button and the aux panel. Deliberately a
   single chip rather than a badge per card: a stale switch is a fact about the
   panel in front of the operator, not about any one valve on the diagram. */

.sync-chip {
  position: absolute;
  bottom: 12px;
  left: 12px;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-surface);
  border: 1px solid #f39c12;
  border-radius: 6px;
  color: #f39c12;
  font-family: inherit;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.3px;
  padding: 5px 10px;
  cursor: pointer;
  box-shadow: 0 0 8px rgba(243, 156, 18, 0.25);
}

.sync-chip:hover {
  background: rgba(243, 156, 18, 0.12);
}

.sync-chip .pi {
  font-size: 11px;
}

.sync-chip-action {
  color: var(--text-muted);
  font-weight: 400;
  text-decoration: underline;
}

/* ── Keyboard shortcut hint ── */
/* Only E-STOP carries one. The cards deliberately do not: at card scale the
   hint is unreadable, and with separate open/close keys there is no single
   key to print on a card anyway. Settings is where bindings are read. */

.estop-keybind {
  font-size: 9px;
  color: inherit;
  letter-spacing: normal;
  opacity: 0.75;
}

/* ── Locked state ── */

.valve-card.locked,
.sensor-card.locked {
  opacity: 0.45;
  cursor: not-allowed;
}

.valve-card.locked .valve-card-body,
.sensor-card.locked .sensor-reading {
  pointer-events: none;
}

/* ── Pending state — yellow border ── */

.valve-card.pending {
  border-color: #f39c12;
  box-shadow: 0 0 5px rgba(243, 156, 18, 0.4);
}

/* ── Warning state — orange/red border ── */

.valve-card.warning {
  border-color: #e74c3c;
  box-shadow: 0 0 5px rgba(231, 76, 60, 0.4);
}

/* ── Error state — device reported a fault applying this control.
   Distinct from .warning (a transient, self-clearing NACK/timeout): this
   persists until the server clears reported_status, so it pulses to read as
   "needs attention" rather than "still working". ── */

.valve-card.error {
  border-color: #ff2d20;
  box-shadow: 0 0 6px rgba(255, 45, 32, 0.55);
  animation: error-pulse 1.4s ease-in-out infinite;
}

@keyframes error-pulse {
  0%, 100% { box-shadow: 0 0 4px  rgba(255, 45, 32, 0.35); }
  50%      { box-shadow: 0 0 9px  rgba(255, 45, 32, 0.75); }
}

@media (prefers-reduced-motion: reduce) {
  .valve-card.error { animation: none; }
}

/* ── Offline state — the owning device disconnected.
   Greyed like .locked (both mean "not commandable"), but kept a touch more
   legible and outlined with a dashed border so the last-known state stays
   readable and the card reads as stale rather than never-wired. ── */

.valve-card.offline {
  opacity: 0.55;
  border-style: dashed;
  border-color: var(--border-color);
  box-shadow: none;
  animation: none;
}

.aux-row.offline {
  opacity: 0.55;
}

.lock-badge,
.warn-badge,
.err-badge,
.offline-badge {
  font-size: 6px;
  font-weight: 600;
  letter-spacing: 0.2px;
  border-radius: 2px;
  padding: 0px 2px;
  white-space: nowrap;
  line-height: 1.1;
}

.lock-badge {
  color: var(--text-muted);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
}

.offline-badge {
  color: var(--text-muted);
  background: var(--bg-surface);
  border: 1px dashed var(--text-muted);
}

.warn-badge {
  color: #e74c3c;
  background: rgba(231, 76, 60, 0.12);
  border: 1px solid #e74c3c;
}

/* Solid fill (vs the outlined warn badge) so error reads louder at a glance. */
.err-badge {
  color: #fff;
  background: #ff2d20;
  border: 1px solid #ff2d20;
  font-weight: 700;
}

/* ── Valve card ── */

.valve-card-body {
  display: flex;
  align-items: stretch;
  gap: 6px;
}

.valve-info {
  flex: 1;
  min-width: 0;
}

.valve-toggle-col {
  display: flex;
  align-items: center;
  justify-content: center;
  border-right: 1px solid var(--border-color);
  padding: 2px 5px 0;
  --p-toggleswitch-width: 30px;
  --p-toggleswitch-height: 12px;
  --p-toggleswitch-handle-size: 8px;
}

.valve-toggle-col :deep(.p-toggleswitch) {
  transform: rotate(-90deg);
  margin: 14px -14px;
  padding: 0;
}

.card-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  margin-bottom: -2px;
}

.card-detail {
  font-size: 8px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.2px;
}

.card-badge {
  font-size: 8px;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border-radius: 2px;
  padding: 0px 4px;
}

.state-indicator {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 8px;
  font-weight: 600;
  color: var(--text-secondary);
  min-width: 40px;
}

/* Valve state — open = green */
.state-indicator.open { color: #2ecc71; }

/* Pending = yellow */
.state-indicator.ctrl-pending { color: #f39c12; }

/* Warning = red */
.state-indicator.ctrl-warning { color: #e74c3c; }
.state-indicator.ctrl-error   { color: #ff2d20; font-weight: 700; }

/* Offline = grey, unlit — the state shown is last-known, not live */
.state-indicator.ctrl-offline,
.state-indicator.relay-offline { color: var(--text-muted); font-weight: 600; }

.state-led {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--border-accent);
  flex-shrink: 0;
  transition: background 0.2s, box-shadow 0.2s;
}

.state-indicator.ctrl-offline .state-led,
.state-indicator.relay-offline .state-led {
  background: var(--text-muted);
  box-shadow: none;
  opacity: 0.6;
  animation: none;
}

.state-indicator.open .state-led {
  background: #2ecc71;
  box-shadow: 0 0 4px rgba(46, 204, 113, 0.6);
}

.state-indicator.ctrl-pending .state-led {
  background: #f39c12;
  box-shadow: 0 0 4px rgba(243, 156, 18, 0.6);
}

.state-indicator.ctrl-warning .state-led {
  background: #e74c3c;
  box-shadow: 0 0 4px rgba(231, 76, 60, 0.5);
}

.state-indicator.ctrl-error .state-led,
.state-indicator.relay-error .state-led {
  background: #ff2d20;
  box-shadow: 0 0 5px rgba(255, 45, 32, 0.8);
  animation: error-pulse 1.4s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .state-indicator.ctrl-error .state-led,
  .state-indicator.relay-error .state-led { animation: none; }
}

/* Relay state — closed = energised = green, open = de-energised = red */
.state-indicator.relay-closed { color: #2ecc71; }
.state-indicator.relay-closed .state-led {
  background: #2ecc71;
  box-shadow: 0 0 4px rgba(46, 204, 113, 0.6);
}

.state-indicator.relay-open { color: #e74c3c; }
.state-indicator.relay-open .state-led {
  background: #e74c3c;
  box-shadow: 0 0 4px rgba(231, 76, 60, 0.5);
}

.state-indicator.relay-pending { color: #f39c12; }
.state-indicator.relay-pending .state-led {
  background: #f39c12;
  box-shadow: 0 0 4px rgba(243, 156, 18, 0.6);
}

.state-indicator.relay-error { color: #ff2d20; font-weight: 700; }

.state-indicator.relay-warning { color: #e74c3c; }
.state-indicator.relay-warning .state-led {
  background: #e74c3c;
  box-shadow: 0 0 4px rgba(231, 76, 60, 0.5);
}

/* ── Sensor card ── */

.sensor-reading {
  display: flex;
  align-items: baseline;
  gap: 3px;
  margin-top: 1px;
}

.reading-value {
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
  line-height: 1;
}

.reading-unit {
  font-size: 9px;
  color: var(--text-muted);
}

/* ── Fixed top-left stack ── */
/* Holds the aux panel and the saturation card in one column in the drawing's
   empty corner. z-index is a deliberate change: the aux panel used to have none,
   so a displaced sensor card could paint over it. With a chart in the stack,
   covering a stray card reads better than being half-covered by one. */

.tl-stack {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: flex-start;  /* otherwise flex stretches both to one width */
  gap: 8px;
  width: max-content;
  max-width: 42%;
  pointer-events: none;
}

/* ── Auxiliary controls panel ── */

/* Placement moved to .tl-stack — an absolutely-positioned child would leave the
   column's flow and let the saturation card slide up underneath it. */
.aux-panel {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  min-width: 200px;
  cursor: default;
  user-select: none;
}

.aux-header {
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-muted);
  padding: 4px 8px 3px;
  border-bottom: 1px solid var(--border-color);
}

.aux-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-color);
}

.aux-row:last-child {
  border-bottom: none;
}

.aux-label {
  font-size: 9px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 0.2px;
  flex: 1;
}

.aux-toggle {
  --p-toggleswitch-width: 30px;
  --p-toggleswitch-height: 12px;
  --p-toggleswitch-handle-size: 8px;
  /* CLOSED/ON (checked) = green; OPEN/OFF (unchecked) = red */
  --p-toggleswitch-checked-background: #2ecc71;
  --p-toggleswitch-checked-hover-background: #27ae60;
  --p-toggleswitch-background: #e74c3c;
  --p-toggleswitch-hover-background: #c0392b;
  flex-shrink: 0;
}

.aux-section-sep {
  height: 1px;
  background: var(--border-color);
  margin: 2px 0;
}

.aux-section-label {
  font-size: 7px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-muted);
  padding: 3px 8px 1px;
}

/* ── Variable (numeric) controls ── */

.variable-row {
  position: relative;
}

.aux-row .card-badge {
  width: 38px;
  flex: 0 0 auto;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aux-row .state-indicator {
  width: 54px;
  flex: 0 0 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.variable-unit {
  margin-left: 2px;
  color: var(--text-muted);
  font-weight: 600;
}

.variable-edit-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 18px;
  flex-shrink: 0;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  background: transparent;
  color: var(--text-muted);
  font-size: 8px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.variable-edit-btn:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: var(--text-muted);
}

.variable-edit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.variable-popover {
  position: absolute;
  top: calc(100% + 7px);
  right: 8px;
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: 5px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  padding: 7px 8px;
}

.variable-popover-caret {
  position: absolute;
  top: -5px;
  right: 14px;
  width: 8px;
  height: 8px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  border-left: 1px solid var(--border-color);
  transform: rotate(45deg);
}

.variable-popover-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.variable-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.variable-input {
  width: 70px;
  font-size: 10px;
  font-family: monospace;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 3px;
  color: var(--text-primary);
  padding: 3px 5px;
}

.variable-input.has-unit {
  padding-right: 20px;
}

.variable-input:focus {
  outline: none;
  border-color: var(--input-focus-border);
}

.variable-input-unit {
  position: absolute;
  right: 6px;
  font-size: 9px;
  font-weight: 600;
  color: var(--text-muted);
  pointer-events: none;
}

.variable-confirm-btn,
.variable-cancel-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  font-size: 9px;
  border-radius: 3px;
  padding: 0;
  cursor: pointer;
  border: 1px solid var(--border-color);
  transition: background 0.12s, border-color 0.12s;
}

.variable-confirm-btn {
  background: #2ecc71;
  border-color: #2ecc71;
  color: #fff;
}

.variable-confirm-btn:hover:not(:disabled) {
  background: #27ae60;
}

.variable-confirm-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.variable-cancel-btn {
  background: transparent;
  color: var(--text-secondary);
}

.variable-cancel-btn:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

/* ── View-only banner (web build; sits where E-STOP does on desktop) ── */

.view-only-banner {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  user-select: none;
}

/* ── E-STOP button ── */

.estop-btn {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 100;
  background: #c0392b;
  color: #fff;
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 1.5px;
  border: 2px solid #e74c3c;
  border-radius: 4px;
  padding: 6px 16px;
  cursor: pointer;
  box-shadow: 0 0 10px rgba(231, 76, 60, 0.5);
  transition: background 0.15s, box-shadow 0.15s;
  user-select: none;
}

.estop-btn:hover {
  background: #e74c3c;
  box-shadow: 0 0 16px rgba(231, 76, 60, 0.75);
}

/* The E-STOP confirmation dialog's styles moved to App.vue with the dialog. */

/* ── Info cards (MV, Tank, Regulator) ── */

.info-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  padding: 2px 5px;
  font-size: 8px;
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
  cursor: default;
  user-select: none;
  opacity: 0.85;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}
</style>
