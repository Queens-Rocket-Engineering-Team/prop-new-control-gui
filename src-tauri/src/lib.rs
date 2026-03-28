use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::string::String;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::BOOL;
#[cfg(target_os = "windows")]
use windows::Win32::Media::Audio::{eCapture, eCommunications, Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator, MMDeviceEnumerator};
#[cfg(target_os = "windows")]
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED};

static IP_ADDRESS: Mutex<String> = Mutex::new(String::new());
static VOICE_WINDOW_PRESENT: Mutex<bool> = Mutex::new(false);
static VOICE_PTT_HELD: Mutex<bool> = Mutex::new(false);
#[allow(dead_code)]
static VOICE_PTT_SEQUENCE: Mutex<u64> = Mutex::new(0);
static VOICE_LAST_PRESS_AT: LazyLock<Mutex<Option<Instant>>> = LazyLock::new(|| Mutex::new(None));

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn GetAsyncKeyState(vkey: i32) -> i16;
}

#[cfg(target_os = "windows")]
fn is_alt_v_physically_held() -> bool {
    const VK_MENU: i32 = 0x12; // Alt
    const VK_V: i32 = 0x56;    // V
    const KEY_DOWN_MASK: i16 = i16::MIN;
    unsafe {
        let alt_down = (GetAsyncKeyState(VK_MENU) & KEY_DOWN_MASK) != 0;
        let v_down = (GetAsyncKeyState(VK_V) & KEY_DOWN_MASK) != 0;
        alt_down && v_down
    }
}

#[cfg(target_os = "windows")]
fn set_system_mic_muted(muted: bool) -> Result<(), String> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| e.to_string())?;

        let result = (|| {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;

            let device = enumerator
                .GetDefaultAudioEndpoint(eCapture, eCommunications)
                .map_err(|e| e.to_string())?;

            let endpoint: IAudioEndpointVolume =
                device.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())?;

            endpoint
                .SetMute(BOOL::from(muted), std::ptr::null())
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        })();

        CoUninitialize();
        result
    }
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

#[tauri::command]
async fn fetch_ptt_state() -> bool {
    #[cfg(target_os = "windows")]
    {
        is_alt_v_physically_held()
    }

    #[cfg(not(target_os = "windows"))]
    {
        *VOICE_PTT_HELD.lock().unwrap()
    }
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
    pending:        Vec<(f64, HashMap<String, f64>, HashMap<String, u8>, HashMap<String, u8>, HashMap<String, u8>)>,
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
    for (_, batch, valve_states, auxiliary_states, kasa_states) in &recorder.pending {
        seen.extend(batch.keys().cloned());
        seen_valves.extend(valve_states.keys().cloned());
        seen_aux.extend(auxiliary_states.keys().cloned());
        seen_kasa.extend(kasa_states.keys().cloned());
    }
    let columns: Vec<String> = seen.into_iter().collect();
    let valve_columns: Vec<String> = seen_valves.into_iter().collect();
    let auxiliary_columns: Vec<String> = seen_aux.into_iter().collect();
    let kasa_columns: Vec<String> = seen_kasa.into_iter().collect();

    // Write header
    let sensor_header = columns.join(",");
    let valve_header = valve_columns
        .iter()
        .map(|name| format!("valve_{}", name))
        .collect::<Vec<_>>()
        .join(",");
    let auxiliary_header = auxiliary_columns
        .iter()
        .map(|name| format!("aux_{}", name))
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
        "device_timestamp\n".to_string()
    } else {
        format!("device_timestamp,{}\n", header_tail)
    };
    recorder.writer.write_all(header.as_bytes())?;

    // Write all buffered rows — use std::mem::take to avoid borrow conflicts
    let pending = std::mem::take(&mut recorder.pending);
    for (ts, batch, valve_states, auxiliary_states, kasa_states) in &pending {
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
            format!("{:.4}\n", ts)
        } else {
            format!("{:.4},{}\n", ts, row_tail)
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
    auxiliary_states: Option<HashMap<String, u8>>,
    kasa_states: Option<HashMap<String, u8>>,
) -> Result<(), String> {
    let mut guard = RECORDER.lock().map_err(|e| e.to_string())?;
    let recorder  = match guard.as_mut() {
        Some(r) => r,
        None    => return Ok(()),  // no recording in progress — silently skip
    };

    let valve_states = valve_states.unwrap_or_default();
    let auxiliary_states = auxiliary_states.unwrap_or_default();
    let kasa_states = kasa_states.unwrap_or_default();

    if !recorder.header_written {
        recorder.pending.push((timestamp, readings, valve_states, auxiliary_states, kasa_states));

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

#[tauri::command]
async fn save_audio_recording_file(filename: String, data: Vec<u8>) -> Result<String, String> {
    let mut safe_name = PathBuf::from(filename)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("audio_recording.opus")
        .replace(['/', '\\', '\0'], "_");

    if Path::new(&safe_name).extension().is_none() {
        safe_name.push_str(".opus");
    }

    let audio_dir = data_dir().join("audio");
    fs::create_dir_all(&audio_dir).map_err(|e| e.to_string())?;

    let path = audio_dir.join(safe_name);
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    file.write_all(&data).map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

#[allow(dead_code)]
fn dispatch_voice_ptt(app: &tauri::AppHandle, pressed: bool) {
        let pressed_literal = if pressed { "true" } else { "false" };
        let sequence = {
            let mut guard = VOICE_PTT_SEQUENCE.lock().unwrap();
            *guard += 1;
            *guard
        };
        let script = r#"
(() => {
    const desiredPressed = __PRESSED__;
    const seq = __SEQ__;

    if (!window.__qretVoicePtt) {
        window.__qretVoicePtt = {
            desiredPressed: false,
            seq: 0,
            desiredChangedAt: 0,
            lastReleaseAt: 0,
            lastServerSyncAt: 0,
            serverSyncInFlight: false,
            configured: false,
            lastConfigAttemptAt: 0,
            timer: null,
        };
    }

    const state = window.__qretVoicePtt;

    const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };

    const firstVisible = (selectors, root = document) => {
        for (const selector of selectors) {
            const nodes = Array.from(root.querySelectorAll(selector));
            const found = nodes.find(isVisible);
            if (found) return found;
        }
        return null;
    };

    const setSelfTalk = (pressed, forceServer = false) => {
        const ui = window.mumbleUi;
        if (!ui || typeof ui.thisUser !== 'function') return false;

        const self = ui.thisUser();
        if (!self) return false;

        const now = Date.now();
        const shouldBeMuted = !pressed;
        const shouldSyncServer = forceServer || (now - state.lastServerSyncAt > 320);

        // Apply local state immediately so hold feels responsive.
        if (pressed) {
            if (typeof ui.requestUnmute === 'function') ui.requestUnmute(self);
            if (typeof ui.selfMute === 'function') ui.selfMute(false);
        } else {
            if (typeof ui.requestMute === 'function') ui.requestMute(self);
            if (typeof ui.selfMute === 'function') ui.selfMute(true);
        }

        if (!shouldSyncServer || state.serverSyncInFlight) {
            return true;
        }

        if (ui.client && typeof ui.client.setSelfMute === 'function') {
            state.lastServerSyncAt = now;
            try {
                const res = ui.client.setSelfMute(shouldBeMuted);
                if (res && typeof res.then === 'function') {
                    state.serverSyncInFlight = true;
                    res.finally(() => { state.serverSyncInFlight = false; });
                }
            } catch (_e) {
                state.serverSyncInFlight = false;
                return false;
            }
            return true;
        }

        return true;
    };

    const getMuteState = () => {
        const ui = window.mumbleUi;
        if (!ui || typeof ui.selfMute !== 'function' || typeof ui.thisUser !== 'function') return null;
        try {
            const self = ui.thisUser();
            const localMuted = !!ui.selfMute();
            const serverMuted = self && typeof self.mute === 'function' ? !!self.mute() : localMuted;
            return { localMuted, serverMuted };
        } catch (_e) {
            return null;
        }
    };

    const configureMumblePtt = () => {
        if (state.configured) return;

        const now = Date.now();
        if (now - state.lastConfigAttemptAt < 300) return;
        state.lastConfigAttemptAt = now;

        try {
            localStorage.setItem('mumble.voiceMode', 'cont');
        } catch (_e) {
            // Ignore storage failures; we'll still try runtime settings.
        }

        const ui = window.mumbleUi;
        if (ui && ui.settings) {
            ui.settings.voiceMode = 'cont';
            if (typeof ui.settings.save === 'function') {
                ui.settings.save();
            }
            if (typeof ui._updateVoiceHandler === 'function') {
                ui._updateVoiceHandler();
            }
            if (typeof ui.closeSettings === 'function') {
                ui.closeSettings();
            }

            // Start muted and let global keybind control unmute/mute transitions.
            setSelfTalk(false, true);
            state.configured = true;
            return;
        }

        // If UI API is not ready yet, keep retrying until it is.
    };

    const reconcile = () => {
        configureMumblePtt();

        const muteState = getMuteState();
        if (muteState == null) return;

        const shouldBeMuted = !state.desiredPressed;
        const localMismatch = muteState.localMuted !== shouldBeMuted;
        const serverMismatch = muteState.serverMuted !== shouldBeMuted;

        // Server is authoritative. Retry with higher urgency right after edge transitions.
        const changedRecently = Date.now() - state.desiredChangedAt < 450;
        if (serverMismatch) {
            setSelfTalk(state.desiredPressed, changedRecently);
        }

        // Mirror local UI only after server has the expected state.
        if (localMismatch) {
            if (!serverMismatch) {
                const ui = window.mumbleUi;
                if (ui && typeof ui.selfMute === 'function') {
                    ui.selfMute(shouldBeMuted);
                }
            }
        }

        // Release watchdog: periodically re-emit keyup to avoid sticky pressed state.
        if (!state.desiredPressed && Date.now() - state.lastReleaseAt > 900) {
            setSelfTalk(false, false);
            state.lastReleaseAt = Date.now();
        }
    };

    if (seq >= state.seq) {
        const changed = state.desiredPressed !== desiredPressed;
        state.seq = seq;
        state.desiredPressed = desiredPressed;
        if (changed) state.desiredChangedAt = Date.now();
        if (!desiredPressed) state.lastReleaseAt = Date.now();
    }

    if (!state.timer) {
        state.timer = setInterval(reconcile, 80);
    }

    reconcile();
})();
"#
    .replace("__PRESSED__", pressed_literal)
    .replace("__SEQ__", &sequence.to_string());

        if let Some(voice_window) = app.get_webview_window("voice-client") {
            let _ = voice_window.eval(&script);
        }
}

fn dispatch_voice_autoconnect(app: &tauri::AppHandle) {
    let script = r#"
(() => {
    const desiredUsername = 'Control';

    const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };

    const setInputValue = (input, value) => {
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) {
            setter.call(input, value);
        } else {
            input.value = value;
        }
        input.setAttribute('value', value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'l' }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'l' }));
    };

    const firstVisible = (selectors, root = document) => {
        for (const selector of selectors) {
            const nodes = Array.from(root.querySelectorAll(selector));
            const found = nodes.find(isVisible);
            if (found) return found;
        }
        return null;
    };

    const dialog = document.querySelector('.connect-dialog.dialog');
    const usernameInput = firstVisible([
        '#username',
        'input[name="username"]',
        '.connect-dialog input[type="text"]'
    ]) || document.querySelector('#username, input[name="username"], .connect-dialog input[type="text"]');

    if (!usernameInput) return;

    if (usernameInput.value !== desiredUsername) {
        setInputValue(usernameInput, desiredUsername);
    }

    if (!dialog || !isVisible(dialog)) return;

    if (usernameInput.value.trim() !== desiredUsername) {
        setInputValue(usernameInput, desiredUsername);
    }

    const connectBtn = firstVisible([
        '#connect-dialog_controls_connect',
        '.connect-dialog input.dialog-submit[type="submit"][value="Connect"]',
        '.connect-dialog input[type="submit"][value="Connect"]',
        '.connect-dialog button.dialog-submit[type="submit"]',
        '.connect-dialog button[type="submit"]'
    ]) || document.querySelector('#connect-dialog_controls_connect, .connect-dialog input[type="submit"], .connect-dialog button[type="submit"]');

    const form = dialog.querySelector('form') || usernameInput.closest('form');

    if (connectBtn && !connectBtn.disabled && isVisible(connectBtn)) {
        connectBtn.click();
        return;
    }

    if (form && usernameInput.value.trim() === desiredUsername) {
        if (typeof form.requestSubmit === 'function') {
            form.requestSubmit(connectBtn || undefined);
        } else {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            if (typeof form.submit === 'function') form.submit();
        }
    }
})();
"#;

    if let Some(voice_window) = app.get_webview_window("voice-client") {
        let _ = voice_window.eval(script);
    }
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::ShortcutState;

                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_shortcuts(["alt+v"])?
                        .with_handler(|_app, _shortcut, event| {
                            match event.state {
                                ShortcutState::Pressed => {
                                    if *VOICE_PTT_HELD.lock().unwrap() {
                                        return;
                                    }
                                    *VOICE_LAST_PRESS_AT.lock().unwrap() = Some(Instant::now());
                                    *VOICE_PTT_HELD.lock().unwrap() = true;
                                    #[cfg(target_os = "windows")]
                                    {
                                        if let Err(err) = set_system_mic_muted(false) {
                                            eprintln!("[Voice] Failed to unmute system mic: {}", err);
                                        }
                                    }
                                }
                                ShortcutState::Released => {
                                    if !*VOICE_PTT_HELD.lock().unwrap() {
                                        return;
                                    }
                                    // Guard against spurious quick-release events from OS/global shortcut handling.
                                    let ignore_release = VOICE_LAST_PRESS_AT
                                        .lock()
                                        .unwrap()
                                        .map(|t| t.elapsed() < Duration::from_millis(120))
                                        .unwrap_or(false);
                                    if ignore_release {
                                        return;
                                    }
                                    *VOICE_PTT_HELD.lock().unwrap() = false;
                                    #[cfg(target_os = "windows")]
                                    {
                                        if let Err(err) = set_system_mic_muted(true) {
                                            eprintln!("[Voice] Failed to mute system mic: {}", err);
                                        }
                                    }
                                }
                            }
                        })
                        .build(),
                )?;
                println!("[Voice] Global push-to-talk shortcut registered: Alt+V");

                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    loop {
                        let has_voice_window = app_handle.get_webview_window("voice-client").is_some();
                        let mut startup_mute = false;
                        {
                            let mut was_present = VOICE_WINDOW_PRESENT.lock().unwrap();
                            if has_voice_window && !*was_present {
                                *was_present = true;
                                *VOICE_PTT_HELD.lock().unwrap() = false;
                                startup_mute = true;
                            } else if !has_voice_window && *was_present {
                                *was_present = false;
                                *VOICE_PTT_HELD.lock().unwrap() = false;
                            }
                        }

                        if startup_mute {
                            #[cfg(target_os = "windows")]
                            {
                                if let Err(err) = set_system_mic_muted(true) {
                                    eprintln!("[Voice] Failed to apply startup system mute: {}", err);
                                }
                            }
                        }

                        #[cfg(target_os = "windows")]
                        {
                            let physically_held = is_alt_v_physically_held();
                            let mut held = VOICE_PTT_HELD.lock().unwrap();
                            if *held != physically_held {
                                *held = physically_held;
                                if let Err(err) = set_system_mic_muted(!physically_held) {
                                    eprintln!("[Voice] Failed to reconcile system mic mute: {}", err);
                                }
                            }
                        }

                        dispatch_voice_autoconnect(&app_handle);

                        std::thread::sleep(Duration::from_millis(160));
                    }
                });
                println!("[Voice] Auto-connect loop active (username: Control)");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fetch_server_ip,
            fetch_ptt_state,
            submit_ip,
            start_recording,
            write_sensor_batch,
            stop_recording,
            fetch_camera_recording_dir,
            set_camera_recording_dir,
            init_camera_recording_file,
            append_camera_recording_chunk,
            save_audio_recording_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
