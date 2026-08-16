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

/** True for targets that command a state, i.e. that a physical switch drives. */
export function isActuator(target) {
  return !!ACTIONS[target?.type] && ACTIONS[target.type].includes(target.action)
}

/** The control a target belongs to, ignoring which state it commands. */
export function controlKey(target) {
  switch (target?.type) {
    case 'valve':    return `valve:${target.id}`
    case 'aux':      return `aux:${target.key}`
    case 'kasa':     return `kasa:${target.host}`
    case 'variable': return `variable:${target.key}`
    case 'estop':    return 'estop'
    default:         return ''
  }
}

export function targetId(target) {
  const control = controlKey(target)
  if (!control) return ''
  const actions = ACTIONS[target.type]
  if (!actions) return control                          // stateless by design
  if (!actions.includes(target.action)) return ''       // actuator without a state — reject
  return `${control}:${target.action}`
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

// ── Key identity ─────────────────────────────────────────────────────────────
//
// A key is identified by `event.code` — the physical key — rather than by
// `event.key`, which is the symbol the active keymap translates it to. Two
// reasons, both of which bit us:
//
//   The switch panel is a keyboard-emulating HID, and those devices emit
//   F13–F24 precisely because nothing else uses them. On Linux those keycodes
//   frequently have no keysym mapped, so `event.key` arrives as "Unidentified"
//   and every unmapped key on the panel collapses onto the same combo string.
//   `event.code` comes from the scancode and reads "F22" either way.
//
//   `event.key` is also layout- and shift-dependent: the key left of Enter is
//   ";" or ":" or "ñ" depending on the keyboard and whether shift is down, so a
//   binding made on one machine would not resolve on another. `event.code` says
//   "Semicolon" for all of them.

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
])

/**
 * Token for a physical key, or '' for a modifier (carried by the event's
 * ctrlKey/altKey/shiftKey/metaKey flags instead — left and right must not be
 * distinguishable, or a binding would depend on which hand pressed it).
 */
function tokenFromCode(code) {
  if (!code || code === 'Unidentified') return ''
  if (MODIFIER_CODES.has(code)) return ''
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1].toLowerCase()
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]
  // Everything else reads well lowercased: f22, space, slash, arrowup, numpad5.
  return code.toLowerCase()
}

// `event.key` names, for the two cases where a code is not available: a device
// that reports none, and combos stored before this module used codes. The
// character rows assume a US layout, which is the only guess available from a
// keysym alone — a binding made on another layout migrates to the key that sits
// in the same place on a US keyboard, and can be re-bound if that is wrong.
const KEY_TOKENS = {
  ' ': 'space',
  '`': 'backquote',  '~': 'backquote',
  '-': 'minus',      '_': 'minus',
  '=': 'equal',      '+': 'equal',
  '[': 'bracketleft',  '{': 'bracketleft',
  ']': 'bracketright', '}': 'bracketright',
  '\\': 'backslash', '|': 'backslash',
  ';': 'semicolon',  ':': 'semicolon',
  "'": 'quote',      '"': 'quote',
  ',': 'comma',      '<': 'comma',
  '.': 'period',     '>': 'period',
  '/': 'slash',      '?': 'slash',
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
  '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  'spacebar': 'space',
  'del': 'delete',
  'esc': 'escape',
}

function tokenFromKey(key) {
  const name = String(key ?? '').toLowerCase()
  if (!name || name === 'unidentified') return ''
  if (KEY_TOKENS[name]) return KEY_TOKENS[name]
  if (['control', 'alt', 'shift', 'meta'].includes(name)) return ''
  return name
}

/** Token for the key a KeyboardEvent refers to, or '' for a modifier. */
export function keyToken(event) {
  const code = String(event?.code ?? '')
  if (code && code !== 'Unidentified') return tokenFromCode(code)
  return tokenFromKey(event?.key)
}

// ── Key combos ───────────────────────────────────────────────────────────────
//
// A combo is a *set* of keys held at once, not a single key: "ctrl+a+b" means
// ctrl, a and b are all down. The non-modifier tokens are sorted so the order
// they were pressed in cannot produce two different strings for the same grip —
// an operator holding a chord is not thinking about which finger landed first.

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta']
const MODIFIERS = new Set(MODIFIER_ORDER)
// Reserved because the app already owns them: esc closes every modal, tab moves
// focus, and enter submits the variable-control input.
const RESERVED = new Set(['escape', 'tab', 'enter', 'numpadenter'])

/** Canonical combo string, e.g. "ctrl+shift+f11" or "a+b". */
export function comboFrom(modifiers, tokens) {
  const parts = MODIFIER_ORDER.filter((m) => modifiers?.[m])
  const keys = [...new Set(tokens)].filter(Boolean).sort()
  return [...parts, ...keys].join('+')
}

function modifiersOf(event) {
  return {
    ctrl:  !!event?.ctrlKey,
    alt:   !!event?.altKey,
    shift: !!event?.shiftKey,
    meta:  !!event?.metaKey,
  }
}

/**
 * The canonical form of a combo string, or '' if it is not a usable shortcut.
 *
 * The single gate for anything entering the map, so a hand-edited, broadcast or
 * pre-token combo is held to the same shape a freshly captured one is: a
 * legacy "shift+/" becomes "shift+slash", and "b+a" becomes "a+b" rather than
 * sitting in storage as a binding no keypress can ever match.
 */
export function canonicaliseCombo(combo) {
  const modifiers = { ctrl: false, alt: false, shift: false, meta: false }
  const keys = []
  for (const part of String(combo ?? '').toLowerCase().trim().split('+')) {
    if (MODIFIERS.has(part)) { modifiers[part] = true; continue }
    const token = tokenFromKey(part)
    if (!token || RESERVED.has(token)) return ''
    keys.push(token)
  }
  if (keys.length === 0) return ''   // modifiers alone are not a shortcut
  return comboFrom(modifiers, keys)
}

// ── Held keys ────────────────────────────────────────────────────────────────
//
// A chord spans several events, so what is currently down has to be remembered
// between them. Module-level, like the bindings themselves: the capture field
// and the control panel must agree on the grip, and the panel's listener sees
// the field's keystrokes on their way past.

const held = new Set()

/** Record a keydown; returns the combo for everything now held. */
export function pressKey(event) {
  const token = keyToken(event)
  if (token) held.add(token)
  return comboFrom(modifiersOf(event), held)
}

/** Record a keyup. */
export function releaseKey(event) {
  const token = keyToken(event)
  if (token) held.delete(token)
}

/**
 * Forget everything held.
 *
 * Load-bearing: a key released while the window is not focused never delivers
 * its keyup, so without this the token stays in the set and every later press
 * resolves to a chord the operator is not holding. Alt-tabbing away mid-press
 * would quietly break the keyboard until reload.
 */
export function resetHeld() {
  held.clear()
}

// Releases are tracked here rather than in the panel, because the set has to
// stay honest whether or not the Control panel is mounted — the keybinding
// editor is reachable from any window, and a key it saw go down there would
// otherwise still be counted as held when the operator navigates back.
// Capture phase so nothing nested can hide a release by stopping propagation.
if (typeof window !== 'undefined') {
  window.addEventListener('keyup', releaseKey, true)
  window.addEventListener('blur', resetHeld)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) resetHeld()
  })
}

// ── Stored bindings: { [combo]: target } ─────────────────────────────────────

// Used for both sources of a map — the stored one and the one another window
// broadcasts — so neither can introduce a shape the other could not.
function parseBindings(json) {
  try {
    const raw = JSON.parse(json ?? '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    // Drop anything unrecognisable rather than letting it reach the keydown
    // handler — a descriptor from a future or hand-edited format would resolve
    // to a target the panel cannot act on.
    const clean = {}
    for (const [combo, target] of Object.entries(raw)) {
      const canonical = canonicaliseCombo(combo)
      if (canonical && targetId(target)) clean[canonical] = target
    }
    return clean
  } catch {
    return {}
  }
}

const bindings = ref(parseBindings(localStorage.getItem(STORAGE_KEY)))

// The registered bindable controls, published by control_panel.vue.
// [{ target, label, group }] in the order the settings editor should show them.
const targets = ref([])

const _settingsChannel = new BroadcastChannel('qret-settings')
let _applyingBroadcast = false

// The map is sent as JSON, not as the object. postMessage structured-clones its
// payload and a Vue reactive proxy cannot be cloned — passing the ref's value
// straight in throws DataCloneError inside the watcher, which loses the
// broadcast (and, being a watcher, does so fairly quietly). Serialising also
// makes the wire format identical to the stored one, so there is one shape to
// think about rather than two.
//
// flush:'sync' is load-bearing, unlike the boolean prefs on this same channel:
// an echoed map is never identity-equal to the one we hold, so a deferred watch
// (which would run after _applyingBroadcast is back to false) would re-post
// every message it received and two windows would ping-pong forever.
watch(
  bindings,
  (value) => {
    const json = JSON.stringify(value)
    localStorage.setItem(STORAGE_KEY, json)
    if (!_applyingBroadcast) {
      _settingsChannel.postMessage({ type: 'keybindings', json })
    }
  },
  { deep: true, flush: 'sync' },
)

// App.vue and settings_modal.vue also listen on this channel and ignore message
// types they do not own, so a third listener costs nothing.
_settingsChannel.addEventListener('message', (e) => {
  if (e.data?.type !== 'keybindings') return
  _applyingBroadcast = true
  bindings.value = parseBindings(e.data.json)
  _applyingBroadcast = false
})

// ── Reads ────────────────────────────────────────────────────────────────────

/** targetId → combo, for the "[f]" hints rendered on the cards. */
const keyForTarget = computed(() => {
  const map = {}
  for (const [combo, target] of Object.entries(bindings.value)) {
    map[targetId(target)] = combo
  }
  return map
})

/** The target bound to a combo, or null. */
function resolve(combo) {
  return bindings.value[combo] ?? null
}

/**
 * Record a keydown and return the target it should act on, or null.
 *
 * Two candidates, in this order: the whole grip — every key held at once, which
 * is what a chord is — and then the key on its own. The fallback is there
 * because presses overlap in ordinary use: an operator rolling from one switch
 * key to the next still has the first down when the second lands, and without
 * it that second press would silently do nothing. It cannot be ambiguous,
 * because conflictingCombo refuses to store a binding whose keys are a subset
 * of another's — so the grip and the solo key can never name two targets.
 */
function pressBinding(event) {
  const grip = pressKey(event)
  return resolve(grip) ?? resolve(comboFrom(modifiersOf(event), [keyToken(event)]))
}

/**
 * Rows for the settings editor — one per *control*, with a cell per state it
 * can be commanded into. Two keys per actuator would otherwise mean two rows
 * repeating the same name; collapsing them here lets the editor lay out a grid
 * with the state as a column heading, and keeps that shaping out of the modal.
 *
 * Registered controls come first, then any binding whose control is not
 * currently registered — otherwise a shortcut left over from another P&ID would
 * keep firing with no row to clear it from.
 */
const editableControls = computed(() => {
  const rows = []
  const byControl = new Map()

  const rowFor = (target, label, group) => {
    const id = controlKey(target)
    let row = byControl.get(id)
    if (!row) {
      row = { id, label, group, cells: [] }
      byControl.set(id, row)
      rows.push(row)
    }
    return row
  }

  for (const t of targets.value) {
    const row = rowFor(t.target, t.label, t.group)
    const id = targetId(t.target)
    row.cells.push({ id, target: t.target, action: t.action, combo: keyForTarget.value[id] ?? '' })
  }

  for (const target of Object.values(bindings.value)) {
    const id = targetId(target)
    if (!id) continue
    const row = rowFor(target, derivedLabel(target), 'Unavailable')
    if (row.cells.some((c) => c.id === id)) continue
    row.cells.push({ id, target, action: derivedAction(target), combo: keyForTarget.value[id] ?? '' })
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

// The modifiers and the key set of a combo, as the two things conflicts compare.
function comboParts(combo) {
  const modifiers = []
  const keys = new Set()
  for (const part of combo.split('+')) {
    if (MODIFIERS.has(part)) modifiers.push(part)
    else keys.add(part)
  }
  return { modifiers: modifiers.join('+'), keys }
}

function isSubsetOf(a, b) {
  for (const token of a) if (!b.has(token)) return false
  return true
}

/**
 * A bound combo that cannot coexist with `combo`, or ''.
 *
 * The panel fires on keydown, because a valve command must not wait on a
 * release timer to find out whether a longer chord was coming. The cost is that
 * a shorter binding fires on the way into a chord that contains it: with "ctrl+a"
 * bound, gripping "ctrl+a+b" commands the ctrl+a target first. Deferring every
 * ordinary keypress to rule that out is the worse trade next to a live stand, so
 * the pair is refused at bind time instead — where somebody is looking at it —
 * and the stored map stays free of combos that shadow each other.
 *
 * `target`'s own bindings are ignored: setBinding clears them before assigning,
 * so they are not there to collide with.
 */
export function conflictingCombo(combo, target) {
  const mine = comboParts(combo)
  const selfId = targetId(target)
  for (const [bound, boundTarget] of Object.entries(bindings.value)) {
    if (bound === combo) continue                    // a straight steal, not a conflict
    if (targetId(boundTarget) === selfId) continue
    const theirs = comboParts(bound)
    if (theirs.modifiers !== mine.modifiers) continue
    if (theirs.keys.size === mine.keys.size) continue
    if (isSubsetOf(theirs.keys, mine.keys) || isSubsetOf(mine.keys, theirs.keys)) return bound
  }
  return ''
}

/**
 * Assign `combo` to `target`, stealing it from whatever held it before.
 * Returns why it was refused, so the field can say so rather than going blank.
 */
function setBinding(target, combo) {
  const normalised = canonicaliseCombo(combo)
  if (!normalised || !targetId(target)) return { ok: false, reason: 'invalid' }
  const clash = conflictingCombo(normalised, target)
  if (clash) return { ok: false, reason: 'conflict', conflict: clash }
  clearBinding(target)
  delete bindings.value[normalised]
  bindings.value[normalised] = target
  return { ok: true, combo: normalised }
}

export function useKeyBindings() {
  return {
    bindings,
    keyForTarget,
    editableControls,
    registerTargets,
    setBinding,
    clearBinding,
    resolve,
    pressBinding,
  }
}
