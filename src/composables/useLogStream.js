import { ref, watch, onUnmounted } from 'vue'

const MAX_LINES = 1000

/**
 * Manages a persistent WebSocket connection to the server's /ws/logs endpoint.
 * Reconnects automatically when serverIp changes. Clears the log buffer on
 * each reconnect so stale output from a previous session is not shown.
 *
 * Intended to be called once at the App level and shared via provide/inject.
 *
 * @param {import('vue').Ref<string>} serverIp
 * @returns {{ logLines: Ref<string[]>, wsStatus: Ref<string>, clearLogs: () => void }}
 */
export function useLogStream(serverIp) {
  /** Accumulated log lines. Capped at MAX_LINES to avoid unbounded growth. */
  const logLines = ref([])

  /**
   * WebSocket lifecycle state.
   * 'disconnected' | 'connecting' | 'connected' | 'error'
   */
  const wsStatus = ref('disconnected')

  let ws = null

  function disconnect() {
    if (ws) {
      // Remove handlers before closing to suppress the onclose reaction
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      ws.close()
      ws = null
    }
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
    }

    ws.onmessage = (event) => {
      logLines.value.push(String(event.data))
      if (logLines.value.length > MAX_LINES) {
        logLines.value.splice(0, logLines.value.length - MAX_LINES)
      }
    }

    ws.onerror = () => {
      wsStatus.value = 'error'
    }

    ws.onclose = () => {
      // Only update status if we weren't the ones who called disconnect()
      if (wsStatus.value !== 'disconnected') {
        wsStatus.value = 'disconnected'
      }
    }
  }

  // Reconnect (and clear old logs) whenever the server IP changes
  watch(serverIp, (ip) => {
    logLines.value = []
    connect(ip)
  }, { immediate: true })

  // Clean up when the owning component (App) is torn down
  onUnmounted(disconnect)

  function clearLogs() {
    logLines.value = []
  }

  return { logLines, wsStatus, clearLogs }
}
