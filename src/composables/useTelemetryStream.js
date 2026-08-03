import { ref, computed, watch } from 'vue'
import { useReconnectingSocket } from './useReconnectingSocket.js'

export const TELEMETRY_WINDOW_SEC = 30

// Selectable rolling-window lengths (seconds).  History retention follows the
// chosen value, so widening the window fills in over time rather than
// retroactively — points older than the previous window were already pruned.
// The minimum stays above STATS_WINDOW_SEC so the rate stats keep a usable span.
export const TELEMETRY_WINDOW_OPTIONS = [10, 30, 60, 120]

export const TELEMETRY_DISPLAY_HZ = 30
const DISPLAY_SAMPLE_INTERVAL_SEC = 1 / TELEMETRY_DISPLAY_HZ
const STATS_WINDOW_SEC = 5

// Server-side downsampling algorithms exposed by /ws/telemetry/display.
// Omitting the query param entirely gets m4, but we always send it so the
// request is self-describing in server logs and devtools — which also means
// the GUI's default need not match the server's.
export const DOWNSAMPLE_ALGORITHMS = ['m4', 'decimation']

// Deliberately decimation, not the server's m4 default: an operator who has
// never opened Settings gets evenly spaced points. A GUI too old to send the
// param still lands on m4, so the two defaults can disagree by version.
export const DEFAULT_DOWNSAMPLE_ALGORITHM = 'decimation'

/**
 * Coerce an arbitrary value (localStorage entry, BroadcastChannel payload) to a
 * known algorithm. A stale or hand-edited value falls back to the default
 * rather than propagating into the socket URL.
 *
 * @param {unknown} value
 * @returns {'m4'|'decimation'}
 */
export function normalizeDownsampleAlgorithm(value) {
  return DOWNSAMPLE_ALGORITHMS.includes(value) ? value : DEFAULT_DOWNSAMPLE_ALGORITHM
}

function pruneHistory(history, cutoffT) {
  let firstKept = 0
  while (firstKept < history.length && history[firstKept].t < cutoffT) {
    firstKept += 1
  }
  if (firstKept > 0) history.splice(0, firstKept)
}

function pruneSortedNumbers(values, cutoff) {
  let firstKept = 0
  while (firstKept < values.length && values[firstKept] < cutoff) {
    firstKept += 1
  }
  if (firstKept > 0) values.splice(0, firstKept)
}

function rateFromSortedTimes(times) {
  if (times.length < 2) return 0
  const span = times[times.length - 1] - times[0]
  return span > 0 ? (times.length - 1) / span : 0
}

function uniqueSorted(values) {
  const result = []
  for (const value of values) {
    if (result.length === 0 || result[result.length - 1] !== value) {
      result.push(value)
    }
  }
  return result
}

function average(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0
}

function displayBucket(t) {
  return Math.floor(t / DISPLAY_SAMPLE_INTERVAL_SEC)
}

function mergeDisplayPoint(info, sourcePoint, plotT) {
  const bucket = displayBucket(plotT)
  if (bucket < info.lastDisplayBucket) return

  const displayPoint = { t: plotT, sourceT: sourcePoint.t, v: sourcePoint.v }
  if (bucket === info.lastDisplayBucket) {
    const lastIndex = info.history.length - 1
    const lastPoint = info.history[lastIndex]
    if (lastPoint && displayBucket(lastPoint.t) === bucket) {
      info.history[lastIndex] = displayPoint
    }
    return
  }

  info.history.push(displayPoint)
  info.lastDisplayBucket = bucket
}

/**
 * Manages the display-rate telemetry WebSocket connection:
 *
 *  /ws/telemetry/display — display-rate stream — drives sensorData and charts
 *
 * Raw, full-rate telemetry (/ws/telemetry/raw) is consumed entirely on the
 * Rust side for CSV recording — see src-tauri/src/telemetry_raw.rs — so the
 * frontend never opens that socket.
 *
 * The sensorData shape keeps the legacy value/unit/history fields and adds
 * windowStart/windowEnd so charts can render the same fixed rolling timeframe.
 *
 * The downsampling algorithm is chosen per connection and fixed at handshake,
 * so changing it requires reconnecting — folding it into the URL computed lets
 * useReconnectingSocket's existing URL watcher do exactly that.
 *
 * @param {import('vue').Ref<string>} serverIp
 * @param {import('vue').Ref<string>} [downsampleAlgorithm]
 * @param {import('vue').Ref<number>} [windowSec] rolling window to retain and
 *   publish, in seconds; defaults to TELEMETRY_WINDOW_SEC when omitted.
 * @returns {{
 *   sensorData:      import('vue').Ref<Record<string,object>>,
 *   telemetryStats:  import('vue').Ref<Record<string,number>>,
 *   displayStatus:   import('vue').Ref<string>,
 *   streamAlgorithm: import('vue').Ref<string|null>,
 *   clearSensorData: () => void,
 *   msSinceLastTelemetry: () => number,
 * }}
 */
export function useTelemetryStream(
  serverIp,
  downsampleAlgorithm = ref(DEFAULT_DOWNSAMPLE_ALGORITHM),
  windowSec = ref(TELEMETRY_WINDOW_SEC),
) {
  // ── Non-reactive internal store ────────────────────────────────────────────────
  // _store[sensorName] = { value: number, unit: string, sensorType: string, history: {t,v,sourceT}[], lastDisplayBucket: number }
  const _store = {}
  let _latestDisplayT = null
  const _statsStore = {
    displayReceiveTimes: [],
    incomingPointsBySensor: new Map(),
    incomingPointsPerSensorBatch: [],
  }

  // ── Reactive snapshot (published once per display batch) ──────────────────────
  const sensorData = ref({})
  const telemetryStats = ref({
    displayBatchHz: 0,
    displayPointHzAvg: 0,
    displayPointHzMax: 0,
    displayTimestampHzAvg: 0,
    displayTimestampHzMax: 0,
    incomingPointHzAvg: 0,
    incomingPointHzMax: 0,
    incomingPointsPerSensorBatchAvg: 0,
    sensors: 0,
    statsWindowSec: STATS_WINDOW_SEC,
    updatedAt: 0,
  })

  // ── URL computeds ──────────────────────────────────────────────────────────────
  const _host = computed(() => {
    const ip = serverIp.value
    if (!ip) return null
    return ip === 'localhost' ? '127.0.0.1' : ip
  })

  const displayUrl = computed(() => {
    if (!_host.value) return null
    const algorithm = normalizeDownsampleAlgorithm(downsampleAlgorithm.value)
    return `ws://${_host.value}:8000/ws/telemetry/display?algorithm=${algorithm}`
  })

  // What the stream is actually serving, echoed by the server on every batch.
  // null means "not told" — either nothing has arrived yet, or the server
  // predates the algorithm parameter and is silently serving m4.
  const streamAlgorithm = ref(null)

  // A reconnect (IP change or algorithm change) invalidates the echo until the
  // new connection reports one of its own.
  watch(displayUrl, () => { streamAlgorithm.value = null })

  function publishTelemetryStats() {
    const pointRates = []
    const timestampRates = []
    const incomingPointRates = []
    const latestPlotT = _latestDisplayT

    if (latestPlotT != null) {
      const cutoffT = latestPlotT - STATS_WINDOW_SEC

      for (const info of Object.values(_store)) {
        const points = info.history
          .map((point) => point.t)
          .filter((t) => t >= cutoffT)

        if (points.length < 2) continue

        pointRates.push(rateFromSortedTimes(points))
        timestampRates.push(rateFromSortedTimes(uniqueSorted(points)))
      }
    }

    const now = performance.now() / 1000
    const receiveCutoff = now - STATS_WINDOW_SEC
    pruneSortedNumbers(_statsStore.displayReceiveTimes, receiveCutoff)
    for (const points of _statsStore.incomingPointsBySensor.values()) {
      pruneSortedNumbers(points, receiveCutoff)
      if (points.length < 2) continue

      incomingPointRates.push(rateFromSortedTimes(points))
    }

    let batchCount = 0
    let pointsPerSensorBatchTotal = 0
    for (let i = _statsStore.incomingPointsPerSensorBatch.length - 1; i >= 0; i -= 1) {
      const entry = _statsStore.incomingPointsPerSensorBatch[i]
      if (entry.receivedAt < receiveCutoff) {
        _statsStore.incomingPointsPerSensorBatch.splice(0, i + 1)
        break
      }
      batchCount += 1
      pointsPerSensorBatchTotal += entry.pointsPerSensor
    }

    telemetryStats.value = {
      displayBatchHz: rateFromSortedTimes(_statsStore.displayReceiveTimes),
      displayPointHzAvg: average(pointRates),
      displayPointHzMax: pointRates.length > 0 ? Math.max(...pointRates) : 0,
      displayTimestampHzAvg: average(timestampRates),
      displayTimestampHzMax: timestampRates.length > 0 ? Math.max(...timestampRates) : 0,
      incomingPointHzAvg: average(incomingPointRates),
      incomingPointHzMax: incomingPointRates.length > 0 ? Math.max(...incomingPointRates) : 0,
      incomingPointsPerSensorBatchAvg: batchCount > 0 ? pointsPerSensorBatchTotal / batchCount : 0,
      sensors: pointRates.length,
      statsWindowSec: STATS_WINDOW_SEC,
      updatedAt: now,
    }
  }

  // Wall-clock time of the last display batch off the socket. 0 = none yet.
  let _lastMessageAtMs = 0

  // ── Coalesced snapshot publishing ──────────────────────────────────────────────
  // Incoming batches are applied to the non-reactive store immediately (cheap),
  // but the reactive snapshot — which triggers the full chart re-render cascade —
  // is published at most once per animation frame. Messages arriving faster than
  // the frame rate collapse into a single render, so the socket always drains at
  // network speed and backlog can never build up in the message queue.
  let _publishScheduled = false

  function publishSnapshot() {
    if (_latestDisplayT == null) {
      publishTelemetryStats()
      return
    }

    const span = Number.isFinite(windowSec.value) && windowSec.value > 0
      ? windowSec.value
      : TELEMETRY_WINDOW_SEC
    const windowStart = _latestDisplayT - span
    for (const info of Object.values(_store)) {
      pruneHistory(info.history, windowStart)
    }

    const snap = {}
    for (const [name, info] of Object.entries(_store)) {
      snap[name] = {
        value: info.value,
        unit: info.unit,
        sensorType: info.sensorType,
        history: info.history.slice(),
        windowStart,
        windowEnd: _latestDisplayT,
      }
    }
    sensorData.value = snap
    publishTelemetryStats()
  }

  function schedulePublish() {
    if (_publishScheduled) return
    _publishScheduled = true
    requestAnimationFrame(() => {
      _publishScheduled = false
      publishSnapshot()
    })
  }

  // ── Display stream → sensorData ────────────────────────────────────────────────
  // Each message: { type: 'telemetry.display_batch', readings: [{ sensor_name, unit, sensor_type, points: [{t,v}] }] }
  // The server may include multiple points per reading; charts keep only the latest
  // point per 1/30 s client display bucket so test stream rate cannot speed up plots.
  const { status: displayStatus } = useReconnectingSocket(displayUrl, {
    onMessage(event) {
      const receivedAt = performance.now() / 1000
      _statsStore.displayReceiveTimes.push(receivedAt)

      // Liveness marker, stamped on delivery rather than on publish, so it
      // answers "is the stand streaming?" rather than "is the UI up to date?".
      // Keep it that way: anything derived from sensorData or telemetryStats
      // reports on rendering, and a caller deciding whether to touch the
      // stand's stream rate must not confuse a stalled view for a silent stand.
      _lastMessageAtMs = Date.now()

      let msg = null
      try { msg = JSON.parse(event.data) } catch { schedulePublish(); return }
      if (msg?.type !== 'telemetry.display_batch') { schedulePublish(); return }

      const reportedAlgorithm = typeof msg.algorithm === 'string' ? msg.algorithm : null
      if (streamAlgorithm.value !== reportedAlgorithm) streamAlgorithm.value = reportedAlgorithm

      let batchPointCount = 0
      let batchSensorCount = 0
      for (const reading of (msg.readings ?? [])) {
        const name   = reading.sensor_name
        if (!name) continue
        const points = (reading.points ?? [])
          .map(({ t, v }) => ({ t: Number(t), v: Number(v) }))
          .filter(({ t, v }) => Number.isFinite(t) && Number.isFinite(v))
          .sort((a, b) => a.t - b.t)
        if (points.length === 0) continue

        batchPointCount += points.length
        batchSensorCount += 1

        let info = _store[name]
        if (!info) {
          info = { value: 0, unit: reading.unit ?? '', sensorType: reading.sensor_type ?? '', history: [], lastDisplayBucket: -Infinity }
          _store[name] = info
        }

        let statsPoints = _statsStore.incomingPointsBySensor.get(name)
        if (!statsPoints) {
          statsPoints = []
          _statsStore.incomingPointsBySensor.set(name, statsPoints)
        }
        for (let i = 0; i < points.length; i += 1) {
          statsPoints.push(receivedAt)
        }

        // Latest point of the newest batch, taken unconditionally: batches arrive
        // ordered over one socket and are sorted above, so a monotonic-timestamp
        // guard here only risks latching the readout forever if a device clock
        // resets or a single spiked `t` arrives.  The charts never guarded this.
        const latestPoint = points[points.length - 1]
        info.value = latestPoint.v
        info.unit  = reading.unit ?? info.unit
        // Group key (QLCP sensor group) — only present when the server sends it;
        // useSensorGroups falls back to the device configs from /ws/state.
        if (reading.sensor_type) info.sensorType = reading.sensor_type
        mergeDisplayPoint(info, latestPoint, receivedAt)

        _latestDisplayT = _latestDisplayT == null
          ? receivedAt
          : Math.max(_latestDisplayT, receivedAt)
      }

      if (batchSensorCount > 0) {
        _statsStore.incomingPointsPerSensorBatch.push({
          receivedAt,
          pointsPerSensor: batchPointCount / batchSensorCount,
        })
      }

      schedulePublish()
    },
  })

  function clearSensorData() {
    for (const k of Object.keys(_store)) delete _store[k]
    _latestDisplayT = null
    _statsStore.displayReceiveTimes = []
    _statsStore.incomingPointsBySensor.clear()
    _statsStore.incomingPointsPerSensorBatch = []
    _lastMessageAtMs = 0
    sensorData.value = {}
    streamAlgorithm.value = null
    publishTelemetryStats()
  }

  /**
   * Milliseconds since a display batch last arrived on the socket, or Infinity
   * if none ever has.
   *
   * Stamped on delivery rather than derived from sensorData, and deliberately a
   * function rather than a ref: callers ask "is the stand streaming?", which
   * must stay truthful independently of whether anything is re-rendering.
   */
  function msSinceLastTelemetry() {
    return _lastMessageAtMs === 0 ? Infinity : Date.now() - _lastMessageAtMs
  }

  return { sensorData, telemetryStats, displayStatus, streamAlgorithm, clearSensorData, msSinceLastTelemetry }
}
