//! Offline map tile serving for the flight panel.
//!
//! Serves raster tiles out of per-launch-site MBTiles (sqlite) files via the
//! custom `tiles://` URI scheme (resolved by the webview as
//! `http://tiles.localhost/...` on Windows, `tiles://localhost/...` on
//! Linux). Every downloaded site is servable at once — the URL carries the
//! site: `/<site-stem>/{z}/{x}/{y}` — so the frontend can layer several
//! sites (e.g. a wide low-zoom region with a high-zoom launch box nested
//! inside). Connections are opened lazily per site and cached. Sites are
//! described by a manifest.json in the maps directory, maintained by the
//! in-app downloader (map_download.rs).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use rusqlite::{Connection, OpenFlags};
use tauri::http::{Request, Response};
use tauri::UriSchemeResponder;

struct TileSource {
    conn: Connection,
    format: String, // "png" | "jpg" | "jpeg" | "webp"
}

// Connection is Send but not Sync; the Mutex provides the Sync. A single
// serialized connection per site is plenty — indexed tile lookups are
// sub-millisecond.
static TILE_POOL: LazyLock<Mutex<HashMap<String, TileSource>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static MAPS_DIR: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new(String::new()));

pub(crate) fn maps_dir() -> PathBuf {
    let configured = MAPS_DIR.lock().unwrap().clone();
    if configured.is_empty() {
        dirs::data_dir()
            .map(|d| d.join("prop-control-gui").join("maps"))
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default().join("maps"))
    } else {
        PathBuf::from(configured)
    }
}

#[tauri::command]
pub async fn fetch_maps_dir() -> String {
    MAPS_DIR.lock().unwrap().clone()
}

#[tauri::command]
pub async fn set_maps_dir(new_dir: String) {
    println!("[Maps] maps directory set to: {}", new_dir);
    *MAPS_DIR.lock().unwrap() = new_dir;
    // Cached connections point into the old directory.
    TILE_POOL.lock().unwrap().clear();
}

/// Drop the cached connection for one site (or all, when `stem` is None).
/// Called after a (re-)download so metadata changes are picked up.
pub(crate) fn evict_tile_source(stem: Option<&str>) {
    let mut pool = TILE_POOL.lock().unwrap();
    match stem {
        Some(stem) => {
            pool.remove(stem);
        }
        None => pool.clear(),
    }
}

/// Parsed manifest.json from the maps directory. A missing manifest is not an
/// error — it just means no sites are available yet.
#[tauri::command]
pub async fn list_map_sites() -> Result<serde_json::Value, String> {
    let path = maps_dir().join("manifest.json");
    if !path.exists() {
        return Ok(serde_json::json!({ "sites": [] }));
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("invalid manifest.json: {e}"))
}

/// The maps directory actually in use — the configured one, or the platform
/// default when none is set. The settings UI shows this so the operator can
/// see where maps live without having to know the default.
#[tauri::command]
pub async fn resolve_maps_dir() -> String {
    maps_dir().to_string_lossy().to_string()
}

/// Reject anything that isn't a plain file name, so a manifest entry can never
/// point deletion at a path outside the maps directory.
fn plain_file_name(file: &str) -> Result<&str, String> {
    let name = file.trim();
    if name.is_empty() || name.contains(['/', '\\']) || name.contains("..") {
        return Err(format!("refusing to act on suspicious map file name: {file:?}"));
    }
    Ok(name)
}

/// Delete a downloaded site: its MBTiles, its OSM features file, and its
/// manifest entry. Irreversible — the caller is expected to confirm first.
#[tauri::command]
pub async fn delete_map_site(file: String) -> Result<(), String> {
    let name = plain_file_name(&file)?.to_string();
    let dir = maps_dir();
    let mbtiles = dir.join(&name);

    // Drop our cached read-only connection first: on Windows an open sqlite
    // handle keeps the file locked and the delete fails outright.
    let stem = mbtiles
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    evict_tile_source(Some(&stem));

    if mbtiles.exists() {
        std::fs::remove_file(&mbtiles)
            .map_err(|e| format!("could not delete {}: {e}", mbtiles.display()))?;
    }
    // Best-effort: a site downloaded without features has no such file.
    let features = mbtiles.with_extension("features.geojson");
    if features.exists() {
        if let Err(e) = std::fs::remove_file(&features) {
            eprintln!("[Maps] could not delete {}: {e}", features.display());
        }
    }

    remove_from_manifest(&dir, &name)?;
    println!("[Maps] deleted site {name}");
    Ok(())
}

fn remove_from_manifest(dir: &std::path::Path, file: &str) -> Result<(), String> {
    let path = dir.join("manifest.json");
    if !path.exists() {
        return Ok(());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut manifest: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("invalid manifest.json: {e}"))?;
    let sites = manifest["sites"]
        .as_array_mut()
        .ok_or("manifest.json has no sites array")?;
    sites.retain(|s| s["file"] != file);
    let text = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(&path, text + "\n").map_err(|e| e.to_string())
}

/// Per-site OSM feature GeoJSON, saved next to the MBTiles by
/// map_download::download_map_features. `file` is the manifest entry's
/// mbtiles path; returns null when no features file exists.
#[tauri::command]
pub async fn get_site_features(file: String) -> Result<serde_json::Value, String> {
    let raw = PathBuf::from(&file);
    let mbtiles = if raw.is_absolute() { raw } else { maps_dir().join(raw) };
    let path = mbtiles.with_extension("features.geojson");
    if !path.exists() {
        return Ok(serde_json::Value::Null);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("invalid {}: {e}", path.display()))
}

fn read_format(conn: &Connection) -> String {
    conn.query_row(
        "SELECT value FROM metadata WHERE name='format'",
        [],
        |r| r.get::<_, String>(0),
    )
    .unwrap_or_else(|_| "png".to_string())
}

/// Minimal percent-decoding for the site stem path segment (the frontend
/// builds it with encodeURIComponent). Invalid escapes pass through as-is.
fn percent_decode(seg: &str) -> String {
    let bytes = seg.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let (Some(hi), Some(lo)) = (
                bytes.get(i + 1).and_then(|b| (*b as char).to_digit(16)),
                bytes.get(i + 2).and_then(|b| (*b as char).to_digit(16)),
            ) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Entry point for the `tiles` URI scheme. Responds off-thread so sqlite
/// reads never block the webview's protocol thread.
pub fn handle_tiles_protocol(request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let path = request.uri().path().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(tile_response(&path));
    });
}

/// Parse a tile request path of the form `/<site-stem>/{z}/{x}/{y}`.
/// Returns None for malformed paths, out-of-range tile coordinates, or a stem
/// that could escape the maps directory.
fn parse_tile_path(path: &str) -> Option<(String, u8, u32, u32)> {
    let seg: Vec<&str> = path.trim_matches('/').split('/').collect();
    if seg.len() != 4 {
        return None;
    }
    let stem = percent_decode(seg[0]);
    // The stem becomes a filename component — keep it a plain name.
    if stem.is_empty() || stem.contains(['/', '\\']) || stem.contains("..") {
        return None;
    }
    let z: u8 = seg[1].parse().ok()?;
    let x: u32 = seg[2].parse().ok()?;
    // Tolerate an extension suffix ("/14/4553/6002.png").
    let y: u32 = seg[3].split('.').next()?.parse().ok()?;
    if z > 24 || u64::from(x) >= 1u64 << z || u64::from(y) >= 1u64 << z {
        return None;
    }
    Some((stem, z, x, y))
}

fn tile_response(path: &str) -> Response<Vec<u8>> {
    let Some((stem, z, x, y)) = parse_tile_path(path) else { return empty(400) };

    let mut pool = TILE_POOL.lock().unwrap();
    if !pool.contains_key(&stem) {
        let path = maps_dir().join(format!("{stem}.mbtiles"));
        match Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            Ok(conn) => {
                let format = read_format(&conn);
                println!("[Maps] opened tile source {} (format={format})", path.display());
                pool.insert(stem.clone(), TileSource { conn, format });
            }
            // Not downloaded (or deleted) — no tile here. Not cached, so a
            // site that appears later starts serving on the next request.
            Err(_) => return empty(404),
        }
    }
    let src = pool.get(&stem).unwrap();

    // MBTiles stores rows in TMS orientation; the frontend requests XYZ.
    let tms_row = (1u32 << z) - 1 - y;
    match src.conn.query_row(
        "SELECT tile_data FROM tiles WHERE zoom_level=?1 AND tile_column=?2 AND tile_row=?3",
        (z, x, tms_row),
        |r| r.get::<_, Vec<u8>>(0),
    ) {
        Ok(data) => Response::builder()
            .status(200)
            .header("Content-Type", content_type(&src.format))
            // The page origin differs from the tiles scheme and MapLibre
            // fetches from a worker, so every response must pass CORS.
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "public, max-age=86400")
            .body(data)
            .unwrap(),
        // MapLibre treats 204 as "no tile here" without logging an error.
        Err(rusqlite::Error::QueryReturnedNoRows) => empty(204),
        Err(e) => {
            eprintln!("[Maps] tile query error at {stem}/{z}/{x}/{y}: {e}");
            empty(500)
        }
    }
}

fn empty(status: u16) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .body(Vec::new())
        .unwrap()
}

fn content_type(format: &str) -> &'static str {
    match format {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_per_site_tile_path() {
        assert_eq!(
            parse_tile_path("/Timmins2026/14/4553/6002"),
            Some(("Timmins2026".to_string(), 14, 4553, 6002)),
        );
        // Extension suffixes and percent-encoded spaces both occur in practice.
        assert_eq!(
            parse_tile_path("/Launch%20Site/14/4553/6002.png"),
            Some(("Launch Site".to_string(), 14, 4553, 6002)),
        );
    }

    #[test]
    fn only_plain_file_names_may_be_deleted() {
        assert_eq!(plain_file_name("Timmins2026.mbtiles").unwrap(), "Timmins2026.mbtiles");
        assert_eq!(plain_file_name("  Launch Site.mbtiles  ").unwrap(), "Launch Site.mbtiles");
        // Anything that could reach outside the maps directory is refused.
        for bad in ["", "   ", "../secrets.mbtiles", "sub/dir.mbtiles", r"sub\dir.mbtiles", ".."] {
            assert!(plain_file_name(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn removing_from_manifest_drops_only_the_named_site() {
        let dir = std::env::temp_dir().join(format!("qret-maps-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = dir.join("manifest.json");
        std::fs::write(
            &manifest,
            r#"{"sites":[
                {"name":"Wide","file":"Wide.mbtiles"},
                {"name":"Pad","file":"Pad.mbtiles"},
                {"name":"Other","file":"Other.mbtiles"}
            ]}"#,
        )
        .unwrap();

        remove_from_manifest(&dir, "Pad.mbtiles").unwrap();

        let left: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&manifest).unwrap()).unwrap();
        let files: Vec<&str> = left["sites"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["file"].as_str().unwrap())
            .collect();
        assert_eq!(files, vec!["Wide.mbtiles", "Other.mbtiles"]);

        // Deleting a site that isn't listed is not an error.
        remove_from_manifest(&dir, "Nope.mbtiles").unwrap();
        // A missing manifest is not an error either.
        std::fs::remove_file(&manifest).unwrap();
        remove_from_manifest(&dir, "Pad.mbtiles").unwrap();

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_malformed_and_unsafe_paths() {
        // Missing the site segment (the pre-multi-site URL shape).
        assert_eq!(parse_tile_path("/14/4553/6002"), None);
        // Tile coordinates out of range for the zoom level.
        assert_eq!(parse_tile_path("/site/2/9/0"), None);
        assert_eq!(parse_tile_path("/site/25/0/0"), None);
        // Stems that could escape the maps directory.
        assert_eq!(parse_tile_path("/..%2F..%2Fsecrets/1/0/0"), None);
        assert_eq!(parse_tile_path("/%2E%2E/1/0/0"), None);
        assert_eq!(parse_tile_path("//1/0/0"), None);
    }
}
