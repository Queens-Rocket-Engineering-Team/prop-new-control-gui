//! In-app satellite tile downloader for the flight panel.
//!
//! Downloads Esri World Imagery XYZ tiles for a bbox + zoom range into a
//! per-site MBTiles file under `maps_dir()`, updating manifest.json — the
//! same formats the tiles:// protocol (maps.rs) reads. The app owns the whole
//! prepare-at-home → fly-offline workflow, so there is no external script to
//! run for tiles beforehand.
//!
//! Downloads run as one background task per app process; progress streams to
//! every window via `map-download-progress` events.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};

use rusqlite::Connection;
use tauri::{Emitter, Manager};

// Tile fetching is latency-bound, not bandwidth-bound, so throughput scales
// almost linearly with in-flight requests. Measured against Esri: 8 -> 57
// tiles/s, 16 -> 108, 24 -> 143, 32 -> 158. 24 captures ~90% of the available
// gain; past that the curve flattens and it is needlessly hard on a service
// we are using by courtesy.
const CONCURRENCY: usize = 24;
const COMMIT_EVERY: usize = 500;
// Progress is emitted on a timer rather than every N tiles: a count-based
// trigger makes the bar step in visible chunks (and look throttled) at high
// rates, while spamming the webview with IPC.
const EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(150);
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
    /// Tile bytes actually transferred during *this* run. Tiles skipped by a
    /// resume contribute nothing, so this tracks real network volume.
    bytes: u64,
    /// Tiles already in the MBTiles when this run started. With `fetched` it
    /// gives the count this run downloaded, which is what `bytes` divides by
    /// to project a final size.
    skipped: u64,
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
        let (fetched, failed, bytes, skipped, error) = match result {
            Ok(summary) => {
                let err = if CANCEL.load(SeqCst) { Some("cancelled".to_string()) } else { None };
                (summary.fetched, summary.failed, summary.bytes, summary.skipped, err)
            }
            Err(e) => (0, 0, 0, 0, Some(e)),
        };
        emit_progress(&app, &Progress {
            name, fetched, failed, total, bytes, skipped, done: true, error,
        });
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

/// Outcome of one download run, for the terminal progress event.
struct DownloadSummary {
    fetched: u64,
    failed: u64,
    bytes: u64,
    skipped: u64,
}

async fn run_download(
    app: &tauri::AppHandle,
    name: &str,
    bbox: [f64; 4],
    minzoom: u8,
    maxzoom: u8,
    total: u64,
) -> Result<DownloadSummary, String> {
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
    // Deep enough that a commit pause in the writer never stalls the fetchers.
    let (tx, rx) = tokio::sync::mpsc::channel::<(u8, u32, u32, Vec<u8>)>(256);
    let writer = tauri::async_runtime::spawn_blocking(move || writer_loop(conn, rx, meta));

    let client = reqwest::Client::builder()
        .user_agent("qret-prop-control-gui/0.1 (offline field basemap; internal team use)")
        .timeout(std::time::Duration::from_secs(20))
        // The idle-connection pool is unbounded by default, so all CONCURRENCY
        // keep-alive connections stay warm without configuring anything.
        .build()
        .map_err(|e| e.to_string())?;

    use futures_util::StreamExt;
    let mut stream = futures_util::stream::iter(
        todo.into_iter().map(|t| fetch_tile(client.clone(), t)),
    )
    .buffer_unordered(CONCURRENCY);

    let mut fetched = skipped;
    let mut failed = 0u64;
    let mut bytes = 0u64;
    let mut last_emit = std::time::Instant::now();
    while let Some(result) = stream.next().await {
        if CANCEL.load(SeqCst) {
            break;
        }
        match result {
            Ok(((z, x, y), data)) => {
                fetched += 1;
                // Measured before the move into the writer channel.
                bytes += data.len() as u64;
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
        if last_emit.elapsed() >= EMIT_INTERVAL {
            last_emit = std::time::Instant::now();
            emit_progress(app, &Progress {
                name: name.to_string(),
                fetched,
                failed,
                total,
                bytes,
                skipped,
                done: false,
                error: None,
            });
        }
    }
    // Close the channel so the writer commits and writes metadata — this must
    // happen on the cancel path too, or the partial file loses the last batch
    // and its metadata table (which the tile server requires).
    drop(stream);
    drop(tx);
    writer.await.map_err(|e| e.to_string())??;

    // A cached read-only connection from a previous download of this site
    // would serve stale metadata; force a reopen on next tile request.
    crate::maps::evict_tile_source(Some(name));

    // Only publish coverage we actually finished. A cancelled run holds a
    // fraction of the requested tiles, so listing it would advertise a bbox and
    // zoom range the file doesn't contain. The partial .mbtiles stays on disk
    // (valid, with its metadata written above) so re-running the same site name
    // resumes it — and if the site was already in the manifest from an earlier
    // complete run, leaving the entry untouched keeps that coverage listed.
    if CANCEL.load(SeqCst) {
        println!(
            "[MapDL] {name}: cancelled after {fetched} tiles ({:.1} MB) — manifest left unchanged",
            bytes as f64 / 1e6,
        );
    } else {
        upsert_manifest(&dir, name, bbox, minzoom, maxzoom)?;
        println!(
            "[MapDL] {name}: done ({fetched} fetched, {failed} failed, {:.1} MB transferred)",
            bytes as f64 / 1e6,
        );
    }
    Ok(DownloadSummary { fetched, failed, bytes, skipped })
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

// ── OSM feature download (Overpass) ─────────────────────────────────────────
//
// Named features (roads, lakes, rivers, parks, towns) for a site bbox,
// fetched from the Overpass API and stored as `<name>.features.geojson` next
// to the MBTiles. The flight panel renders them as MapLibre vector layers, so
// labels stay crisp offline at any zoom and the names are queryable data.

// Must be *global* instances. Several public Overpass servers only host a
// single country's extract (overpass.osm.ch is Switzerland-only, for one) and
// answer an out-of-region query with a perfectly valid, totally empty 200 —
// which would silently write an empty features file instead of failing.
const OVERPASS_ENDPOINTS: [&str; 2] = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
];

/// Sweeps over the whole endpoint list before giving up.
const OVERPASS_ROUNDS: u32 = 3;
/// Ceiling on the whole retry campaign. A 70x70 km launch box answers in ~12 s,
/// so anything approaching this is a server refusing rather than working.
const OVERPASS_TOTAL_BUDGET: std::time::Duration = std::time::Duration::from_secs(150);

/// Every element is required to carry a `name`.
///
/// This is load-bearing, not tidiness: without the name filter the area
/// queries pull *every* water body and park in the bbox, named or not. Over
/// the Canadian Shield that is thousands of unnamed ponds, each with full
/// geometry, and Overpass gives up — a 30x30 km box around the Timmins launch
/// site returned HTTP 504 after 14 s. With the filter the same box answers in
/// under 5 s with 381 features. Nothing is really lost either: the satellite
/// imagery underneath already shows where the water is, and what OSM is here
/// to add is the names.
fn overpass_query(bbox: [f64; 4]) -> String {
    let [w, s, e, n] = bbox;
    let bb = format!("({s},{w},{n},{e})");
    format!(
        "[out:json][timeout:90];(\
         way[\"highway\"][\"name\"]{bb};\
         way[\"waterway\"][\"name\"]{bb};\
         way[\"natural\"=\"water\"][\"name\"]{bb};\
         relation[\"natural\"=\"water\"][\"name\"]{bb};\
         way[\"leisure\"=\"park\"][\"name\"]{bb};\
         relation[\"leisure\"=\"park\"][\"name\"]{bb};\
         way[\"boundary\"=\"protected_area\"][\"name\"]{bb};\
         relation[\"boundary\"=\"protected_area\"][\"name\"]{bb};\
         node[\"place\"]{bb};\
         );out geom;"
    )
}

/// Classify an OSM element's tags into the small set of kinds the map styles.
fn feature_kind(tags: &serde_json::Value) -> Option<&'static str> {
    if tags.get("highway").is_some() {
        Some("road")
    } else if tags.get("waterway").is_some() {
        Some("waterway")
    } else if tags.get("natural").and_then(|v| v.as_str()) == Some("water") {
        Some("water")
    } else if tags.get("leisure").and_then(|v| v.as_str()) == Some("park")
        || tags.get("boundary").and_then(|v| v.as_str()) == Some("protected_area")
    {
        Some("park")
    } else if tags.get("place").is_some() {
        Some("place")
    } else {
        None
    }
}

fn osm_to_geojson(osm: &serde_json::Value) -> serde_json::Value {
    let mut features: Vec<serde_json::Value> = Vec::new();
    let empty = vec![];
    let elements = osm["elements"].as_array().unwrap_or(&empty);

    for el in elements {
        let tags = &el["tags"];
        let Some(kind) = feature_kind(tags) else { continue };
        let name = tags.get("name").and_then(|v| v.as_str());

        let mut props = serde_json::json!({ "kind": kind });
        if let Some(name) = name {
            props["name"] = serde_json::json!(name);
        }
        if kind == "place" {
            if let Some(place) = tags.get("place") {
                props["place"] = place.clone();
            }
        }

        let geometry = match el["type"].as_str() {
            Some("node") => {
                let (Some(lat), Some(lon)) = (el["lat"].as_f64(), el["lon"].as_f64()) else {
                    continue;
                };
                serde_json::json!({ "type": "Point", "coordinates": [lon, lat] })
            }
            Some("way") => {
                let Some(geom) = el["geometry"].as_array() else { continue };
                let coords: Vec<[f64; 2]> = geom
                    .iter()
                    .filter_map(|p| Some([p["lon"].as_f64()?, p["lat"].as_f64()?]))
                    .collect();
                if coords.len() < 2 {
                    continue;
                }
                let closed = coords.len() >= 4 && coords.first() == coords.last();
                if closed {
                    serde_json::json!({ "type": "Polygon", "coordinates": [coords] })
                } else {
                    serde_json::json!({ "type": "LineString", "coordinates": coords })
                }
            }
            Some("relation") => {
                // Multipolygon assembly isn't worth the complexity here — a
                // named centroid point is enough to label the lake/park.
                if name.is_none() {
                    continue;
                }
                let Some(members) = el["members"].as_array() else { continue };
                let (mut sum_lat, mut sum_lon, mut count) = (0.0f64, 0.0f64, 0u64);
                for m in members {
                    if let Some(geom) = m["geometry"].as_array() {
                        for p in geom {
                            if let (Some(lat), Some(lon)) = (p["lat"].as_f64(), p["lon"].as_f64()) {
                                sum_lat += lat;
                                sum_lon += lon;
                                count += 1;
                            }
                        }
                    }
                }
                if count == 0 {
                    continue;
                }
                let n = count as f64;
                props["label_only"] = serde_json::json!(true);
                serde_json::json!({ "type": "Point", "coordinates": [sum_lon / n, sum_lat / n] })
            }
            _ => continue,
        };

        features.push(serde_json::json!({
            "type": "Feature",
            "properties": props,
            "geometry": geometry,
        }));
    }

    serde_json::json!({ "type": "FeatureCollection", "features": features })
}

/// Fetch named OSM features for a site bbox and store them as
/// `<name>.features.geojson`. Returns the feature count. Failures are
/// non-fatal to the site: the imagery works without the feature layer.
#[tauri::command]
pub async fn download_map_features(name: String, bbox: [f64; 4]) -> Result<u64, String> {
    let name = name.trim().to_string();
    if name.is_empty()
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || "-_ ".contains(c))
    {
        return Err("site name must be alphanumeric (dashes/underscores/spaces allowed)".into());
    }
    let [w, s, e, n] = bbox;
    if !(w < e && s < n) {
        return Err("bbox out of order".into());
    }

    let client = reqwest::Client::builder()
        .user_agent("qret-prop-control-gui/0.1 (launch site offline map labels)")
        // Overpass mirrors go down without warning, and an unreachable one
        // otherwise burns the whole request timeout before we try the next.
        // A short connect timeout makes failover quick instead of a multi-
        // minute hang with nothing on screen.
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let query = overpass_query(bbox);
    let mut last_err = String::new();
    let mut empty_result: Option<serde_json::Value> = None;

    // The public instances shed load by answering HTTP 504 after ~10 s when
    // busy — measured roughly one refusal in three for a launch-site-sized
    // box, even though the query itself completes in ~3 s when it gets a slot.
    // So sweep the endpoint list several times rather than giving up after one
    // attempt each; the refusals are transient, not a verdict on the query.
    // Endpoints that couldn't be connected to at all: the host is down, so
    // unlike a 504 there is nothing to retry, and re-dialling it every round
    // would just burn the connect timeout again.
    let mut unreachable: Vec<&str> = Vec::new();
    let started = std::time::Instant::now();

    'rounds: for round in 0..OVERPASS_ROUNDS {
        if round > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(3 * u64::from(round))).await;
        }
        for endpoint in OVERPASS_ENDPOINTS {
            if unreachable.contains(&endpoint) {
                continue;
            }
            if started.elapsed() > OVERPASS_TOTAL_BUDGET {
                last_err = format!("gave up after {}s", started.elapsed().as_secs());
                eprintln!("[MapDL] Overpass {last_err}");
                break 'rounds;
            }
            match client.post(endpoint).form(&[("data", query.as_str())]).send().await {
                Ok(resp) if resp.status().is_success() => {
                    let body =
                        resp.bytes().await.map_err(|e| format!("bad Overpass response: {e}"))?;
                    let osm: serde_json::Value = serde_json::from_slice(&body)
                        .map_err(|e| format!("bad Overpass JSON: {e}"))?;
                    let geojson = osm_to_geojson(&osm);
                    let count =
                        geojson["features"].as_array().map(|a| a.len() as u64).unwrap_or(0);

                    // An empty answer is usually a mirror that doesn't hold
                    // this part of the world, so try the others before
                    // believing it. If everything comes back empty the area
                    // really is featureless and we write that.
                    if count == 0 {
                        eprintln!("[MapDL] Overpass {endpoint}: no features — trying elsewhere");
                        last_err = format!("{endpoint}: returned no features");
                        empty_result = Some(geojson);
                        continue;
                    }
                    return write_features(&name, &geojson, count);
                }
                Ok(resp) => {
                    last_err = format!("{endpoint}: HTTP {}", resp.status());
                    eprintln!("[MapDL] Overpass attempt {}: {last_err}", round + 1);
                }
                Err(e) => {
                    if e.is_connect() {
                        unreachable.push(endpoint);
                    }
                    last_err = format!("{endpoint}: {e}");
                    eprintln!("[MapDL] Overpass attempt {}: {last_err}", round + 1);
                }
            }
        }
    }

    if let Some(geojson) = empty_result {
        return write_features(&name, &geojson, 0);
    }
    Err(format!("Overpass feature download failed after {OVERPASS_ROUNDS} attempts ({last_err})"))
}

fn write_features(name: &str, geojson: &serde_json::Value, count: u64) -> Result<u64, String> {
    let dir = crate::maps::maps_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{name}.features.geojson"));
    std::fs::write(&path, serde_json::to_string(geojson).map_err(|e| e.to_string())?)
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    println!("[MapDL] {name}: saved {count} OSM features");
    Ok(count)
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

#[cfg(test)]
mod tests {
    use super::*;

    // Shapes taken from a real Overpass response for the Timmins launch area.
    #[test]
    fn converts_overpass_elements_to_geojson() {
        let osm = serde_json::json!({
            "elements": [
                // Named open way -> LineString road
                { "type": "way", "tags": { "highway": "residential", "name": "Main Road" },
                  "geometry": [ {"lat": 47.9, "lon": -81.9}, {"lat": 47.91, "lon": -81.89} ] },
                // Closed way -> Polygon lake
                { "type": "way", "tags": { "natural": "water", "name": "Ahsine Lake" },
                  "geometry": [ {"lat": 47.9, "lon": -81.9}, {"lat": 47.91, "lon": -81.9},
                                {"lat": 47.91, "lon": -81.89}, {"lat": 47.9, "lon": -81.9} ] },
                // Place node -> Point
                { "type": "node", "lat": 47.95, "lon": -81.87,
                  "tags": { "place": "hamlet", "name": "Kenogaming" } },
                // Relation -> centroid Point
                { "type": "relation", "tags": { "leisure": "park", "name": "Big Park" },
                  "members": [ { "geometry": [ {"lat": 47.0, "lon": -81.0},
                                               {"lat": 49.0, "lon": -83.0} ] } ] },
                // Irrelevant tags are dropped
                { "type": "way", "tags": { "barrier": "fence" },
                  "geometry": [ {"lat": 47.9, "lon": -81.9}, {"lat": 47.91, "lon": -81.89} ] },
            ]
        });

        let gj = osm_to_geojson(&osm);
        let features = gj["features"].as_array().unwrap();
        assert_eq!(features.len(), 4, "the fence has no mapped kind and should be dropped");

        let by_name = |name: &str| {
            features
                .iter()
                .find(|f| f["properties"]["name"] == name)
                .unwrap_or_else(|| panic!("missing feature {name}"))
                .clone()
        };

        let road = by_name("Main Road");
        assert_eq!(road["properties"]["kind"], "road");
        assert_eq!(road["geometry"]["type"], "LineString");

        let lake = by_name("Ahsine Lake");
        assert_eq!(lake["properties"]["kind"], "water");
        assert_eq!(lake["geometry"]["type"], "Polygon");

        let hamlet = by_name("Kenogaming");
        assert_eq!(hamlet["properties"]["kind"], "place");
        assert_eq!(hamlet["geometry"]["type"], "Point");
        assert_eq!(hamlet["geometry"]["coordinates"][0], -81.87); // GeoJSON is [lon, lat]

        // Relations collapse to a labelled centroid rather than a multipolygon.
        let park = by_name("Big Park");
        assert_eq!(park["properties"]["kind"], "park");
        assert_eq!(park["geometry"]["type"], "Point");
        assert_eq!(park["geometry"]["coordinates"][0], -82.0);
        assert_eq!(park["geometry"]["coordinates"][1], 48.0);
    }

    #[test]
    fn overpass_query_covers_the_bbox_in_south_west_north_east_order() {
        let q = overpass_query([-81.95, 47.9, -81.8, 48.03]);
        // Overpass bbox filters are (south,west,north,east).
        assert!(q.contains("(47.9,-81.95,48.03,-81.8)"), "unexpected bbox in: {q}");
        for tag in ["highway", "waterway", "natural", "leisure", "place"] {
            assert!(q.contains(tag), "query is missing {tag}");
        }
    }

    #[test]
    fn every_area_query_is_restricted_to_named_features() {
        // Dropping this filter makes the query pull every unnamed pond in the
        // bbox and Overpass 504s on launch-site-sized areas. Guard it.
        let q = overpass_query([-82.07, 47.83, -81.67, 48.10]);
        for clause in q.split(';') {
            let clause = clause.trim();
            if !clause.starts_with("way[") && !clause.starts_with("relation[") {
                continue;
            }
            assert!(
                clause.contains("[\"name\"]"),
                "area clause without a name filter would blow up Overpass: {clause}",
            );
        }
    }
}
