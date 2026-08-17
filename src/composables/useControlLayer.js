// Everything about commanding the stand that does not depend on the P&ID.
//
// This used to live inside control_panel.vue, which meant it existed only while
// that panel was mounted. App.vue swaps views by replacing a component, so
// navigating to a telemetry view unmounted the panel and took the keyboard with
// it — the switch panel driving the stand is a keyboard-emulating HID, so an
// operator who had clicked onto Graph had silently disarmed every switch. That
// is the reason this module exists: instantiate it once in App.vue, above the
// view swap, and the keys behave the same on every view of every window.
//
// What stayed behind in control_panel.vue is the half that genuinely needs the
// drawing: which valve/sensor/tank cards exist and where they sit. Everything
// here resolves through the device list instead, which App.vue already owns.
//
// One instance per window. The panel injects it rather than building its own, so
// a key press and a mouse click run the same code and share the same pending /
// NACK bookkeeping — a valve commanded by keystroke shows PENDING on its card
// exactly as a clicked one does.

import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { CAPS } from '../lib/platform.js'
import { useServerApi } from './useServerApi.js'
import { useKeyBindings, controlKey } from './useKeyBindings.js'
import { useSwitchSync } from './useSwitchSync.js'

// Controls that own a card on the P&ID. They command with valve semantics (OPEN
// is open) wherever they appear, which is the whole point of listing them: a
// relay row — and the relay column of the CSV — reads CLOSED as energised, i.e.
// ON, which is the state a valve card calls shut. One control described two ways
// is how an operator ends up commanding the opposite of what they meant.
//
// Module-level so the panel and the recorder can't drift apart on it.
export function isPidCardControl(name) {
  const norm = name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  // The clamshell is drawn as the dotted shell outline around the onboard tank
  // rather than as a valve symbol, so it has no AV tag to be recognised by.
  return norm.startsWith('av') || norm.startsWith('clamshell')
}

/**
 * @param {object} deps  reactive state owned by App.vue
 * @param {import('vue').Ref<string>} deps.serverIp
 * @param {import('vue').Ref<Array>}  deps.devices
 * @param {import('vue').Ref<Array>}  deps.kasaDevices
 * @param {import('vue').Ref<Map>}    deps.commandsById
 * @param {import('vue').Ref<string>} deps.pidConfig
 * @param {(reason: string) => Promise} deps.requestStatusSnapshot
 * @param {(host: string, active: boolean) => void} deps.setKasaState
 */
export function useControlLayer({
  serverIp,
  devices,
  kasaDevices,
  commandsById,
  pidConfig,
  requestStatusSnapshot,
  setKasaState,
}) {
  const { setControl, sendEstop } = useServerApi(serverIp)

  // The view-only build renders live state but cannot act on it. Controls are
  // disabled rather than hidden so the pad still sees what exists and what it is
  // doing — a control that looks live and silently fails is worse than a dead one.
  const readOnly = !CAPS.commands

  // ── Emergency stop ─────────────────────────────────────────────────────────

  const showEstopConfirm = ref(false)
  const estopPending     = ref(false)

  async function confirmEstop() {
    estopPending.value = true
    try {
      await sendEstop()
      await requestStatusSnapshot('estop')
    } catch (err) {
      console.error('[ControlLayer] ESTOP failed:', err)
    } finally {
      estopPending.value     = false
      showEstopConfirm.value = false
    }
  }

  // ── ID normalisation ───────────────────────────────────────────────────────

  // Strip non-alphanumeric, lowercase — for fuzzy matching against server names.
  function normalizeId(id) {
    return id.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  }

  // Display label: strip non-alphanumeric, UPPERCASE.
  function toControlKey(id) {
    return id.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  }

  // ── Control indexes (flat maps keyed by normalizeId) ───────────────────────

  // Flattens all device controls into a Map: normalizeId(name) → control object
  // (with added deviceName/deviceConnected for context). Used for fuzzy
  // drawio-ID → server-name matching.
  // `deviceConnected` is tri-state on purpose: strictly `false` means the server
  // told us the owning device dropped. An older server that omits `connected`
  // leaves it undefined, which must not read as offline.
  const normalizedControlLookup = computed(() => {
    const map = new Map()
    for (const dev of devices.value) {
      for (const ctrl of (dev.controls ?? [])) {
        map.set(normalizeId(ctrl.name), {
          ...ctrl,
          deviceName:      dev.name,
          deviceConnected: dev.connected,
        })
      }
    }
    return map
  })

  // Map: control.name → control object (for direct name lookups)
  const controlLookup = computed(() => {
    const map = new Map()
    for (const dev of devices.value) {
      for (const ctrl of (dev.controls ?? [])) {
        map.set(ctrl.name, { ...ctrl, deviceConnected: dev.connected })
      }
    }
    return map
  })

  // ── Fuzzy matching: drawio ID → server controls ────────────────────────────
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

  // ── Variable (non-BOOL) control detection ──────────────────────────────────
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

  // ── Auxiliary controls (BOOL server controls with no P&ID card) ────────────

  const auxiliaryControls = computed(() => {
    const result = []
    for (const dev of devices.value) {
      for (const ctrl of (dev.controls ?? [])) {
        if (!isPidCardControl(ctrl.name) && !isVariableType(ctrl.type)) {
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

  // ── Variable controls (numeric — isolated from relays/valves) ──────────────
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

  // ── Variable control editor popover ────────────────────────────────────────
  // The editor is anchored to its card in the aux panel, so unlike the E-STOP
  // dialog it has nowhere to appear when the Control panel is not the active
  // view. That is why a variable key is the one binding this module refuses to
  // act on off-panel — see the dispatch below.

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

  // The edit button is disabled once a device drops, but a popover already open
  // when it dropped would otherwise sit there accepting input it can't submit.
  watch(devices, () => {
    if (openVariableEditor.value && isAuxOffline(openVariableEditor.value)) {
      openVariableEditor.value = null
    }
  })

  async function submitVariableControl(controlName) {
    const num = Number(variableInput.value)
    if (variableInput.value === '' || Number.isNaN(num)) return
    if (isAuxOffline(controlName)) { openVariableEditor.value = null; return }

    openVariableEditor.value = null
    pending[controlName] = { requested: num }
    delete warning[controlName]
    try {
      await setControl(controlName, num)
      requestStatusSnapshot('control')
    } catch (err) {
      console.error(`[ControlLayer] CONTROL ${controlName} failed:`, err)
      delete pending[controlName]
      warning[controlName] = { message: String(err), errorCode: null }
    }
  }

  // ── Server-reported control status ─────────────────────────────────────────
  // The server publishes two fields per control:
  //   settled         — false while a command is awaiting ACK *or* the device's
  //                     last STATUS report was 'pending' (still actuating).
  //   reported_status — 'confirmed' | 'pending' | 'error' | null (null = no STATUS
  //                     report ever received).
  // While status is 'pending', reported_state is the target being moved toward,
  // not the device's actual state; while it's 'error', reported_state is the last
  // known-good value and must not be shown as current truth.

  function isCtrlSettling(ctrl) {
    return ctrl?.settled === false
  }

  function isCtrlErrored(ctrl) {
    return ctrl?.reported_status === 'error'
  }

  // ── Offline (owning device disconnected) ───────────────────────────────────
  // The server keeps a dropped device's entry so the P&ID can keep showing its
  // last-known control states, but nothing it owns can be commanded until it
  // rejoins — the command would just be rejected. Grey those controls out and
  // lock input rather than letting the operator fire a command that can't land.

  function isCtrlOffline(ctrl) {
    return ctrl?.deviceConnected === false
  }

  function isControlOffline(drawioId) {
    return getMatchingControls(drawioId).some(isCtrlOffline)
  }

  function isAuxOffline(controlName) {
    return isCtrlOffline(controlLookup.value.get(controlName))
  }

  // ── Pending / NACK tracking ────────────────────────────────────────────────
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

        // Only clear once the server says the control has settled. While
        // reported_status is 'pending', reported_state already echoes the value we
        // requested (it's the target, not the actual state) — clearing on a match
        // alone would drop the pending indicator mid-actuation.
        const serverState = ctrl.reported_state ?? ctrl.accepted_state
        if (!isCtrlSettling(ctrl) && statesMatch(serverState, p.requested)) {
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

  // Pending covers both the local optimistic window (command issued, server hasn't
  // echoed anything yet) and the server's own `settled === false`.
  function isControlPending(drawioId) {
    const ctrls = getMatchingControls(drawioId)
    for (const ctrl of ctrls) {
      if (pending[ctrl.name]) return true
      if (isCtrlSettling(ctrl)) return true
      if (ctrl.pending_command_id) {
        const cmd = commandsById.value.get(ctrl.pending_command_id)
        if (cmd?.state === 'sent') return true
      }
    }
    return false
  }

  // Whether to lock the operator out of re-commanding. Deliberately narrower than
  // isControlPending: `settled === false` is server-owned with no client-side
  // escape, so if a device drops mid-actuation it would latch the toggle disabled
  // forever. Only the locally-tracked in-flight command — which self-clears on
  // NACK/timeout — blocks input; `settled` drives the indicator alone.
  function isControlLocked(drawioId) {
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

  function isControlError(drawioId) {
    return getMatchingControls(drawioId).some(isCtrlErrored)
  }

  function isAuxPending(controlName) {
    if (pending[controlName]) return true
    const ctrl = controlLookup.value.get(controlName)
    if (isCtrlSettling(ctrl)) return true
    if (ctrl?.pending_command_id) {
      const cmd = commandsById.value.get(ctrl.pending_command_id)
      if (cmd?.state === 'sent') return true
    }
    return false
  }

  // See isControlLocked — input lockout deliberately ignores `settled`.
  function isAuxLocked(controlName) {
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

  function isAuxError(controlName) {
    return isCtrlErrored(controlLookup.value.get(controlName))
  }

  // ── Valve toggle ───────────────────────────────────────────────────────────
  // Server-authoritative: do NOT mutate displayed state. Show pending while in-flight.

  async function onValveToggle(drawioId, newOpenState) {
    if (!isValveEnabled(drawioId) || isControlOffline(drawioId)) return
    const controls  = getMatchingControls(drawioId)
    const requested = newOpenState ? 'OPEN' : 'CLOSED'

    for (const ctrl of controls) {
      pending[ctrl.name] = { requested }
      delete warning[ctrl.name]
      try {
        await setControl(ctrl.name, requested)
        requestStatusSnapshot('control')
      } catch (err) {
        console.error(`[ControlLayer] CONTROL ${ctrl.name} failed:`, err)
        delete pending[ctrl.name]
        warning[ctrl.name] = { message: String(err), errorCode: null }
      }
    }
  }

  // ── Aux toggle ─────────────────────────────────────────────────────────────

  async function onAuxToggle(controlName, newEnergised) {
    if (isAuxOffline(controlName)) return
    // Relay: energised=true → CLOSE command (CLOSED state); energised=false → OPEN
    const expected = newEnergised ? 'CLOSED' : 'OPEN'

    pending[controlName] = { requested: expected }
    delete warning[controlName]
    try {
      await setControl(controlName, expected)
      requestStatusSnapshot('control')
    } catch (err) {
      console.error(`[ControlLayer] CONTROL ${controlName} failed:`, err)
      delete pending[controlName]
      warning[controlName] = { message: String(err), errorCode: null }
    }
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
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

  const { keyForTarget, bindings, pressBinding } = useKeyBindings()

  // Set by control_panel.vue's own lifecycle. The only thing it gates is the
  // variable-control editor, which has no home outside that panel.
  const panelActive = ref(false)

  function setPanelActive(active) {
    panelActive.value = active
    if (!active) openVariableEditor.value = null
  }

  // ── Physical switch reconciliation ─────────────────────────────────────────
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

  // The bound valve cards, taken from the bindings rather than from the parsed
  // P&ID. Only bound controls can be reconciled at all — an unbound one has no
  // switch to be out of position — so the two sources agree on the rows, and
  // reading the bindings is what frees this from the drawing. It also means a
  // binding left over from another P&ID is still reconcilable so long as a
  // server control answers to it, which is the safer of the two behaviours.
  const boundValveIds = computed(() => {
    const ids = new Set()
    for (const target of Object.values(bindings.value)) {
      if (target?.type === 'valve' && target.id) ids.add(target.id)
    }
    return [...ids].sort()
  })

  // Every bound valve and relay, with its switch position judged against the
  // device. Variable controls and smart plugs are absent by design: a variable
  // control's key is momentary rather than a position, and a plug is not a device
  // that registers controls.
  const allSyncRows = computed(() => {
    const rows = []
    for (const id of boundValveIds.value) {
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
  // device can register before its controls have landed in the device list.
  // (This used to have to wait on the P&ID parsing too, because valve rows were
  // keyed by drawio IDs the drawing supplied. Reading them from the bindings
  // instead removed that race along with the dependency.)
  watch([pendingDevices, syncRows, devices], () => {
    if (pendingDevices.value.length === 0) return
    if (syncRows.value.length > 0) return
    if (pendingControlNames.value.size === 0) return   // controls not published yet
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

  // ── The global keydown handler ─────────────────────────────────────────────

  function onKeydown(evt) {
    // Resolved before any guard below can return: pressBinding is what records
    // the key as held, and a press that went uncounted would still deliver its
    // keyup, leaving the held set disagreeing with the keyboard.
    const binding = pressBinding(evt)

    // The pad build cannot command the stand — same reason every control in the
    // panel template is :disabled there.
    if (readOnly) return
    // A held key must not machine-gun a valve.
    if (evt.repeat) return

    // Also what exempts the keybind capture box, which is a readonly <input>.
    const el = evt.target
    if (el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)) return

    // The reconciliation prompt is the one dialog that still wants these keys —
    // and the only one that must not let them through. The operator is flipping
    // switches to match the device, so a press records the position it reports
    // and commands nothing. Checked before the generic modal guard below, which
    // would otherwise swallow it like any other open modal.
    if (syncOpen.value) {
      if (!binding) return
      evt.preventDefault()
      recordSwitch(binding)
      return
    }

    // A dialog owns the keyboard while it is up: the E-STOP confirmation and the
    // variable-control popover here, and — via the shared .modal-overlay class —
    // the settings and about modals, whose overlay is focused programmatically
    // but whose keydowns still bubble to window. Settings in particular must be
    // able to capture a key for rebinding without also firing it.
    if (showEstopConfirm.value || openVariableEditor.value) return
    if (document.querySelector('.modal-overlay')) return

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
      // The one binding that stays panel-only: its editor is a popover anchored
      // to a card in the aux panel, so off-panel there is nothing to open. A key
      // that silently opened an invisible input would be worse than one that
      // does nothing.
      case 'variable':
        if (!panelActive.value) return
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

  // Capture phase, so a press is counted as held before anything nested can act
  // on the event — a component that stopped propagation would otherwise leave the
  // key counted as down for the rest of the session. Bound to App.vue's lifecycle,
  // which is the window's: releases are tracked by useKeyBindings itself, which
  // listens for as long as the module is loaded.
  onMounted(() => window.addEventListener('keydown', onKeydown, true))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))

  return {
    readOnly,

    // E-STOP
    showEstopConfirm,
    estopPending,
    confirmEstop,

    // Lookups and display
    normalizeId,
    getMatchingControls,
    isValveEnabled,
    getValveDefaultState,
    getDisplayedOpen,
    auxiliaryControls,
    variableControls,
    getAuxDisplayed,
    getVariableValue,

    // Status
    isControlOffline,
    isControlPending,
    isControlLocked,
    isControlWarning,
    isControlError,
    isAuxOffline,
    isAuxPending,
    isAuxLocked,
    isAuxWarning,
    isAuxError,

    // Commands
    onValveToggle,
    onAuxToggle,

    // Variable editor
    openVariableEditor,
    variableInput,
    toggleVariableEditor,
    cancelVariableEditor,
    submitVariableControl,

    // Switch reconciliation
    pendingDevices,
    syncRows,
    syncOpen,
    outOfSync,
    reviewOpen,
    onSyncConfirm,
    onSyncDismiss,

    // Panel presence
    setPanelActive,
  }
}
