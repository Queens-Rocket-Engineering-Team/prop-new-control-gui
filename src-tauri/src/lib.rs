use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::string::String;
use std::sync::{LazyLock, Mutex};

static IP_ADDRESS: Mutex<String> = Mutex::new(String::new());

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
    write_count:    u32,
    /// Batches accumulated before the header is written
    pending:        Vec<(f64, HashMap<String, f64>, HashMap<String, u8>)>,
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
    for (_, batch, valve_states) in &recorder.pending {
        seen.extend(batch.keys().cloned());
        seen_valves.extend(valve_states.keys().cloned());
    }
    let columns: Vec<String> = seen.into_iter().collect();
    let valve_columns: Vec<String> = seen_valves.into_iter().collect();

    // Write header
    let sensor_header = columns.join(",");
    let valve_header = valve_columns
        .iter()
        .map(|name| format!("valve_{}", name))
        .collect::<Vec<_>>()
        .join(",");

    let header_tail = match (sensor_header.is_empty(), valve_header.is_empty()) {
        (true, true) => String::new(),
        (false, true) => sensor_header,
        (true, false) => valve_header,
        (false, false) => format!("{},{}", sensor_header, valve_header),
    };

    let header = if header_tail.is_empty() {
        "device_timestamp\n".to_string()
    } else {
        format!("device_timestamp,{}\n", header_tail)
    };
    recorder.writer.write_all(header.as_bytes())?;

    // Write all buffered rows — use std::mem::take to avoid borrow conflicts
    let pending = std::mem::take(&mut recorder.pending);
    for (ts, batch, valve_states) in &pending {
        let sensor_vals: Vec<String> = columns.iter()
            .map(|c| batch.get(c).map(|v| format!("{:.4}", v)).unwrap_or_default())
            .collect();
        let valve_vals: Vec<String> = valve_columns
            .iter()
            .map(|c| valve_states.get(c).copied().unwrap_or(0).to_string())
            .collect();

        let row_tail = match (sensor_vals.is_empty(), valve_vals.is_empty()) {
            (true, true) => String::new(),
            (false, true) => sensor_vals.join(","),
            (true, false) => valve_vals.join(","),
            (false, false) => format!("{},{}", sensor_vals.join(","), valve_vals.join(",")),
        };

        let row = if row_tail.is_empty() {
            format!("{:.4}\n", ts)
        } else {
            format!("{:.4},{}\n", ts, row_tail)
        };

        recorder.writer.write_all(row.as_bytes())?;
    }

    recorder.writer.flush()?;
    recorder.columns        = columns;
    recorder.valve_columns  = valve_columns;
    recorder.header_written = true;
    recorder.write_count    = 0;
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
        write_count:    0,
        pending:        Vec::new(),
        header_written: false,
    });

    println!("[Recorder] started → {}", path.display());
    Ok(path.to_string_lossy().to_string())
}

/// Append one row of sensor readings.
/// For the first HEADER_BATCHES calls, data is buffered so that the full set of
/// sensor names can be determined before the header is written.  After that,
/// rows are written immediately and flushed every 10 writes.
#[tauri::command]
fn write_sensor_batch(
    timestamp: f64,
    readings: HashMap<String, f64>,
    valve_states: Option<HashMap<String, u8>>,
) -> Result<(), String> {
    let mut guard = RECORDER.lock().map_err(|e| e.to_string())?;
    let recorder  = match guard.as_mut() {
        Some(r) => r,
        None    => return Ok(()),  // no recording in progress — silently skip
    };

    let valve_states = valve_states.unwrap_or_default();

    if !recorder.header_written {
        recorder.pending.push((timestamp, readings, valve_states));

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

    let row_tail = match (sensor_values.is_empty(), valve_values.is_empty()) {
        (true, true) => String::new(),
        (false, true) => sensor_values.join(","),
        (true, false) => valve_values.join(","),
        (false, false) => format!("{},{}", sensor_values.join(","), valve_values.join(",")),
    };
    let row = if row_tail.is_empty() {
        format!("{:.4}\n", timestamp)
    } else {
        format!("{:.4},{}\n", timestamp, row_tail)
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
async fn init_camera_recording_file(filename: String) -> Result<String, String> {
    let path = camera_recording_path(&filename)?;
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn append_camera_recording_chunk(filename: String, data: Vec<u8>) -> Result<(), String> {
    let path = camera_recording_path(&filename)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    file.write_all(&data).map_err(|e| e.to_string())?;
    Ok(())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fetch_server_ip,
            submit_ip,
            start_recording,
            write_sensor_batch,
            stop_recording,
            fetch_camera_recording_dir,
            set_camera_recording_dir,
            init_camera_recording_file,
            append_camera_recording_chunk,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
