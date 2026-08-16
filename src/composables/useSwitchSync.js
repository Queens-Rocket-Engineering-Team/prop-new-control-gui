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
// see the handler in useControlLayer.js. This is what makes the prompt usable at
// all: a switch already sitting in the right position has an unknown recorded
// state until it is flipped, so the operator has to flip it away and back, and
// the "away" press would otherwise command exactly the state the prompt exists
// to prevent.

import { ref, watch } from 'vue'
import { controlKey, isActuator } from './useKeyBindings.js'
import { reconciledDevices, markReconciled } from '../lib/desktop.js'

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
    for (const name of e.data.devices ?? []) _reconciled.add(name)
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

// Device names that have registered and not yet been reconciled. Not persisted
// in its own right — what survives a reload is the *answer* (see _reconciled
// below), so a prompt reloaded before it was dealt with is raised again by the
// same route that raised it first.
const pendingDevices = ref([])

// Controls left unmatched when a prompt was dismissed rather than confirmed.
// They stay listed until their positions agree with the device, so a broken
// switch is visibly outstanding instead of silently forgotten. Whether a
// flagged control *still* disagrees is derived where device state is known —
// see useControlLayer.js.
const flagged = ref([])

// Two sets, deliberately. They answer different questions and have different
// lifetimes, and collapsing them is what made the prompt fire on every reload.
//
//   _seen        — "this window has already decided about this device". Purely a
//                  dedupe against the device list being republished (any control
//                  update republishes it), so it must include devices whose
//                  prompt is currently open. Window-scoped; a reload gets a
//                  fresh one, which is correct.
//
//   _reconciled  — "the operator has already dealt with this device". Owned by
//                  Rust (see desktop.js), so it outlives a reload and is shared
//                  with every other window, but not an app restart.
//
// Both are scoped to a server, because pointing the app at a different stand
// makes a familiar device name a different device with its own switches.
const _seen = new Set()
const _reconciled = new Set()
let _seenServer = null
let _hydration = null

// ── Device state while we were not looking ───────────────────────────────────
//
// A device that drops and rejoins announces itself with a `device.registered`
// delta, which noteDeviceRegistered turns into a prompt. But if the *state
// socket* is down when that happens, there is no delta to receive: the device
// simply reappears in the resync snapshot, already known to _seen, and the
// registration passes unnoticed. That is the one way a device can come up in
// its controls' defaults without the operator being asked about its switches.
//
// The server offers nothing to detect it with — no registration id, no
// registration timestamp — so the check is on the consequence rather than the
// event: what the device *reports* its controls to be. A reconciliation is a
// statement about that state, so if the state is unchanged across the outage
// the reconciliation still holds, whether or not the device rebooted meanwhile.
// If it changed, the reconciliation describes a stand that no longer exists and
// the question is owed again.
//
// Deliberately not "re-prompt on every resync". A brief socket blip changes
// nothing about the switch panel, and prompting for it would put back exactly
// the noise this module was rewritten to remove.

/** The device's reported control states, as one comparable string. */
function _controlFingerprint(device) {
  return (device?.controls ?? [])
    .map((ctrl) => `${ctrl.name}=${ctrl.reported_state ?? ctrl.accepted_state ?? ''}`)
    .sort()
    .join(';')
}

// name → fingerprint, refreshed on every device publish.
const _lastStates = new Map()
// A copy taken when the socket dropped, or null while it is up.
let _frozenStates = null

// Fetching the reconciled set is async and noteDevicesPresent is called from a
// synchronous, immediate watcher — so the first device publish for a server
// always arrives before the answer does. Every caller awaits the same promise
// rather than racing it, and re-checks the server afterwards in case the IP
// moved while it was in flight.
function _hydrate(serverIp) {
  _seenServer = serverIp
  _seen.clear()
  _reconciled.clear()
  _lastStates.clear()
  _frozenStates = null
  _hydration = reconciledDevices(serverIp)
    .then((names) => {
      if (_seenServer !== serverIp) return
      for (const name of names) _reconciled.add(name)
    })
    .catch(() => { /* degrade to prompting once more than strictly needed */ })
  return _hydration
}

function _queue(deviceName) {
  if (!pendingDevices.value.includes(deviceName)) {
    pendingDevices.value = [...pendingDevices.value, deviceName]
  }
}

// Called from App.vue's onDeviceRegistered. Every registration counts, rejoins
// included: a device that dropped and came back may have reset its controls to
// their defaults, which makes its switches exactly as suspect as a cold connect.
//
// This is also the one thing that *retracts* a reconciliation. A device that has
// just re-registered is no longer described by whatever the operator confirmed
// about it earlier, so the record has to go — otherwise the next reload would
// read the stale confirmation and stay quiet about a device that came back up in
// its defaults.
export function noteDeviceRegistered(deviceName) {
  if (!deviceName) return
  _seen.add(deviceName)
  _reconciled.delete(deviceName)
  if (_seenServer) markReconciled(_seenServer, [deviceName], false)
  _queue(deviceName)
}

// The other way a device arrives: already registered before this client
// connected, so it comes down in the /ws/state snapshot and no device.registered
// delta is ever sent. Its switches are no less suspect for having been missed —
// more so, if anything, since this client has watched none of its history — so
// presence counts the same as the event announcing it.
//
// This is the path a window reload takes, which is why it consults _reconciled:
// nothing about the stand changed, so a device the operator already dealt with
// owes no second prompt.
export async function noteDevicesPresent(serverIp, devices = []) {
  // No server means no devices to reconcile, and this is not a server *change*
  // worth resetting anything over — App.vue's watcher is immediate, so every
  // load calls through here once before the address has resolved. Treating that
  // as a switch to a different stand would throw away the set on every reload,
  // which is the exact bug this whole mechanism exists to fix.
  if (!serverIp) return

  if (serverIp !== _seenServer) _hydrate(serverIp)

  const hydration = _hydration
  await hydration
  if (serverIp !== _seenServer) return   // pointed elsewhere mid-flight

  // The first publish after an outage is the resync snapshot, so this is where
  // the across-the-outage comparison belongs. Doing it on the socket's status
  // transition instead would be too early: status flips to 'connected' in the
  // socket's onopen, before the snapshot has arrived, so `devices` would still
  // be the pre-outage list and every comparison would trivially match.
  const before = _frozenStates
  _frozenStates = null
  const stale = []

  for (const device of devices) {
    const name = device?.name
    if (!name) continue
    const fingerprint = _controlFingerprint(device)

    // Reported state moved while we were blind: whatever the operator confirmed
    // about this device describes a stand that no longer exists. Devices absent
    // from `before` are new to us and the ordinary path below queues them.
    if (before && _reconciled.has(name) && before.has(name) && before.get(name) !== fingerprint) {
      _reconciled.delete(name)
      stale.push(name)
      _queue(name)
    }

    _lastStates.set(name, fingerprint)
    if (_seen.has(name)) continue
    _seen.add(name)
    if (_reconciled.has(name)) continue
    _queue(name)
  }

  if (stale.length) markReconciled(_seenServer, stale, false)
}

/**
 * The state socket went down. Remember what every device looked like, so the
 * next publish — the resync snapshot — can tell whether anything moved while we
 * were blind.
 */
export function noteStateDisconnected() {
  _frozenStates = new Map(_lastStates)
}

function _clearPending() {
  // Spread, not the ref's value: postMessage clones its payload and a Vue
  // reactive array is as uncloneable as a reactive object.
  const devices = [...pendingDevices.value]
  pendingDevices.value = []
  if (!devices.length) return

  // Recorded here, at the point the operator actually resolved the prompt,
  // rather than when it was raised. Reloading with a prompt still open has to
  // bring it back — it was never dealt with — and only a confirm, a dismiss or a
  // "nothing bound to reconcile" is evidence that it was.
  for (const name of devices) _reconciled.add(name)
  if (_seenServer) markReconciled(_seenServer, devices, true)

  _settingsChannel.postMessage({ type: 'switchSyncResolved', devices })
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
