<script setup>
import { ref, inject, computed, reactive, watch } from 'vue'
import ToggleSwitch from 'primevue/toggleswitch'
import PidDiagram from '../components/PidDiagram.vue'
import { useServerApi } from '../composables/useServerApi.js'

const serverIp     = inject('serverIp',     ref(''))
const devices      = inject('devices',      ref([]))
const commandsById = inject('commandsById', ref(new Map()))
const pidConfig    = inject('pidConfig',    ref('rocket-launch'))
const sensorData   = inject('sensorData',   ref({}))
const tares        = inject('tares',        ref({}))
const kasaDevices  = inject('kasaDevices',  ref([]))
const setKasaState = inject('setKasaState', () => {})
const requestStatusSnapshot = inject('requestStatusSnapshot', () => Promise.resolve())

const { setControl, sendEstop } = useServerApi(serverIp)

// ── Emergency stop ───────────────────────────────────────────────────────────

const showEstopConfirm = ref(false)
const estopPending     = ref(false)

async function confirmEstop() {
  estopPending.value = true
  try {
    await sendEstop()
    await requestStatusSnapshot('estop')
  } catch (err) {
    console.error('[ControlPanel] ESTOP failed:', err)
  } finally {
    estopPending.value     = false
    showEstopConfirm.value = false
  }
}

// ── SVG URL mapping ──────────────────────────────────────────────────────────

const SVG_URLS = {
  'hot-fire':      '/P&IDs/Hot-Fire-P&ID-26-05-2026.svg',
  'rocket-launch': '/P&IDs/Rocket-P&ID-01-03-2026.svg',
}

const svgUrl = computed(() => SVG_URLS[pidConfig.value] ?? SVG_URLS['rocket-launch'])

// ── Dynamic element lists (populated from parsed SVG cells) ──────────────────

const valves     = ref([])    // drawio IDs starting with AV
const sensors    = ref([])    // [{ id, unit }, ...]
const mvs        = ref([])
const tanks      = ref([])
const regulators = ref([])

function onCellsParsed(cells) {
  const newValves = [], newSensors = [], newMvs = [], newTanks = [], newRegs = []

  for (const id of Object.keys(cells)) {
    const up = id.toUpperCase()
    if      (up.startsWith('AV'))         newValves.push(id)
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

// ── ID normalisation ─────────────────────────────────────────────────────────

// Strip non-alphanumeric, lowercase — for fuzzy matching against server names.
function normalizeId(id) {
  return id.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

// Display label: strip non-alphanumeric, UPPERCASE.
function toControlKey(id) {
  return id.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
}

// ── Control + sensor indexes (flat maps keyed by normalizeId) ─────────────────

// Flattens all device controls into a Map: normalizeId(name) → control object
// (with added deviceName for context). Used for fuzzy drawio-ID → server-name matching.
const normalizedControlLookup = computed(() => {
  const map = new Map()
  for (const dev of devices.value) {
    for (const ctrl of (dev.controls ?? [])) {
      map.set(normalizeId(ctrl.name), { ...ctrl, deviceName: dev.name })
    }
  }
  return map
})

// Map: control.name → control object (for direct name lookups)
const controlLookup = computed(() => {
  const map = new Map()
  for (const dev of devices.value) {
    for (const ctrl of (dev.controls ?? [])) {
      map.set(ctrl.name, ctrl)
    }
  }
  return map
})

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

// ── Fuzzy matching: drawio ID → server controls ───────────────────────────────
// A server control matches a drawio ID when normalizeId(control.name) starts with
// normalizeId(drawioId). This covers numbered variants:
//   drawio "AV-PURGE" (norm "avpurge") matches "AVPurge1" (norm "avpurge1") and "AVPurge2".
// Returns only the longest-matching controls (most specific).

function getMatchingControls(drawioId) {
  const norm = normalizeId(drawioId)
  const results = []
  let bestLen = 0
  for (const [normKey, ctrl] of normalizedControlLookup.value) {
    if (normKey.startsWith(norm)) {
      if (normKey.length > bestLen) bestLen = normKey.length
      results.push({ normKey, ctrl })
    }
  }
  return results.filter(m => m.normKey.length === bestLen).map(m => m.ctrl)
}

function isValveEnabled(drawioId) {
  return getMatchingControls(drawioId).length > 0
}

function getValveDefaultState(drawioId) {
  const ctrls = getMatchingControls(drawioId)
  return ctrls.length > 0 ? (ctrls[0].default_state ?? '—') : '—'
}

// Server-authoritative displayed open state:
// prefer reported_state from STATUS/control.updated, fall back to accepted_state.
function getDisplayedOpen(drawioId) {
  const ctrls = getMatchingControls(drawioId)
  if (ctrls.length === 0) return false
  const state = ctrls[0].reported_state ?? ctrls[0].accepted_state
  return state === 'OPEN'
}

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

const normalizedTaresMap = computed(() => {
  const map = {}
  for (const [name, offset] of Object.entries(tares.value)) {
    map[normalizeId(name)] = offset
  }
  return map
})

function getLiveValue(drawioId) {
  const norm   = normalizeId(drawioId)
  const info   = normalizedSensorMap.value[norm]
  if (!info) return '—'
  const offset = normalizedTaresMap.value[norm] ?? 0
  const v      = info.value - offset
  const abs    = Math.abs(v)
  if (abs >= 1000) return v.toFixed(0)
  if (abs >= 10)   return v.toFixed(1)
  return v.toFixed(2)
}

// ── Auxiliary controls (non-AV server controls) ───────────────────────────────

const auxiliaryControls = computed(() => {
  const result = []
  for (const dev of devices.value) {
    for (const ctrl of (dev.controls ?? [])) {
      if (!normalizeId(ctrl.name).startsWith('av')) {
        result.push({
          key:          ctrl.name,
          label:        toControlKey(ctrl.name),
          defaultState: ctrl.default_state ?? '—',
        })
      }
    }
  }
  return result
})

// Relay semantics: CLOSED = energised = true; OPEN = de-energised = false.
function getAuxDisplayed(controlName) {
  const ctrl = controlLookup.value.get(controlName)
  if (!ctrl) return false
  const state = ctrl.reported_state ?? ctrl.accepted_state
  return state === 'CLOSED'
}

// ── Pending / NACK tracking ───────────────────────────────────────────────────
// 'pending[name]' = { requested: 'OPEN'|'CLOSED' }
// 'warning[name]' = { message: string, errorCode: string|null }

const pending = reactive({})
const warning = reactive({})

function _clearControl(name) {
  delete pending[name]
  delete warning[name]
}

// When device control state settles to the requested value, clear pending.
// When a command is nacked or timed out, clear pending and set warning.
watch([devices, commandsById], () => {
  for (const dev of devices.value) {
    for (const ctrl of (dev.controls ?? [])) {
      const p = pending[ctrl.name]
      if (!p) continue

      const serverState = ctrl.reported_state ?? ctrl.accepted_state
      if (serverState === p.requested) {
        _clearControl(ctrl.name)
        continue
      }

      // Check command lifecycle for NACK/timeout
      const cmdId = ctrl.pending_command_id
      if (!cmdId) continue
      const cmd = commandsById.value.get(cmdId)
      if (!cmd) continue
      if (cmd.state === 'nacked' || cmd.state === 'timed_out') {
        delete pending[ctrl.name]
        warning[ctrl.name] = {
          message:   cmd.state === 'nacked' ? 'NACK' : 'Timeout',
          errorCode: cmd.nack_error_code ?? null,
        }
      }
    }
  }
}, { deep: false })   // shallow watch is enough — devices ref is replaced on each publish

// Clear pending/warning when server IP or P&ID changes (stale keys)
watch([serverIp, pidConfig], () => {
  for (const key of Object.keys(pending)) delete pending[key]
  for (const key of Object.keys(warning)) delete warning[key]
})

function isControlPending(drawioId) {
  const ctrls = getMatchingControls(drawioId)
  for (const ctrl of ctrls) {
    if (pending[ctrl.name]) return true
    if (ctrl.pending_command_id) {
      const cmd = commandsById.value.get(ctrl.pending_command_id)
      if (cmd?.state === 'sent') return true
    }
  }
  return false
}

function isControlWarning(drawioId) {
  return getMatchingControls(drawioId).some(ctrl => !!warning[ctrl.name])
}

function isAuxPending(controlName) {
  if (pending[controlName]) return true
  const ctrl = controlLookup.value.get(controlName)
  if (ctrl?.pending_command_id) {
    const cmd = commandsById.value.get(ctrl.pending_command_id)
    if (cmd?.state === 'sent') return true
  }
  return false
}

function isAuxWarning(controlName) {
  return !!warning[controlName]
}

// ── Valve toggle ─────────────────────────────────────────────────────────────
// Server-authoritative: do NOT mutate displayed state. Show pending while in-flight.

async function onValveToggle(drawioId, newOpenState) {
  if (!isValveEnabled(drawioId)) return
  const controls  = getMatchingControls(drawioId)
  const requested = newOpenState ? 'OPEN' : 'CLOSED'

  for (const ctrl of controls) {
    pending[ctrl.name] = { requested }
    delete warning[ctrl.name]
    try {
      await setControl(ctrl.name, requested)
      requestStatusSnapshot('control')
    } catch (err) {
      console.error(`[ControlPanel] CONTROL ${ctrl.name} failed:`, err)
      delete pending[ctrl.name]
      warning[ctrl.name] = { message: String(err), errorCode: null }
    }
  }
}

// ── Aux toggle ───────────────────────────────────────────────────────────────

async function onAuxToggle(controlName, newEnergised) {
  // Relay: energised=true → CLOSED state; energised=false → OPEN
  const expected = newEnergised ? 'CLOSED' : 'OPEN'

  pending[controlName] = { requested: expected }
  delete warning[controlName]
  try {
    await setControl(controlName, expected)
    requestStatusSnapshot('control')
  } catch (err) {
    console.error(`[ControlPanel] CONTROL ${controlName} failed:`, err)
    delete pending[controlName]
    warning[controlName] = { message: String(err), errorCode: null }
  }
}
</script>

<template>
  <div id="control-panel">
    <PidDiagram :svg-url="svgUrl" @cells-parsed="onCellsParsed">
      <template #default="{ positionOf, positionBeside }">

        <!-- ── Auxiliary controls panel (fixed top-left) ── -->
        <div
          v-if="auxiliaryControls.length > 0 || kasaDevices.length > 0"
          class="pid-overlay aux-panel"
        >
          <div class="aux-header">Aux Controls</div>
          <div
            v-for="ctrl in auxiliaryControls"
            :key="ctrl.key"
            class="aux-row"
          >
            <span class="aux-label">{{ ctrl.label }}</span>
            <span class="card-badge">{{ ctrl.defaultState }}</span>
            <span
              class="state-indicator"
              :class="
                isAuxWarning(ctrl.key) ? 'relay-warning' :
                isAuxPending(ctrl.key) ? 'relay-pending' :
                getAuxDisplayed(ctrl.key) ? 'relay-closed' : 'relay-open'
              "
            >
              <span class="state-led" />
              <span v-if="isAuxPending(ctrl.key)">PENDING…</span>
              <span v-else-if="isAuxWarning(ctrl.key)">WARN</span>
              <span v-else>{{ getAuxDisplayed(ctrl.key) ? 'CLOSED' : 'OPEN' }}</span>
            </span>
            <ToggleSwitch
              :modelValue="getAuxDisplayed(ctrl.key)"
              :disabled="isAuxPending(ctrl.key)"
              @update:modelValue="onAuxToggle(ctrl.key, $event)"
              class="aux-toggle"
            />
          </div>

          <!-- Kasa Smart Plugs -->
          <template v-if="kasaDevices.length > 0">
            <div class="aux-section-sep" v-if="auxiliaryControls.length > 0" />
            <div class="aux-section-label">Smart Plugs</div>
            <div
              v-for="dev in kasaDevices"
              :key="dev.host"
              class="aux-row"
            >
              <span class="aux-label">{{ dev.alias || dev.host }}</span>
              <span class="state-indicator" :class="dev.active ? 'relay-closed' : 'relay-open'">
                <span class="state-led" />
                {{ dev.active ? 'ON' : 'OFF' }}
              </span>
              <ToggleSwitch
                :modelValue="dev.active"
                @update:modelValue="setKasaState(dev.host, $event)"
                class="aux-toggle"
              />
            </div>
          </template>
        </div>

        <!-- ── Actuated valve cards ── -->
        <div
          v-for="id in valves"
          :key="id"
          :style="{ ...positionBeside(id, 'bottom', -10), marginLeft: '-50px' }"
          class="pid-overlay"
        >
          <div
            class="valve-card"
            :class="{
              open:    getDisplayedOpen(id),
              locked:  !isValveEnabled(id),
              pending: isControlPending(id),
              warning: isControlWarning(id),
            }"
          >
            <div class="card-id">
              {{ id }}
              <span v-if="!isValveEnabled(id)" class="lock-badge">NO CTRL</span>
              <span v-else-if="isControlWarning(id)" class="warn-badge">WARN</span>
            </div>
            <div class="valve-card-body">
              <div class="valve-toggle-col">
                <ToggleSwitch
                  :modelValue="getDisplayedOpen(id)"
                  :disabled="!isValveEnabled(id) || isControlPending(id)"
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
                  <span
                    class="state-indicator"
                    :class="{
                      open:          getDisplayedOpen(id) && !isControlPending(id) && !isControlWarning(id),
                      'ctrl-pending': isControlPending(id),
                      'ctrl-warning': isControlWarning(id),
                    }"
                  >
                    <span class="state-led" />
                    <span v-if="isControlPending(id)">PENDING…</span>
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
          :style="{ ...positionBeside(sensor.id, 'bottom', -15), marginLeft: '-50px' }"
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
          :style="{ ...positionBeside(id, 'bottom', -10), marginLeft: '-60px' }"
          class="pid-overlay"
        >
          <div class="info-card">{{ id }}</div>
        </div>

        <!-- ── Tank name cards (centred) ── -->
        <div
          v-for="id in tanks"
          :key="id"
          :style="{ ...positionBeside(id, 'right', -55)}"
          class="pid-overlay"
        >
          <div class="info-card">{{ id }}</div>
        </div>

        <!-- ── Regulator name cards (right) ── -->
        <div
          v-for="id in regulators"
          :key="id"
          :style="{ ...positionBeside(id, 'right', -40), marginTop: '-15px' }"
          class="pid-overlay"
        >
          <div class="info-card">{{ id }}</div>
        </div>

      </template>
    </PidDiagram>

    <!-- ── E-STOP button (fixed top-right) ── -->
    <button class="estop-btn" @click="showEstopConfirm = true">E-STOP</button>

    <!-- ── E-STOP confirmation dialog ── -->
    <Teleport to="body">
      <div v-if="showEstopConfirm" class="estop-overlay" @click.self="showEstopConfirm = false">
        <div class="estop-dialog">
          <div class="estop-dialog-title">EMERGENCY STOP</div>
          <div class="estop-dialog-body">
            This will immediately send an emergency stop command to the server. <br>
            All actuated valves will reset to their default state and data streaming will stop. <br>
            Are you sure?
          </div>
          <div class="estop-dialog-actions">
            <button
              class="estop-confirm-btn"
              :disabled="estopPending"
              @click="confirmEstop"
            >{{ estopPending ? 'SENDING…' : 'CONFIRM E-STOP' }}</button>
            <button
              class="estop-cancel-btn"
              :disabled="estopPending"
              @click="showEstopConfirm = false"
            >Cancel</button>
          </div>
        </div>
      </div>
    </Teleport>
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

.lock-badge,
.warn-badge {
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

.warn-badge {
  color: #e74c3c;
  background: rgba(231, 76, 60, 0.12);
  border: 1px solid #e74c3c;
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

.state-led {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--border-accent);
  flex-shrink: 0;
  transition: background 0.2s, box-shadow 0.2s;
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

/* ── Auxiliary controls panel ── */

.aux-panel {
  position: absolute;
  top: 12px;
  left: 12px;
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

/* ── E-STOP confirmation dialog ── */

.estop-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
}

.estop-dialog {
  background: var(--bg-secondary);
  border: 2px solid #e74c3c;
  border-radius: 6px;
  padding: 24px 28px;
  min-width: 320px;
  box-shadow: 0 0 32px rgba(231, 76, 60, 0.4);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.estop-dialog-title {
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 1px;
  color: #e74c3c;
  text-align: center;
}

.estop-dialog-body {
  font-size: 13px;
  color: var(--text-primary);
  text-align: center;
  line-height: 1.5;
}

.estop-dialog-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.estop-confirm-btn {
  background: #c0392b;
  color: #fff;
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 1px;
  border: none;
  border-radius: 4px;
  padding: 8px 0;
  cursor: pointer;
  transition: background 0.15s;
}

.estop-confirm-btn:hover:not(:disabled) {
  background: #e74c3c;
}

.estop-confirm-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.estop-cancel-btn {
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 6px 0;
  cursor: pointer;
  transition: background 0.15s;
}

.estop-cancel-btn:hover:not(:disabled) {
  background: var(--bg-surface);
}

.estop-cancel-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

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
