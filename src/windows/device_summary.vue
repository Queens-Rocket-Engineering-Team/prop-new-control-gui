<script setup>
import { ref, inject } from 'vue'

const serverConfig = inject('serverConfig', ref(null))

const CATEGORY_LABELS = {
  thermocouples: 'Thermocouple',
  pressureTransducers: 'Pressure Transducer',
  loadCells: 'Load Cell',
  current: 'Current Sensor',
  resistance: 'Resistance Sensor',
}

function getControls(deviceConfig) {
  return Object.entries(deviceConfig.controls ?? {}).map(([name, cfg]) => ({
    name,
    type: cfg.type ?? '—',
    defaultState: cfg.defaultState ?? '—',
    pin: cfg.pin ?? '—',
  }))
}

function getSensors(deviceConfig) {
  const result = []
  for (const [category, items] of Object.entries(deviceConfig.sensorInfo ?? {})) {
    if (typeof items !== 'object' || Array.isArray(items)) continue
    for (const name of Object.keys(items)) {
      result.push({ name, type: CATEGORY_LABELS[category] ?? category })
    }
  }
  return result
}
</script>

<template>
  <div id="device-summary">
    <div class="summary-header">
      <span class="summary-title">Connected Devices</span>
      <span v-if="serverConfig" class="device-count-badge">
        {{ serverConfig.count }} device{{ serverConfig.count !== 1 ? 's' : '' }}
      </span>
    </div>

    <div v-if="!serverConfig" class="no-connection">
      <i class="pi pi-server" style="font-size: 28px; margin-bottom: 10px;" />
      <p>No server connected.</p>
      <p class="hint">Configure a server IP in settings to see device information.</p>
    </div>

    <div v-else class="device-list">
      <div
        v-for="(config, deviceKey) in serverConfig.configs"
        :key="deviceKey"
        class="device-card"
      >
        <!-- Device banner -->
        <div class="device-banner">
          <span class="device-name">{{ config.deviceName ?? deviceKey }}</span>
          <span class="device-type-badge">{{ config.deviceType ?? 'Device' }}</span>
        </div>

        <!-- Controls + Sensors side by side -->
        <div class="device-body">

          <!-- Controls table -->
          <div class="device-section">
            <div class="section-header">
              Controls
              <span class="count-badge">{{ getControls(config).length }}</span>
            </div>
            <p v-if="getControls(config).length === 0" class="empty-msg">No controls configured</p>
            <table v-else class="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Default</th>
                  <th>Pin</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="ctrl in getControls(config)" :key="ctrl.name">
                  <td class="name-cell">{{ ctrl.name }}</td>
                  <td>{{ ctrl.type }}</td>
                  <td>
                    <span
                      class="state-badge"
                      :class="ctrl.defaultState === 'CLOSED' ? 'state-closed' : 'state-open'"
                    >{{ ctrl.defaultState }}</span>
                  </td>
                  <td class="mono">{{ ctrl.pin }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Sensors table -->
          <div class="device-section">
            <div class="section-header">
              Sensors
              <span class="count-badge">{{ getSensors(config).length }}</span>
            </div>
            <p v-if="getSensors(config).length === 0" class="empty-msg">No sensors configured</p>
            <table v-else class="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="sensor in getSensors(config)" :key="sensor.name">
                  <td class="name-cell">{{ sensor.name }}</td>
                  <td>{{ sensor.type }}</td>
                </tr>
              </tbody>
            </table>
          </div>

        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
#device-summary {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  padding: 14px 16px;
  box-sizing: border-box;
}

/* ── Header ── */

.summary-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}

.summary-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 0.3px;
}

.device-count-badge {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 1px 8px;
}

/* ── No connection placeholder ── */

.no-connection {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 180px;
  color: var(--text-muted);
  text-align: center;
  gap: 2px;
  font-size: 13px;
}

.no-connection .hint {
  font-size: 11px;
  opacity: 0.7;
}

/* ── Device list ── */

.device-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.device-card {
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
}

/* ── Device banner ── */

.device-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 14px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-color);
}

.device-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 0.5px;
  font-family: monospace;
}

.device-type-badge {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  padding: 2px 7px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

/* ── Device body: sections side by side ── */

.device-body {
  display: flex;
  background: var(--bg-secondary);
}

.device-section {
  flex: 1;
  padding: 10px 14px 12px;
  border-right: 1px solid var(--border-color);
  min-width: 0;
}

.device-section:last-child {
  border-right: none;
}

/* ── Section header ── */

.section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-weight: 700;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 7px;
}

.count-badge {
  font-size: 10px;
  font-weight: 600;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 0 6px;
  color: var(--text-muted);
}

.empty-msg {
  font-size: 11px;
  color: var(--text-muted);
  margin: 0;
  padding: 2px 0;
}

/* ── Data table ── */

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.data-table th {
  text-align: left;
  padding: 2px 10px 4px 0;
  color: var(--text-muted);
  font-weight: 600;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.2px;
  border-bottom: 1px solid var(--border-color);
}

.data-table td {
  padding: 3px 10px 3px 0;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
}

.data-table tr:last-child td {
  border-bottom: none;
}

.name-cell {
  font-weight: 600;
  font-family: monospace;
  color: var(--text-primary);
}

.mono {
  font-family: monospace;
  color: var(--text-secondary);
}

/* ── Default state badges ── */

.state-badge {
  font-size: 9px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 2px;
  text-transform: uppercase;
  letter-spacing: 0.2px;
}

.state-closed {
  background: rgba(231, 76, 60, 0.15);
  color: #e74c3c;
}

.state-open {
  background: rgba(46, 204, 113, 0.15);
  color: #2ecc71;
}
</style>
