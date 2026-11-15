use std::path::{Path, PathBuf};

/// Read a text file. Errors are returned as strings to the frontend.
#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

/// Write a text file, replacing its contents. Missing parent directories
/// are created (a file copied into a directory that does not have it yet).
#[tauri::command]
fn write_text(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

/// "file", "dir" or "missing".
#[tauri::command]
fn path_kind(path: String) -> &'static str {
    match std::fs::metadata(&path) {
        Ok(m) if m.is_dir() => "dir",
        Ok(_) => "file",
        Err(_) => "missing",
    }
}

/// A cheap "has it changed" fingerprint per path (modification time and
/// size), or `None` for a path that does not exist / is not a file.
#[tauri::command]
fn file_stamps(paths: Vec<String>) -> Vec<Option<String>> {
    paths
        .iter()
        .map(|p| {
            let m = std::fs::metadata(p).ok().filter(|m| m.is_file())?;
            let t = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            Some(format!("{t}:{}", m.len()))
        })
        .collect()
}

const MAX_FILES: usize = 5000;

fn is_manifest(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("yaml" | "yml" | "json")
    )
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        let ft = entry.file_type()?;
        if ft.is_dir() {
            walk(root, &path, out)?;
        } else if ft.is_file() && is_manifest(&path) {
            if out.len() >= MAX_FILES {
                return Err(std::io::Error::other(format!("more than {MAX_FILES} files")));
            }
            let rel = path.strip_prefix(root).unwrap_or(&path);
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

/// YAML/JSON files under `root`, as sorted `/`-separated relative paths.
/// Hidden entries and `node_modules` are skipped.
#[tauri::command]
fn list_files(root: String) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    walk(Path::new(&root), Path::new(&root), &mut out).map_err(|e| format!("{root}: {e}"))?;
    out.sort();
    Ok(out)
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
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_text, write_text, path_kind, list_files, file_stamps, initial_paths])
        .run(tauri::generate_context!())
        .expect("error while running yad");
}
