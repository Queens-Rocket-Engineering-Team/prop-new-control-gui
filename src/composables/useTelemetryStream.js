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

// Reactive snapshots are published at most this often (~15 fps). Charts gain
// nothing from faster updates, and every publish triggers the full chart
// re-render cascade, so this caps the render load independently of message rate.
const MIN_PUBLISH_INTERVAL_MS = 66

// Drop leading entries of the sorted array pair below cutoffT (in place).
function pruneSeries(ts, vs, cutoffT) {
  let firstKept = 0
  while (firstKept < ts.length && ts[firstKept] < cutoffT) {
    firstKept += 1
  }
  if (firstKept > 0) {
    ts.splice(0, firstKept)
    vs.splice(0, firstKept)
  }
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

function average(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0
}

function displayBucket(t) {
  return Math.floor(t / DISPLAY_SAMPLE_INTERVAL_SEC)
}

// Merge one point into the sensor's parallel-array history, keeping at most one
// point per 1/30 s client display bucket so test stream rate cannot speed up
// plots. `plotT` is client receive time — the charts' x axis.
function mergeDisplayPoint(info, plotT, value) {
  const bucket = displayBucket(plotT)
  if (bucket < info.lastDisplayBucket) return

  const n = info.ts.length
  if (bucket === info.lastDisplayBucket) {
    if (n > 0 && displayBucket(info.ts[n - 1]) === bucket) {
      info.ts[n - 1] = plotT
      info.vs[n - 1] = value
    }
    return
  }

  info.ts.push(plotT)
  info.vs.push(value)
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
 * Incoming batches are applied to a non-reactive store per message (cheap);
 * the reactive snapshot — which drives chart re-renders — is published at most
 * once per animation frame and no more often than MIN_PUBLISH_INTERVAL_MS, so
 * the socket always drains at network speed regardless of render load.
 *
 * Each sensorData entry keeps the legacy value/unit fields; history is exposed
 * as sorted parallel arrays `ts`/`vs` (client receive time / value) shared with
 * the internal store — treat them as read-only. `lastSourceT` is the
 * server-side timestamp of the newest reading. windowStart/windowEnd let
 * charts render the same fixed rolling timeframe.
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
 *   sensorData:          import('vue').Ref<Record<string,object>>,
 *   telemetryStats:      import('vue').Ref<Record<string,number>>,
 *   displayStatus:       import('vue').Ref<string>,
 *   streamAlgorithm:     import('vue').Ref<string|null>,
 *   clearSensorData:     () => void,
 *   setUnchartedStreams: (names: Iterable<string>|null) => void,
 *   msSinceLastTelemetry: () => number,
 * }}
 */
export function useTelemetryStream(
  serverIp,
  downsampleAlgorithm = ref(DEFAULT_DOWNSAMPLE_ALGORITHM),
  windowSec = ref(TELEMETRY_WINDOW_SEC),
) {
  // ── Non-reactive internal store ────────────────────────────────────────────────
  // _store[sensorName] = { value, unit, sensorType, ts: number[], vs: number[],
  //                        lastSourceT: number|null, lastDisplayBucket: number }
  const _store = {}
  let _latestDisplayT = null
  const _statsStore = {
    displayReceiveTimes: [],
    incomingPointsBySensor: new Map(),
    incomingPointsPerSensorBatch: [],
  }

  // Streams nobody is charting right now: latest value/unit/lastSourceT are
  // still tracked (readouts, flight track), but history retention is skipped.
  // Re-charting a stream restarts its history from now, matching the existing
  // "widening the window fills in over time" behavior.
  const _uncharted = new Set()

  // ── Reactive snapshot ──────────────────────────────────────────────────────────
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
        const ts = info.ts
        // Sorted ascending: walk back to the first index inside the window.
        let i0 = ts.length
        while (i0 > 0 && ts[i0 - 1] >= cutoffT) i0 -= 1

        const count = ts.length - i0
        if (count < 2) continue

        const span = ts[ts.length - 1] - ts[i0]
        pointRates.push(span > 0 ? (count - 1) / span : 0)

        let unique = 1
        for (let i = i0 + 1; i < ts.length; i += 1) {
          if (ts[i] !== ts[i - 1]) unique += 1
        }
        timestampRates.push(span > 0 && unique >= 2 ? (unique - 1) / span : 0)
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
  let _publishScheduled = false
  let _lastPublishMs = 0

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
      pruneSeries(info.ts, info.vs, windowStart)
    }

    // Wrapper objects only — ts/vs are the live store arrays, not copies.
    const snap = {}
    for (const [name, info] of Object.entries(_store)) {
      snap[name] = {
        value: info.value,
        unit: info.unit,
        sensorType: info.sensorType,
        ts: info.ts,
        vs: info.vs,
        lastSourceT: info.lastSourceT,
        windowStart,
        windowEnd: _latestDisplayT,
      }
    }
    sensorData.value = snap
    publishTelemetryStats()
  }

  function publishNow() {
    _publishScheduled = false
    _lastPublishMs = performance.now()
    publishSnapshot()
  }

  function schedulePublish() {
    if (_publishScheduled) return
    _publishScheduled = true
    requestAnimationFrame(() => {
      const waitMs = MIN_PUBLISH_INTERVAL_MS - (performance.now() - _lastPublishMs)
      if (waitMs > 0) {
        setTimeout(() => requestAnimationFrame(publishNow), waitMs)
      } else {
        publishNow()
      }
    })
  }

  // ── Display stream → store ─────────────────────────────────────────────────────
  // Each message: { type: 'telemetry.display_batch', readings: [{ sensor_name, unit, sensor_type, points: [{t,v}] }] }
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
        const name = reading.sensor_name
        if (!name) continue

        // Single allocation-free pass: count finite points and track the
        // newest one. Only the latest point is merged into history anyway.
        let latestT = -Infinity
        let latestV = 0
        let finiteCount = 0
        for (const p of (reading.points ?? [])) {
          const t = Number(p?.t)
          const v = Number(p?.v)
          if (!Number.isFinite(t) || !Number.isFinite(v)) continue
          finiteCount += 1
          if (t >= latestT) { latestT = t; latestV = v }
        }
        if (finiteCount === 0) continue

        batchPointCount += finiteCount
        batchSensorCount += 1

        let info = _store[name]
        if (!info) {
          info = {
            value: 0,
            unit: reading.unit ?? '',
            sensorType: reading.sensor_type ?? '',
            ts: [],
            vs: [],
            lastSourceT: null,
            lastDisplayBucket: -Infinity,
          }
          _store[name] = info
        }

        let statsPoints = _statsStore.incomingPointsBySensor.get(name)
        if (!statsPoints) {
          statsPoints = []
          _statsStore.incomingPointsBySensor.set(name, statsPoints)
        }
        for (let i = 0; i < finiteCount; i += 1) {
          statsPoints.push(receivedAt)
        }

        // Latest point of the newest batch, taken unconditionally: batches
        // arrive ordered over one socket, so a monotonic-timestamp guard here
        // only risks latching the readout forever if a device clock resets or
        // a single spiked `t` arrives. The charts never guarded this.
        info.value = latestV
        info.unit = reading.unit ?? info.unit
        // Group key (QLCP sensor group) — only present when the server sends it;
        // useSensorGroups falls back to the device configs from /ws/state.
        if (reading.sensor_type) info.sensorType = reading.sensor_type
        info.lastSourceT = latestT

        if (!_uncharted.has(name)) {
          mergeDisplayPoint(info, receivedAt, latestV)
        }

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

  /**
   * Declare which streams have no chart anywhere in the UI right now. Their
   * history retention is skipped (and any retained history freed); latest
   * values keep updating. Pass null/empty to chart everything again.
   */
  function setUnchartedStreams(names) {
    const next = new Set(names ?? [])
    for (const name of next) {
      if (!_uncharted.has(name)) {
        const info = _store[name]
        if (info) {
          info.ts.length = 0
          info.vs.length = 0
          info.lastDisplayBucket = -Infinity
        }
      }
    }
    _uncharted.clear()
    for (const name of next) _uncharted.add(name)
  }

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

  return { sensorData, telemetryStats, displayStatus, streamAlgorithm, clearSensorData, setUnchartedStreams, msSinceLastTelemetry }
}
