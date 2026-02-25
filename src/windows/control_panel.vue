<script setup>
import { ref } from 'vue'
import ToggleSwitch from 'primevue/toggleswitch'
import PidDiagram from '../components/PidDiagram.vue'

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
    <PidDiagram svg-url="/Launch-P&ID.svg">
      <template #default="{ positionBeside }">

        <!-- Valve popup card: one per actuated valve -->
        <div
          v-for="(valve, id) in valves"
          :key="id"
          :style="positionBeside(id, 'right')"
          class="pid-overlay"
        >
          <div class="valve-card" :class="{ open: valve.state }">
            <div class="card-id">{{ id }}</div>
            <div class="valve-card-body">
              <div class="valve-toggle-col">
                <ToggleSwitch v-model="valve.state" />
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
          :style="positionBeside(id, 'right')"
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
  margin-bottom: 3px;
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 2px;
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
  padding: 0 4px 0 0;
  --p-toggleswitch-width: 40px;
  --p-toggleswitch-height: 12px;
  --p-toggleswitch-handle-size: 8px;
}

/* Rotate the toggle switch to be vertical */
.valve-toggle-col :deep(.p-toggleswitch) {
  transform: rotate(-90deg);
  /* Collapse the layout box to match the post-rotation visual size:
     native 40w×12h → visual 12w×40h after -90deg rotation.
     Horizontal excess: (40-12)/2 = 14px each side → negative margins.
     Vertical deficit:  same 14px each side → positive margins. */
  margin: 14px -14px;
  padding: 0;
}

.card-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
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
