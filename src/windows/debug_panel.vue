<script setup>
import { inject, ref, watch, nextTick } from 'vue'

const logLines  = inject('logLines',  ref([]))
const wsStatus  = inject('wsStatus',  ref('disconnected'))
const clearLogs = inject('clearLogs', () => {})

const logEl = ref(null)

// Auto-scroll to bottom whenever new lines arrive
watch(logLines, async () => {
  await nextTick()
  if (logEl.value) {
    logEl.value.scrollTop = logEl.value.scrollHeight
  }
}, { deep: true })
import { computed } from 'vue'

// Channel filter state
const availableChannels = [
  { key: 'log', label: 'Log' },
  { key: 'syslog', label: 'Syslog' },
  { key: 'errlog', label: 'Errlog' },
  { key: 'debuglog', label: 'Debuglog' },
]
const selectedChannels = ref(availableChannels.map(c => c.key))

// Filter log lines by selected channels
const filteredLogLines = computed(() => {
  if (selectedChannels.value.length === availableChannels.length) return logLines.value
  return logLines.value.filter(line => {
    // Match prefix: [sys], [log], [err], [debug]
    if (selectedChannels.value.includes('log') && line.startsWith('[log]')) return true
    if (selectedChannels.value.includes('syslog') && line.startsWith('[sys]')) return true
    if (selectedChannels.value.includes('errlog') && line.startsWith('[err]')) return true
    if (selectedChannels.value.includes('debuglog') && line.startsWith('[debug]')) return true
    return false
  })
})

// Auto-scroll to bottom whenever new lines arrive
watch(filteredLogLines, async () => {
  await nextTick()
  if (logEl.value) {
    logEl.value.scrollTop = logEl.value.scrollHeight
  }
}, { deep: true })
</script>

<template>
  <div class="debug-panel">
    <div class="debug-toolbar">
      <span class="debug-title">Server Logs</span>
      <span class="ws-status" :class="wsStatus">
        <span class="ws-led" />
        {{ wsStatus }}
      </span>
      <button class="clear-btn" @click="clearLogs()">Clear</button>
    </div>
        <div class="channel-filter">
          <label v-for="ch in availableChannels" :key="ch.key" class="channel-checkbox">
            <input
              type="checkbox"
              :value="ch.key"
              v-model="selectedChannels"
            />
            {{ ch.label }}
          </label>
        </div>

    <div class="log-output" ref="logEl">
      <div v-if="filteredLogLines.length === 0" class="log-empty">
        No log output yet…
      </div>
      <div
        v-for="(line, i) in filteredLogLines"
        :key="i"
        class="log-line"
      >{{ line }}</div>
    </div>
  </div>
</template>

<style scoped>
.debug-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
  font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
}

.debug-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
  flex-shrink: 0;
}

.debug-title {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-right: auto;
}

.ws-status {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.ws-led {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #555;
}

.ws-status.connected   { color: #2ecc71; }
.ws-status.connected .ws-led   { background: #2ecc71; box-shadow: 0 0 4px #2ecc71; }
.ws-status.connecting  { color: #f39c12; }
.ws-status.connecting .ws-led  { background: #f39c12; }
.ws-status.error       { color: #e74c3c; }
.ws-status.error .ws-led       { background: #e74c3c; }
.ws-status.disconnected .ws-led { background: #555; }

.clear-btn {
  font-size: 0.72rem;
  padding: 2px 8px;
  background: var(--btn-bg);
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
}

.clear-btn:hover {
  color: var(--text-primary);
  border-color: var(--border-accent);
}

.log-output {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px;
  font-size: 0.78rem;
  line-height: 1.5;
}

.log-empty {
  color: var(--text-muted);
  font-style: italic;
}

.log-line {
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-primary);
}

.log-line:hover {
  background: var(--bg-secondary);
}
.channel-filter {
  display: flex;
  gap: 0.5em;
  margin-left: 1em;
}
.channel-checkbox {
  font-size: 0.95em;
  display: flex;
  align-items: center;
  gap: 0.2em;
}
</style>
