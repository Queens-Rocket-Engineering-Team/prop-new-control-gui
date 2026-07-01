import { ref, computed } from 'vue'
import { useReconnectingSocket } from './useReconnectingSocket.js'

const COMMAND_CAP = 200   // keep at most this many commands in memory

/**
 * Manages a persistent /ws/state connection.
 *
 * The server sends one `state.snapshot` on every connect, then incremental delta
 * events each carrying a monotonically increasing `state_version`. This composable
 * maintains the authoritative in-memory store for devices, kasa devices, and
 * command lifecycle, and republishes to reactive refs after each message.
 *
 * @param {import('vue').Ref<string>} serverIp
 * @returns {{
 *   devices:         import('vue').Ref<object[]>,
 *   kasaDevices:     import('vue').Ref<object[]>,
 *   commandsById:    import('vue').Ref<Map<number,object>>,
 *   stateVersion:    import('vue').Ref<number>,
 *   status:          import('vue').Ref<string>,
 *   getStateSnapshot: () => Promise<object>,
 * }}
 */
export function useStateStream(serverIp) {
  // ── Non-reactive internal maps (hot path — no Vue reactivity overhead) ────────
  const _byName     = new Map()   // device_name  → device object (mutated in-place)
  const _kasaByHost = new Map()   // host         → kasa object
  const _commands   = new Map()   // command_id   → command object
  let   _version    = -1

  // ── Reactive refs (published snapshots of the maps) ──────────────────────────
  const devices      = ref([])
  const kasaDevices  = ref([])
  const commandsById = ref(new Map())
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
  function _applySnapshot(state) {
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

    _version = state.state_version ?? -1
    _publishDevices()
    _publishKasa()
    _publishCommands()
    _publishVersion(_version)
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
      'reported_timestamp',
      'accepted_state',
      'accepted_timestamp',
      'pending_command_id',
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
  function _handleDelta(msg) {
    const v = msg.state_version ?? 0
    if (v <= _version) return    // stale / replay — drop
    _version = v
    _publishVersion(_version)

    switch (msg.type) {
      case 'device.registered': {
        _byName.set(msg.device.name, msg.device)
        _publishDevices()
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
      // Unknown delta types are silently ignored
    }
  }

  // ── WebSocket via useReconnectingSocket ────────────────────────────────────────
  // The server always sends a state.snapshot immediately on connect, so every
  // reconnect automatically resyncs the full store before any deltas arrive.
  const { status } = useReconnectingSocket(wsUrl, {
    onMessage(event) {
      let msg = null
      try { msg = JSON.parse(event.data) } catch { return }
      if (!msg?.type) return

      if (msg.type === 'state.snapshot') {
        _applySnapshot(msg.state)
      } else {
        _handleDelta(msg)
      }
    },
  })

  // ── HTTP snapshot (for debug / bootstrap fallback) ─────────────────────────────
  async function getStateSnapshot() {
    if (!baseUrl.value) throw new Error('No server IP configured')
    const res = await fetch(`${baseUrl.value}/v1/state`)
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`${res.status}: ${text}`)
    }
    return res.json()
  }

  return { devices, kasaDevices, commandsById, stateVersion, status, getStateSnapshot }
}
