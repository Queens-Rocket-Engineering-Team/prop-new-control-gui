use futures_util::StreamExt;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::string::String;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    LazyLock, Mutex,
};
use std::time::Duration;
use tauri::Manager;
use tokio::io::AsyncWriteExt;

mod telemetry_raw;

static IP_ADDRESS: Mutex<String> = Mutex::new(String::new());
static ACTIVE_SERVER_SESSION: Mutex<Option<String>> = Mutex::new(None);

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

static SESSION_DOWNLOAD_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[tauri::command]
async fn fetch_server_ip() -> String {
    IP_ADDRESS.lock().unwrap().to_string()
}

#[tauri::command]
async fn submit_ip(new_ip: String) -> Result<(), String> {
    let current_ip = IP_ADDRESS.lock().map_err(|e| e.to_string())?.clone();
    if current_ip != new_ip {
        let active_session = ACTIVE_SERVER_SESSION
            .lock()
            .map_err(|e| e.to_string())?
            .clone();
        let local_recording = RECORDER
            .lock()
            .map_err(|e| e.to_string())?
            .recorder
            .is_some();
        if let Some(session_id) = active_session {
            return Err(format!(
                "server IP is locked while session {session_id} is recording"
            ));
        }
        if local_recording {
            return Err("server IP is locked while the laptop CSV recorder is armed".to_string());
        }
    }

    let mut ip = IP_ADDRESS.lock().map_err(|e| e.to_string())?;
    println!("New IP Submitted: {}", new_ip);
    *ip = new_ip;
    Ok(())
}

#[tauri::command]
fn set_server_session_lock(session_id: Option<String>) -> Result<(), String> {
    let mut active = ACTIVE_SERVER_SESSION.lock().map_err(|e| e.to_string())?;
    *active = session_id.filter(|value| !value.trim().is_empty());
    Ok(())
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

struct RecorderState {
    recorder: Option<CsvRecorder>,
    path: Option<PathBuf>,
}

static RECORDER: Mutex<RecorderState> = Mutex::new(RecorderState {
    recorder: None,
    path: None,
});

fn data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("telemetry")
}

fn sessions_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("sessions")
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

    // Every monitor hosts its own App.vue and may invoke this command at nearly
    // the same time. The process-global lock makes repeated starts idempotent:
    // the first caller creates the CSV and all later callers receive its path.
    if guard.recorder.is_some() {
        return guard
            .path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string())
            .ok_or_else(|| "recorder is active but its path is unavailable".to_string());
    }

    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Sanitise mode string so it is safe as a filename component
    let safe_mode = mode.replace(|c: char| !c.is_alphanumeric() && c != '-', "-");
    let filename  = format!("{}-{}.csv", safe_mode, datetime);
    let path      = dir.join(&filename);
    let file      = File::create(&path).map_err(|e| e.to_string())?;

    guard.recorder = Some(CsvRecorder {
        writer:         BufWriter::new(file),
        columns:        Vec::new(),
        valve_columns:  Vec::new(),
        auxiliary_columns: Vec::new(),
        kasa_columns:   Vec::new(),
        write_count:    0,
        pending:        Vec::new(),
        header_written: false,
    });
    guard.path = Some(path.clone());

    println!("[Recorder] started → {}", path.display());
    telemetry_raw::start();
    Ok(path.to_string_lossy().to_string())
}

/// Report whether this HELM process currently has its independent CSV backup
/// armed. This is deliberately separate from the server-side session state.
#[tauri::command]
fn local_recording_active() -> Result<bool, String> {
    let guard = RECORDER.lock().map_err(|e| e.to_string())?;
    Ok(guard.recorder.is_some())
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
    let recorder  = match guard.recorder.as_mut() {
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
    let mut guard = RECORDER.lock().map_err(|e| e.to_string())?;
    telemetry_raw::stop();
    guard.path = None;
    if let Some(mut r) = guard.recorder.take() {
        if !r.header_written && !r.pending.is_empty() {
            flush_pending(&mut r).map_err(|e| e.to_string())?;
        } else {
            r.writer.flush().map_err(|e| e.to_string())?;
        }
        println!("[Recorder] stopped");
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct SessionDownloadError {
    kind: String,
    status: Option<u16>,
    message: String,
}

impl SessionDownloadError {
    fn new(kind: &str, status: Option<u16>, message: impl Into<String>) -> Self {
        Self {
            kind: kind.to_string(),
            status,
            message: message.into(),
        }
    }

    fn filesystem(action: &str, error: impl std::fmt::Display) -> Self {
        Self::new("filesystem", None, format!("{action}: {error}"))
    }
}

#[derive(Debug)]
struct SessionDownloadGuard;

impl SessionDownloadGuard {
    fn acquire() -> Result<Self, SessionDownloadError> {
        SESSION_DOWNLOAD_IN_PROGRESS
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                SessionDownloadError::new(
                    "download_in_progress",
                    None,
                    "another session download is already in progress",
                )
            })?;
        Ok(Self)
    }
}

impl Drop for SessionDownloadGuard {
    fn drop(&mut self) {
        SESSION_DOWNLOAD_IN_PROGRESS.store(false, Ordering::Release);
    }
}

fn validate_session_id(session_id: &str) -> Result<(), SessionDownloadError> {
    let valid_length = !session_id.is_empty() && session_id.len() <= 255;
    let valid_characters = session_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');

    if valid_length && valid_characters {
        Ok(())
    } else {
        Err(SessionDownloadError::new(
            "invalid_session_id",
            None,
            "session id must be 1-255 ASCII letters, numbers, hyphens, or underscores",
        ))
    }
}

fn session_download_url(
    server: &str,
    port: u16,
    session_id: &str,
) -> Result<String, SessionDownloadError> {
    validate_session_id(session_id)?;

    if server != "localhost" && server.parse::<Ipv4Addr>().is_err() {
        return Err(SessionDownloadError::new(
            "invalid_server",
            None,
            "the configured server must be localhost or an IPv4 address",
        ));
    }

    Ok(format!(
        "http://{server}:{port}/v1/sessions/{session_id}/download"
    ))
}

async fn create_partial_file(
    directory: &Path,
    session_id: &str,
) -> Result<(PathBuf, tokio::fs::File), SessionDownloadError> {
    for suffix in 0_u32.. {
        let suffix = if suffix == 0 {
            String::new()
        } else {
            format!("-{suffix}")
        };
        let filename = format!(".{session_id}.{}{}.zip.part", std::process::id(), suffix);
        let path = directory.join(filename);
        match tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .await
        {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(SessionDownloadError::filesystem(
                    "failed to create the partial download",
                    error,
                ))
            }
        }
    }

    unreachable!("u32 suffix space exhausted while creating a partial file")
}

async fn promote_without_clobbering(
    partial_path: &Path,
    directory: &Path,
    session_id: &str,
) -> Result<PathBuf, SessionDownloadError> {
    for copy_number in 1_u32.. {
        let filename = if copy_number == 1 {
            format!("{session_id}.zip")
        } else {
            format!("{session_id}-{copy_number}.zip")
        };
        let final_path = directory.join(filename);

        // A hard link is an atomic create-if-absent operation on both Windows
        // and Unix. Unlike rename on Unix, it can never replace an existing ZIP.
        match tokio::fs::hard_link(partial_path, &final_path).await {
            Ok(()) => return Ok(final_path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(link_error) => match copy_without_clobbering(partial_path, &final_path).await {
                Ok(true) => return Ok(final_path),
                Ok(false) => continue,
                Err(copy_error) => {
                    return Err(SessionDownloadError::new(
                        "filesystem",
                        None,
                        format!(
                            "failed to promote the completed session archive (hard link: {link_error}; fallback: {})",
                            copy_error.message
                        ),
                    ))
                }
            }
        }
    }

    unreachable!("u32 suffix space exhausted while naming a session archive")
}

async fn copy_without_clobbering(
    source_path: &Path,
    final_path: &Path,
) -> Result<bool, SessionDownloadError> {
    let mut destination = match tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(final_path)
        .await
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(error) => {
            return Err(SessionDownloadError::filesystem(
                "failed to reserve the session archive filename",
                error,
            ))
        }
    };

    let result = async {
        let mut source = tokio::fs::File::open(source_path).await.map_err(|error| {
            SessionDownloadError::filesystem("failed to reopen the completed download", error)
        })?;
        tokio::io::copy(&mut source, &mut destination)
            .await
            .map_err(|error| {
                SessionDownloadError::filesystem(
                    "failed to copy the completed session archive",
                    error,
                )
            })?;
        destination.flush().await.map_err(|error| {
            SessionDownloadError::filesystem("failed to flush the session archive", error)
        })?;
        destination.sync_all().await.map_err(|error| {
            SessionDownloadError::filesystem("failed to sync the session archive", error)
        })?;
        Ok(true)
    }
    .await;

    if result.is_err() {
        drop(destination);
        let _ = tokio::fs::remove_file(final_path).await;
    }
    result
}

async fn download_session_zip_to(
    server: &str,
    port: u16,
    session_id: &str,
    directory: &Path,
) -> Result<PathBuf, SessionDownloadError> {
    let url = session_download_url(server, port, session_id)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| {
            SessionDownloadError::new(
                "client",
                None,
                format!("failed to configure the download client: {error}"),
            )
        })?;

    let response = client.get(url).send().await.map_err(|error| {
        SessionDownloadError::new(
            "network",
            None,
            format!("failed to start the session download: {error}"),
        )
    })?;
    let status = response.status();
    if status == reqwest::StatusCode::CONFLICT {
        return Err(SessionDownloadError::new(
            "session_active",
            Some(status.as_u16()),
            "the session is still recording and cannot be downloaded yet",
        ));
    }
    if !status.is_success() {
        return Err(SessionDownloadError::new(
            "http_status",
            Some(status.as_u16()),
            format!("session download failed with HTTP {status}"),
        ));
    }

    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|error| {
            SessionDownloadError::filesystem("failed to create the download directory", error)
        })?;
    let (partial_path, mut file) = create_partial_file(directory, session_id).await?;

    let result = async {
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                SessionDownloadError::new(
                    "network",
                    None,
                    format!("session download was interrupted: {error}"),
                )
            })?;
            file.write_all(&chunk).await.map_err(|error| {
                SessionDownloadError::filesystem("failed to write the session archive", error)
            })?;
        }
        file.flush().await.map_err(|error| {
            SessionDownloadError::filesystem("failed to flush the session archive", error)
        })?;
        file.sync_all().await.map_err(|error| {
            SessionDownloadError::filesystem("failed to sync the session archive", error)
        })?;
        drop(file);

        let final_path = promote_without_clobbering(&partial_path, directory, session_id).await?;
        if let Err(error) = tokio::fs::remove_file(&partial_path).await {
            eprintln!(
                "[Sessions] Download completed at {}, but partial link cleanup failed: {}",
                final_path.display(),
                error
            );
        }
        Ok(final_path)
    }
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(&partial_path).await;
    }
    result
}

#[tauri::command]
async fn download_session_zip(session_id: String) -> Result<String, SessionDownloadError> {
    validate_session_id(&session_id)?;

    let server = IP_ADDRESS
        .lock()
        .map_err(|error| {
            SessionDownloadError::new(
                "state",
                None,
                format!("failed to read the configured server: {error}"),
            )
        })?
        .clone();
    if server.is_empty() {
        return Err(SessionDownloadError::new(
            "server_not_configured",
            None,
            "configure a server before downloading a session",
        ));
    }
    
    let directory = sessions_dir();

    let _download_guard = SessionDownloadGuard::acquire()?;
    let path = download_session_zip_to(&server, 8000, &session_id, &directory).await?;

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
                .title(format!("HELM — Screen {}", i + 1))
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
            set_server_session_lock,
            start_recording,
            stop_recording,
            local_recording_active,
            telemetry_raw::update_control_states,
            download_session_zip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;

    async fn serve_once(response: Vec<u8>) -> (String, u16, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            let _ = socket.read(&mut request).await;
            socket.write_all(&response).await.unwrap();
            socket.shutdown().await.unwrap();
        });
        ("127.0.0.1".to_string(), address.port(), task)
    }

    #[test]
    fn validates_session_ids_before_building_urls() {
        assert!(validate_session_id("2026-08-10_143005_hot-fire-3").is_ok());
        for invalid in ["", "../escape", "has space", "percent%2fslash", "x.zip"] {
            let error = validate_session_id(invalid).unwrap_err();
            assert_eq!(error.kind, "invalid_session_id");
            assert_eq!(error.status, None);
        }
    }

    #[test]
    fn download_error_has_a_stable_serialized_shape() {
        let error = SessionDownloadError::new("session_active", Some(409), "still recording");
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({
                "kind": "session_active",
                "status": 409,
                "message": "still recording",
            })
        );
    }

    #[test]
    fn only_one_process_wide_download_guard_can_be_held() {
        let first = SessionDownloadGuard::acquire().unwrap();
        let error = SessionDownloadGuard::acquire().unwrap_err();
        assert_eq!(error.kind, "download_in_progress");
        drop(first);
        assert!(SessionDownloadGuard::acquire().is_ok());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn active_server_session_locks_the_process_wide_server_ip() {
        *IP_ADDRESS.lock().unwrap() = "127.0.0.1".to_string();
        set_server_session_lock(Some("session-1".to_string())).unwrap();

        let error = submit_ip("192.168.1.10".to_string()).await.unwrap_err();
        assert!(error.contains("session-1"));
        assert_eq!(server_ip(), "127.0.0.1");

        set_server_session_lock(None).unwrap();
        submit_ip("192.168.1.10".to_string()).await.unwrap();
        assert_eq!(server_ip(), "192.168.1.10");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn copy_promotion_fallback_is_no_clobber() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.part");
        let existing = directory.path().join("existing.zip");
        let destination = directory.path().join("destination.zip");
        tokio::fs::write(&source, b"new archive").await.unwrap();
        tokio::fs::write(&existing, b"existing archive").await.unwrap();

        assert!(!copy_without_clobbering(&source, &existing).await.unwrap());
        assert_eq!(tokio::fs::read(&existing).await.unwrap(), b"existing archive");
        assert!(copy_without_clobbering(&source, &destination).await.unwrap());
        assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"new archive");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn streams_chunked_downloads_without_content_length() {
        let response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\nPK\x03\x04\r\n3\r\nzip\r\n0\r\n\r\n".to_vec();
        let (server, port, task) = serve_once(response).await;
        let directory = tempfile::tempdir().unwrap();

        let path = download_session_zip_to(
            &server,
            port,
            "2026-08-10_143005_hot-fire-3",
            directory.path(),
        )
        .await
        .unwrap();

        task.await.unwrap();
        assert_eq!(tokio::fs::read(path).await.unwrap(), b"PK\x03\x04zip");
        assert!(std::fs::read_dir(directory.path())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".part")));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn maps_conflict_and_does_not_follow_redirects() {
        let directory = tempfile::tempdir().unwrap();
        let conflict =
            b"HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec();
        let (server, port, task) = serve_once(conflict).await;
        let error = download_session_zip_to(&server, port, "session-1", directory.path())
            .await
            .unwrap_err();
        task.await.unwrap();
        assert_eq!(error.kind, "session_active");
        assert_eq!(error.status, Some(409));

        let redirect = b"HTTP/1.1 302 Found\r\nLocation: /unexpected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec();
        let (server, port, task) = serve_once(redirect).await;
        let error = download_session_zip_to(&server, port, "session-1", directory.path())
            .await
            .unwrap_err();
        task.await.unwrap();
        assert_eq!(error.kind, "http_status");
        assert_eq!(error.status, Some(302));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn preserves_existing_zip_and_uses_a_numbered_name() {
        let response =
            b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nnew".to_vec();
        let (server, port, task) = serve_once(response).await;
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("session-1.zip");
        std::fs::write(&original, b"old").unwrap();

        let path = download_session_zip_to(&server, port, "session-1", directory.path())
            .await
            .unwrap();

        task.await.unwrap();
        assert_eq!(std::fs::read(original).unwrap(), b"old");
        assert_eq!(path.file_name().unwrap(), "session-1-2.zip");
        assert_eq!(std::fs::read(path).unwrap(), b"new");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn removes_partial_file_after_an_interrupted_response() {
        let response =
            b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nshort".to_vec();
        let (server, port, task) = serve_once(response).await;
        let directory = tempfile::tempdir().unwrap();

        let error = download_session_zip_to(&server, port, "session-1", directory.path())
            .await
            .unwrap_err();

        task.await.unwrap();
        assert_eq!(error.kind, "network");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

}
