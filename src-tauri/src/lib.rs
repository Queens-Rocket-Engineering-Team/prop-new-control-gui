// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::string::String;
use std::sync::{LazyLock, Mutex};
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

static IP_ADDRESS: Mutex<String> = Mutex::new(String::new());

// Default camera recording directory set to Videos folder, can be changed
static CAMERA_RECORDING_DIR: LazyLock<Mutex<String>> = LazyLock::new(|| {
    let default_dir = dirs::video_dir()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    Mutex::new(default_dir)
});

#[tauri::command]
// returns the current ip address
async fn fetch_server_ip() -> String {
    let gaurded_ip = IP_ADDRESS.lock().unwrap();
    gaurded_ip.to_string()
}


#[tauri::command]
//stores the inputted string in IP_ADDRESS for later use
async fn submit_ip(new_ip: String) {
    let mut gaurded_ip = IP_ADDRESS.lock().unwrap();
    println!("New IP Submitted: {}", new_ip);
    *gaurded_ip = String::from(new_ip);
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

fn recording_path(filename: &str) -> Result<PathBuf, String> {
    let videos_dir = PathBuf::from(CAMERA_RECORDING_DIR.lock().unwrap().to_string());
    fs::create_dir_all(&videos_dir).map_err(|e| e.to_string())?;
    Ok(videos_dir.join(filename))
}

#[tauri::command]
async fn init_recording_file(filename: String) -> Result<String, String> {
    let path = recording_path(&filename)?;
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn append_recording_chunk(filename: String, data: Vec<u8>) -> Result<(), String> {
    let path = recording_path(&filename)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    file.write_all(&data).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
// Saves the camera recording data to a file in the specified camera recording directory
async fn save_recording(data: Vec<u8>, filename: String) -> Result<String, String> {
    let path = recording_path(&filename)?;
    fs::write(&path, &data).map_err(|e| e.to_string())?;
    let saved_path = path.to_string_lossy().to_string();
    println!("Recording saved: {} ({} bytes)", saved_path, data.len());
    Ok(saved_path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![fetch_server_ip, submit_ip, fetch_camera_recording_dir, set_camera_recording_dir, init_recording_file, append_recording_chunk, save_recording])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
