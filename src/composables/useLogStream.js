import { ref, watch, onUnmounted } from 'vue'

const MAX_LINES       = 1000       // debug log buffer
const SNAP_INTERVAL   = 50         // ms — snap/render interval (20 Hz)
const CHART_POINTS    = 600        // max chart history points (30 s @ 20 Hz)
const DISPLAY_INTERVAL = 1 / 20   // seconds between interpolated chart points (0.05 s)

// Regex: "PANDA-V3 108700.620 SensorName:-152.70"
const LOG_RE = /\S+ ([\d.]+) ([A-Za-z]\w+):([-\d.]+)/

function getUnit(name) {
  const u = name.toUpperCase()
  if (u.startsWith('PT'))              return 'psi'
  if (u.startsWith('TC'))              return '°C'
  if (u.startsWith('LC'))              return 'kg'
  if (u.includes('CURRENT'))           return 'A'
  if (u.includes('RESISTANCE'))        return 'Ω'
  return ''
}

/**
 * Manages a persistent WebSocket connection to /ws/logs. This is a generic log/sensor stream handler, any data
 * transformation or handling can be handled by a callback function.
 *
 * @param {import('vue').Ref<string>} serverIp
 * @param {{
 *   onBatch?: (timestamp: number, readings: Record<string,number>) => void,
 *   onLog?: (channel: string, message: string) => void,
 * }} [opts]
 * @returns {{ logLines, wsStatus, sensorData, clearLogs, clearSensorData }}
 */
export function useLogStream(serverIp, { onBatch, onLog } = {}) {
  const logLines  = ref([])
  const wsStatus  = ref('disconnected')

  /**
   * Throttled sensor snapshot — updated every SNAP_INTERVAL ms.
   * Shape: { [sensorName]: { value: number, unit: string, history: {t,v}[] } }
   * history contains linearly-interpolated 20 Hz chart points; value is the latest raw reading.
   */
  const sensorData = ref({})

  // Internal store — not reactive (avoids ingestion-rate reactivity storms)
  // _store[name] = { value, unit, history: {t,v}[], rawBuf: {t,v}[] }
  //   history — interpolated 20 Hz chart points (fixed device-time grid)
  //   rawBuf  — recent raw readings kept for interpolation bracket lookup
  const _store = {}

  // Batch accumulator for onBatch callback (CSV path — fires at full ingestion rate)
  let _pendingTs       = null
  let _pendingReadings = {}
  let _pendingCount    = 0   // avoids Object.keys() on every flush

  // Latest device timestamp seen; used by snap timer to detect new data
  let _latestT   = null
  let _lastEmitT = null  // _latestT at last history push — prevents duplicate chart points

  let ws        = null
  let snapTimer = null

  // ── Helpers ────────────────────────────────────────────────────────────────

  function flushBatch() {
    if (_pendingTs !== null && onBatch && _pendingCount > 0) {
      onBatch(_pendingTs, { ..._pendingReadings })
    }
    _pendingTs       = null
    _pendingReadings = {}
    _pendingCount    = 0
  }

  function pushLogLine(text) {
    logLines.value.push(text)
    if (logLines.value.length > MAX_LINES) {
      logLines.value.splice(0, logLines.value.length - MAX_LINES)
    }
  }

  // ── Snapshot timer (20 Hz) ─────────────────────────────────────────────────
  // Fires every SNAP_INTERVAL ms. On each tick it advances a fixed 20 Hz device-
  // timestamp grid by one step (DISPLAY_INTERVAL = 0.05 s) and linearly
  // interpolates between the two rawBuf samples that bracket that timestamp.
  // At 190 Hz both brackets are always present; at 20 Hz the left bracket is
  // used as a nearest-neighbour fallback. sensorData is always written at 20 Hz
  // for smooth chart and value-display updates.

  function startSnap() {
    if (snapTimer) return
    snapTimer = setInterval(() => {
      if (_latestT === null) return

      // Bootstrap: align the display grid to the first available device timestamp
      if (_lastEmitT === null) {
        let minT = Infinity
        for (const info of Object.values(_store)) {
          if (info.rawBuf.length > 0) minT = Math.min(minT, info.rawBuf[0].t)
        }
        if (!isFinite(minT)) return
        _lastEmitT = minT - DISPLAY_INTERVAL
      }

      // Target timestamp for this display tick — fixed 20 Hz grid in device time
      const expectedT  = _lastEmitT + DISPLAY_INTERVAL

      // Only advance history when new device data straddles expectedT.
      // At 190 Hz both brackets are always present; at 20 Hz we may only have
      // the left bracket (nearest-neighbour fallback), but sensorData still
      // updates every tick for smooth value display.
      const hasNewData = _latestT > _lastEmitT

      const snap = {}

      for (const [name, info] of Object.entries(_store)) {
        if (hasNewData) {
          // Keep rawBuf bounded: drop entries well before the interpolation point
          const pruneT = expectedT - DISPLAY_INTERVAL * 4
          while (info.rawBuf.length > 0 && info.rawBuf[0].t < pruneT) {
            info.rawBuf.shift()
          }

          // Find the samples immediately before and after expectedT
          let lo = null, hi = null
          for (const p of info.rawBuf) {
            if (p.t <= expectedT) lo = p
            else if (hi === null) { hi = p; break }
          }

          if (lo !== null) {
            let v
            if (hi !== null && hi.t !== lo.t) {
              // Linear interpolation between the two bracketing samples
              const alpha = (expectedT - lo.t) / (hi.t - lo.t)
              v = lo.v + alpha * (hi.v - lo.v)
            } else {
              // Only left bracket available (e.g. 20 Hz stream, exact alignment)
              v = lo.v
            }
            info.history.push({ t: expectedT, v })
            if (info.history.length > CHART_POINTS) info.history.shift()
          }
        }

        snap[name] = { value: info.value, unit: info.unit, history: info.history.slice() }
      }

      if (hasNewData) _lastEmitT = expectedT

      // Always write sensorData at 20 Hz for smooth chart rendering and value display
      sensorData.value = snap
    }, SNAP_INTERVAL)
  }

  function stopSnap() {
    clearInterval(snapTimer)
    snapTimer = null
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  function disconnect() {
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      ws.close()
      ws = null
    }
    flushBatch()
    stopSnap()
    wsStatus.value = 'disconnected'
  }

  function connect(ip) {
    disconnect()
    if (!ip) return

    const host = ip === 'localhost' ? '127.0.0.1' : ip
    wsStatus.value = 'connecting'

    try {
      ws = new WebSocket(`ws://${host}:8000/ws/logs`)
    } catch {
      wsStatus.value = 'error'
      return
    }

    ws.onopen = () => {
      wsStatus.value = 'connected'
      startSnap()
    }

    // Expected message format: { channel: 'log' | 'syslog' | 'debuglog' | 'errlog' | 'packetlog', data: string }
    // This triggers onBatch callbacks and updates the internal store, which is snapshotted to sensorData every SNAP_INTERVAL ms.
    ws.onmessage = (event) => {
      let parsed = null
      try { parsed = JSON.parse(event.data) } catch { /* not JSON */ }

      if (!parsed?.channel || !parsed?.data) {
        pushLogLine(String(event.data))
        return
      }

      if (parsed.channel === 'log') {
        // ── Hot path: sensor readings ──────────────────────────────────────────
        // No reactive writes here — sensorData is only updated by the snap timer.
        const m = LOG_RE.exec(parsed.data)
        if (!m) {
          // Non-sensor log message (e.g. STATUS updates) — forward to cold path
          onLog?.('log', String(parsed.data))
          return
        }
        const t    = parseFloat(m[1])
        const name = m[2]
        const val  = parseFloat(m[3])

        if (t !== _pendingTs) {
          flushBatch()
          _pendingTs = t
        }
        _pendingReadings[name] = val
        _pendingCount++
        _latestT = t

        const entry = _store[name]
        if (entry) {
          entry.value = val
          entry.rawBuf.push({ t, v: val })
        } else {
          _store[name] = {
            value:   val,
            unit:    getUnit(name),
            history: [],
            rawBuf:  [{ t, v: val }],
          }
        }
      } else {
        // ── Cold path: syslog / debuglog / errlog / packetlog ──────────────────
        const prefix = parsed.channel === 'syslog'   ? '[sys]' :
                       parsed.channel === 'debuglog'  ? '[dbg]' :
                       parsed.channel === 'errlog'    ? '[err]' :
                       parsed.channel === 'packetlog' ? '[pkt]' : '[unknown]'
        pushLogLine(`${prefix} ${parsed.data}`)
        onLog?.(parsed.channel, String(parsed.data))
      }
    }

    ws.onerror = () => {
      wsStatus.value = 'error'
    }

    ws.onclose = () => {
      flushBatch()
      stopSnap()
      if (wsStatus.value !== 'disconnected') wsStatus.value = 'disconnected'
    }
  }

  // Reconnect whenever server IP changes; clear log + sensor display
  watch(serverIp, (ip) => {
    logLines.value   = []
    sensorData.value = {}
    for (const k of Object.keys(_store)) delete _store[k]
    connect(ip)
  }, { immediate: true })

  onUnmounted(disconnect)

  function clearLogs() {
    logLines.value = []
  }

  function clearSensorData() {
    for (const info of Object.values(_store)) {
      info.history = []
      info.rawBuf  = []
    }
    sensorData.value = {}
    _latestT   = null
    _lastEmitT = null
  }

  return { logLines, wsStatus, sensorData, clearLogs, clearSensorData }
}
