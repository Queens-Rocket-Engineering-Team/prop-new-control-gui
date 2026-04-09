<script setup>
import { inject, ref, watch, nextTick, computed, reactive } from 'vue'

// ── log source ────────────────────
const logLines  = inject('logLines',  ref([]))
const wsStatus  = inject('wsStatus',  ref('disconnected'))
const clearLogs = inject('clearLogs', () => {})

const CHANNELS = [
  { key: 'log',       label: 'Log'    },
  { key: 'syslog',    label: 'Sys'    },
  { key: 'errlog',    label: 'Err'    },
  { key: 'debuglog',  label: 'Debug'  },
  { key: 'packetlog', label: 'Packet' },
]

// ── tab names + channel filters ───────────────────
const views = reactive([
  { id: 'v1', name: 'View 1', filters: CHANNELS.map(c => c.key) }
])

const activeId = ref('v1')
let viewCounter = 2

const activeView = computed(() =>
  views.find(v => v.id === activeId.value) ?? views[0] ?? null
)

// ── Channel helpers ───────────────────────────────────────────────────────────
function extractChannel(line) {
  const m = line.match(/^\[(\w+)\]/)
  if (!m) return null
  const map = { log: 'log', sys: 'syslog', err: 'errlog', dbg: 'debuglog', pkt: 'packetlog' }
  return map[m[1]] ?? null
}

function getLineClass(line) {
  const ch = extractChannel(line)
  return ch ? `log-line-${ch}` : ''
}

function toggleChannel(view, key) {
  const idx = view.filters.indexOf(key)
  if (idx === -1) view.filters.push(key)
  else view.filters.splice(idx, 1)
}

// ── Filtered lines for the active view ───────────────────────────────────────
const filteredLines = computed(() => {
  const v = activeView.value
  if (!v) return []
  if (v.filters.length === CHANNELS.length) return logLines.value
  return logLines.value.filter(line => {
    const ch = extractChannel(line)
    return ch !== null && v.filters.includes(ch)
  })
})

// ── Auto-scroll ───────────────────────────────────────────────────────────────
const logEl = ref(null)
watch(filteredLines, async () => {
  await nextTick()
  if (logEl.value) logEl.value.scrollBottom = logEl.value.scrollHeight
}, { deep: true })

// ── Add / Remove views ────────────────────────────────────────────────────────
function addView() {
  const id = `v${Date.now()}`
  views.push({ id, name: `View ${viewCounter++}`, filters: CHANNELS.map(c => c.key) })
  activeId.value = id
}

function removeView(id) {
  if (views.length <= 1) return
  const idx = views.findIndex(v => v.id === id)
  if (idx !== -1) views.splice(idx, 1)
  if (activeId.value === id) activeId.value = views[0]?.id ?? null
}

// ── Rename ────────────────────────────────────────────────────────────────────
const editingId   = ref(null)
const editingName = ref('')

function startRename(v) {
  editingId.value = v.id
  editingName.value = v.name
}

function commitRename(v) {
  if (editingName.value.trim()) v.name = editingName.value.trim()
  editingId.value = null
}

// ── WS status helper ──────────────────────────────────────────────────────────
const statusClass = computed(() => {
  const s = wsStatus
  return (s && typeof s === 'object' && 'value' in s) ? s.value : s
})
</script>

<template>
  <div class="debug-panel">

    <!-- ── Tab bar ── -->
    <div class="tab-bar">
      <div
        v-for="v in views"
        :key="v.id"
        class="tab"
        :class="{ 'tab-active': v.id === activeId }"
        @click="activeId = v.id"
      >
        <input
          v-if="editingId === v.id"
          class="tab-rename-input"
          v-model="editingName"
          @blur="commitRename(v)"
          @keydown.enter="commitRename(v)"
          @keydown.escape="editingId = null"
          @click.stop
        />
        <span
          v-else
          class="tab-name"
          @dblclick.stop="startRename(v)"
          title="Double-click to rename"
        >{{ v.name }}</span>

        <button
          v-if="views.length > 1"
          class="tab-close"
          @click.stop="removeView(v.id)"
          title="Remove view"
        >x</button>
      </div>

      <button class="add-tab-btn" @click="addView" title="Add view">+</button>
    </div>

    <!-- ── Filter toolbar ── -->
    <div class="debug-toolbar">
      <span class="ws-status" :class="statusClass">
        <span class="ws-led" />
        {{ statusClass }}
      </span>

      <div class="channel-filter">
        <button
          v-for="ch in CHANNELS"
          :key="ch.key"
          class="channel-pill"
          :class="[`ch-${ch.key}`, { 'ch-active': activeView && activeView.filters.includes(ch.key) }]"
          @click="activeView && toggleChannel(activeView, ch.key)"
        >{{ ch.label }}</button>
      </div>

      <button class="clear-btn" @click="clearLogs()">Clear</button>
    </div>

    <!-- ── Log output ── -->
    <div class="log-output" ref="logEl">
      <div v-if="filteredLines.length === 0" class="log-empty">
        No log output yet…
      </div>
      <div
        v-for="(line, i) in filteredLines"
        :key="i"
        :class="['log-line', getLineClass(line)]"
      >{{ line }}</div>
    </div>

  </div>
</template>

<style scoped>
.debug-panel {
  display: flex;
  flex-direction: column;
  height: 100vh;
  max-height: 100vh;
  background: var(--bg-primary);
  font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
  color: var(--text-primary, #c9d1d9);
}

/* ── Tab bar ── */
.tab-bar {
  display: flex;
  align-items: stretch;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
  flex-shrink: 0;
  scrollbar-width: none;
}
.tab-bar::-webkit-scrollbar { display: none; }

.tab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px 5px 10px;
  font-size: 0.72rem;
  color: var(--text-muted);
  cursor: pointer;
  white-space: nowrap;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, background 0.15s;
  user-select: none;
}
.tab:hover { color: var(--text-primary); background: var(--bg-secondary); }
.tab-active { color: var(--text-primary); background: var(--bg-primary, #0d1117); border-bottom-color: #58a6ff; }

.tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
  color: var(--text-primary);
}

.tab-rename-input {
  font-family: inherit;
  font-size: inherit;
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid #58a6ff;
  border-radius: 3px;
  padding: 1px 4px;
  width: 90px;
  outline: none;
}

.tab-close {
  background: none;
  border: none;
  color: var(--text-muted, #8b949e);
  cursor: pointer;
  font-size: 0.9rem;
  line-height: 1;
  padding: 0 2px;
  border-radius: 3px;
  opacity: 0.5;
  transition: opacity 0.15s, color 0.15s;
}
.tab-close:hover { opacity: 1; color: #e74c3c; }

.add-tab-btn {
  display: flex;
  align-items: center;
  padding: 0 10px;
  background: none;
  border: none;
  color: var(--text-muted, #8b949e);
  font-size: 1rem;
  cursor: pointer;
  transition: color 0.15s;
  flex-shrink: 0;
}
.add-tab-btn:hover { color: #58a6ff; }

/* ── Toolbar ── */
.debug-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border-color, #30363d);
  background: var(--bg-secondary, #161b22);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.ws-status {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted, #8b949e);
  flex-shrink: 0;
}
.ws-led { width: 7px; height: 7px; border-radius: 50%; background: #555; }
.ws-status.connected   { color: #2ecc71; }
.ws-status.connected .ws-led   { background: #2ecc71; box-shadow: 0 0 4px #2ecc71; }
.ws-status.connecting  { color: #f39c12; }
.ws-status.connecting .ws-led  { background: #f39c12; }
.ws-status.error       { color: #e74c3c; }
.ws-status.error .ws-led       { background: #e74c3c; }
.ws-status.disconnected .ws-led { background: #555; }

/* ── Channel pills ── */
.channel-filter {
  display: flex;
  gap: 4px;
  flex: 1;
  flex-wrap: wrap;
}

.channel-pill {
  font-family: inherit;
  font-size: 0.7rem;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.channel-pill:hover { border-color: #8b949e; color: #c9d1d9; }

.ch-log.ch-active       { background: --bg-secondary; color: #2ecc71; border-color: #2ecc71; }
.ch-syslog.ch-active    { background: --bg-secondary; color: #3498db; border-color: #3498db; }
.ch-errlog.ch-active    { background: --bg-secondary; color: #e74c3c; border-color: #e74c3c; }
.ch-debuglog.ch-active  { background: --bg-secondary; color: #f39c12; border-color: #f39c12; }
.ch-packetlog.ch-active { background: --bg-secondary; color: #9b59b6; border-color: #9b59b6; }

/* ── Clear ── */
.clear-btn {
  font-size: 0.7rem;
  padding: 2px 9px;
  background: transparent;
  color: var(--text-muted, #8b949e);
  border: 1px solid var(--border-color, #30363d);
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
  flex-shrink: 0;
  transition: color 0.12s, border-color 0.12s;
}
.clear-btn:hover { color: #e74c3c; border-color: #e74c3c; }

/* ── Log output ── */
.log-output {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 8px 10px;
  font-size: 0.78rem;
  line-height: 1.6;
  background: var(--bg-primary, #0d1117);
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: #30363d transparent;
}

.log-empty { color: var(--text-muted, #8b949e); font-style: italic; }

.log-line {
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-primary, #c9d1d9);
  padding: 1px 4px;
  border-radius: 2px;
}
.log-line:hover { background: var(--bg-secondary, #161b22); }

.log-line-log       { color: #2ecc71; }
.log-line-syslog    { color: #3498db; }
.log-line-errlog    { color: #e74c3c; font-weight: 600; }
.log-line-debuglog  { color: #f39c12; }
.log-line-packetlog { color: #9b59b6; }
</style>