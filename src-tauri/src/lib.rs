use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};
use tauri::{ipc::Request, ipc::Response, AppHandle, Emitter, Manager, State};

#[derive(Serialize)]
struct Entry {
    rel: String,
    size: u64,
    mtime: u64,
}

#[derive(Serialize, Default)]
struct Scan {
    dirs: Vec<String>,
    files: Vec<Entry>,
}

fn mtime(m: &fs::Metadata) -> u64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

fn walk(root: &Path, dir: &Path, out: &mut Scan) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.starts_with('$') {
            continue;
        }
        let p = e.path();
        let rel = p
            .strip_prefix(root)
            .unwrap_or(&p)
            .to_string_lossy()
            .replace('\\', "/");
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            out.dirs.push(rel);
            walk(root, &p, out);
        } else if ft.is_file() && name.to_lowercase().ends_with(".pdf") {
            if let Ok(m) = e.metadata() {
                out.files.push(Entry { rel, size: m.len(), mtime: mtime(&m) });
            }
        }
    }
}

/// Every folder and PDF under `root`, as '/'-separated relative paths. Dotfiles are skipped.
#[tauri::command]
fn scan(root: String) -> Result<Scan, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err("folder not found".into());
    }
    let mut out = Scan::default();
    walk(&root, &root, &mut out);
    Ok(out)
}

#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    fs::read(path).map(Response::new).map_err(|e| e.to_string())
}

fn header(req: &Request, key: &str) -> Result<String, String> {
    let v = req
        .headers()
        .get(key)
        .and_then(|v| v.to_str().ok())
        .ok_or(format!("missing {key}"))?;
    urlencoding_decode(v)
}

fn urlencoding_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let h = u8::from_str_radix(&s[i + 1..i + 3], 16).map_err(|e| e.to_string())?;
            out.push(h);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

/// Atomically replaces a PDF (temp file + rename). The first time a file is
/// written, its untouched original is copied to <app data>/originals/<backup>.
#[tauri::command]
fn write_pdf(app: AppHandle, req: Request) -> Result<u64, String> {
    let tauri::ipc::InvokeBody::Raw(data) = req.body() else {
        return Err("expected raw bytes".into());
    };
    let path = PathBuf::from(header(&req, "path")?);
    let backup = header(&req, "backup")?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("originals");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let orig = dir.join(format!("{backup}.pdf"));
    if !orig.exists() {
        fs::copy(&path, &orig).map_err(|e| e.to_string())?;
    }
    let name = path.file_name().ok_or("bad path")?.to_string_lossy();
    let tmp = path.with_file_name(format!(".{name}.tbd-tmp"));
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("couldn't replace the file (is it open in another app?) {e}"));
    }
    Ok(fs::metadata(&path).map(|m| mtime(&m)).unwrap_or(0))
}

#[tauri::command]
fn move_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err("something with that name is already there".into());
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}

#[tauri::command]
fn make_dir(path: String) -> Result<(), String> {
    fs::create_dir(path).map_err(|e| e.to_string())
}

struct WatchState(Mutex<Option<RecommendedWatcher>>);

/// Emits "fs-change" whenever anything non-hidden under `root` changes.
#[tauri::command]
fn watch(app: AppHandle, state: State<WatchState>, root: String) -> Result<(), String> {
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        let visible = ev.paths.iter().any(|p| {
            !p.file_name()
                .map_or(false, |n| n.to_string_lossy().starts_with('.'))
        });
        if visible {
            let _ = app.emit("fs-change", ());
        }
    })
    .map_err(|e| e.to_string())?;
    w.watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(w);
    Ok(())
}

/// Replaces the app database with a backup. The frontend must close its
/// connection first and reload afterwards.
#[tauri::command]
fn restore_db(app: AppHandle, src: String) -> Result<(), String> {
    let db = app.path().app_config_dir().map_err(|e| e.to_string())?.join("tbd.db");
    for ext in ["-wal", "-shm"] {
        let _ = fs::remove_file(format!("{}{ext}", db.display()));
    }
    fs::copy(src, db).map(|_| ()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .manage(WatchState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            scan, read_file, write_pdf, move_path, make_dir, watch, restore_db
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
