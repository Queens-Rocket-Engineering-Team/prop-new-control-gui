import { ref, computed } from 'vue'
import { useReconnectingSocket } from './useReconnectingSocket.js'

const MAX_LINES = 1000   // rolling debug log buffer size

/**
 * Manages a persistent /ws/logs connection.
 *
 * The server now sends pure log lines — no sensor data, no STATUS strings.
 * Message shape: { level: 'DEBUG'|'INFO'|'WARNING'|'ERROR'|'CRITICAL', data: string, timestamp_ws: string }
 * Lines are stored as "[LEVEL] <data>" strings, matching the prefix pattern
 * consumed by debug_panel's extractLevel filter.
 *
 * @param {import('vue').Ref<string>} serverIp
 * @returns {{ logLines: import('vue').Ref<string[]>, wsStatus: import('vue').Ref<string>, clearLogs: () => void }}
 */
export function useLogStream(serverIp) {
  const logLines = ref([])

  const wsUrl = computed(() => {
    const ip = serverIp.value
    if (!ip) return null
    const host = ip === 'localhost' ? '127.0.0.1' : ip
    return `ws://${host}:8000/ws/logs`
  })

  function pushLogLine(text) {
    logLines.value.push(text)
    if (logLines.value.length > MAX_LINES) {
      logLines.value.splice(0, logLines.value.length - MAX_LINES)
    }
  }

  const { status: wsStatus } = useReconnectingSocket(wsUrl, {
    onMessage(event) {
      let msg = null
      try { msg = JSON.parse(event.data) } catch {
        pushLogLine(String(event.data))
        return
      }

      if (!msg?.level || !msg?.data) {
        // Unexpected shape — push raw
        pushLogLine(String(event.data))
        return
      }

      pushLogLine(`[${msg.level}] ${msg.data}`)
    },
  })

  function clearLogs() {
    logLines.value = []
  }

  return { logLines, wsStatus, clearLogs }
}
