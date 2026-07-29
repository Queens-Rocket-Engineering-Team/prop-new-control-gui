//! In-app satellite tile downloader for the flight panel.
//!
//! Downloads Esri World Imagery XYZ tiles for a bbox + zoom range into a
//! per-site MBTiles file under `maps_dir()`, updating manifest.json — the
//! same formats the tiles:// protocol (maps.rs) reads. Replaces the old
//! tile-prep Python scripts so a single shipped app covers the whole
//! prepare-at-home → fly-offline workflow.
//!
//! Downloads run as one background task per app process; progress streams to
//! every window via `map-download-progress` events.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};

use rusqlite::Connection;
use tauri::{Emitter, Manager};

const CONCURRENCY: usize = 8;
const COMMIT_EVERY: usize = 200;
const EMIT_EVERY: u64 = 25;
const MAX_TILES: u64 = 200_000;
// Esri World Imagery defines LODs 0-23, but true imagery detail runs out
// around z19-20 outside dense urban areas (higher levels return upsampled
// tiles) and tile count quadruples per level. 21 is a guard rail above the
// z20 the download form offers; MAX_TILES is the real backstop.
const MAX_ZOOM: u8 = 21;

// Esri path order is {z}/{y}/{x}, not {z}/{x}/{y}.
const TILE_URL: &str =
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";

static ACTIVE: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
struct Progress {
    name: String,
    fetched: u64,
    failed: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

fn emit_progress(app: &tauri::AppHandle, progress: &Progress) {
    for (_, window) in app.webview_windows() {
        let _ = window.emit("map-download-progress", progress.clone());
    }
}

// Slippy-map tile math (mirrors mercantile). North latitude → smaller y.
fn lon2x(lon: f64, z: u8) -> u32 {
    let n = (1u64 << z) as f64;
    (((lon + 180.0) / 360.0) * n).floor().clamp(0.0, n - 1.0) as u32
}

fn lat2y(lat: f64, z: u8) -> u32 {
    let n = (1u64 << z) as f64;
    let r = lat.to_radians();
    (((1.0 - (r.tan() + 1.0 / r.cos()).ln() / std::f64::consts::PI) / 2.0) * n)
        .floor()
        .clamp(0.0, n - 1.0) as u32
}

fn count_tiles(bbox: [f64; 4], minzoom: u8, maxzoom: u8) -> u64 {
    let [w, s, e, n] = bbox;
    let mut total = 0u64;
    for z in minzoom..=maxzoom {
        let cols = (lon2x(e, z) - lon2x(w, z) + 1) as u64;
        let rows = (lat2y(s, z) - lat2y(n, z) + 1) as u64;
        total += cols * rows;
    }
    total
}

/// Start a background tile download. Returns immediately; progress arrives as
/// `map-download-progress` events. Re-running an existing site resumes it
/// (tiles already in the MBTiles are skipped).
#[tauri::command]
pub async fn download_map_tiles(
    app: tauri::AppHandle,
    name: String,
    bbox: [f64; 4],
    minzoom: u8,
    maxzoom: u8,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty()
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || "-_ ".contains(c))
    {
        return Err("site name must be alphanumeric (dashes/underscores/spaces allowed)".into());
    }
    let [w, s, e, n] = bbox;
    if !(w < e && s < n)
        || !(-180.0..=180.0).contains(&w)
        || !(-180.0..=180.0).contains(&e)
        || !(-85.06..=85.06).contains(&s)
        || !(-85.06..=85.06).contains(&n)
    {
        return Err("bbox out of order or range (need W<E, S<N, web-mercator latitudes)".into());
    }
    if minzoom > maxzoom || maxzoom > MAX_ZOOM {
        return Err(format!("zoom range out of bounds (max {MAX_ZOOM})"));
    }
    let total = count_tiles(bbox, minzoom, maxzoom);
    if total > MAX_TILES {
        return Err(format!("{total} tiles exceeds the {MAX_TILES} limit — shrink the area or zoom range"));
    }

    if ACTIVE.compare_exchange(false, true, SeqCst, SeqCst).is_err() {
        return Err("a map download is already running".into());
    }
    CANCEL.store(false, SeqCst);

    tauri::async_runtime::spawn(async move {
        let result = run_download(&app, &name, bbox, minzoom, maxzoom, total).await;
        let (fetched, failed, error) = match result {
            Ok((fetched, failed)) => {
                let err = if CANCEL.load(SeqCst) { Some("cancelled".to_string()) } else { None };
                (fetched, failed, err)
            }
            Err(e) => (0, 0, Some(e)),
        };
        emit_progress(&app, &Progress { name, fetched, failed, total, done: true, error });
        ACTIVE.store(false, SeqCst);
    });
    Ok(())
}

#[tauri::command]
pub async fn cancel_map_download() {
    CANCEL.store(true, SeqCst);
}

struct MetaParams {
    name: String,
    bbox: [f64; 4],
    minzoom: u8,
    maxzoom: u8,
}

async fn run_download(
    app: &tauri::AppHandle,
    name: &str,
    bbox: [f64; 4],
    minzoom: u8,
    maxzoom: u8,
    total: u64,
) -> Result<(u64, u64), String> {
    let dir = crate::maps::maps_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{name}.mbtiles"));

    // Open/create + read the resume set on a blocking thread.
    let open_path = path.clone();
    let (conn, existing) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let conn = Connection::open(&open_path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS metadata (name TEXT, value TEXT);
             CREATE TABLE IF NOT EXISTS tiles (
                 zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB
             );
             CREATE UNIQUE INDEX IF NOT EXISTS tile_index
                 ON tiles (zoom_level, tile_column, tile_row);",
        )
        .map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT zoom_level, tile_column, tile_row FROM tiles")
            .map_err(|e| e.to_string())?;
        let existing: HashSet<(u8, u32, u32)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        drop(stmt);
        Ok((conn, existing))
    })
    .await
    .map_err(|e| e.to_string())??;

    // Enumerate the XYZ tiles still needed (resume skips present TMS rows).
    let [w, s, e, n] = bbox;
    let mut todo: Vec<(u8, u32, u32)> = Vec::new();
    let mut skipped = 0u64;
    for z in minzoom..=maxzoom {
        for x in lon2x(w, z)..=lon2x(e, z) {
            for y in lat2y(n, z)..=lat2y(s, z) {
                let tms = (1u32 << z) - 1 - y;
                if existing.contains(&(z, x, tms)) {
                    skipped += 1;
                } else {
                    todo.push((z, x, y));
                }
            }
        }
    }
    println!("[MapDL] {name}: {total} tiles requested, {skipped} already present");

    let meta = MetaParams { name: name.to_string(), bbox, minzoom, maxzoom };
    let (tx, rx) = tokio::sync::mpsc::channel::<(u8, u32, u32, Vec<u8>)>(64);
    let writer = tauri::async_runtime::spawn_blocking(move || writer_loop(conn, rx, meta));

    let client = reqwest::Client::builder()
        .user_agent("qret-prop-control-gui/0.1 (offline field basemap; internal team use)")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    use futures_util::StreamExt;
    let mut stream = futures_util::stream::iter(
        todo.into_iter().map(|t| fetch_tile(client.clone(), t)),
    )
    .buffer_unordered(CONCURRENCY);

    let mut fetched = skipped;
    let mut failed = 0u64;
    while let Some(result) = stream.next().await {
        if CANCEL.load(SeqCst) {
            break;
        }
        match result {
            Ok(((z, x, y), data)) => {
                fetched += 1;
                let tms = (1u32 << z) - 1 - y;
                if tx.send((z, x, tms, data)).await.is_err() {
                    break; // writer died; its error surfaces below
                }
            }
            Err(err) => {
                failed += 1;
                eprintln!("[MapDL] {err}");
            }
        }
        if (fetched + failed - skipped) % EMIT_EVERY == 0 {
            emit_progress(app, &Progress {
                name: name.to_string(),
                fetched,
                failed,
                total,
                done: false,
                error: None,
            });
        }
    }
    // Close the channel so the writer commits and writes metadata — this must
    // happen on the cancel path too, or the partial file loses the last batch
    // and its metadata table (which set_tile_source requires).
    drop(stream);
    drop(tx);
    writer.await.map_err(|e| e.to_string())??;

    upsert_manifest(&dir, name, bbox, minzoom, maxzoom)?;
    println!("[MapDL] {name}: done ({fetched} fetched, {failed} failed)");
    Ok((fetched, failed))
}

async fn fetch_tile(
    client: reqwest::Client,
    tile: (u8, u32, u32),
) -> Result<((u8, u32, u32), Vec<u8>), String> {
    let (z, x, y) = tile;
    let url = format!("{TILE_URL}/{z}/{y}/{x}");
    for attempt in 0..3u32 {
        if CANCEL.load(SeqCst) {
            return Err(format!("tile {z}/{x}/{y} cancelled"));
        }
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(bytes) = resp.bytes().await {
                    if !bytes.is_empty() {
                        return Ok((tile, bytes.to_vec()));
                    }
                }
            }
            _ => {}
        }
        tokio::time::sleep(std::time::Duration::from_millis(
            (1000.0 * 1.5f64.powi(attempt as i32)) as u64,
        ))
        .await;
    }
    Err(format!("tile {z}/{x}/{y} failed after 3 tries"))
}

fn writer_loop(
    conn: Connection,
    mut rx: tokio::sync::mpsc::Receiver<(u8, u32, u32, Vec<u8>)>,
    meta: MetaParams,
) -> Result<(), String> {
    let mut n = 0usize;
    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    while let Some((z, x, tms, data)) = rx.blocking_recv() {
        conn.execute(
            "INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![z, x, tms, data],
        )
        .map_err(|e| e.to_string())?;
        n += 1;
        if n % COMMIT_EVERY == 0 {
            conn.execute_batch("COMMIT; BEGIN").map_err(|e| e.to_string())?;
        }
    }
    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;

    let [w, s, e, n_] = meta.bbox;
    let values: [(&str, String); 8] = [
        ("name", meta.name.clone()),
        ("format", "jpg".into()),
        ("bounds", format!("{w},{s},{e},{n_}")),
        ("center", format!("{},{},{}", (w + e) / 2.0, (s + n_) / 2.0, meta.minzoom + 1)),
        ("minzoom", meta.minzoom.to_string()),
        ("maxzoom", meta.maxzoom.to_string()),
        ("type", "baselayer".into()),
        ("version", "1".into()),
    ];
    for (key, value) in values {
        conn.execute("DELETE FROM metadata WHERE name = ?1", [key])
            .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO metadata (name, value) VALUES (?1, ?2)", [key, &value])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn upsert_manifest(
    dir: &std::path::Path,
    name: &str,
    bbox: [f64; 4],
    minzoom: u8,
    maxzoom: u8,
) -> Result<(), String> {
    let path = dir.join("manifest.json");
    let mut manifest: serde_json::Value = if path.exists() {
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|e| format!("invalid manifest.json: {e}"))?
    } else {
        serde_json::json!({ "sites": [] })
    };

    let [w, s, e, n] = bbox;
    let entry = serde_json::json!({
        "name": name,
        "file": format!("{name}.mbtiles"),
        "bbox": bbox,
        "center": [(s + n) / 2.0, (w + e) / 2.0], // manifest convention: [lat, lon]
        "minzoom": minzoom,
        "maxzoom": maxzoom,
        "fetched_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    });

    let sites = manifest["sites"].as_array_mut().ok_or("manifest.json has no sites array")?;
    if let Some(existing) = sites.iter_mut().find(|s| s["name"] == name) {
        *existing = entry;
    } else {
        sites.push(entry);
    }
    let text = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(&path, text + "\n").map_err(|e| e.to_string())
}
