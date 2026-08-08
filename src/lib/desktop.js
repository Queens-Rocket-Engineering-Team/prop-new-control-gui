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
// Desktop persists the IP in Rust. The web build is served *from* the propnet,
// so it defaults to whatever host served the page — which is correct whenever
// the GUI container runs alongside the server — and only falls back to an
// operator-entered value stored locally.

const IP_STORAGE_KEY = "qret-server-ip"

// Populated by main.js from the container's runtime config.json, if present.
let _injectedServerIp = ""

export function setInjectedServerIp(ip) {
  _injectedServerIp = typeof ip === "string" ? ip.trim() : ""
}

export async function fetchServerIp() {
  if (!isWeb()) return call("fetch_server_ip")

  const stored = localStorage.getItem(IP_STORAGE_KEY)
  if (stored) return stored
  if (_injectedServerIp) return _injectedServerIp
  // Same-host default: the page came from the server, so the API is there too.
  return window.location.hostname || ""
}

export async function submitIp(newIp) {
  if (!isWeb()) return call("submit_ip", { newIp })

  if (newIp) localStorage.setItem(IP_STORAGE_KEY, newIp)
  else localStorage.removeItem(IP_STORAGE_KEY)
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
