// Tile URL resolution for the flight panel's offline basemap.
//
// Inside Tauri, tiles come from the custom `tiles` URI scheme backed by the
// Rust MBTiles reader (src-tauri/src/maps.rs). The webview exposes custom
// schemes differently per platform: Windows (WebView2) maps them to
// http://<scheme>.localhost, while Linux (WebKitGTK) and macOS keep the raw
// scheme URL. Outside Tauri (e.g. the flight_harness dev page in a plain
// browser) there is no custom scheme, so fall back to online OSM tiles.

export function isTauri() {
  return '__TAURI_INTERNALS__' in window
}

export function tileUrlTemplate() {
  if (!isTauri()) return 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
  const isWindows = navigator.userAgent.includes('Windows')
  return isWindows
    ? 'http://tiles.localhost/{z}/{x}/{y}'
    : 'tiles://localhost/{z}/{x}/{y}'
}
