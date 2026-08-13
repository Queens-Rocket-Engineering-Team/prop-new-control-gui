import { onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue'

// Real internet-reachability detection for the flight panel's map downloader.
//
// navigator.onLine is not enough here: the field setup is a laptop + telemetry
// server on a router with no upstream, which reports "online". So this probes
// the actual tile source. no-cors keeps it a cheap opaque request that
// resolves iff the server was reached; no-store + ts param prevent a cached
// tile from faking connectivity.

const PROBE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/0/0/0'
const PROBE_TIMEOUT_MS = 4_000
const RECHECK_MS = 30_000

export function useOnlineStatus() {
  const online = ref(false) // pessimistic until the first probe lands
  const checking = ref(false)
  let timer = null
  let seq = 0 // ignores stale probes that resolve after a newer one started

  async function recheck() {
    const mySeq = ++seq
    checking.value = true
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
    try {
      await fetch(`${PROBE_URL}?ts=${Date.now()}`, {
        mode: 'no-cors',
        cache: 'no-store',
        signal: ctrl.signal,
      })
      if (mySeq === seq) online.value = true
    } catch {
      if (mySeq === seq) online.value = false
    } finally {
      clearTimeout(timeout)
      if (mySeq === seq) checking.value = false
    }
  }

  function start() {
    stop()
    recheck()
    timer = setInterval(recheck, RECHECK_MS)
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  // The polling interval only runs while the panel is the active KeepAlive
  // tab; the cheap window listeners live for the component's whole life.
  // start() runs from onMounted too because onActivated only ever fires for
  // KeepAlive-cached components (the dev harness mounts the panel bare).
  onMounted(() => {
    window.addEventListener('online', recheck)
    window.addEventListener('offline', recheck)
    start()
  })
  onActivated(start) // idempotent with the onMounted start()
  onDeactivated(stop)
  onUnmounted(() => {
    stop()
    window.removeEventListener('online', recheck)
    window.removeEventListener('offline', recheck)
  })

  return { online, checking, recheck }
}
