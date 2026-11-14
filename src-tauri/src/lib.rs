use std::path::PathBuf;

/// Read a text file. Errors are returned as strings to the frontend.
#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

/// Write a text file, replacing its contents.
#[tauri::command]
fn write_text(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

/// Paths passed on the command line (`yad left.yaml right.yaml`),
/// resolved to absolute paths. Flags (starting with `-`) are ignored,
/// which also skips macOS `-psn_*` launch arguments.
#[tauri::command]
fn initial_paths() -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .take(2)
        .map(|a| {
            let p = PathBuf::from(&a);
            let abs = if p.is_absolute() { p } else { cwd.join(p) };
            abs.canonicalize().unwrap_or(abs).to_string_lossy().into_owned()
        })
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_text, write_text, initial_paths])
        .run(tauri::generate_context!())
        .expect("error while running yad");
}
