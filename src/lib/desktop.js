// The only module allowed to import @tauri-apps/api.
//
// Every Rust command and event the frontend uses is wrapped here with a
// web-mode fallback. Two reasons this is a hard rule rather than a tidiness
// preference:
//
//   1. @tauri-apps/api throws on load outside a Tauri webview, so a stray
//      import anywhere else would break the web bundle at startup.
//   2. It keeps "what does the pad build actually do instead" answerable by
//      reading one file.
//
// Desktop behaviour is a straight passthrough to invoke(); only the web
// fallbacks are interesting, and each is commented where it is not obvious.

import { CAPS, isWeb } from "./platform.js"

// Static imports would be evaluated in the web bundle too, so the Tauri API is
// pulled in lazily and only ever on the desktop path.
async function tauri() {
  const [core, event] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ])
  return { invoke: core.invoke, listen: event.listen }
}

async function call(command, args) {
  const { invoke } = await tauri()
  return invoke(command, args)
}

/** Thrown by bridge functions with no meaningful web-mode equivalent. */
export class UnsupportedOnWebError extends Error {
  constructor(what) {
    super(`${what} is only available in the desktop app`)
    this.name = "UnsupportedOnWebError"
  }
}

// ── Server IP ────────────────────────────────────────────────────────────────
// Desktop persists the IP in Rust: it runs on a laptop that could be pointed at
// any stand, and has a picker to point it with.
//
// The web build has no such choice to make — it is served by the propnet host it
// talks to — so its address is *derived on every load, never stored*: the
// container's config.json if it was given PROP_SERVER_IP (for a GUI not
// co-located with the server), otherwise whichever host served the page.
//
// Nothing is persisted client-side, deliberately. A stored override outlives the
// tab and survives a redeploy, and with no picker in this build there would be
// nothing to show or clear it — a tablet would sit pointed at a stale server
// with no way to tell. Deriving it means reloading the page is always the fix.

// Populated by main.js from the container's runtime config.json, if present.
let _injectedServerIp = ""

export function setInjectedServerIp(ip) {
  _injectedServerIp = typeof ip === "string" ? ip.trim() : ""
}

export async function fetchServerIp() {
  if (!isWeb()) return call("fetch_server_ip")
  return _injectedServerIp || window.location.hostname || ""
}

export async function submitIp(newIp) {
  if (!isWeb()) return call("submit_ip", { newIp })
  // No-op on web, and not merely because the picker is hidden: opening the
  // settings modal syncs ipMode from the current IP, which trips the watcher
  // that lands here. Persisting from that path is exactly the stale override
  // this build avoids.
}

// Tares are not wrapped here: they are server state reached over the HTTP API
// (useServerApi), not a Rust command, so there is nothing Tauri-specific to
// bridge. What the pad may do with them is gated by CAPS.tares at the call site.

// ── Recording ────────────────────────────────────────────────────────────────
// Unreachable from the web build (Start/Stop Test is hidden), but it rejects
// rather than silently succeeding so a future caller fails loudly.

export async function updateControlStates({ valveStates, auxiliaryStates, kasaStates }) {
  if (!CAPS.recording) return
  return call("update_control_states", { valveStates, auxiliaryStates, kasaStates })
}

export async function startRecording(mode, datetime) {
  if (!CAPS.recording) throw new UnsupportedOnWebError("Recording")
  return call("start_recording", { mode, datetime })
}

export async function stopRecording() {
  if (!CAPS.recording) throw new UnsupportedOnWebError("Recording")
  return call("stop_recording")
}

// ── Camera recordings ────────────────────────────────────────────────────────

export async function fetchCameraRecordingDir() {
  if (!CAPS.fileSave) return ""
  return call("fetch_camera_recording_dir")
}

export async function setCameraRecordingDir(newDir) {
  if (!CAPS.fileSave) return
  return call("set_camera_recording_dir", { newDir })
}

// Desktop writes to the configured recordings directory; the browser has no
// such concept, so hand the bytes to the download manager instead.
export async function saveDownloadedCameraRecording(filename, bytes) {
  if (!CAPS.fileSave) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }))
    try {
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = filename
      anchor.click()
    } finally {
      // Revoking synchronously can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }
    return filename
  }
  return call("save_downloaded_camera_recording", { filename, data: bytes })
}
