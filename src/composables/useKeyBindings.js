// Keyboard shortcuts for the control panel.
//
// Two halves: settings_modal.vue writes the map, control_panel.vue reads it and
// listens for keys. Both import this module directly rather than going through
// provide/inject — the state is a module-level singleton, so a panel that has
// been unmounted (navigating away from Control) does not lose it, and App.vue
// needs no knowledge of the feature at all.
//
// Nothing is bound by default. Auto-assigning keys to whatever the P&ID happens
// to contain means a stray keystroke actuates a valve nobody chose to bind, on a
// stand that may be live. Every binding here was typed by someone on purpose.
//
// Persistence is localStorage + BroadcastChannel, the same shape as dark mode
// and the P&ID choice (see settings_modal.vue / App.vue): it is a per-client
// preference, it survives a restart, it reaches every spawned window, and it
// works unchanged in the view-only web build — which has no Rust side to store
// it in. Note that the pad build never *acts* on bindings; control_panel.vue
// drops every key press when CAPS.commands is false.

import { computed, ref, watch } from 'vue'

const STORAGE_KEY = 'qret-keybindings'

// ── Target descriptors ───────────────────────────────────────────────────────
// The persisted value of a binding, and the only thing written to disk besides
// the key combo itself. Deliberately identifying rather than positional, so a
// binding survives the P&ID growing a valve or a device reordering its controls:
//
//   { type: 'valve',    id,   action: 'open'|'close' }   drawio ID on the P&ID —
//                               matches the visible card, which may drive several
//                               server controls at once
//   { type: 'aux',      key,  action: 'open'|'close' }   server control name;
//                               relay semantics, close = energised
//   { type: 'kasa',     host, action: 'on'|'off' }
//   { type: 'variable', key }   server control name (numeric) — opens the editor
//   { type: 'estop' }           opens the confirmation dialog
//
// Every actuator binds a *state*, never a toggle. A toggle key does something
// different depending on where the stand happens to be, which is the wrong
// property for a keystroke to have next to a loaded test article: whoever
// presses it has to be right about the current state for the result to be the
// one they wanted. "This key opens AV-1" is true regardless.

const ACTIONS = {
  valve: ['open', 'close'],
  aux:   ['open', 'close'],
  kasa:  ['on', 'off'],
}

export function targetId(target) {
  const type = target?.type
  if (!type) return ''
  const actions = ACTIONS[type]
  if (actions) {
    if (!actions.includes(target.action)) return ''   // stateless binding — reject
    switch (type) {
      case 'valve': return `valve:${target.id}:${target.action}`
      case 'aux':   return `aux:${target.key}:${target.action}`
      case 'kasa':  return `kasa:${target.host}:${target.action}`
    }
  }
  if (type === 'variable') return `variable:${target.key}`
  if (type === 'estop')    return 'estop'
  return ''
}

// Fallback display name and action caption, used for a stored binding whose
// control is no longer registered (a P&ID switch, a device that has not
// connected yet). Live targets carry the label the panel itself shows — see
// registerTargets.
function derivedLabel(target) {
  switch (target?.type) {
    case 'valve':    return target.id
    case 'aux':      return target.key
    case 'variable': return target.key
    case 'kasa':     return target.host
    case 'estop':    return 'E-STOP'
    default:         return ''
  }
}

function derivedAction(target) {
  return ACTIONS[target?.type] ? String(target.action).toUpperCase() : ''
}

// ── Key combos ───────────────────────────────────────────────────────────────

/** Normalised combo string for a KeyboardEvent, e.g. "ctrl+shift+p" or "f". */
export function buildKeyCombo(event) {
  const parts = []
  if (event.ctrlKey)  parts.push('ctrl')
  if (event.altKey)   parts.push('alt')
  if (event.shiftKey) parts.push('shift')
  if (event.metaKey)  parts.push('meta')
  const key = String(event.key ?? '').toLowerCase()
  if (key && !['control', 'alt', 'shift', 'meta'].includes(key)) parts.push(key)
  return parts.join('+')
}

const MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'meta'])
// Reserved because the app already owns them: esc closes both modals, tab moves
// focus, and enter submits the variable-control input.
const RESERVED = new Set(['escape', 'tab', 'enter'])

export function isValidKeyCombo(combo) {
  if (!combo) return false
  const parts = combo.split('+')
  const key = parts[parts.length - 1]
  if (MODIFIERS.has(key)) return false   // modifiers alone are not a shortcut
  return !RESERVED.has(key)
}

// ── Stored bindings: { [combo]: target } ─────────────────────────────────────

function loadBindings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    // Drop anything unrecognisable rather than letting it reach the keydown
    // handler — a descriptor from a future or hand-edited format would resolve
    // to a target the panel cannot act on.
    const clean = {}
    for (const [combo, target] of Object.entries(raw)) {
      if (isValidKeyCombo(combo) && targetId(target)) clean[combo] = target
    }
    return clean
  } catch {
    return {}
  }
}

const bindings = ref(loadBindings())

// The registered bindable controls, published by control_panel.vue.
// [{ target, label, group }] in the order the settings editor should show them.
const targets = ref([])

const _settingsChannel = new BroadcastChannel('qret-settings')
let _applyingBroadcast = false

// flush:'sync' is load-bearing, unlike the boolean prefs on this same channel:
// an echoed object is never identity-equal to the one we hold, so a deferred
// watch (which would run after _applyingBroadcast is back to false) would
// re-post every message it received and two windows would ping-pong forever.
watch(
  bindings,
  (value) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    if (!_applyingBroadcast) {
      _settingsChannel.postMessage({ type: 'keybindings', value })
    }
  },
  { deep: true, flush: 'sync' },
)

// App.vue and settings_modal.vue also listen on this channel and ignore message
// types they do not own, so a third listener costs nothing.
_settingsChannel.addEventListener('message', (e) => {
  if (e.data?.type !== 'keybindings') return
  _applyingBroadcast = true
  bindings.value = loadRemote(e.data.value)
  _applyingBroadcast = false
})

function loadRemote(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...value }
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** targetId → combo, for the "[f]" hints rendered on the cards. */
const keyForTarget = computed(() => {
  const map = {}
  for (const [combo, target] of Object.entries(bindings.value)) {
    map[targetId(target)] = combo
  }
  return map
})

/** The target a key press should act on, or null. */
function resolve(combo) {
  return bindings.value[combo] ?? null
}

/**
 * Rows for the settings editor: every registered control, followed by any
 * binding whose control is not currently registered — otherwise a shortcut left
 * over from another P&ID would keep firing with no row to clear it from.
 */
const editableTargets = computed(() => {
  const rows = targets.value.map((t) => ({ ...t, id: targetId(t.target) }))
  const known = new Set(rows.map((r) => r.id))
  for (const target of Object.values(bindings.value)) {
    const id = targetId(target)
    if (!id || known.has(id)) continue
    known.add(id)
    rows.push({
      target,
      id,
      label:  derivedLabel(target),
      action: derivedAction(target),
      group:  'Unavailable',
    })
  }
  return rows
})

// ── Writes ───────────────────────────────────────────────────────────────────

function registerTargets(list) {
  targets.value = list.filter((t) => targetId(t.target))
}

function clearBinding(target) {
  const id = targetId(target)
  for (const [combo, bound] of Object.entries(bindings.value)) {
    if (targetId(bound) === id) delete bindings.value[combo]
  }
}

/** Assign `combo` to `target`, stealing it from whatever held it before. */
function setBinding(target, combo) {
  const normalised = String(combo).toLowerCase().trim()
  if (!isValidKeyCombo(normalised) || !targetId(target)) return
  clearBinding(target)
  delete bindings.value[normalised]
  bindings.value[normalised] = target
}

export function useKeyBindings() {
  return {
    bindings,
    keyForTarget,
    editableTargets,
    registerTargets,
    setBinding,
    clearBinding,
    resolve,
  }
}
