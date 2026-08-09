use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::string::String;
use std::sync::{LazyLock, Mutex};
use tauri::Manager;

mod telemetry_raw;

static IP_ADDRESS: Mutex<String> = Mutex::new(String::new());

/// Latest known unit for each sensor name, as reported on the raw telemetry
/// stream. Used to annotate CSV column headers, e.g. "PT101 [PSI]".
static SENSOR_UNITS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Current server IP, as set via `submit_ip`. Used by the raw telemetry
/// websocket client to build its connection URL.
pub(crate) fn server_ip() -> String {
    IP_ADDRESS.lock().unwrap().clone()
}

/// Record the latest reported unit for a sensor.
pub(crate) fn set_sensor_unit(name: &str, unit: &str) {
    SENSOR_UNITS.lock().unwrap().insert(name.to_string(), unit.to_string());
}

/// Latest known unit for a sensor, if any has been reported.
fn sensor_unit(name: &str) -> Option<String> {
    SENSOR_UNITS.lock().unwrap().get(name).cloned()
}

// Default camera recording directory set to Videos folder, can be changed
static CAMERA_RECORDING_DIR: LazyLock<Mutex<String>> = LazyLock::new(|| {
    let default_dir = dirs::video_dir()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    Mutex::new(default_dir)
});

#[tauri::command]
async fn fetch_server_ip() -> String {
    IP_ADDRESS.lock().unwrap().to_string()
}

#[tauri::command]
async fn submit_ip(new_ip: String) {
    let mut ip = IP_ADDRESS.lock().unwrap();
    println!("New IP Submitted: {}", new_ip);
    *ip = new_ip;
}

// ── CSV recorder ─────────────────────────────────────────────────────────────
//
// The recorder buffers the first HEADER_BATCHES batches before writing the CSV
// header.  This is necessary because different device timestamps carry different
// subsets of sensors; locking columns on the very first batch causes sensors
// that arrive in later batches to be silently dropped.  After HEADER_BATCHES
// batches we have seen the full set of sensor names and can write a stable header.

const HEADER_BATCHES: usize = 30;  // ~0.3 s at 100 Hz

struct CsvRecorder {
    writer:         BufWriter<File>,
    columns:        Vec<String>,
    valve_columns:  Vec<String>,
    auxiliary_columns: Vec<String>,
    kasa_columns:   Vec<String>,
    write_count:    u32,
    /// Batches accumulated before the header is written
    pending:        Vec<(f64, String, HashMap<String, f64>, HashMap<String, u8>, HashMap<String, u8>, HashMap<String, u8>)>,
    header_written: bool,
}

static RECORDER: Mutex<Option<CsvRecorder>> = Mutex::new(None);

fn data_dir() -> PathBuf {
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("data")
}

/// Flush the pending buffer: collect all sensor names seen, write the CSV
/// header, then write every buffered row.  Called once either after
/// HEADER_BATCHES batches have been received, or when the test is stopped early.
fn flush_pending(recorder: &mut CsvRecorder) -> std::io::Result<()> {
    // Collect every sensor name seen across all buffered batches (sorted)
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut seen_valves: BTreeSet<String> = BTreeSet::new();
    let mut seen_aux: BTreeSet<String> = BTreeSet::new();
    let mut seen_kasa: BTreeSet<String> = BTreeSet::new();
    for (_, _, batch, valve_states, auxiliary_states, kasa_states) in &recorder.pending {
        seen.extend(batch.keys().cloned());
        seen_valves.extend(valve_states.keys().cloned());
        seen_aux.extend(auxiliary_states.keys().cloned());
        seen_kasa.extend(kasa_states.keys().cloned());
    }
    let columns: Vec<String> = seen.into_iter().collect();
    let valve_columns: Vec<String> = seen_valves.into_iter().collect();
    let auxiliary_columns: Vec<String> = seen_aux.into_iter().collect();
    let kasa_columns: Vec<String> = seen_kasa.into_iter().collect();

    // Write header — sensor columns are annotated with their unit when known,
    // e.g. "PT101 [PSI]".
    let sensor_header = columns
        .iter()
        .map(|name| match sensor_unit(name) {
            Some(unit) if !unit.is_empty() => format!("{} [{}]", name, unit),
            _ => name.clone(),
        })
        .collect::<Vec<_>>()
        .join(",");
    let valve_header = valve_columns
        .iter()
        .map(|name| format!("valve_{}", name))
        .collect::<Vec<_>>()
        .join(",");
    let auxiliary_header = auxiliary_columns
        .iter()
        .map(|name| format!("relay_{}", name))
        .collect::<Vec<_>>()
        .join(",");
    let kasa_header = kasa_columns
        .iter()
        .map(|name| format!("kasa_{}", name))
        .collect::<Vec<_>>()
        .join(",");

    let mut header_parts: Vec<String> = Vec::new();
    if !sensor_header.is_empty() {
        header_parts.push(sensor_header);
    }
    if !valve_header.is_empty() {
        header_parts.push(valve_header);
    }
    if !auxiliary_header.is_empty() {
        header_parts.push(auxiliary_header);
    }
    if !kasa_header.is_empty() {
        header_parts.push(kasa_header);
    }
    let header_tail = header_parts.join(",");

    let header = if header_tail.is_empty() {
        "device_timestamp,source\n".to_string()
    } else {
        format!("device_timestamp,source,{}\n", header_tail)
    };
    recorder.writer.write_all(header.as_bytes())?;

    // Write all buffered rows — use std::mem::take to avoid borrow conflicts
    let pending = std::mem::take(&mut recorder.pending);
    for (ts, source, batch, valve_states, auxiliary_states, kasa_states) in &pending {
        let sensor_vals: Vec<String> = columns.iter()
            .map(|c| batch.get(c).map(|v| format!("{:.4}", v)).unwrap_or_default())
            .collect();
        let valve_vals: Vec<String> = valve_columns
            .iter()
            .map(|c| valve_states.get(c).copied().unwrap_or(0).to_string())
            .collect();
        let auxiliary_vals: Vec<String> = auxiliary_columns
            .iter()
            .map(|c| auxiliary_states.get(c).copied().unwrap_or(0).to_string())
            .collect();
        let kasa_vals: Vec<String> = kasa_columns
            .iter()
            .map(|c| kasa_states.get(c).copied().unwrap_or(0).to_string())
            .collect();

        let mut row_parts: Vec<String> = Vec::new();
        if !sensor_vals.is_empty() {
            row_parts.push(sensor_vals.join(","));
        }
        if !valve_vals.is_empty() {
            row_parts.push(valve_vals.join(","));
        }
        if !auxiliary_vals.is_empty() {
            row_parts.push(auxiliary_vals.join(","));
        }
        if !kasa_vals.is_empty() {
            row_parts.push(kasa_vals.join(","));
        }
        let row_tail = row_parts.join(",");

        let row = if row_tail.is_empty() {
            format!("{:.4},{}\n", ts, source)
        } else {
            format!("{:.4},{},{}\n", ts, source, row_tail)
        };

        recorder.writer.write_all(row.as_bytes())?;
    }

    recorder.writer.flush()?;
    recorder.columns           = columns;
    recorder.valve_columns     = valve_columns;
    recorder.auxiliary_columns = auxiliary_columns;
    recorder.kasa_columns      = kasa_columns;
    recorder.header_written    = true;
    recorder.write_count       = 0;
    Ok(())
}

/// Open a new CSV file.
/// `mode`     — the test configuration name, used as a filename prefix
///              (e.g. "hot-fire", "rocket-launch").
/// `datetime` — pre-formatted date+time string from the frontend
///              (e.g. "2026-03-01-210221").
/// Returns the absolute path of the created file.
#[tauri::command]
fn start_recording(mode: String, datetime: String) -> Result<String, String> {
    let mut guard = RECORDER.lock().map_err(|e| e.to_string())?;

    // Close any previous recording cleanly
    if let Some(mut r) = guard.take() {
        if !r.header_written && !r.pending.is_empty() {
            let _ = flush_pending(&mut r);
        } else {
            let _ = r.writer.flush();
        }
    }

    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Sanitise mode string so it is safe as a filename component
    let safe_mode = mode.replace(|c: char| !c.is_alphanumeric() && c != '-', "-");
    let filename  = format!("{}-{}.csv", safe_mode, datetime);
    let path      = dir.join(&filename);
    let file      = File::create(&path).map_err(|e| e.to_string())?;

    *guard = Some(CsvRecorder {
        writer:         BufWriter::new(file),
        columns:        Vec::new(),
        valve_columns:  Vec::new(),
        auxiliary_columns: Vec::new(),
        kasa_columns:   Vec::new(),
        write_count:    0,
        pending:        Vec::new(),
        header_written: false,
    });

    println!("[Recorder] started → {}", path.display());
    telemetry_raw::start();
    Ok(path.to_string_lossy().to_string())
}

/// Append one row of sensor readings, sourced from the raw telemetry
/// websocket stream (see `telemetry_raw`). Readings are recorded exactly as the
/// server sends them — the server owns tare offsets and applies them before
/// fan-out, so these values are already tared and match what operators see.
/// For the first HEADER_BATCHES calls, data is buffered so that the full set of
/// sensor names can be determined before the header is written.  After that,
/// rows are written immediately and flushed every 10 writes.
pub(crate) fn record_batch(
    timestamp: f64,
    source: String,
    readings: HashMap<String, f64>,
    valve_states: HashMap<String, u8>,
    auxiliary_states: HashMap<String, u8>,
    kasa_states: HashMap<String, u8>,
) -> Result<(), String> {
    let mut guard = RECORDER.lock().map_err(|e| e.to_string())?;
    let recorder  = match guard.as_mut() {
        Some(r) => r,
        None    => return Ok(()),  // no recording in progress — silently skip
    };

    if !recorder.header_written {
        recorder.pending.push((timestamp, source, readings, valve_states, auxiliary_states, kasa_states));

        if recorder.pending.len() >= HEADER_BATCHES {
            flush_pending(recorder).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    // Header already written — append the row directly
    let sensor_values: Vec<String> = recorder.columns.iter()
        .map(|col| readings.get(col).map(|v| format!("{:.4}", v)).unwrap_or_default())
        .collect();
    let valve_values: Vec<String> = recorder.valve_columns
        .iter()
        .map(|col| valve_states.get(col).copied().unwrap_or(0).to_string())
        .collect();
    let auxiliary_values: Vec<String> = recorder.auxiliary_columns
        .iter()
        .map(|col| auxiliary_states.get(col).copied().unwrap_or(0).to_string())
        .collect();
    let kasa_values: Vec<String> = recorder.kasa_columns
        .iter()
        .map(|col| kasa_states.get(col).copied().unwrap_or(0).to_string())
        .collect();

    let mut row_parts: Vec<String> = Vec::new();
    if !sensor_values.is_empty() {
        row_parts.push(sensor_values.join(","));
    }
    if !valve_values.is_empty() {
        row_parts.push(valve_values.join(","));
    }
    if !auxiliary_values.is_empty() {
        row_parts.push(auxiliary_values.join(","));
    }
    if !kasa_values.is_empty() {
        row_parts.push(kasa_values.join(","));
    }
    let row_tail = row_parts.join(",");
    let row = if row_tail.is_empty() {
        format!("{:.4},{}\n", timestamp, source)
    } else {
        format!("{:.4},{},{}\n", timestamp, source, row_tail)
    };
    recorder.writer.write_all(row.as_bytes()).map_err(|e| e.to_string())?;

    recorder.write_count += 1;
    if recorder.write_count >= 10 {
        recorder.writer.flush().map_err(|e| e.to_string())?;
        recorder.write_count = 0;
    }

    Ok(())
}

/// Flush and close the current CSV file.
/// If called before the header buffer filled, writes whatever has been collected.
#[tauri::command]
fn stop_recording() -> Result<(), String> {
    telemetry_raw::stop();
    let mut guard = RECORDER.lock().map_err(|e| e.to_string())?;
    if let Some(mut r) = guard.take() {
        if !r.header_written && !r.pending.is_empty() {
            flush_pending(&mut r).map_err(|e| e.to_string())?;
        } else {
            r.writer.flush().map_err(|e| e.to_string())?;
        }
        println!("[Recorder] stopped");
    }
    Ok(())
}

#[tauri::command]
// returns the current camera recording directory
async fn fetch_camera_recording_dir() -> String {
    let gaurded_dir = CAMERA_RECORDING_DIR.lock().unwrap();
    gaurded_dir.to_string()
}

#[tauri::command]
// stores the inputted string in CAMERA_RECORDING_DIR for later use
async fn set_camera_recording_dir(new_dir: String) {
    let mut gaurded_dir = CAMERA_RECORDING_DIR.lock().unwrap();
    println!("New Camera Recording Directory Submitted: {}", new_dir);
    *gaurded_dir = String::from(new_dir);
}

fn camera_recording_path(filename: &str) -> Result<PathBuf, String> {
    let videos_dir = PathBuf::from(CAMERA_RECORDING_DIR.lock().unwrap().to_string());
    fs::create_dir_all(&videos_dir).map_err(|e| e.to_string())?;
    Ok(videos_dir.join(filename))
}

#[tauri::command]
async fn save_downloaded_camera_recording(filename: String, data: Vec<u8>) -> Result<String, String> {
    let path = camera_recording_path(&filename)?;
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    file.write_all(&data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(target_os = "linux")]
fn linux_media_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("linux-media")
        .on_webview_ready(|webview| configure_linux_webview_media(&webview))
        .build()
}

#[cfg(target_os = "linux")]
fn configure_linux_webview_media<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    use webkit2gtk::{glib::prelude::ObjectExt, WebViewExt};

    let label = webview.label().to_owned();
    let callback_label = label.clone();
    let result = webview.with_webview(move |platform_webview| {
        let native_webview = platform_webview.inner();
        let Some(settings) = native_webview.settings() else {
            eprintln!("[WebKit] No settings object is available for webview '{callback_label}'");
            return;
        };

        // WebKitGTK ships several media features disabled by default. Set the
        // properties dynamically so this remains safe if a distro's WebKit is
        // older and does not expose one of the newer settings.
        const MEDIA_SETTINGS: [(&str, bool); 8] = [
            ("enable-media", true),
            ("enable-media-capabilities", true),
            ("enable-media-stream", true),
            ("enable-mediasource", true),
            ("enable-webaudio", true),
            ("enable-webrtc", true),
            ("media-playback-allows-inline", true),
            ("media-playback-requires-user-gesture", false),
        ];

        let mut webrtc_available = false;
        for (property, enabled) in MEDIA_SETTINGS {
            if settings.find_property(property).is_some() {
                settings.set_property(property, enabled);
                if property == "enable-webrtc" {
                    webrtc_available = true;
                }
            } else {
                eprintln!(
                    "[WebKit] Setting '{property}' is unavailable for webview '{callback_label}'"
                );
            }
        }

        if webrtc_available {
            println!("[WebKit] Enabled WebRTC and media playback for webview '{callback_label}'");
        } else {
            eprintln!(
                "[WebKit] WebRTC is unavailable for webview '{callback_label}'; media playback settings were applied where supported"
            );
        }
    });

    if let Err(error) = result {
        eprintln!("[WebKit] Failed to configure webview '{label}': {error}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    #[cfg(target_os = "linux")]
    let builder = builder.plugin(linux_media_plugin());

    builder
        .setup(|app| {
            // Maximize the main window
            let main_win = app.get_webview_window("main").expect("main window");
            let _ = main_win.maximize();

            // Spawn one maximized window on each additional monitor
            let monitors = main_win.available_monitors().unwrap_or_default();
            println!("[Setup] Detected {} monitor(s)", monitors.len());

            // Log every monitor so we can see all positions
            for (i, m) in monitors.iter().enumerate() {
                let pos  = m.position();
                let size = m.size();
                println!("[Setup] Monitor {}: name={:?}, pos=({}, {}), size={}x{}, scale={}", i, m.name(), pos.x, pos.y, size.width, size.height, m.scale_factor());
            }

            for (i, monitor) in monitors.into_iter().enumerate().skip(1) {
                let pos   = monitor.position();
                let scale = monitor.scale_factor();
                let lx    = pos.x as f64 / scale;
                let ly    = pos.y as f64 / scale;
                println!("[Setup] Spawning screen-{} at physical ({}, {}), logical ({:.0}, {:.0}), scale {}", i, pos.x, pos.y, lx, ly, scale);

                let result = tauri::WebviewWindowBuilder::new(
                    app,
                    format!("screen-{}", i),
                    tauri::WebviewUrl::App("/".into()),
                )
                .title(format!("prop-control-gui — Screen {}", i + 1))
                .position(lx, ly)
                .maximized(true)
                .build();

                if let Err(e) = result {
                    eprintln!("[Setup] Failed to create screen-{}: {}", i, e);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fetch_server_ip,
            submit_ip,
            start_recording,
            stop_recording,
            telemetry_raw::update_control_states,
            fetch_camera_recording_dir,
            set_camera_recording_dir,
            save_downloaded_camera_recording,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
