<script setup>
import { ref, inject, computed } from 'vue'
import ToggleSwitch from 'primevue/toggleswitch'
import PidDiagram from '../components/PidDiagram.vue'
import { useServerApi } from '../composables/useServerApi.js'

const serverIp = inject('serverIp', ref(''))
const serverConfig = inject('serverConfig', ref(null))
const { sendCommand } = useServerApi(serverIp)

// Normalize an ID to alphanumeric lowercase for fuzzy matching.
// e.g. 'AV-DUMP' → 'avdump', 'AVDump' → 'avdump'
function normalizeId(id) {
  return id.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

// Set of normalized control keys from every connected device.
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

// A drawio valve ID is enabled if any server control key's normalized form
// starts with the normalized drawio ID (handles numbered variants like AVPurge1).
function isValveEnabled(drawioId) {
  const norm = normalizeId(drawioId)
  for (const key of enabledControls.value) {
    if (key.startsWith(norm)) return true
  }
  return false
}

// Remotely actuated valves — keyed by drawio element ID.
// defaultState: 'NC' = normally closed, 'NO' = normally open.
const valves = ref({
  'AV-DUMP':      { label: 'AV Dump',      state: false, defaultState: 'NC' },
  'AV-FILL-DUMP': { label: 'AV Fill Dump', state: false, defaultState: 'NC' },
  'AV-N2-FILL':   { label: 'AV N2 Fill',   state: false, defaultState: 'NC' },
  'AV-N2O-FILL':  { label: 'AV N2O Fill',  state: false, defaultState: 'NC' },
  'AV-PURGE':     { label: 'AV Purge',     state: false, defaultState: 'NC' },
  'AV-RUN':       { label: 'AV Run',       state: false, defaultState: 'NC' },
  'AV-VENT':      { label: 'AV Vent',      state: false, defaultState: 'NC' },
})

async function onValveToggle(id, newState) {
  console.log("Toggling valve", id, "to", newState)
  const valve = valves.value[id]
  if (!valve) return

  valve.state = newState  // optimistic update

  try {
    await sendCommand('CONTROL', [id, newState ? 'OPEN' : 'CLOSE'])
  } catch (err) {
    console.error(`[ControlPanel] CONTROL ${id} failed:`, err)
    valve.state = !newState  // revert on failure
  }
}

// Pressure transducers — keyed by drawio element ID.
const sensors = ref({
  'PT-N2-SUPPLY':  { label: 'N2 Supply',  value: null, unit: 'psi' },
  'PT-N2O-SUPPLY': { label: 'N2O Supply', value: null, unit: 'psi' },
  'PT-C-CHAMBER':  { label: 'Chamber',    value: null, unit: 'psi' },
  'PT-RUN':        { label: 'Run Line',   value: null, unit: 'psi' },
})
</script>

<template>
  <div id="control-panel">
    <PidDiagram svg-url="/P&IDs/Rocket-P&ID-01-03-2026.svg">
      <template #default="{ positionBeside }">

        <!-- Valve popup card: one per actuated valve -->
        <div
          v-for="(valve, id) in valves"
          :key="id"
          :style="positionBeside(id, 'right', -40)"
          class="pid-overlay"
        >
          <div class="valve-card" :class="{ open: valve.state, locked: !isValveEnabled(id) }">
            <div class="card-id">
              {{ id }}
              <span v-if="!isValveEnabled(id)" class="lock-badge">NO CTRL</span>
            </div>
            <div class="valve-card-body">
              <div class="valve-toggle-col">
                <ToggleSwitch
                  :modelValue="valve.state"
                  :disabled="!isValveEnabled(id)"
                  @update:modelValue="onValveToggle(id, $event)"
                />
              </div>
              <div class="valve-info">
                <div class="card-row">
                  <span class="card-detail">Default</span>
                  <span class="card-badge">{{ valve.defaultState }}</span>
                </div>
                <div class="card-row">
                  <span class="card-detail">State</span>
                  <span class="state-indicator" :class="{ open: valve.state }">
                    <span class="state-led" />
                    {{ valve.state ? 'OPEN' : 'CLOSED' }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Sensor popup card: one per pressure transducer -->
        <div
          v-for="(sensor, id) in sensors"
          :key="id"
          :style="positionBeside(id, 'left', 60)"
          class="pid-overlay"
        >
          <div class="sensor-card">
            <div class="card-id">{{ id }}</div>
            <div class="sensor-reading">
              <span class="reading-value">
                {{ sensor.value !== null ? sensor.value : '—' }}
              </span>
              <span class="reading-unit">{{ sensor.unit }}</span>
            </div>
          </div>
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
  margin-bottom: 0px;
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 0px;
}

/* ── Valve card ── */

/* ── Valve card body: info left, toggle right ── */

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
  padding: 2px 5px  0;
  --p-toggleswitch-width: 30px;
  --p-toggleswitch-height: 12px;
  --p-toggleswitch-handle-size: 8px;
}

/* Rotate the toggle switch to be vertical */
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

.state-indicator.open {
  color: #2ecc71;
}

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

/* ── Locked valve card ── */

.valve-card.locked {
  opacity: 0.45;
  cursor: not-allowed;
}

.valve-card.locked .valve-card-body {
  pointer-events: none;
}

.lock-badge {
  float: right;
  font-size: 7px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: var(--text-muted);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 2px;
  padding: 0px 3px;
  margin-left: 4px;
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
</style>
