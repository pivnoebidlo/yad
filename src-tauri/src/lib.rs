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

/// `.yad.yaml` for a compared path: look in its folder and up, stopping at
/// the repository root (a folder with `.git`). Returns (path, contents).
#[tauri::command]
fn find_config(path: String) -> Option<(String, String)> {
    let p = PathBuf::from(&path);
    let mut dir = if p.is_dir() { Some(p.as_path()) } else { p.parent() };
    while let Some(d) = dir {
        let cfg = d.join(".yad.yaml");
        if cfg.is_file() {
            let text = std::fs::read_to_string(&cfg).ok()?;
            return Some((cfg.to_string_lossy().into_owned(), text));
        }
        if d.join(".git").exists() {
            return None;
        }
        dir = d.parent();
    }
    None
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
        // Symlinked files count (`git difftool -d` links the working tree files);
        // symlinked folders are not followed, so a link loop cannot hang the walk.
        let is_file = ft.is_file() || (ft.is_symlink() && std::fs::metadata(&path).is_ok_and(|m| m.is_file()));
        if ft.is_dir() {
            walk(root, &path, out)?;
        } else if is_file && is_manifest(&path) {
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

// ---- rendering Kustomize overlays and Helm charts ----------------------------

/// "kustomize" or "helm" when `dir` is such a project.
#[tauri::command]
fn project_kind(dir: String) -> Option<&'static str> {
    let d = Path::new(&dir);
    if ["kustomization.yaml", "kustomization.yml", "Kustomization"].iter().any(|f| d.join(f).is_file()) {
        Some("kustomize")
    } else if d.join("Chart.yaml").is_file() {
        Some("helm")
    } else {
        None
    }
}

/// A tool from PATH or the usual install locations: apps started from the
/// Finder get a minimal PATH without Homebrew.
fn find_tool(name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin", "/home/linuxbrew/.linuxbrew/bin"] {
        dirs.push(PathBuf::from(d));
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        dirs.extend([home.join(".local/bin"), home.join("bin"), home.join("go/bin")]);
    }
    dirs.into_iter().map(|d| d.join(&exe)).find(|p| p.is_file())
}

/// Release name for `helm template`: the chart's own name, so two copies of a
/// chart (stage/prod) render with the same resource names.
fn chart_name(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("Chart.yaml"))
        .ok()
        .and_then(|t| {
            t.lines()
                .find_map(|l| l.strip_prefix("name:"))
                .map(|v| v.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
        })
        .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .unwrap_or_else(|| "release".into())
}

fn run_render(tool: &str, dir: &str, values: &[String]) -> Result<String, String> {
    let mut cmd = match tool {
        "kustomize" => {
            if let Some(k) = find_tool("kustomize") {
                let mut c = std::process::Command::new(k);
                c.arg("build").arg(dir);
                c
            } else if let Some(k) = find_tool("kubectl") {
                let mut c = std::process::Command::new(k);
                c.arg("kustomize").arg(dir);
                c
            } else {
                return Err("kustomize not found (neither kustomize nor kubectl is installed)".into());
            }
        }
        "helm" => {
            let h = find_tool("helm").ok_or("helm not found")?;
            let mut c = std::process::Command::new(h);
            c.arg("template").arg(chart_name(Path::new(dir))).arg(dir);
            for v in values {
                c.arg("-f").arg(v);
            }
            c
        }
        _ => return Err(format!("unknown tool {tool}")),
    };
    let out = cmd.current_dir(dir).output().map_err(|e| format!("{tool}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(format!("{tool}: {}", err.trim()))
    }
}

/// Output of `kustomize build <dir>` or `helm template <chart> <dir> -f …`.
#[tauri::command]
async fn render(tool: String, dir: String, values: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_render(&tool, &dir, &values))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chart_name_from_chart_yaml() {
        let d = std::env::temp_dir().join(format!("yad-chart-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("Chart.yaml"), "apiVersion: v2\nname: \"shop-api\"\nversion: 1.0.0\n").unwrap();
        assert_eq!(chart_name(&d), "shop-api");
        assert_eq!(project_kind(d.to_string_lossy().into()), Some("helm"));
        std::fs::write(d.join("Chart.yaml"), "name: Bad Name\n").unwrap();
        assert_eq!(chart_name(&d), "release");
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn list_files_follows_file_symlinks_only() {
        let d = std::env::temp_dir().join(format!("yad-walk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::write(d.join("real.yaml"), "a: 1\n").unwrap();
        std::os::unix::fs::symlink(d.join("real.yaml"), d.join("sub/link.yaml")).unwrap();
        std::os::unix::fs::symlink(&d, d.join("sub/loop")).unwrap();
        let files = list_files(d.to_string_lossy().into()).unwrap();
        assert_eq!(files, vec!["real.yaml", "sub/link.yaml"]);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn find_config_stops_at_repo_root() {
        let d = std::env::temp_dir().join(format!("yad-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("repo/.git")).unwrap();
        std::fs::create_dir_all(d.join("repo/k8s/prod")).unwrap();
        std::fs::write(d.join("repo/k8s/prod/a.yaml"), "a: 1\n").unwrap();
        std::fs::write(d.join(".yad.yaml"), "outside: true\n").unwrap();
        let file = d.join("repo/k8s/prod/a.yaml").to_string_lossy().into_owned();
        assert_eq!(find_config(file.clone()), None, "must not look above the repository");
        std::fs::write(d.join("repo/.yad.yaml"), "crossNamespace: false\n").unwrap();
        let (path, text) = find_config(file).unwrap();
        assert!(path.ends_with("repo/.yad.yaml"));
        assert_eq!(text, "crossNamespace: false\n");
        assert!(find_config(d.join("repo/k8s").to_string_lossy().into()).is_some());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn merge_args_need_four_paths() {
        let v = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let got = parse_merge_args(&v(&["--merge", "/b", "/l", "/r", "/m"])).unwrap();
        assert_eq!(got.len(), 4);
        assert!(got[3].ends_with("m"));
        assert_eq!(parse_merge_args(&v(&["--merge", "/b", "/l"])), None);
        assert_eq!(parse_merge_args(&v(&["/a", "/b"])), None);
    }
}

/// Paths passed on the command line (`yad left.yaml right.yaml`),
/// resolved to absolute paths. Flags (starting with `-`) are ignored,
/// which also skips macOS `-psn_*` launch arguments.
#[tauri::command]
fn initial_paths() -> Vec<String> {
    std::env::args().skip(1).filter(|a| !a.starts_with('-')).take(2).map(|a| absolute(&a)).collect()
}

fn absolute(a: &str) -> String {
    let p = PathBuf::from(a);
    let abs = if p.is_absolute() { p } else { std::env::current_dir().unwrap_or_default().join(p) };
    abs.canonicalize().unwrap_or(abs).to_string_lossy().into_owned()
}

/// `yad --merge BASE LOCAL REMOTE MERGED` (git mergetool): the four paths, absolute.
fn parse_merge_args(args: &[String]) -> Option<Vec<String>> {
    let i = args.iter().position(|a| a == "--merge")?;
    let rest: Vec<String> = args[i + 1..].iter().take(4).map(|a| absolute(a)).collect();
    (rest.len() == 4).then_some(rest)
}

#[tauri::command]
fn merge_args() -> Option<Vec<String>> {
    parse_merge_args(&std::env::args().skip(1).collect::<Vec<_>>())
}

/// Quit with an exit code: git mergetool reads it (0 = merged, 1 = not).
#[tauri::command]
fn exit_app(app: tauri::AppHandle, code: i32) {
    app.exit(code);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Seamless window: on Windows the frame is drawn by the app itself
            // (the top bar is the drag region, the window controls are its own
            // buttons). macOS uses `titleBarStyle: "Overlay"` from the config
            // (native traffic lights over the content); Linux keeps the native
            // frame for now.
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_decorations(false);
                }
            }
            #[cfg(not(target_os = "windows"))]
            let _ = app; // the setup above only exists on Windows
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![read_text, write_text, path_kind, list_files, file_stamps, project_kind, render, initial_paths, merge_args, exit_app, find_config])
        .run(tauri::generate_context!())
        .expect("error while running yad");
}
