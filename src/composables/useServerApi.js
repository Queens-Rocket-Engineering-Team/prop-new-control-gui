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

  async function _post(path, body = undefined, { tolerateCodes = [] } = {}) {
    const url = `${_requireUrl()}${path}`
    const init = { method: 'POST' }
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' }
      init.body    = JSON.stringify(body)
    }
    const res = await fetch(url, init)
    if (!res.ok && !tolerateCodes.includes(res.status)) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`${res.status}: ${text}`)
    }
    return res.json().catch(() => ({}))
  }

  async function _get(path) {
    const res = await fetch(`${_requireUrl()}${path}`)
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`${res.status}: ${text}`)
    }
    return res.json()
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
    // Audio
    startAudio,
    stopAudio,
    listAudioFiles,
    audioFileUrl,
    // Exposed for consumers that build URLs (e.g. camera panel)
    baseUrl,
  }
}
