import { computed } from 'vue'
import { CAPS } from '../lib/platform.js'

/** Raised instead of issuing a command the current build is not allowed to send. */
export class ReadOnlyError extends Error {
  constructor(what) {
    super(`${what} is not available in the view-only build`)
    this.name = 'ReadOnlyError'
  }
}

/**
 * Resting stream rate: what runs outside a test so charts are populated.
 * A test replaces it with the configured test frequency.
 */
export const PREVIEW_STREAM_HZ = 30

/**
 * Composable for communicating with the FastAPI server over HTTP.
 *
 * This is the single choke point for command authority. The view-only build
 * served to the pad must never mutate server or device state, and gating here
 * rather than at the button level is what makes that true: several of these are
 * called from App.vue's own lifecycle (stream setup, the re-arm watchdog,
 * periodic status polling), not from any UI a user could avoid pressing.
 *
 * The commands matter because QLCP STREAM/STOP are *broadcast* — a stray call
 * from a tablet at the pad would re-arm the stream rate for the whole stand,
 * and STOP+STREAM carries a deliberate telemetry gap.
 *
 * @param {import('vue').Ref<string>} serverIp - reactive ref containing the server IP string
 */
export function useServerApi(serverIp) {
  const baseUrl = computed(() => {
    const ip = serverIp.value
    if (!ip) return null
    const host = ip === 'localhost' ? '127.0.0.1' : ip
    return `http://${host}:8000`
  })

  // ── Internal helpers ─────────────────────────────────────────────────────────

  function _requireUrl() {
    if (!baseUrl.value) throw new Error('No server IP configured')
    return baseUrl.value
  }

  /**
   * Build an Error for a failed response, carrying the HTTP status and the
   * parsed FastAPI `detail` so callers can react to specific failures — e.g.
   * the 409 the tare endpoint returns when a sensor name is ambiguous across
   * two connected devices.
   */
  async function _httpError(res) {
    const text = await res.text().catch(() => res.statusText)
    let detail
    try { detail = JSON.parse(text)?.detail } catch { /* not JSON */ }
    const err = new Error(`${res.status}: ${text}`)
    err.status = res.status
    err.detail = detail
    return err
  }

  /** Reject rather than send, when the build has no command authority. */
  function _requireCommands(what) {
    if (!CAPS.commands) throw new ReadOnlyError(what)
  }

  async function _post(path, body = undefined, { tolerateCodes = [] } = {}) {
    const url = `${_requireUrl()}${path}`
    const init = { method: 'POST' }
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' }
      init.body    = JSON.stringify(body)
    }
    const res = await fetch(url, init)
    if (!res.ok && !tolerateCodes.includes(res.status)) {
      throw await _httpError(res)
    }
    return res.json().catch(() => ({}))
  }

  async function _get(path) {
    const res = await fetch(`${_requireUrl()}${path}`)
    if (!res.ok) throw await _httpError(res)
    return res.json()
  }

  async function _delete(path, { tolerateCodes = [] } = {}) {
    const res = await fetch(`${_requireUrl()}${path}`, { method: 'DELETE' })
    if (!res.ok && !tolerateCodes.includes(res.status)) {
      throw await _httpError(res)
    }
    return res.json().catch(() => ({}))
  }

  // ── ESP Device Commands — POST /v1/command ────────────────────────────────────

  // Every function below is `async` so the capability guard surfaces as a
  // rejected promise; callers already `.catch()` and a synchronous throw would
  // bypass them.

  /**
   * Request a single sensor snapshot from all connected devices.
   */
  async function getSingle() {
    _requireCommands('GETS')
    return _post('/v1/command', { command: 'GETS' })
  }

  /**
   * Stop the active data stream.
   */
  async function stopStream() {
    _requireCommands('STOP')
    return _post('/v1/command', { command: 'STOP' })
  }

  /**
   * Start streaming sensor data at the given rate.
   * @param {number} frequencyHz - 1–65535 Hz
   */
  async function setStream(frequencyHz) {
    _requireCommands('STREAM')
    return _post('/v1/command', { command: 'STREAM', frequency_hz: Number(frequencyHz) })
  }

  /**
   * Start a preview stream at the fixed resting rate.
   *
   * The one stream command a view-only client may send, so devices that connect
   * before launch control is up still produce data instead of appearing dead.
   *
   * It takes no frequency *by design*. The server forwards STREAM_START to every
   * registered device unconditionally (esp_connection_runtime.start_streaming),
   * so a STREAM at a rate different from the active one would re-rate the whole
   * stand — dropping a 190 Hz test to 30 Hz. Hard-coding the rate here makes
   * that structurally impossible rather than a thing callers must remember.
   *
   * It also never sends STOP. Changing an *active* rate requires STOP+STREAM,
   * which carries a deliberate data gap; the caller's job is to only prime while
   * the stand is silent, and this function cannot interrupt a running stream.
   */
  async function primeStream() {
    if (!CAPS.streamPriming) throw new ReadOnlyError('Stream priming')
    return _post('/v1/command', { command: 'STREAM', frequency_hz: PREVIEW_STREAM_HZ })
  }

  /**
   * Send a CONTROL command to a named actuator.
   * @param {string} controlName  - server-side control name (e.g. "AVDump")
   * @param {'OPEN'|'CLOSED'|number} controlState - OPEN/CLOSED for BOOL controls,
   *   or a numeric value for variable (FLOAT32/INT32/etc.) controls
   */
  async function setControl(controlName, controlState) {
    _requireCommands('CONTROL')
    return _post('/v1/command', { command: 'CONTROL', control_name: controlName, control_state: controlState })
  }

  /**
   * Request current actuator/control status from all connected devices.
   *
   * Blocked in the view-only build, which costs nothing: this only forces a
   * refresh, and control states arrive on /ws/state regardless from launch
   * control's own 5 s polling.
   */
  async function requestStatus() {
    _requireCommands('STATUS')
    return _post('/v1/status-request')
  }

  // ── Discovery ─────────────────────────────────────────────────────────────────

  /**
   * POST /v1/discover
   * Broadcast an SSDP discovery packet so ESP devices reconnect.
   *
   * The one write the view-only build is allowed. The server already broadcasts
   * this exact packet every 30 s on its own, so an extra one costs nothing and
   * lets an engineer who just powered a device on skip the wait.
   */
  async function discoverDevices() {
    if (!CAPS.espDiscovery) throw new ReadOnlyError('Device discovery')
    return _post('/v1/discover')
  }

  // ── Emergency stop ─────────────────────────────────────────────────────────────

  /**
   * POST /v1/estop — 204 No Content on success (body may be empty)
   */
  async function sendEstop() {
    _requireCommands('ESTOP')
    return _post('/v1/estop')
  }

  // ── Kasa Smart Plugs ──────────────────────────────────────────────────────────

  /**
   * GET /v1/kasa
   * @returns {Promise<object[]>}
   */
  function fetchKasaDevices() {
    return _get('/v1/kasa')
  }

  /**
   * GET /v1/kasa/discover
   *
   * A GET, but not a read: it triggers a broadcast-and-wait scan that occupies
   * the server's event loop for several seconds. Gated with the other commands.
   * @returns {Promise<object[]>}
   */
  async function discoverKasaDevices() {
    _requireCommands('Kasa discovery')
    return _get('/v1/kasa/discover')
  }

  /**
   * POST /v1/kasa?host=<host>&active=<bool>
   * @param {string}  host
   * @param {boolean} active
   * @returns {Promise<object>} updated KasaDeviceInfo
   */
  async function controlKasaDevice(host, active) {
    _requireCommands('Kasa control')
    const params = new URLSearchParams({ host, active: String(active) })
    return _post(`/v1/kasa?${params}`)
  }

  // ── Tares ─────────────────────────────────────────────────────────────────────
  //
  // Tare offsets live on the server, which applies them before fanning telemetry
  // out — so every connected GUI sees the same tared values and no client ever
  // subtracts an offset itself. Changes arrive back on /ws/state as tare.updated
  // / tare.cleared deltas; these calls only need to fire and forget.
  //
  // That fan-out is exactly why the writes are gated: a tare set from the pad
  // silently changes the numbers launch control reads off its own screen. The
  // guard is CAPS.tares rather than CAPS.commands so one flag owns the feature —
  // the same flag the tare button reads — and flipping it opens the button and
  // the API together. Reads stay open: the pad should see which sensors are
  // tared, and knowing that is what stops it misreporting a value over radio.

  /**
   * POST /v1/tares — capture (or set) a tare offset for a sensor.
   * With no options the server averages its most recent raw samples itself.
   * @param {string} sensorName
   * @param {object} [opts]
   * @param {string} [opts.deviceName] - required only when two connected devices
   *                                     report this sensor name (409 otherwise)
   * @param {number} [opts.samples]    - raw samples to average, 1–256 (default 16)
   * @param {number} [opts.offset]     - set this exact offset, skipping capture
   * @returns {Promise<{sensor_name:string, offset:number, sampled_device:string,
   *                    sample_count:number, applies_to:string[]}>}
   */
  async function setTare(sensorName, { deviceName, samples, offset } = {}) {
    if (!CAPS.tares) throw new ReadOnlyError('Taring')
    return _post('/v1/tares', {
      sensor_name: sensorName,
      ...(deviceName !== undefined && { device_name: deviceName }),
      ...(samples    !== undefined && { samples }),
      ...(offset     !== undefined && { offset }),
    })
  }

  /**
   * GET /v1/tares — current offsets, keyed by sensor name.
   * @returns {Promise<Record<string, number>>}
   */
  function getTares() {
    return _get('/v1/tares')
  }

  /**
   * DELETE /v1/tares — remove a sensor's offset. Idempotent.
   * The name is a query parameter (not a path segment) because sensor names are
   * arbitrary device-CONFIG JSON keys and may contain slashes or spaces.
   * @param {string} sensorName
   */
  async function clearTare(sensorName) {
    if (!CAPS.tares) throw new ReadOnlyError('Taring')
    return _delete(`/v1/tares?sensor_name=${encodeURIComponent(sensorName)}`)
  }

  // ── Recording sessions ────────────────────────────────────────────────────────
  //
  // A session is server-wide: one start command begins telemetry, audio and
  // every camera at once, for every client. That is why the writes are gated
  // and the reads are not — the pad may see what is being recorded, and needs
  // to (a tablet reporting a number over radio should know whether the run is
  // on the record), but starting or stopping one from the pad would end a test
  // launch control believes is still running.

  /**
   * POST /v1/sessions/start — start telemetry, audio, and every camera.
   * A 409 is benign because another client already started the session.
   * @param {string} name
   * @returns {Promise<object>}
   */
  async function startSession(name) {
    _requireCommands('Starting a recording session')
    return _post('/v1/sessions/start', { name }, { tolerateCodes: [409] })
  }

  /**
   * POST /v1/sessions/stop — stop the active server recording session.
   * A 409 is benign because another client already stopped it.
   * @returns {Promise<object>}
   */
  async function stopSession() {
    _requireCommands('Stopping a recording session')
    return _post('/v1/sessions/stop', undefined, { tolerateCodes: [409] })
  }

  /**
   * GET /v1/sessions — newest-first sessions and server free disk space.
   * @returns {Promise<{sessions:object[], free_bytes:number}>}
   */
  function listSessions() {
    return _get('/v1/sessions')
  }

  /**
   * GET /v1/sessions/{id} — complete session.json metadata.
   * @param {string} sessionId
   * @returns {Promise<object>}
   */
  function getSession(sessionId) {
    return _get(`/v1/sessions/${encodeURIComponent(sessionId)}`)
  }

  /**
   * Build the full URL for the streamed session ZIP.
   * @param {string} sessionId
   * @returns {string}
   */
  function sessionDownloadUrl(sessionId) {
    return `${_requireUrl()}/v1/sessions/${encodeURIComponent(sessionId)}/download`
  }

  return {
    // Command variants
    getSingle,
    stopStream,
    setStream,
    primeStream,
    setControl,
    requestStatus,
    // Discovery + control
    discoverDevices,
    sendEstop,
    // Kasa
    fetchKasaDevices,
    discoverKasaDevices,
    controlKasaDevice,
    // Tares
    setTare,
    getTares,
    clearTare,
    // Recording sessions
    startSession,
    stopSession,
    listSessions,
    getSession,
    sessionDownloadUrl,
    // Exposed for consumers that build URLs (e.g. camera panel)
    baseUrl,
  }
}
