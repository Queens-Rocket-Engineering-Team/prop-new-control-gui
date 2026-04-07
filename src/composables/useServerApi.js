import { computed } from 'vue'

/**
 * Composable for sending commands to the FastAPI server.
 * @param {import('vue').Ref<string>} serverIp - reactive ref containing the server IP string
 */
export function useServerApi(serverIp) {
  const baseUrl = computed(() => {
    const ip = serverIp.value
    if (!ip) return null
    const host = ip === 'localhost' ? '127.0.0.1' : ip
    return `http://${host}:8000`
  })

  /**
   * POST /v1/command
   * @param {string} command - e.g. 'CONTROL', 'GETS', 'STREAM', 'STOP'
   * @param {string[]} args
   * @returns {Promise<object>} CommandResponse
   * @throws {Error} if the server returns a non-OK status or no IP is configured
   */
  async function sendCommand(command, args = []) {
    if (!baseUrl.value) {
      throw new Error('No server IP configured')
    }

    const res = await fetch(`${baseUrl.value}/v1/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, args }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`${res.status}: ${text}`)
    }

    return res.json()
  }

  /**
   * GET /config
   * @returns {Promise<{ count: number, configs: Record<string, object> }>}
   */
  async function fetchConfig() {
    if (!baseUrl.value) throw new Error('No server IP configured')
    const res = await fetch(`${baseUrl.value}/config`)
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`${res.status}: ${text}`)
    }
    return res.json()
  }

  /**
   * GET /status
    * Triggers a status request broadcast to connected devices.
    * Device valve states are reported asynchronously on the log stream as:
    * "<device name> STATUS <valve name> <OPEN|CLOSED>"
    * @returns {Promise<object>}
   */
  async function fetchStatus() {
    if (!baseUrl.value) throw new Error('No server IP configured')
    const res = await fetch(`${baseUrl.value}/status`)
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`${res.status}: ${text}`)
    }
    return res.json()
  }

  /**
   * GET /v1/kasa
   * @returns {Promise<KasaDeviceInfo[]>}
   */
  async function fetchKasaDevices() {
    if (!baseUrl.value) throw new Error('No server IP configured')
    const res = await fetch(`${baseUrl.value}/v1/kasa`)
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`${res.status}: ${text}`)
    }
    return res.json()
  }

  /**
   * GET /v1/kasa/discover
   * @returns {Promise<KasaDeviceInfo[]>}
   */
  async function discoverKasaDevices() {
    if (!baseUrl.value) throw new Error('No server IP configured')
    const res = await fetch(`${baseUrl.value}/v1/kasa/discover`)
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`${res.status}: ${text}`)
    }
    return res.json()
  }

  /**
   * POST /v1/kasa?host=<host>&active=<bool>
   * @param {string} host
   * @param {boolean} active
   * @returns {Promise<KasaDeviceInfo>}
   */
  async function controlKasaDevice(host, active) {
    if (!baseUrl.value) throw new Error('No server IP configured')
    const params = new URLSearchParams({ host, active: String(active) })
    const res = await fetch(`${baseUrl.value}/v1/kasa?${params}`, { method: 'POST' })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`${res.status}: ${text}`)
    }
    return res.json()
  }

  /**
   * POST /v1/audio/start
   * @returns {Promise<{status?: string, error?: string}>}
   */
  async function startAudioRecording() {
    if (!baseUrl.value) throw new Error('No server IP configured')
    const res = await fetch(`${baseUrl.value}/v1/audio/start`, {
      method: 'POST',
    })

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`${res.status}: ${text}`)
    }

    return res.json()
  }

  /**
   * POST /v1/audio/stop
   * @returns {Promise<{status?: string, file?: string, error?: string}>}
   */
  async function stopAudioRecording() {
    if (!baseUrl.value) throw new Error('No server IP configured')
    const res = await fetch(`${baseUrl.value}/v1/audio/stop`, {
      method: 'POST',
    })

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`${res.status}: ${text}`)
    }

    return res.json()
  }

  /**
   * GET /v1/audio/files
   * @returns {Promise<{files?: Array<string | { filename?: string, download_path?: string }>}>}
   */
  async function listAudioFiles() {
    if (!baseUrl.value) throw new Error('No server IP configured')
    const res = await fetch(`${baseUrl.value}/v1/audio/files`)

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`${res.status}: ${text}`)
    }

    return res.json()
  }

  /**
   * Returns a direct URL for an audio file download.
   * Accepts either a file name (legacy) or a download path from /v1/audio/files.
   * @param {string} fileNameOrPath
   * @returns {string}
   */
  function getAudioFileUrl(fileNameOrPath) {
    if (!baseUrl.value) throw new Error('No server IP configured')
    const target = String(fileNameOrPath ?? '').trim()
    if (!target) throw new Error('No audio file name or download path provided')
    if (/^https?:\/\//i.test(target)) return target
    if (target.startsWith('/')) return `${baseUrl.value}${target}`
    return `${baseUrl.value}/v1/audio/files/${encodeURIComponent(target)}`
  }

  return {
    sendCommand,
    fetchConfig,
    fetchStatus,
    fetchKasaDevices,
    discoverKasaDevices,
    controlKasaDevice,
    startAudioRecording,
    stopAudioRecording,
    listAudioFiles,
    getAudioFileUrl,
    baseUrl,
  }
}
