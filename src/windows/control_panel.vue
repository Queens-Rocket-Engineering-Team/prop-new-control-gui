<script setup>
import { ref, inject, computed, watch } from 'vue'
import ToggleSwitch from 'primevue/toggleswitch'
import PidDiagram from '../components/PidDiagram.vue'
import { useServerApi } from '../composables/useServerApi.js'

const serverIp        = inject('serverIp',        ref(''))
const serverConfig    = inject('serverConfig',    ref(null))
const pidConfig       = inject('pidConfig',       ref('rocket-launch'))
const sensorData      = inject('sensorData',      ref({}))
const tares           = inject('tares',           ref({}))
const kasaDevices     = inject('kasaDevices',     ref([]))
const setKasaState    = inject('setKasaState',    () => {})
const valveStates     = inject('valveStates',     ref({}))
const auxiliaryStates = inject('auxiliaryStates', ref({}))
const valveStatusByControl = inject('valveStatusByControl', ref({}))
const { sendCommand, fetchStatus } = useServerApi(serverIp)

// ── SVG URL mapping (the only static config needed) ─────────────────────────

const SVG_URLS = {
  'hot-fire':      '/P&IDs/Hot-Fire-P&ID-01-03-2026.svg',
  'rocket-launch': '/P&IDs/Rocket-P&ID-01-03-2026.svg',
}

const svgUrl = computed(() => SVG_URLS[pidConfig.value] ?? SVG_URLS['rocket-launch'])

// ── Dynamic element lists (populated from parsed SVG cells) ──────────────────
// Categorised by ID prefix/pattern:
//   AV-*         → actuated valve toggle cards
//   PT-*         → pressure transducer sensor cards  (unit: psi)
//   TC-*         → thermocouple sensor cards          (unit: °C)
//   LC-*         → load-cell sensor cards             (unit: kg)
//   MV-*         → manual valve info cards (below element)
//   *TANK*       → tank info cards         (centred on element)
//   REGULATOR-*  → regulator info cards    (right of element)

const valves     = ref([])           // [id, ...]
const sensors    = ref([])           // [{ id, unit }, ...]
const mvs        = ref([])           // [id, ...]
const tanks      = ref([])           // [id, ...]
const regulators = ref([])           // [id, ...]

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

  // Preserve any user-toggled states; only default-initialise new valve IDs.
  const s = {}
  for (const id of newValves) {
    s[id] = id in valveStates.value ? valveStates.value[id] : false
  }
  valveStates.value = s
}

// Clear stale overlays immediately when the config switches (before the new
// SVG loads and fires cells-parsed).
watch(pidConfig, () => {
  valves.value     = []
  sensors.value    = []
  mvs.value        = []
  tanks.value      = []
  regulators.value = []
  valveStates.value = {}
})

// ── ID normalization ─────────────────────────────────────────────────────────

// Strip non-alphanumeric, lowercase — for fuzzy matching against server keys.
function normalizeId(id) {
  return id.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

// Control key sent to the server: strip non-alphanumeric, UPPERCASE.
// 'AV-DUMP' → 'AVDUMP', 'AV-N2FILL' → 'AVN2FILL'
function toControlKey(id) {
  return id.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
}

function getBestMatchingValveIds(statusControlKey) {
  const statusNorm = normalizeId(statusControlKey)
  const ids = Object.keys(valveStates.value)
  const matches = ids
    .map((id) => ({ id, norm: normalizeId(id) }))
    .filter(({ norm }) => statusNorm === norm || statusNorm.startsWith(norm))

  if (matches.length === 0) return []

  const bestLen = Math.max(...matches.map((m) => m.norm.length))
  return matches.filter((m) => m.norm.length === bestLen).map((m) => m.id)
}

// ── Server-enabled controls ──────────────────────────────────────────────────

const enabledControls = computed(() => {
  const cfg = serverConfig.value
  if (!cfg) return new Set()
  const keys = new Set()
  for (const device of Object.values(cfg.configs)) {
    for (const key of Object.keys(device.controls ?? {})) {
      keys.add(normalizeId(key))
    }
  }
  return keys
})

// A valve is enabled if any server control key starts with its normalised form.
// (handles numbered variants: AVPurge1 / AVPurge2 both match AV-PURGE)
function isValveEnabled(drawioId) {
  const norm = normalizeId(drawioId)
  for (const key of enabledControls.value) {
    if (key.startsWith(norm)) return true
  }
  return false
}

function getValveDefaultState(drawioId) {
  const norm = normalizeId(drawioId)
  const cfg = serverConfig.value
  if (!cfg) return '—'
  for (const device of Object.values(cfg.configs)) {
    for (const [key, ctrl] of Object.entries(device.controls ?? {})) {
      if (normalizeId(key).startsWith(norm)) return ctrl.defaultState ?? '—'
    }
  }
  return '—'
}

// ── Server-enabled sensors ───────────────────────────────────────────────────

const enabledSensors = computed(() => {
  const cfg = serverConfig.value
  if (!cfg) return new Set()
  const keys = new Set()
  for (const device of Object.values(cfg.configs)) {
    for (const category of Object.values(device.sensorInfo ?? {})) {
      if (typeof category !== 'object' || Array.isArray(category)) continue
      for (const key of Object.keys(category)) {
        keys.add(normalizeId(key))
      }
    }
  }
  return keys
})

function isSensorEnabled(drawioId) {
  const norm = normalizeId(drawioId)
  for (const key of enabledSensors.value) {
    if (key.startsWith(norm) || norm.startsWith(key)) return true
  }
  return false
}

// ── Live sensor value lookup ─────────────────────────────────────────────────
// sensorData keys are camelCase (e.g. "PTN2Supply"); drawio IDs use hyphens
// (e.g. "PT-N2-SUPPLY"). normalizeId strips all punctuation + lowercases both.

const normalizedSensorMap = computed(() => {
  const map = {}
  for (const [name, info] of Object.entries(sensorData.value)) {
    map[normalizeId(name)] = info
  }
  return map
})

// Maps normalizeId(sensorName) → tare offset, for O(1) lookup in getLiveValue.
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

// ── Auxiliary controls (non-AV controls from server config) ─────────────────
// Any control whose normalised name does NOT start with 'av' is shown here.

const auxiliaryControls = computed(() => {
  const cfg = serverConfig.value
  if (!cfg) return []
  const result = []
  for (const device of Object.values(cfg.configs)) {
    for (const [name, ctrl] of Object.entries(device.controls ?? {})) {
      if (!normalizeId(name).startsWith('av')) {
        result.push({
          key:          name,
          label:        toControlKey(name),   // e.g. "IgnPrime" → "IGNPRIME"
          defaultState: ctrl.defaultState ?? '—',
        })
      }
    }
  }
  return result
})

watch(serverConfig, (cfg) => {
  if (!cfg) { auxiliaryStates.value = {}; return }
  // Preserve any user-toggled states; only default-initialise new keys.
  const s = {}
  for (const device of Object.values(cfg.configs)) {
    for (const [name, ctrl] of Object.entries(device.controls ?? {})) {
      if (!normalizeId(name).startsWith('av')) {
        // Relay semantics: CLOSED = energised = true, OPEN = de-energised = false
        s[name] = name in auxiliaryStates.value
          ? auxiliaryStates.value[name]
          : (ctrl.defaultState ?? '').toUpperCase() === 'CLOSED'
      }
    }
  }
  auxiliaryStates.value = s
}, { immediate: true })

const lastAppliedStatusSeqByControl = ref({})

function applyValveStatusMap(statusMap) {
  const nextApplied = { ...lastAppliedStatusSeqByControl.value }

  for (const [controlKey, statusInfo] of Object.entries(statusMap ?? {})) {
    const seq = Number(statusInfo?.seq ?? 0)
    const lastSeq = Number(nextApplied[controlKey] ?? 0)
    if (!seq || seq <= lastSeq) continue

    const state = String(statusInfo?.state ?? '').toUpperCase()
    if (state !== 'OPEN' && state !== 'CLOSED') continue

    const matchedIds = getBestMatchingValveIds(controlKey)
    if (matchedIds.length === 0) continue

    for (const id of matchedIds) {
      valveStates.value[id] = state === 'OPEN'
    }

    nextApplied[controlKey] = seq
  }

  lastAppliedStatusSeqByControl.value = nextApplied
}

watch(valveStatusByControl, (statusMap) => {
  applyValveStatusMap(statusMap)
}, { deep: true })

watch(
  () => Object.keys(valveStates.value).sort().join('|'),
  () => {
    applyValveStatusMap(valveStatusByControl.value)
  }
)

watch(pidConfig, () => {
  lastAppliedStatusSeqByControl.value = {}
})

async function onAuxToggle(key, newState) {
  auxiliaryStates.value[key] = newState  // optimistic update
  try {
    // Relay semantics: true = CLOSED (energised) → send 'CLOSE'
    await sendCommand('CONTROL', [toControlKey(key), newState ? 'CLOSE' : 'OPEN'])
  } catch (err) {
    console.error(`[ControlPanel] CONTROL ${toControlKey(key)} failed:`, err)
    auxiliaryStates.value[key] = !newState  // revert on failure
  }
}

// ── Valve toggle ─────────────────────────────────────────────────────────────

async function onValveToggle(id, newState) {
  if (!isValveEnabled(id)) return
  const controlKey = toControlKey(id)

  try {
    valveStates.value[id] = newState  // optimistic update

    await sendCommand('CONTROL', [controlKey, newState ? 'OPEN' : 'CLOSE'])

    // Trigger fresh device STATUS reporting, but do not block UI on validation.
    fetchStatus().catch((err) => {
      console.error(`[ControlPanel] STATUS trigger after ${controlKey} failed:`, err)
    })
  } catch (err) {
    console.error(`[ControlPanel] CONTROL ${controlKey} failed:`, err)
    valveStates.value[id] = !newState  // revert on failure
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
            <span class="state-indicator" :class="auxiliaryStates[ctrl.key] ? 'relay-closed' : 'relay-open'">
              <span class="state-led" />
              {{ auxiliaryStates[ctrl.key] ? 'CLOSED' : 'OPEN' }}
            </span>
            <ToggleSwitch
              :modelValue="auxiliaryStates[ctrl.key]"
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
          <div class="valve-card" :class="{ open: valveStates[id], locked: !isValveEnabled(id) }">
            <div class="card-id">
              {{ id }}
              <span v-if="!isValveEnabled(id)" class="lock-badge">NO CTRL</span>
            </div>
            <div class="valve-card-body">
              <div class="valve-toggle-col">
                <ToggleSwitch
                  :modelValue="valveStates[id]"
                  :disabled="!isValveEnabled(id)"
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
                  <span class="state-indicator" :class="{ open: valveStates[id] }">
                    <span class="state-led" />
                    {{ valveStates[id] ? 'OPEN' : 'CLOSED' }}
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
  </div>
</template>

<style scoped>
#control-panel {
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

.lock-badge {
  font-size: 6px;
  font-weight: 600;
  letter-spacing: 0.2px;
  color: var(--text-muted);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 2px;
  padding: 0px 2px;
  white-space: nowrap;
  line-height: 1.1;
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
