// Build target + capability flags.
//
// The GUI ships in two shapes from one codebase:
//
//   desktop — the Tauri app at launch control. Full control authority.
//   web     — a view-only build served over the propnet so engineers at the pad
//             can see pressures and control states without radioing back.
//
// Every capability is derived from `mode()` rather than checked ad hoc, so the
// blast radius of "what can the pad do" is this one file.
//
// The mode check is deliberately biased: web wins if *either* the build flag or
// the runtime says web. A desktop bundle that somehow ends up served over http
// therefore degrades to read-only rather than handing a browser full command
// authority. The inverse mistake — a web bundle believing it is desktop — is
// the one that could stomp on a live test, so it must be unreachable.
//
// `__APP_TARGET__` is injected by vite.config.js and is always defined.

let _mode = null

/** 'desktop' | 'web' — resolved once, on first access. */
export function mode() {
  if (_mode === null) {
    // Tauri injects __TAURI_INTERNALS__ before page scripts run, but this is
    // resolved lazily anyway so nothing depends on that ordering.
    const isTauri = "__TAURI_INTERNALS__" in window
    _mode = !isTauri || __APP_TARGET__ === "web" ? "web" : "desktop"
  }
  return _mode
}

export function isTauri() {
  return mode() === "desktop"
}

export function isWeb() {
  return mode() === "web"
}

// Getters rather than plain values so nothing is evaluated at module-eval time.
export const CAPS = {
  /** May we mutate server or device state at all? */
  get commands() {
    return mode() === "desktop"
  },

  // /v1/discover is a fire-and-forget UDP multicast that the server already
  // broadcasts every 30 s on its own, so the button adds no new class of
  // traffic — it only lets someone who just powered a device on skip the wait
  // instead of radioing launch control.
  get espDiscovery() {
    return true
  },

  // Lets a view-only client start a *preview* stream when the whole stand is
  // silent, so devices that connect before launch control is up still show
  // data instead of sitting there looking broken. Web-only: the desktop app
  // owns the stream rate outright and uses setStream directly.
  //
  // Deliberately narrow — see primeStream() in useServerApi.js, which fixes the
  // rate so a pad client cannot set the stand's frequency, and the priming
  // guard in App.vue, which only fires while nothing is streaming anywhere.
  get streamPriming() {
    return mode() === "web"
  },

  /** CSV recording of the raw telemetry stream (Rust-side). */
  get recording() {
    return mode() === "desktop"
  },

  /** Offline MBTiles basemaps served by the Rust tile scheme. */
  get offlineMaps() {
    return mode() === "desktop"
  },

  /** Tare offsets, which live in Rust and are applied to displayed values. */
  get tares() {
    return mode() === "desktop"
  },

  /** Native multi-window via Tauri's WebviewWindow. */
  get nativeWindows() {
    return mode() === "desktop"
  },

  /** Writing files to a chosen directory on disk. */
  get fileSave() {
    return mode() === "desktop"
  },
}

/** Panels the current build exposes, in nav order. */
export function availablePanels() {
  if (mode() === "desktop") {
    return ["control", "graph", "camera", "devices", "debug", "flight"]
  }
  // Pad build: pressures, device health and charts. Camera is deliberately out
  // (multiple WebRTC streams would hammer both the iPad and the wifi link the
  // test depends on), and Flight's basemap has no offline tiles in a browser.
  return ["control", "graph", "devices"]
}
