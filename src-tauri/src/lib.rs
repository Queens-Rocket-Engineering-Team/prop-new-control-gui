use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::string::String;

// ── Persisted IP ─────────────────────────────────────────────────────────────

static IP_ADDRESS: Mutex<String> = Mutex::new(String::new());

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
    write_count:    u32,
    /// Batches accumulated before the header is written
    pending:        Vec<(f64, HashMap<String, f64>)>,
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
    for (_, batch) in &recorder.pending {
        seen.extend(batch.keys().cloned());
    }
    let columns: Vec<String> = seen.into_iter().collect();

    // Write header
    let header = format!("device_timestamp,{}\n", columns.join(","));
    recorder.writer.write_all(header.as_bytes())?;

    // Write all buffered rows — use std::mem::take to avoid borrow conflicts
    let pending = std::mem::take(&mut recorder.pending);
    for (ts, batch) in &pending {
        let vals: Vec<String> = columns.iter()
            .map(|c| batch.get(c).map(|v| format!("{:.4}", v)).unwrap_or_default())
            .collect();
        recorder.writer.write_all(format!("{:.4},{}\n", ts, vals.join(",")).as_bytes())?;
    }

    recorder.writer.flush()?;
    recorder.columns        = columns;
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
fn write_sensor_batch(timestamp: f64, readings: HashMap<String, f64>) -> Result<(), String> {
    let mut guard = RECORDER.lock().map_err(|e| e.to_string())?;
    let recorder  = match guard.as_mut() {
        Some(r) => r,
        None    => return Ok(()),  // no recording in progress — silently skip
    };

    if !recorder.header_written {
        recorder.pending.push((timestamp, readings));

        if recorder.pending.len() >= HEADER_BATCHES {
            flush_pending(recorder).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    // Header already written — append the row directly
    let row_values: Vec<String> = recorder.columns.iter()
        .map(|col| readings.get(col).map(|v| format!("{:.4}", v)).unwrap_or_default())
        .collect();

    let row = format!("{:.4},{}\n", timestamp, row_values.join(","));
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

// ── Tauri entry point ────────────────────────────────────────────────────────

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
