// Physical switch positions, and the reconciliation prompt that keeps them
// honest.
//
// The keybindings in useKeyBindings.js exist because launch control drives the
// stand from a panel of physical two-position switches: each position emits its
// own keystroke, which is why an actuator binds a state per key rather than one
// toggle. The GUI therefore has no way to *read* a switch — the only thing it
// ever learns is which of the two keys it last saw. That inference is what this
// module stores.
//
// The inference goes stale in one specific way that matters. A device that has
// just registered comes up in its controls' default states, but the switches on
// the panel are wherever the last operator left them. A switch sitting in OPEN
// against a valve the device reports CLOSED is not a display problem: the next
// person to touch that switch believes they are closing a valve that is already
// closed, and instead opens it. So a registration raises a prompt listing the
// bound controls that device exposes, and the operator flips switches until
// every position matches what the device reports.
//
// While that prompt is up, keystrokes record position and command nothing —
// see the handler in control_panel.vue. This is what makes the prompt usable at
// all: a switch already sitting in the right position has an unknown recorded
// state until it is flipped, so the operator has to flip it away and back, and
// the "away" press would otherwise command exactly the state the prompt exists
// to prevent.

import { ref, watch } from 'vue'
import { controlKey, isActuator } from './useKeyBindings.js'

const STORAGE_KEY = 'qret-switch-states'

// { [controlKey]: 'open' | 'close' | 'on' | 'off' } — the last position this
// client saw a switch take. Persisted because a physical switch does not move
// when the app restarts, so a remembered position is better evidence than none.
const switchStates = ref(parseStates(localStorage.getItem(STORAGE_KEY)))

function parseStates(json) {
  try {
    const raw = JSON.parse(json ?? '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const clean = {}
    for (const [key, action] of Object.entries(raw)) {
      if (key && typeof action === 'string') clean[key] = action
    }
    return clean
  } catch {
    return {}
  }
}

// Shared with the other per-client preferences. One physical panel can be
// watched by several windows, and only the focused one receives the keystroke,
// so a position learned in one window has to reach the others.
const _settingsChannel = new BroadcastChannel('qret-settings')
let _applyingBroadcast = false

// Sent as JSON for the same reason the bindings are: postMessage structured-
// clones its payload and cannot serialise a Vue reactive proxy. sync flush so
// the re-entry guard is still true when the watcher runs.
watch(
  switchStates,
  (value) => {
    const json = JSON.stringify(value)
    localStorage.setItem(STORAGE_KEY, json)
    if (!_applyingBroadcast) {
      _settingsChannel.postMessage({ type: 'switchStates', json })
    }
  },
  { deep: true, flush: 'sync' },
)

_settingsChannel.addEventListener('message', (e) => {
  if (e.data?.type === 'switchStates') {
    _applyingBroadcast = true
    switchStates.value = parseStates(e.data.json)
    _applyingBroadcast = false
    return
  }
  // Another window finished the reconciliation for these devices. Without this
  // every open window would hold its own copy of the same prompt, and the
  // operator would have to dismiss a prompt per window after syncing once.
  if (e.data?.type === 'switchSyncResolved') {
    pendingDevices.value = pendingDevices.value.filter((n) => !e.data.devices?.includes(n))
  }
})

/** Record the position a keystroke reports. Ignores non-actuators. */
function recordSwitch(target) {
  if (!isActuator(target)) return
  const key = controlKey(target)
  if (key) switchStates.value[key] = target.action
}

/** The recorded position of a control's switch, or '' if never seen. */
function switchActionFor(key) {
  return switchStates.value[key] ?? ''
}

// ── Reconciliation queue ─────────────────────────────────────────────────────

// Device names that have registered and not yet been reconciled. Not persisted:
// a prompt is owed for a registration that happened in this session, and a
// restart will get its own registrations.
const pendingDevices = ref([])

// Controls left unmatched when a prompt was dismissed rather than confirmed.
// They stay listed until their positions agree with the device, so a broken
// switch is visibly outstanding instead of silently forgotten. Whether a
// flagged control *still* disagrees is derived where device state is known —
// see control_panel.vue.
const flagged = ref([])

// Called from App.vue's onDeviceRegistered. Every registration counts, rejoins
// included: a device that dropped and came back may have reset its controls to
// their defaults, which makes its switches exactly as suspect as a cold connect.
export function noteDeviceRegistered(deviceName) {
  if (!deviceName) return
  if (!pendingDevices.value.includes(deviceName)) {
    pendingDevices.value = [...pendingDevices.value, deviceName]
  }
}

function _clearPending() {
  // Spread, not the ref's value: postMessage clones its payload and a Vue
  // reactive array is as uncloneable as a reactive object.
  const devices = [...pendingDevices.value]
  pendingDevices.value = []
  if (devices.length) {
    _settingsChannel.postMessage({ type: 'switchSyncResolved', devices })
  }
}

/** Everything matched and the operator confirmed. */
function confirmSync(keys = []) {
  flagged.value = flagged.value.filter((k) => !keys.includes(k))
  _clearPending()
}

/** Dismissed with mismatches outstanding — remember which. */
function dismissSync(mismatchedKeys = []) {
  const next = new Set(flagged.value)
  for (const key of mismatchedKeys) next.add(key)
  flagged.value = [...next]
  _clearPending()
}

/** A registration with nothing bound to reconcile — drop it without a prompt. */
function skipSync() {
  _clearPending()
}

export function useSwitchSync() {
  return {
    switchStates,
    switchActionFor,
    recordSwitch,
    pendingDevices,
    flagged,
    confirmSync,
    dismissSync,
    skipSync,
  }
}
