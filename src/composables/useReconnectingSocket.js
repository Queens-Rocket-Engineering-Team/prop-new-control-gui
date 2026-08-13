import { ref, computed, watch, onUnmounted } from 'vue'

/**
 * A self-healing WebSocket that automatically reconnects with exponential
 * backoff when the connection drops unexpectedly.
 *
 * @param {import('vue').Ref<string|null>} urlRef - Reactive WS URL (null = stay disconnected)
 * @param {{
 *   onOpen?:    (event: Event) => void,
 *   onMessage?: (event: MessageEvent) => void,
 *   onClose?:   (event: CloseEvent) => void,
 *   onError?:   (event: Event) => void,
 * }} [opts]
 * @returns {{ status: import('vue').Ref<string>, close: () => void, isOpen: import('vue').ComputedRef<boolean> }}
 */
export function useReconnectingSocket(urlRef, { onOpen, onMessage, onClose, onError } = {}) {
  // 'disconnected' | 'connecting' | 'connected' | 'error'
  const status = ref('disconnected')

  let ws          = null
  let attempt     = 0
  let retryId     = null
  let intentional = false   // set true for intentional closes to suppress reconnect

  function _teardown() {
    if (retryId !== null) { clearTimeout(retryId); retryId = null }
    if (ws) {
      // Null handlers before close to prevent spurious onclose firing
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      ws.close()
      ws = null
    }
  }

  function _scheduleRetry(url) {
    if (intentional || !url) return
    const delay = Math.min(500 * Math.pow(2, attempt), 5000) + Math.random() * 200
    attempt++
    retryId = setTimeout(() => {
      retryId = null
      _connect(url)
    }, delay)
  }

  function _connect(url) {
    _teardown()
    if (!url) { status.value = 'disconnected'; return }
    intentional = false
    status.value = 'connecting'

    try {
      ws = new WebSocket(url)
    } catch {
      status.value = 'error'
      _scheduleRetry(url)
      return
    }

    ws.onopen = (e) => {
      attempt = 0
      status.value = 'connected'
      onOpen?.(e)
    }

    ws.onmessage = (e) => {
      onMessage?.(e)
    }

    ws.onerror = (e) => {
      status.value = 'error'
      onError?.(e)
    }

    ws.onclose = (e) => {
      onClose?.(e)
      if (!intentional) {
        status.value = 'disconnected'
        _scheduleRetry(url)
      }
    }
  }

  /** Close the socket intentionally — no reconnect will be scheduled. */
  function close() {
    intentional = true
    _teardown()
    status.value = 'disconnected'
  }

  // Reconnect whenever the URL changes (covers IP changes)
  watch(urlRef, (url) => {
    intentional = true   // suppress retry on the old connection's onclose
    attempt = 0
    _connect(url)
  }, { immediate: true })

  onUnmounted(close)

  const isOpen = computed(() => status.value === 'connected')

  return { status, close, isOpen }
}
