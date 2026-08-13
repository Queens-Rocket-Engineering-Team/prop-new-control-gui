// Tile URL resolution for the flight panel's offline basemap.
//
// Inside Tauri, tiles come from the custom `tiles` URI scheme backed by the
// Rust MBTiles reader (src-tauri/src/maps.rs). Every downloaded site is
// addressable at once — the first path segment names the site (mbtiles file
// stem) so several sites can be layered on one map. The webview exposes
// custom schemes differently per platform: Windows (WebView2) maps them to
// http://<scheme>.localhost, while Linux (WebKitGTK) and macOS keep the raw
// scheme URL. Outside Tauri (e.g. the flight_harness dev page in a plain
// browser) there is no custom scheme, so fall back to online OSM tiles.

export function isTauri() {
  return '__TAURI_INTERNALS__' in window
}

// `file` is the manifest entry's mbtiles path (e.g. "Timmins2026.mbtiles").
export function tileUrlTemplate(file) {
  if (!isTauri()) return 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
  const stem = encodeURIComponent(String(file).replace(/\.mbtiles$/i, ''))
  const isWindows = navigator.userAgent.includes('Windows')
  return isWindows
    ? `http://tiles.localhost/${stem}/{z}/{x}/{y}`
    : `tiles://localhost/${stem}/{z}/{x}/{y}`
}
