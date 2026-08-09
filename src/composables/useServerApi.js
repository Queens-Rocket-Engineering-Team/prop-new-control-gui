import { computed } from 'vue'

/**
 * Composable for communicating with the FastAPI server over HTTP.
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

  /**
   * Request a single sensor snapshot from all connected devices.
   */
  function getSingle() {
    return _post('/v1/command', { command: 'GETS' })
  }

  /**
   * Stop the active data stream.
   */
  function stopStream() {
    return _post('/v1/command', { command: 'STOP' })
  }

  /**
   * Start streaming sensor data at the given rate.
   * @param {number} frequencyHz - 1–65535 Hz
   */
  function setStream(frequencyHz) {
    return _post('/v1/command', { command: 'STREAM', frequency_hz: Number(frequencyHz) })
  }

  /**
   * Send a CONTROL command to a named actuator.
   * @param {string} controlName  - server-side control name (e.g. "AVDump")
   * @param {'OPEN'|'CLOSED'} controlState
   */
  function setControl(controlName, controlState) {
    return _post('/v1/command', { command: 'CONTROL', control_name: controlName, control_state: controlState })
  }

  /**
   * Request current actuator/control status from all connected devices.
   */
  function requestStatus() {
    return _post('/v1/status-request')
  }

  // ── Discovery ─────────────────────────────────────────────────────────────────

  /**
   * POST /v1/discover
   * Broadcast an SSDP discovery packet so ESP devices reconnect.
   */
  function discoverDevices() {
    return _post('/v1/discover')
  }

  // ── Emergency stop ─────────────────────────────────────────────────────────────

  /**
   * POST /v1/estop — 204 No Content on success (body may be empty)
   */
  function sendEstop() {
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
   * @returns {Promise<object[]>}
   */
  function discoverKasaDevices() {
    return _get('/v1/kasa/discover')
  }

  /**
   * POST /v1/kasa?host=<host>&active=<bool>
   * @param {string}  host
   * @param {boolean} active
   * @returns {Promise<object>} updated KasaDeviceInfo
   */
  function controlKasaDevice(host, active) {
    const params = new URLSearchParams({ host, active: String(active) })
    return _post(`/v1/kasa?${params}`)
  }

  // ── Tares ─────────────────────────────────────────────────────────────────────
  //
  // Tare offsets live on the server, which applies them before fanning telemetry
  // out — so every connected GUI sees the same tared values and no client ever
  // subtracts an offset itself. Changes arrive back on /ws/state as tare.updated
  // / tare.cleared deltas; these calls only need to fire and forget.

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
  function setTare(sensorName, { deviceName, samples, offset } = {}) {
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
  function clearTare(sensorName) {
    return _delete(`/v1/tares?sensor_name=${encodeURIComponent(sensorName)}`)
  }

  // ── Audio (Mumble) ────────────────────────────────────────────────────────────

  /**
   * POST /v1/audio/start — begin recording the Mumble channel.
   * Tolerates 409 (already recording).
   * @returns {Promise<{status:string}>}
   */
  function startAudio() {
    return _post('/v1/audio/start', undefined, { tolerateCodes: [409] })
  }

  /**
   * POST /v1/audio/stop — stop recording and transcode.
   * Tolerates 409 (not recording).
   * @returns {Promise<{status:string, file?:string}>}
   */
  function stopAudio() {
    return _post('/v1/audio/stop', undefined, { tolerateCodes: [409] })
  }

  /**
   * GET /v1/audio/files — list available Opus recordings.
   * @returns {Promise<{files:{filename:string,download_path:string}[]}>}
   */
  function listAudioFiles() {
    return _get('/v1/audio/files')
  }

  /**
   * Build the full download URL for an audio file.
   * @param {string} filename
   * @returns {string}
   */
  function audioFileUrl(filename) {
    return `${_requireUrl()}/v1/audio/files/${encodeURIComponent(filename)}`
  }

  return {
    // Command variants
    getSingle,
    stopStream,
    setStream,
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
    // Audio
    startAudio,
    stopAudio,
    listAudioFiles,
    audioFileUrl,
    // Exposed for consumers that build URLs (e.g. camera panel)
    baseUrl,
  }
}
