<script setup>
import { ref, inject, computed, reactive, watch, onMounted, onBeforeUnmount } from 'vue'
import ToggleSwitch from 'primevue/toggleswitch'
import PidDiagram from '../components/PidDiagram.vue'
import { useServerApi } from '../composables/useServerApi.js'
import { useKeyBindings, buildKeyCombo, targetId, controlKey } from '../composables/useKeyBindings.js'
import { useSwitchSync } from '../composables/useSwitchSync.js'
import SwitchSyncModal from '../components/switch_sync_modal.vue'
import { CAPS } from '../lib/platform.js'

const serverIp     = inject('serverIp',     ref(''))
const devices      = inject('devices',      ref([]))
const commandsById = inject('commandsById', ref(new Map()))
const pidConfig    = inject('pidConfig',    ref('rocket-launch'))
const sensorData   = inject('sensorData',   ref({}))
const kasaDevices  = inject('kasaDevices',  ref([]))
const setKasaState = inject('setKasaState', () => {})
const requestStatusSnapshot = inject('requestStatusSnapshot', () => Promise.resolve())

const { setControl, sendEstop } = useServerApi(serverIp)

// The view-only build renders live state but cannot act on it. Controls are
// disabled rather than hidden so the pad still sees what exists and what it is
// doing — a control that looks live and silently fails is worse than a dead one.
const readOnly = !CAPS.commands

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
  },
}

function sideFor(id, fallback) {
  return SIDE_HINTS[pidConfig.value]?.[id] ?? fallback
}

/** Hinted cards are placed first, so neighbours route around them. */
function isPinned(id) {
  return SIDE_HINTS[pidConfig.value]?.[id] ? true : null
}

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
    // Variable (numeric) controls render in their own side panel, not as P&ID valve cards.
    if (isVariableType(ctrl.type)) continue
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

// ── Variable (non-BOOL) control detection ───────────────────────────────────
// Controls with type FLOAT32/INT32/etc. carry a numeric value instead of an
// OPEN/CLOSED state. Treat a missing type as BOOL for backwards compatibility.
function isVariableType(type) {
  return !!type && type !== 'BOOL'
}

// Server state values may come back as either the type that was sent or a
// string echo (e.g. requested 42.5, reported_state "42.5"). Compare loosely.
function statesMatch(a, b) {
  if (a === b) return true
  const na = Number(a), nb = Number(b)
  return !Number.isNaN(na) && !Number.isNaN(nb) && na === nb
}

// ── Auxiliary controls (non-AV, BOOL server controls) ────────────────────────

const auxiliaryControls = computed(() => {
  const result = []
  for (const dev of devices.value) {
    for (const ctrl of (dev.controls ?? [])) {
      if (!normalizeId(ctrl.name).startsWith('av') && !isVariableType(ctrl.type)) {
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

// ── Variable controls (numeric — isolated from relays/valves) ────────────────
// Rendered as their own side-panel section, similar to Smart Plugs: a small
// value box plus an edit icon that opens a popover for numeric input.

const variableControls = computed(() => {
  const result = []
  for (const dev of devices.value) {
    for (const ctrl of (dev.controls ?? [])) {
      if (isVariableType(ctrl.type)) {
        result.push({
          key:          ctrl.name,
          label:        toControlKey(ctrl.name),
          type:         ctrl.type,
          unit:         ctrl.unit ?? '',
          defaultState: ctrl.default_state ?? '—',
        })
      }
    }
  }
  return result
})

function getVariableValue(controlName) {
  const ctrl = controlLookup.value.get(controlName)
  if (!ctrl) return '—'
  const state = ctrl.reported_state ?? ctrl.accepted_state
  return state ?? '—'
}

// ── Variable control editor popover ──────────────────────────────────────────

const openVariableEditor = ref(null)   // control name currently being edited, or null
const variableInput      = ref('')

function toggleVariableEditor(controlName) {
  if (openVariableEditor.value === controlName) {
    openVariableEditor.value = null
    return
  }
  variableInput.value      = String(getVariableValue(controlName) ?? '')
  openVariableEditor.value = controlName
}

function cancelVariableEditor() {
  openVariableEditor.value = null
}

async function submitVariableControl(controlName) {
  const num = Number(variableInput.value)
  if (variableInput.value === '' || Number.isNaN(num)) return

  openVariableEditor.value = null
  pending[controlName] = { requested: num }
  delete warning[controlName]
  try {
    await setControl(controlName, num)
    requestStatusSnapshot('control')
  } catch (err) {
    console.error(`[ControlPanel] CONTROL ${controlName} failed:`, err)
    delete pending[controlName]
    warning[controlName] = { message: String(err), errorCode: null }
  }
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
      if (statesMatch(serverState, p.requested)) {
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

// ── Keyboard shortcuts ───────────────────────────────────────────────────────
// Bindings are assigned in Settings and stored per client (useKeyBindings.js).
// A key press does exactly what clicking the control would: it routes through
// the handlers above, so pending/NACK tracking and server authority are
// identical whether the command came from a mouse or the keyboard.
//
// Each actuator gets two keys — one per state — rather than one that toggles.
// A toggle key's effect depends on where the stand currently is, so pressing it
// is only as correct as the presser's belief about the current state. A state
// key means the same thing every time, and pressing it twice is a no-op instead
// of an undo.

const { keyForTarget, registerTargets, resolve } = useKeyBindings()

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

// ── Physical switch reconciliation ───────────────────────────────────────────
// A device comes up in its controls' default states while the switches on the
// panel are wherever the last operator left them. useSwitchSync.js explains why
// that combination is dangerous rather than merely untidy; this is the half
// that knows what the device actually reports.

const {
  switchActionFor,
  recordSwitch,
  pendingDevices,
  flagged,
  confirmSync,
  dismissSync,
  skipSync,
} = useSwitchSync()

const reviewOpen = ref(false)

// Which server controls each pending device exposes. Names, because that is
// what a binding and a P&ID match both resolve to.
const pendingControlNames = computed(() => {
  const names = new Set()
  for (const dev of devices.value) {
    if (!pendingDevices.value.includes(dev.name)) continue
    for (const ctrl of (dev.controls ?? [])) names.add(ctrl.name)
  }
  return names
})

// A row per bound control, in the panel's own vocabulary. `expected` is the
// action the switch must be in for the position to agree with the device.
function buildSyncRow(kind, id, label, expectedOpen) {
  const target = kind === 'valve' ? { type: 'valve', id } : { type: 'aux', key: id }
  const key = controlKey(target)
  // Aux relays read CLOSED when energised, valves read OPEN when open — the two
  // land on the same pair of action words, so one comparison serves both.
  const expected = expectedOpen ? 'open' : 'close'
  const actual = switchActionFor(key)
  const word = (action) => (action === 'open' ? 'OPEN' : action === 'close' ? 'CLOSED' : '—')
  return {
    key,
    label,
    expected,
    deviceLabel: word(expected),
    switchLabel: actual ? word(actual) : 'UNKNOWN',
    matched: actual === expected,
    cells: [
      { id: `${key}:open`,  target: { ...target, action: 'open'  }, action: 'OPEN'  },
      { id: `${key}:close`, target: { ...target, action: 'close' }, action: 'CLOSE' },
    ],
  }
}

// Every bound valve and relay, with its switch position judged against the
// device. Variable controls and smart plugs are absent by design: a variable
// control's key is momentary rather than a position, and a plug is not a device
// that registers controls.
const allSyncRows = computed(() => {
  const rows = []
  for (const id of valves.value) {
    if (!keyForTarget.value[`valve:${id}:open`] && !keyForTarget.value[`valve:${id}:close`]) continue
    if (!isValveEnabled(id)) continue
    rows.push(buildSyncRow('valve', id, id, getDisplayedOpen(id)))
  }
  for (const ctrl of auxiliaryControls.value) {
    if (!keyForTarget.value[`aux:${ctrl.key}:open`] && !keyForTarget.value[`aux:${ctrl.key}:close`]) continue
    // Energised (CLOSED) is the relay's "open" action — see buildSyncRow.
    rows.push(buildSyncRow('aux', ctrl.key, ctrl.label, !getAuxDisplayed(ctrl.key)))
  }
  return rows
})

// Which server controls a row speaks for, so a row can be attributed to the
// device that just registered. A valve card may drive several at once.
function rowControlNames(row) {
  if (row.key.startsWith('valve:')) {
    return getMatchingControls(row.key.slice('valve:'.length)).map((c) => c.name)
  }
  return [row.key.slice('aux:'.length)]
}

// name → owning device, so a row can be labelled with whose registration it
// answers. A second device registering mid-review otherwise adds rows that
// look identical to the first device's — nothing marks them as new, so an
// operator scrolled deep into a long valve list has no reason to notice the
// list grew under them while Confirm stays mysteriously disabled.
const controlDeviceOf = computed(() => {
  const map = new Map()
  for (const dev of devices.value) {
    for (const ctrl of (dev.controls ?? [])) map.set(ctrl.name, dev.name)
  }
  return map
})

// Attributed to whichever pending device owns the row, preferring queue order
// so a row touched by more than one device's controls (rare, but the fuzzy
// P&ID match does not forbid it) lands under the one that has been waiting
// longest rather than splitting across two sections.
function deviceGroupFor(row) {
  const names = rowControlNames(row)
  for (const dev of pendingDevices.value) {
    if (names.some((n) => controlDeviceOf.value.get(n) === dev)) return dev
  }
  return ''
}

// A registration prompts for that device's controls; the review chip reopens
// with whatever was left unreconciled. Only the first case attributes rows to
// a device — grouping a handful of leftover mismatches of unrelated origin
// would suggest a relationship between them that is not there.
const syncRows = computed(() => {
  if (pendingDevices.value.length > 0) {
    const names = pendingControlNames.value
    return allSyncRows.value
      .filter((row) => rowControlNames(row).some((n) => names.has(n)))
      .map((row) => ({ ...row, group: deviceGroupFor(row) }))
  }
  if (reviewOpen.value) {
    return allSyncRows.value.filter((row) => flagged.value.includes(row.key))
  }
  return []
})

const syncOpen = computed(() => !readOnly && syncRows.value.length > 0)

// Flagged controls that still disagree — a control that has since been put
// right needs no chip, and one that was never flagged was never in question.
const outOfSync = computed(() =>
  allSyncRows.value.filter((row) => flagged.value.includes(row.key) && !row.matched)
)

// A registration from a device with nothing bound owes no prompt. Dropping it
// here rather than never queueing it keeps useSwitchSync.js free of any
// knowledge of what is bound to what.
//
// "No rows" is only trustworthy once rows could have been built at all: a
// device can register before its controls have landed in the device list, and
// valve bindings are keyed by drawio ID, so before the P&ID parses every valve
// row is missing. Dropping the registration then would skip the prompt for a
// device whose valves are bound. Waiting instead means a late parse raises the
// prompt late, which is the outcome worth having.
watch([pendingDevices, syncRows, valves, devices], () => {
  if (pendingDevices.value.length === 0) return
  if (syncRows.value.length > 0) return
  if (pendingControlNames.value.size === 0) return   // controls not published yet
  if (valves.value.length === 0) return              // P&ID not parsed yet
  skipSync()
})

function onSyncConfirm(keys) {
  confirmSync(keys)
  reviewOpen.value = false
}

function onSyncDismiss(mismatchedKeys) {
  dismissSync(mismatchedKeys)
  reviewOpen.value = false
}

function onKeydown(evt) {
  // The pad build cannot command the stand — same reason every control in this
  // template is :disabled there.
  if (readOnly) return
  // A held key must not machine-gun a valve.
  if (evt.repeat) return

  const el = evt.target
  if (el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)) return

  // The reconciliation prompt is the one dialog that still wants these keys —
  // and the only one that must not let them through. The operator is flipping
  // switches to match the device, so a press records the position it reports
  // and commands nothing. Checked before the generic modal guard below, which
  // would otherwise swallow it like any other open modal.
  if (syncOpen.value) {
    const flip = resolve(buildKeyCombo(evt))
    if (!flip) return
    evt.preventDefault()
    recordSwitch(flip)
    return
  }

  // A dialog owns the keyboard while it is up: the E-STOP confirmation and the
  // variable-control popover here, and — via the shared .modal-overlay class —
  // the settings and about modals, whose overlay is focused programmatically
  // but whose keydowns still bubble to window. Settings in particular must be
  // able to capture a key for rebinding without also firing it.
  if (showEstopConfirm.value || openVariableEditor.value) return
  if (document.querySelector('.modal-overlay')) return

  const binding = resolve(buildKeyCombo(evt))
  if (!binding) return
  evt.preventDefault()

  // A flip is a position report as well as a command, so the switch's recorded
  // state tracks normal operation and not just reconciliation.
  recordSwitch(binding)

  // The requested state is commanded outright, never derived from the current
  // one. Pressing OPEN on an already-open valve re-asserts it, which is the
  // harmless half of the trade that makes the keys unambiguous.
  switch (binding.type) {
    case 'valve':
      if (!isValveEnabled(binding.id) || isControlPending(binding.id)) return
      onValveToggle(binding.id, binding.action === 'open')
      break
    case 'aux':
      if (isAuxPending(binding.key)) return
      onAuxToggle(binding.key, binding.action === 'close')   // close = energised
      break
    case 'variable':
      if (isAuxPending(binding.key)) return
      toggleVariableEditor(binding.key)
      break
    case 'kasa': {
      const dev = kasaDevices.value.find((d) => d.host === binding.host)
      if (dev) setKasaState(dev.host, binding.action === 'on')
      break
    }
    // Opens the confirmation dialog only — a keystroke never sends an E-STOP.
    case 'estop':
      showEstopConfirm.value = true
      break
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div id="control-panel">
    <PidDiagram :svg-url="svgUrl" @cells-parsed="onCellsParsed">
      <template #default="{ positionOf, positionBeside }">

        <!-- ── Auxiliary controls panel (fixed top-left) ── -->
        <div
          v-if="auxiliaryControls.length > 0 || variableControls.length > 0 || kasaDevices.length > 0"
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
              :disabled="isAuxPending(ctrl.key) || readOnly"
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
            >
              <span class="aux-label">{{ ctrl.label }}</span>
              <span class="card-badge">{{ ctrl.defaultState }}<span v-if="ctrl.unit" class="variable-unit">{{ ctrl.unit }}</span></span>
              <span
                class="state-indicator"
                :class="{
                  'relay-warning': isAuxWarning(ctrl.key),
                  'relay-pending': isAuxPending(ctrl.key),
                }"
              >
                <span class="state-led" />
                <span v-if="isAuxWarning(ctrl.key)">WARN</span>
                <span v-else-if="isAuxPending(ctrl.key)">PENDING…</span>
                <span v-else>{{ getVariableValue(ctrl.key) }}<span v-if="ctrl.unit" class="variable-unit">{{ ctrl.unit }}</span></span>
              </span>
              <button
                class="variable-edit-btn"
                :disabled="isAuxPending(ctrl.key) || readOnly"
                @click="toggleVariableEditor(ctrl.key)"
                :title="readOnly ? 'Controls are issued from launch control' : 'Set value'"
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
            >
              <span class="aux-label">{{ dev.alias || dev.host }}</span>
              <span class="state-indicator" :class="dev.active ? 'relay-closed' : 'relay-open'">
                <span class="state-led" />
                {{ dev.active ? 'ON' : 'OFF' }}
              </span>
              <ToggleSwitch
                :modelValue="dev.active"
                :disabled="readOnly"
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
                  :disabled="!isValveEnabled(id) || isControlPending(id) || readOnly"
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

    <!-- ── Physical switch reconciliation prompt ── -->
    <switch-sync-modal
      :is-open="syncOpen"
      :rows="syncRows"
      :devices="pendingDevices"
      @confirm="onSyncConfirm"
      @dismiss="onSyncDismiss"
    />

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
