// ── Raw telemetry ingestion ────────────────────────────────────────────────
//
// Connects to the server's /ws/telemetry/raw websocket and feeds every batch
// straight into the CSV recorder (`crate::record_batch`). This runs entirely
// on the Rust side — the frontend never sees these messages — so it is only
// active for the lifetime of a recording (started in `start_recording`,
// stopped in `stop_recording`).
//
// Valve/auxiliary/kasa control-state bits aren't part of the raw batch
// message; the frontend derives them from /ws/state and pushes the latest
// snapshot via `update_control_states` whenever they change.

use futures_util::StreamExt;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::async_runtime::{self, JoinHandle};
use tokio_tungstenite::tungstenite::Message;

#[derive(Deserialize)]
struct RawBatchMsg {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(rename= "device_name")]
    source: String,
    timestamp_s: f64,
    readings: Vec<RawReading>,
}

#[derive(Deserialize)]
struct RawReading {
    sensor_name: String,
    value: f64,
    #[serde(default)]
    unit: String,
}

#[derive(Default)]
struct ControlStates {
    valve: HashMap<String, u8>,
    auxiliary: HashMap<String, u8>,
    kasa: HashMap<String, u8>,
}

static CONTROL_STATES: LazyLock<Mutex<ControlStates>> =
    LazyLock::new(|| Mutex::new(ControlStates::default()));
static TASK: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);

/// Called from the frontend whenever the derived valve/auxiliary/kasa state
/// bits change, so the raw-batch CSV rows can include the latest values.
#[tauri::command]
pub fn update_control_states(
    valve_states: HashMap<String, u8>,
    auxiliary_states: HashMap<String, u8>,
    kasa_states: HashMap<String, u8>,
) {
    let mut guard = CONTROL_STATES.lock().unwrap();
    guard.valve = valve_states;
    guard.auxiliary = auxiliary_states;
    guard.kasa = kasa_states;
}

fn control_states_snapshot() -> (HashMap<String, u8>, HashMap<String, u8>, HashMap<String, u8>) {
    let guard = CONTROL_STATES.lock().unwrap();
    (guard.valve.clone(), guard.auxiliary.clone(), guard.kasa.clone())
}

/// Start streaming /ws/telemetry/raw for the duration of a recording.
/// Idempotent — stops any previously running stream first.
pub(crate) fn start() {
    stop();
    let handle = async_runtime::spawn(run());
    *TASK.lock().unwrap() = Some(handle);
}

/// Stop the raw telemetry stream, if running.
pub(crate) fn stop() {
    if let Some(handle) = TASK.lock().unwrap().take() {
        handle.abort();
    }
}

async fn run() {
    let mut attempt: u32 = 0;
    loop {
        let ip = crate::server_ip();
        if ip.is_empty() {
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }
        let host = if ip == "localhost" { "127.0.0.1".to_string() } else { ip };
        let url = format!("ws://{}:8000/ws/telemetry/raw", host);

        match tokio_tungstenite::connect_async(&url).await {
            Ok((mut stream, _)) => {
                println!("[TelemetryRaw] connected to {}", url);
                attempt = 0;
                loop {
                    match stream.next().await {
                        Some(Ok(Message::Text(text))) => handle_message(&text),
                        Some(Ok(Message::Close(_))) | None => break,
                        Some(Ok(_)) => {} // ignore ping/pong/binary/frame
                        Some(Err(e)) => {
                            eprintln!("[TelemetryRaw] read error: {}", e);
                            break;
                        }
                    }
                }
                println!("[TelemetryRaw] disconnected");
            }
            Err(e) => {
                eprintln!("[TelemetryRaw] connect failed: {}", e);
            }
        }

        let delay_ms = (500u64.saturating_mul(1u64 << attempt.min(4))).min(5000);
        attempt += 1;
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
    }
}

fn handle_message(text: &str) {
    let msg: RawBatchMsg = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(_) => return,
    };
    if msg.msg_type != "telemetry.raw_batch" {
        return;
    }

    // `value` arrives already tared — the server owns tare offsets and applies
    // them before fan-out — so it is recorded as-is. Subtracting here again
    // would double-tare every reading.
    let mut readings = HashMap::with_capacity(msg.readings.len());
    for reading in msg.readings {
        if !reading.unit.is_empty() {
            crate::set_sensor_unit(&reading.sensor_name, &reading.unit);
        }
        readings.insert(reading.sensor_name, reading.value);
    }

    let (valve_states, auxiliary_states, kasa_states) = control_states_snapshot();
    let _ = crate::record_batch(msg.timestamp_s, msg.source, readings, valve_states, auxiliary_states, kasa_states);
}
