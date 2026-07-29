//! Offline map tile serving for the flight panel.
//!
//! Serves raster tiles out of a per-launch-site MBTiles (sqlite) file via the
//! custom `tiles://` URI scheme (resolved by the webview as
//! `http://tiles.localhost/{z}/{x}/{y}` on Windows, `tiles://localhost/...`
//! on Linux). Sites are described by a manifest.json in the maps directory,
//! produced by the tile-prep sub-project.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use rusqlite::{Connection, OpenFlags};
use tauri::http::{Request, Response};
use tauri::UriSchemeResponder;

/// Summary of the currently opened MBTiles, read from its `metadata` table.
/// The frontend uses this to build the MapLibre raster source (zoom limits,
/// coverage bounds) without a second sqlite round-trip per query.
#[derive(Clone, serde::Serialize)]
pub struct TileMeta {
    pub name: String,
    pub format: String, // "png" | "jpg" | "jpeg" | "webp"
    pub minzoom: u8,
    pub maxzoom: u8,
    pub bounds: [f64; 4], // [w, s, e, n]
}

struct TileSource {
    path: PathBuf,
    conn: Connection,
    meta: TileMeta,
}

// Connection is Send but not Sync; the Mutex provides the Sync. A single
// serialized connection is plenty — indexed tile lookups are sub-millisecond.
static TILE_SOURCE: LazyLock<Mutex<Option<TileSource>>> = LazyLock::new(|| Mutex::new(None));
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

/// Open (or clear, when `file` is empty) the MBTiles the tile protocol serves
/// from. `file` is the manifest entry's path, relative to the maps directory.
/// Idempotent: re-invoking with the already-open path is a cheap no-op, so
/// multiple windows racing at startup is harmless.
#[tauri::command]
pub async fn set_tile_source(file: String) -> Result<Option<TileMeta>, String> {
    if file.trim().is_empty() {
        *TILE_SOURCE.lock().unwrap() = None;
        println!("[Maps] tile source cleared");
        return Ok(None);
    }

    let raw = PathBuf::from(&file);
    let path = if raw.is_absolute() { raw } else { maps_dir().join(raw) };

    {
        let guard = TILE_SOURCE.lock().unwrap();
        if let Some(src) = guard.as_ref() {
            if src.path == path {
                return Ok(Some(src.meta.clone()));
            }
        }
    }

    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    let meta = read_meta(&conn, &path)?;
    println!(
        "[Maps] tile source set to {} (format={}, z{}-{})",
        path.display(),
        meta.format,
        meta.minzoom,
        meta.maxzoom
    );
    *TILE_SOURCE.lock().unwrap() = Some(TileSource { path, conn, meta: meta.clone() });
    Ok(Some(meta))
}

#[tauri::command]
pub async fn get_tile_meta() -> Option<TileMeta> {
    TILE_SOURCE.lock().unwrap().as_ref().map(|src| src.meta.clone())
}

fn read_meta(conn: &Connection, path: &Path) -> Result<TileMeta, String> {
    let mut stmt = conn
        .prepare("SELECT name, value FROM metadata")
        .map_err(|e| format!("no metadata table in {}: {e}", path.display()))?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let map: HashMap<String, String> = rows.filter_map(Result::ok).collect();

    let bounds = map
        .get("bounds")
        .and_then(|b| {
            let vals: Vec<f64> = b.split(',').filter_map(|p| p.trim().parse().ok()).collect();
            (vals.len() == 4).then(|| [vals[0], vals[1], vals[2], vals[3]])
        })
        .unwrap_or([-180.0, -85.0, 180.0, 85.0]);

    Ok(TileMeta {
        name: map.get("name").cloned().unwrap_or_else(|| {
            path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
        }),
        format: map.get("format").cloned().unwrap_or_else(|| "png".to_string()),
        minzoom: map.get("minzoom").and_then(|v| v.parse().ok()).unwrap_or(0),
        maxzoom: map.get("maxzoom").and_then(|v| v.parse().ok()).unwrap_or(18),
        bounds,
    })
}

/// Entry point for the `tiles` URI scheme. Responds off-thread so sqlite
/// reads never block the webview's protocol thread.
pub fn handle_tiles_protocol(request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let path = request.uri().path().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(tile_response(&path));
    });
}

fn tile_response(path: &str) -> Response<Vec<u8>> {
    let seg: Vec<&str> = path.trim_matches('/').split('/').collect();
    let parsed = (|| {
        if seg.len() != 3 {
            return None;
        }
        let z: u8 = seg[0].parse().ok()?;
        let x: u32 = seg[1].parse().ok()?;
        // Tolerate an extension suffix ("/14/4553/6002.png").
        let y: u32 = seg[2].split('.').next()?.parse().ok()?;
        if z > 24 || u64::from(x) >= 1u64 << z || u64::from(y) >= 1u64 << z {
            return None;
        }
        Some((z, x, y))
    })();
    let Some((z, x, y)) = parsed else { return empty(400) };

    let guard = TILE_SOURCE.lock().unwrap();
    let Some(src) = guard.as_ref() else { return empty(503) };

    // MBTiles stores rows in TMS orientation; the frontend requests XYZ.
    let tms_row = (1u32 << z) - 1 - y;
    match src.conn.query_row(
        "SELECT tile_data FROM tiles WHERE zoom_level=?1 AND tile_column=?2 AND tile_row=?3",
        (z, x, tms_row),
        |r| r.get::<_, Vec<u8>>(0),
    ) {
        Ok(data) => Response::builder()
            .status(200)
            .header("Content-Type", content_type(&src.meta.format))
            // The page origin differs from the tiles scheme and MapLibre
            // fetches from a worker, so every response must pass CORS.
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "public, max-age=86400")
            .body(data)
            .unwrap(),
        // MapLibre treats 204 as "no tile here" without logging an error.
        Err(rusqlite::Error::QueryReturnedNoRows) => empty(204),
        Err(e) => {
            eprintln!("[Maps] tile query error at {z}/{x}/{y}: {e}");
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
