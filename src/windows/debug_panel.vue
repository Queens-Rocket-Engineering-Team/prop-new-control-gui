<script setup>
import { inject, ref, watch, nextTick, computed, reactive } from 'vue'

// ── Injection API ─────────────────────────────────────────────────────────────
// Expects parent to provide:
//   terminals      : Ref<Array<{ id, name, logLines: Ref<string[]>, wsStatus: Ref<string>, clearLogs: fn }>>
//   addTerminal    : () => void
//   removeTerminal : (id: string) => void
//
// Falls back to legacy single-terminal providers if multi-terminal API is absent.
// ─────────────────────────────────────────────────────────────────────────────

const injectedTerminals  = inject('terminals',      null)
const injectedAdd        = inject('addTerminal',     null)
const injectedRemove     = inject('removeTerminal',  null)

// Legacy single-terminal fallback
const legacyLogLines  = inject('logLines',  ref([]))
const legacyWsStatus  = inject('wsStatus',  ref('disconnected'))
const legacyClearLogs = inject('clearLogs', () => {})

const CHANNELS = [
  { key: 'log',       label: 'Log',    prefix: 'log' },
  { key: 'syslog',    label: 'Sys',    prefix: 'sys' },
  { key: 'errlog',    label: 'Err',    prefix: 'err' },
  { key: 'debuglog',  label: 'Debug',  prefix: 'dbg' },
  { key: 'packetlog', label: 'Packet', prefix: 'pkt' },
]

// ── Terminal list ─────────────────────────────────────────────────────────────
const terminals = injectedTerminals ?? ref([
  {
    id: 't1',
    name: 'Terminal 1',
    logLines: legacyLogLines,
    wsStatus: legacyWsStatus,
    clearLogs: legacyClearLogs
  }
])

const activeId = ref(terminals.value[0]?.id ?? null)

// Per-terminal channel filter map: { [terminalId]: string[] }
const terminalFilters = reactive({})

function ensureFilter(id) {
  if (!terminalFilters[id]) {
    terminalFilters[id] = CHANNELS.map(c => c.key)
  }
}
terminals.value.forEach(t => ensureFilter(t.id))

// ── Helpers ───────────────────────────────────────────────────────────────────
function getStatus(t) {
  const s = t.wsStatus
  return (s && typeof s === 'object' && 'value' in s) ? s.value : s
}

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

function getLines(t) {
  const ll = t.logLines
  return (ll && typeof ll === 'object' && 'value' in ll) ? ll.value : (ll ?? [])
}

// ── Computed for active terminal ──────────────────────────────────────────────
const activeTerminal = computed(() =>
  terminals.value.find(t => t.id === activeId.value) ?? terminals.value[0] ?? null
)

const filteredLines = computed(() => {
  const t = activeTerminal.value
  if (!t) return []
  const sel = terminalFilters[t.id] ?? CHANNELS.map(c => c.key)
  const lines = getLines(t)
  if (sel.length === CHANNELS.length) return lines
  return lines.filter(line => {
    const ch = extractChannel(line)
    return ch !== null && sel.includes(ch)
  })
})

function toggleChannel(terminalId, key) {
  const filters = terminalFilters[terminalId]
  if (!filters) return
  const idx = filters.indexOf(key)
  if (idx === -1) filters.push(key)
  else filters.splice(idx, 1)
}

function isChannelActive(terminalId, key) {
  return (terminalFilters[terminalId] ?? []).includes(key)
}

// ── Auto-scroll ───────────────────────────────────────────────────────────────
const logEl = ref(null)
watch(filteredLines, async () => {
  await nextTick()
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
}, { deep: true })

// ── Add / Remove ──────────────────────────────────────────────────────────────
let counter = terminals.value.length + 1

function addTerminal() {
  if (injectedAdd) { injectedAdd(); return }
  const id = `t${Date.now()}`
  const name = `Terminal ${counter++}`
  const logs = ref([])
  terminals.value.push({
    id,
    name,
    logLines: logs,
    wsStatus: ref('disconnected'),
    clearLogs: () => { logs.value.splice(0) }
  })
  ensureFilter(id)
  activeId.value = id
}

function removeTerminal(id) {
  if (terminals.value.length <= 1) return
  if (injectedRemove) { injectedRemove(id); return }
  const idx = terminals.value.findIndex(t => t.id === id)
  if (idx !== -1) terminals.value.splice(idx, 1)
  delete terminalFilters[id]
  if (activeId.value === id) {
    activeId.value = terminals.value[0]?.id ?? null
  }
}

// ── Rename ────────────────────────────────────────────────────────────────────
const editingId   = ref(null)
const editingName = ref('')

function startRename(t) {
  editingId.value = t.id
  editingName.value = t.name
}

function commitRename(t) {
  if (editingName.value.trim()) t.name = editingName.value.trim()
  editingId.value = null
}
</script>

<template>
  <div class="debug-panel">

    <!-- ── Tab bar ── -->
    <div class="tab-bar">
      <div
        v-for="t in terminals"
        :key="t.id"
        class="tab"
        :class="{ 'tab-active': t.id === activeId }"
        @click="activeId = t.id"
      >
        <span class="tab-led" :class="getStatus(t)" />

        <input
          v-if="editingId === t.id"
          class="tab-rename-input"
          v-model="editingName"
          @blur="commitRename(t)"
          @keydown.enter="commitRename(t)"
          @keydown.escape="editingId = null"
          @click.stop
        />
        <span
          v-else
          class="tab-name"
          @dblclick.stop="startRename(t)"
          title="Double-click to rename"
        >{{ t.name }}</span>

        <button
          v-if="terminals.length > 1"
          class="tab-close"
          @click.stop="removeTerminal(t.id)"
          title="Remove terminal"
        >×</button>
      </div>

      <button class="add-tab-btn" @click="addTerminal" title="Add terminal">＋</button>
    </div>

    <!-- ── Toolbar ── -->
    <div class="debug-toolbar">
      <span class="ws-status" :class="activeTerminal ? getStatus(activeTerminal) : ''">
        <span class="ws-led" />
        {{ activeTerminal ? getStatus(activeTerminal) : '—' }}
      </span>

      <div class="channel-filter">
        <button
          v-for="ch in CHANNELS"
          :key="ch.key"
          class="channel-pill"
          :class="[`ch-${ch.key}`, { 'ch-active': isChannelActive(activeId, ch.key) }]"
          @click="toggleChannel(activeId, ch.key)"
        >{{ ch.label }}</button>
      </div>

      <button class="clear-btn" @click="activeTerminal && activeTerminal.clearLogs()">Clear</button>
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
  background: var(--bg-primary, #0d1117);
  font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
  color: var(--text-primary, #c9d1d9);
}

/* ── Tab bar ── */
.tab-bar {
  display: flex;
  align-items: stretch;
  background: var(--bg-tertiary, #010409);
  border-bottom: 1px solid var(--border-color, #30363d);
  overflow-x: auto;
  flex-shrink: 0;
  scrollbar-width: none;
}
.tab-bar::-webkit-scrollbar { display: none; }

.tab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px 5px 8px;
  font-size: 0.72rem;
  color: var(--text-muted, #8b949e);
  cursor: pointer;
  white-space: nowrap;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, background 0.15s;
  user-select: none;
}
.tab:hover { color: var(--text-primary, #c9d1d9); background: var(--bg-secondary, #161b22); }
.tab-active { color: #e6edf3; background: var(--bg-primary, #0d1117); border-bottom-color: #58a6ff; }

.tab-led {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: #555;
  flex-shrink: 0;
}
.tab-led.connected    { background: #2ecc71; box-shadow: 0 0 4px #2ecc71; }
.tab-led.connecting   { background: #f39c12; }
.tab-led.error        { background: #e74c3c; }
.tab-led.disconnected { background: #555; }

.tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
}

.tab-rename-input {
  font-family: inherit;
  font-size: inherit;
  background: var(--bg-tertiary, #010409);
  color: #e6edf3;
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
  margin-left: 2px;
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
.ws-status.connected  { color: #2ecc71; }
.ws-status.connected .ws-led  { background: #2ecc71; box-shadow: 0 0 4px #2ecc71; }
.ws-status.connecting { color: #f39c12; }
.ws-status.connecting .ws-led { background: #f39c12; }
.ws-status.error      { color: #e74c3c; }
.ws-status.error .ws-led      { background: #e74c3c; }

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
  border: 1px solid var(--border-color, #30363d);
  background: transparent;
  color: var(--text-muted, #8b949e);
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}

.ch-log.ch-active       { background: #1a3a27; color: #2ecc71; border-color: #2ecc71; }
.ch-syslog.ch-active    { background: #0e2a3d; color: #3498db; border-color: #3498db; }
.ch-errlog.ch-active    { background: #3d0e0e; color: #e74c3c; border-color: #e74c3c; }
.ch-debuglog.ch-active  { background: #3d2a0e; color: #f39c12; border-color: #f39c12; }
.ch-packetlog.ch-active { background: #2a0e3d; color: #9b59b6; border-color: #9b59b6; }

.channel-pill:not(.ch-active):hover { border-color: #8b949e; color: #c9d1d9; }

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