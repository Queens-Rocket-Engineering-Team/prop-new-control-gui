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

  return { sendCommand, fetchConfig, fetchKasaDevices, discoverKasaDevices, controlKasaDevice, baseUrl }
}
