import { ref, watch, onUnmounted } from 'vue'

const MAX_LINES    = 1000   // debug log buffer
const SNAP_INTERVAL = 100  // ms — how often sensorData ref is updated (10 Hz)
const CHART_POINTS  = 3500 // max history points exposed to charts (~35 s @ 100 Hz)

// Regex: "[21:02:21] PANDA-V3 36.799 SensorName:-152.70"
const LOG_RE = /\[[\d:]+\] \S+ ([\d.]+) ([A-Za-z]\w+):([-\d.]+)/

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
 * Manages a persistent WebSocket connection to /ws/logs.
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
   */
  const sensorData = ref({})

  // Internal store — unbounded history, not reactive (avoids 100 Hz reactivity)
  const _store = {}  // { [name]: { value, unit, history: {t,v}[] } }

  // Batch accumulator for onBatch callback
  let _pendingTs       = null
  let _pendingReadings = {}

  let ws        = null
  let snapTimer = null

  // ── Helpers ────────────────────────────────────────────────────────────────

  function flushBatch() {
    if (_pendingTs !== null && onBatch && Object.keys(_pendingReadings).length > 0) {
      onBatch(_pendingTs, { ..._pendingReadings })
    }
    _pendingTs       = null
    _pendingReadings = {}
  }

  function parseSensorLine(dataStr) {
    const m = LOG_RE.exec(dataStr)
    if (!m) return null
    return { t: parseFloat(m[1]), name: m[2], value: parseFloat(m[3]) }
  }

  function pushLogLine(text) {
    logLines.value.push(text)
    if (logLines.value.length > MAX_LINES) {
      logLines.value.splice(0, logLines.value.length - MAX_LINES)
    }
  }

  // ── Snapshot timer (10 Hz) ─────────────────────────────────────────────────

  function startSnap() {
    if (snapTimer) return
    snapTimer = setInterval(() => {
      const snap = {}
      for (const [name, info] of Object.entries(_store)) {
        const h   = info.history
        const len = h.length
        snap[name] = {
          value:   info.value,
          unit:    info.unit,
          history: len > CHART_POINTS ? h.slice(len - CHART_POINTS) : h.slice(),
        }
      }
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

    ws.onmessage = (event) => {
      let parsed = null
      try { parsed = JSON.parse(event.data) } catch { /* not JSON */ }

      if (parsed?.channel && parsed?.data) {
        const prefix = (parsed?.channel === 'syslog') ? '[sys]' : 
          (parsed?.channel === 'debuglog') ? '[dbg]' :
          (parsed?.channel === 'errlog') ? '[err]' : 
          (parsed?.channel === 'packetlog') ? '[pkt]' : '[log]'

        
        pushLogLine(`${prefix} ${parsed.data}`)
        onLog?.(parsed.channel, String(parsed.data))

        if (parsed.channel === 'log') {
          const reading = parseSensorLine(parsed.data)
          if (reading) {
            // Accumulate for onBatch callback
            if (reading.t !== _pendingTs) {
              flushBatch()
              _pendingTs = reading.t
            }
            _pendingReadings[reading.name] = reading.value

            // Update internal store
            if (_store[reading.name]) {
              _store[reading.name].value = reading.value
              _store[reading.name].history.push({ t: reading.t, v: reading.value })
            } else {
              _store[reading.name] = {
                value:   reading.value,
                unit:    getUnit(reading.name),
                history: [{ t: reading.t, v: reading.value }],
              }
            }
          }
        }
      } else {
        pushLogLine(String(event.data))
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
    logLines.value  = []
    sensorData.value = {}
    for (const k of Object.keys(_store)) delete _store[k]
    connect(ip)
  }, { immediate: true })

  onUnmounted(disconnect)

  function clearLogs() {
    logLines.value = []
  }

  function clearSensorData() {
    for (const info of Object.values(_store)) info.history = []
    sensorData.value = {}
  }

  return { logLines, wsStatus, sensorData, clearLogs, clearSensorData }
}
