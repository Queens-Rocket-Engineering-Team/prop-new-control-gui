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

  return { sendCommand, baseUrl }
}
