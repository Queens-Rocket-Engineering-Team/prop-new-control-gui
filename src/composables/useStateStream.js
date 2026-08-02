import { ref, computed, watch } from 'vue'
import { useReconnectingSocket } from './useReconnectingSocket.js'
import { normalizeSessionComponents } from '../utils/session.js'

const COMMAND_CAP = 200   // keep at most this many commands in memory

/**
 * Manages a persistent /ws/state connection.
 *
 * The server sends one `state.snapshot` on every connect, then incremental delta
 * events each carrying a monotonically increasing `state_version`. This composable
 * maintains the authoritative in-memory store for devices, kasa devices, and
 * command lifecycle, and republishes to reactive refs after each message.
 *
 * Tare offsets ride the same stream. The server owns them and applies them to
 * telemetry before fan-out, so `tares` here is only ever read to tell whether a
 * sensor is tared — never subtracted from a reading.
 *
 * @param {import('vue').Ref<string>} serverIp
 * @param {{ onDeviceRegistered?: (deviceName: string) => void }} [opts]
 *   onDeviceRegistered fires on every `device.registered` delta — including a
 *   device rejoining that was never marked disconnected, which produces no
 *   `connected` transition for callers to watch.
 * @returns {{
 *   devices:         import('vue').Ref<object[]>,
 *   kasaDevices:     import('vue').Ref<object[]>,
 *   commandsById:    import('vue').Ref<Map<number,object>>,
 *   tares:           import('vue').Ref<Record<string,number>>,
 *   session:         import('vue').Ref<object|null>,
 *   sessionWarning:  import('vue').Ref<object|null>,
 *   stateVersion:    import('vue').Ref<number>,
 *   status:          import('vue').Ref<string>,
 *   getStateSnapshot: () => Promise<object>,
 *   applyStateSnapshot: (snapshot: object, version?: number) => boolean,
 *   resyncState:      () => Promise<object>,
 * }}
 */
export function useStateStream(serverIp, { onDeviceRegistered } = {}) {
  // ── Non-reactive internal maps (hot path — no Vue reactivity overhead) ────────
  const _byName     = new Map()   // device_name  → device object (mutated in-place)
  const _kasaByHost = new Map()   // host         → kasa object
  const _commands   = new Map()   // command_id   → command object
  let   _version    = -1

  // ── Reactive refs (published snapshots of the maps) ──────────────────────────
  const devices      = ref([])
  const kasaDevices  = ref([])
  const commandsById = ref(new Map())
  const tares        = ref({})    // sensor_name → offset
  const session      = ref(null)
  const sessionWarning = ref(null)
  const stateVersion = ref(-1)

  // ── URL + baseUrl ──────────────────────────────────────────────────────────────
  const _host = computed(() => {
    const ip = serverIp.value
    if (!ip) return null
    return ip === 'localhost' ? '127.0.0.1' : ip
  })

  const wsUrl = computed(() =>
    _host.value ? `ws://${_host.value}:8000/ws/state` : null
  )

  const baseUrl = computed(() =>
    _host.value ? `http://${_host.value}:8000` : null
  )

  // ── Publish helpers ────────────────────────────────────────────────────────────
  function _publishDevices()  { devices.value      = [..._byName.values()] }
  function _publishKasa()     { kasaDevices.value   = [..._kasaByHost.values()] }
  function _publishCommands() { commandsById.value  = new Map(_commands) }
  function _publishVersion(v) { stateVersion.value  = v }

  // ── Full resync from snapshot ──────────────────────────────────────────────────
  function _normalizeVersion(value, fallback = -1) {
    const version = Number(value)
    return Number.isFinite(version) ? version : fallback
  }

  function _normalizeSession(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null

    const normalized = { ...value }
    normalized.components = normalizeSessionComponents(value.components)
    return normalized
  }

  function _setSession(value) {
    const previousId = session.value?.id ?? null
    const next = value == null ? null : _normalizeSession(value)
    session.value = next

    // A warning belongs to one server-side session. Do not let it bleed into a
    // later session (or remain after that session has stopped).
    if (!next || previousId !== (next.id ?? null)) {
      sessionWarning.value = null
    }
  }

  function _applySnapshot(state, version = undefined) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false

    const snapshotVersion = _normalizeVersion(
      version ?? state.state_version,
      _version
    )
    if (snapshotVersion >= 0 && snapshotVersion < _version) return false

    _byName.clear()
    _kasaByHost.clear()
    _commands.clear()

    for (const dev of (state.devices ?? [])) {
      _byName.set(dev.name, dev)
    }
    for (const kasa of (state.kasa ?? [])) {
      _kasaByHost.set(kasa.host, kasa)
    }
    for (const cmd of [
      ...(state.commands?.pending ?? []),
      ...(state.commands?.recent  ?? []),
    ]) {
      _commands.set(cmd.command_id, cmd)
    }

    const snapshotTares = state.tares
    tares.value = snapshotTares && typeof snapshotTares === 'object' && !Array.isArray(snapshotTares)
      ? { ...snapshotTares }
      : {}
    _setSession(state.session ?? null)

    _version = snapshotVersion
    _publishDevices()
    _publishKasa()
    _publishCommands()
    _publishVersion(_version)
    return true
  }

  /**
   * Apply either a websocket snapshot envelope or the direct state shape
   * returned by GET /v1/state. The explicit version parameter is useful to
   * callers that already unwrapped an envelope.
   */
  function applyStateSnapshot(snapshot, version = undefined) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return false
    }

    const isEnvelope = !!snapshot.state &&
      typeof snapshot.state === 'object' &&
      !Array.isArray(snapshot.state) &&
      (snapshot.type === 'state.snapshot' ||
        _hasOwn(snapshot, 'state_version') ||
        _hasOwn(snapshot.state, 'devices'))

    const state = isEnvelope ? snapshot.state : snapshot
    const snapshotVersion = version ?? snapshot.state_version
    return _applySnapshot(state, snapshotVersion)
  }

  // ── Command upsert (with cap) ──────────────────────────────────────────────────
  function _upsertCommand(cmd) {
    _commands.set(cmd.command_id, cmd)
    if (_commands.size > COMMAND_CAP) {
      const oldest = _commands.keys().next().value
      _commands.delete(oldest)
    }
    _publishCommands()
  }

  function _hasOwn(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key)
  }

  function _controlPayload(msg) {
    return msg.control && typeof msg.control === 'object' ? msg.control : null
  }

  function _controlId(msg) {
    const control = _controlPayload(msg)
    return msg.control_id ?? control?.control_id ?? control?.id
  }

  function _controlName(msg) {
    const control = _controlPayload(msg)
    return msg.control_name ?? control?.control_name ?? control?.name
  }

  function _deviceName(msg) {
    const control = _controlPayload(msg)
    const nestedDevice = control?.device && typeof control.device === 'object'
      ? control.device.name
      : control?.device

    return msg.device_name ?? control?.device_name ?? msg.device?.name ?? nestedDevice
  }

  function _findControl(dev, msg) {
    const controls = dev.controls ?? []
    const id = _controlId(msg)
    const name = _controlName(msg)

    if (id != null) {
      const idText = String(id)
      const byId = controls.find(c =>
        c.id === id ||
        c.control_id === id ||
        (c.id != null && String(c.id) === idText) ||
        (c.control_id != null && String(c.control_id) === idText)
      )
      if (byId) return byId
    }

    if (name != null) {
      return controls.find(c => c.name === name || c.control_name === name)
    }

    return null
  }

  function _mergeControlDelta(ctrl, msg) {
    const control = _controlPayload(msg)
    if (control) Object.assign(ctrl, control)

    for (const key of [
      'reported_state',
      'reported_status',
      'reported_timestamp',
      'accepted_state',
      'accepted_timestamp',
      'pending_command_id',
      'settled',
    ]) {
      if (_hasOwn(msg, key)) {
        ctrl[key] = msg[key]
      }
    }

    if (_hasOwn(control, 'pending_command_id')) {
      ctrl.pending_command_id = control.pending_command_id
    } else if (msg.type === 'control.updated' && (_hasOwn(msg, 'reported_state') || _hasOwn(control, 'reported_state'))) {
      ctrl.pending_command_id = null
    }
  }

  function _applyControlDelta(msg) {
    const devName = _deviceName(msg)
    const dev = _byName.get(devName)
    if (!dev) return

    const ctrl = _findControl(dev, msg)
    if (ctrl) {
      _mergeControlDelta(ctrl, msg)
      _publishDevices()
      return
    }

    if (msg.control && typeof msg.control === 'object') {
      const control = { ...msg.control }
      if (control.id == null && control.control_id != null) control.id = control.control_id
      if (control.name == null && control.control_name != null) control.name = control.control_name
      dev.controls = [...(dev.controls ?? []), control]
      _publishDevices()
    }
  }

  // ── Delta event dispatcher ─────────────────────────────────────────────────────
  const SESSION_FIELDS = [
    'id',
    'name',
    'status',
    'started_unix',
    'started_monotonic',
    'stopped_unix',
    'size_bytes',
    'download_path',
    'components',
  ]

  function _sessionPayload(msg) {
    const nested = [msg.session, msg.data?.session]
      .find(value => value && typeof value === 'object' && !Array.isArray(value))
    if (nested) return nested

    const source = msg.data && typeof msg.data === 'object' && !Array.isArray(msg.data)
      ? msg.data
      : msg
    const payload = {}
    for (const key of SESSION_FIELDS) {
      if (key === 'status' && (source.component || source.component_name)) continue
      if (_hasOwn(source, key)) payload[key] = source[key]
    }
    if (!_hasOwn(payload, 'id') && _hasOwn(source, 'session_id')) {
      payload.id = source.session_id
    }
    return Object.keys(payload).length ? payload : null
  }

  function _componentPatch(msg, payload) {
    if (payload?.components && typeof payload.components === 'object' && !Array.isArray(payload.components)) {
      return normalizeSessionComponents(payload.components)
    }

    const source = msg.update && typeof msg.update === 'object'
      ? msg.update
      : msg.data && typeof msg.data === 'object' && !Array.isArray(msg.data)
        ? msg.data
        : msg
    const name = source.component_name ?? source.component
    if (typeof name !== 'string' || !name) return {}

    let value
    if (_hasOwn(source, 'component_status')) {
      value = source.component_status
    } else if (_hasOwn(source, 'value')) {
      value = source.value
    } else if (_hasOwn(source, 'status')) {
      value = { status: source.status, detail: source.detail ?? null }
    } else {
      return {}
    }

    return normalizeSessionComponents({ [name]: value })
  }

  function _mergeSessionPatch(payload, componentPatch = {}) {
    const current = session.value
    if (!current) return false

    const payloadId = payload?.id ?? null
    if (payloadId !== null && current.id != null && payloadId !== current.id) {
      return false
    }

    const normalized = payload ? _normalizeSession(payload) : null
    session.value = {
      ...current,
      ...(normalized ?? {}),
      components: {
        ...(current.components ?? {}),
        ...(normalized?.components ?? {}),
        ...componentPatch,
      },
    }
    return true
  }

  function _warningPayload(msg) {
    const warning = msg.warning ?? msg.data?.warning ?? msg.data ?? msg.detail ?? msg.message
    const payload = warning && typeof warning === 'object' && !Array.isArray(warning)
      ? { ...warning }
      : { message: warning == null ? 'Session warning' : String(warning) }

    return {
      ...payload,
      session_id: payload.session_id ?? msg.session_id ?? msg.session?.id ?? session.value?.id ?? null,
      component: payload.component ?? msg.component ?? msg.component_name ?? null,
    }
  }

  function _requestResync(reason) {
    if (!baseUrl.value) return
    void resyncState().catch((error) => {
      console.error(`[state] resync failed after ${reason}:`, error)
    })
  }

  function _handleDelta(msg) {
    const v = _normalizeVersion(msg.state_version, -1)
    if (v < 0) {
      if (String(msg.type).startsWith('session.')) {
        _requestResync(`${msg.type} without state_version`)
      }
      return
    }
    if (v <= _version) return    // stale / replay — drop
    _version = v
    _publishVersion(_version)

    switch (msg.type) {
      case 'device.registered': {
        _byName.set(msg.device.name, msg.device)
        _publishDevices()
        // A device that just joined has not been told to stream. Signalled here
        // rather than via a `connected` transition because an unclean drop
        // leaves the old entry marked connected, so a rejoin changes nothing
        // callers could watch.
        onDeviceRegistered?.(msg.device.name)
        break
      }
      case 'device.disconnected': {
        const dev = _byName.get(msg.device_name)
        if (dev) {
          dev.connected = false
          // Keep the entry so the P&ID retains last-known control states (greyed)
          dev.heartbeat = {
            state: 'disconnected',
            consecutive_misses: dev.heartbeat?.consecutive_misses ?? 0,
          }
          _publishDevices()
        }
        break
      }
      case 'control.updated': {
        _applyControlDelta(msg)
        break
      }
      case 'control.accepted': {
        _applyControlDelta(msg)
        break
      }
      // Fired when a control's reported_status flips to 'error'. Carries the same
      // control payload as control.updated — merged into the store the same way,
      // so the error surfaces through ctrl.reported_status.
      case 'control.error': {
        _applyControlDelta(msg)
        break
      }
      case 'command.sent':
      case 'command.acked':
      case 'command.nacked':
      case 'command.timed_out': {
        _upsertCommand(msg.command)
        break
      }
      case 'heartbeat.updated': {
        const dev = _byName.get(msg.device_name)
        if (dev) {
          dev.heartbeat = msg.heartbeat
          _publishDevices()
        }
        break
      }
      case 'tare.updated': {
        tares.value = { ...tares.value, [msg.sensor_name]: msg.offset }
        break
      }
      case 'tare.cleared': {
        if (msg.sensor_name in tares.value) {
          const next = { ...tares.value }
          delete next[msg.sensor_name]
          tares.value = next
        }
        break
      }
      case 'kasa.registered':
      case 'kasa.updated': {
        _kasaByHost.set(msg.kasa.host, msg.kasa)
        _publishKasa()
        break
      }
      case 'kasa.disconnected': {
        const kasa = _kasaByHost.get(msg.kasa.host)
        if (kasa) {
          Object.assign(kasa, msg.kasa)   // server sets connected: false
          _publishKasa()
        }
        break
      }
      case 'session.started': {
        const payload = _sessionPayload(msg)
        if (!payload || typeof payload.id !== 'string' || !payload.id) {
          _requestResync('incomplete session.started')
          break
        }
        _setSession(payload)
        sessionWarning.value = null
        break
      }
      case 'session.updated': {
        const payload = _sessionPayload(msg)
        const components = _componentPatch(msg, payload)
        const hasPatch = !!payload || Object.keys(components).length > 0
        if (!hasPatch || !_mergeSessionPatch(payload, components)) {
          _requestResync('incomplete session.updated')
        }
        break
      }
      case 'session.stopped': {
        const payload = _sessionPayload(msg)
        const stoppedId = payload?.id ?? msg.session_id ?? null
        if (stoppedId && session.value?.id && stoppedId !== session.value.id) {
          _requestResync('mismatched session.stopped')
          break
        }
        _setSession(null)
        break
      }
      case 'session.warning': {
        sessionWarning.value = _warningPayload(msg)
        const payload = _sessionPayload(msg)
        const components = _componentPatch(msg, payload)
        if ((payload || Object.keys(components).length) && session.value) {
          _mergeSessionPatch(payload, components)
        }
        break
      }
      // Unknown delta types are silently ignored
    }
  }

  // ── WebSocket via useReconnectingSocket ────────────────────────────────────────
  // The server always sends a state.snapshot immediately on connect, so every
  // reconnect automatically resyncs the full store before any deltas arrive.
  const { status } = useReconnectingSocket(wsUrl, {
    onMessage(event) {
      const sourceUrl = event.currentTarget?.url ?? event.target?.url
      if (sourceUrl && sourceUrl !== wsUrl.value) return

      let msg = null
      try { msg = JSON.parse(event.data) } catch { return }
      if (!msg?.type) return

      if (msg.type === 'state.snapshot') {
        applyStateSnapshot(msg)
      } else {
        _handleDelta(msg)
      }
    },
  })

  // ── HTTP snapshot (for debug / bootstrap fallback) ─────────────────────────────
  async function getStateSnapshot() {
    const target = baseUrl.value
    if (!target) throw new Error('No server IP configured')
    const res = await fetch(`${target}/v1/state`)
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      const error = new Error(`${res.status}: ${text}`)
      error.status = res.status
      throw error
    }
    return res.json()
  }

  let _resyncRequest = null

  /**
   * Fetch and apply the server's authoritative state. Concurrent callers for
   * one target share a request; a response from an old target is returned but
   * never applied after the configured server changes.
   */
  async function resyncState() {
    const target = baseUrl.value
    if (!target) throw new Error('No server IP configured')
    if (_resyncRequest?.target === target) return _resyncRequest.promise

    const promise = (async () => {
      const snapshot = await getStateSnapshot()
      if (baseUrl.value === target) applyStateSnapshot(snapshot)
      return snapshot
    })()
    const request = { target, promise }
    _resyncRequest = request

    try {
      return await promise
    } finally {
      if (_resyncRequest === request) _resyncRequest = null
    }
  }

  // Session state is authoritative only for the currently selected server.
  // Socket disconnects do not touch it; reconnect snapshots will refresh it.
  watch(_host, (host, previousHost) => {
    if (host === previousHost) return
    session.value = null
    sessionWarning.value = null
    _version = -1
    _publishVersion(_version)
  }, { flush: 'sync' })

  return {
    devices,
    kasaDevices,
    commandsById,
    tares,
    session,
    sessionWarning,
    stateVersion,
    status,
    getStateSnapshot,
    applyStateSnapshot,
    resyncState,
  }
}
