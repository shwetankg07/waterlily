use notify::{
    event::{AccessKind, AccessMode},
    EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use serde::Serialize;
use std::{
    fs,
    io::{Read, Write},
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

/// Path relative to `root`, always '/'-separated (a '\' inside a Linux file name stays as is).
fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn walk(root: &Path, dir: &Path, out: &mut Scan) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.starts_with('$') {
            continue;
        }
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            out.dirs.push(rel_of(root, &p));
            walk(root, &p, out);
        } else if ft.is_file() && name.to_lowercase().ends_with(".pdf") {
            if let Ok(m) = e.metadata() {
                out.files.push(Entry { rel: rel_of(root, &p), size: m.len(), mtime: mtime(&m) });
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

/// Atomically replaces a PDF: write a temp file, flush it to disk, then rename over the
/// original. The first time a file is written, its untouched original is copied to
/// <app data>/originals/<backup>.pdf.
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
    let written = fs::File::create(&tmp).and_then(|mut f| {
        f.write_all(data)?;
        f.sync_all()
    });
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("couldn't replace the file (is it open in another app?) {e}"));
    }
    Ok(fs::metadata(&path).map(|m| mtime(&m)).unwrap_or(0))
}

/// Moves or renames. Never replaces a different file; a case-only rename of the same
/// file ("notes.pdf" -> "Notes.pdf", which Windows sees as one name) is allowed.
#[tauri::command]
fn move_path(from: String, to: String) -> Result<(), String> {
    let (f, t) = (Path::new(&from), Path::new(&to));
    if t.exists() {
        let same = match (fs::canonicalize(f), fs::canonicalize(t)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
        if !same {
            return Err("something with that name is already there".into());
        }
    }
    fs::rename(f, t).map_err(|e| e.to_string())
}

#[tauri::command]
fn make_dir(path: String) -> Result<(), String> {
    fs::create_dir(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => "a folder with that name is already there".into(),
        _ => e.to_string(),
    })
}

struct WatchState(Mutex<Option<RecommendedWatcher>>);

/// Emits "fs-change" whenever anything non-hidden under `root` changes. Plain reads
/// (the app opening PDFs) are ignored so they don't trigger rescans.
#[tauri::command]
fn watch(app: AppHandle, state: State<WatchState>, root: String) -> Result<(), String> {
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        if matches!(ev.kind, EventKind::Access(k) if k != AccessKind::Close(AccessMode::Write)) {
            return;
        }
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

fn is_sqlite(path: &Path) -> bool {
    let mut head = [0u8; 16];
    fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .map_or(false, |_| &head == b"SQLite format 3\0")
}

/// The backup dialog already asked about overwriting; clear the old file so
/// `VACUUM INTO` can write there. Refuses to delete anything that isn't a database.
#[tauri::command]
fn clear_backup_target(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(());
    }
    if !is_sqlite(p) {
        return Err("that file isn't a backup, so it wasn't replaced. Pick another name".into());
    }
    fs::remove_file(p).map_err(|e| e.to_string())
}

/// Replaces the app database with a backup. The frontend must close its connection
/// first and reload afterwards. The backup is checked before anything is touched.
#[tauri::command]
fn restore_db(app: AppHandle, src: String) -> Result<(), String> {
    if !is_sqlite(Path::new(&src)) {
        return Err("that file isn't a backup made by this app".into());
    }
    let db = app.path().app_config_dir().map_err(|e| e.to_string())?.join("tbd.db");
    let tmp = db.with_extension("db.restoring");
    fs::copy(&src, &tmp).map_err(|e| e.to_string())?;
    for ext in ["-wal", "-shm"] {
        let _ = fs::remove_file(format!("{}{ext}", db.display()));
    }
    fs::rename(&tmp, &db).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch (double-clicking the icon twice) focuses the open window instead.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .manage(WatchState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            scan,
            read_file,
            write_pdf,
            move_path,
            make_dir,
            watch,
            clear_backup_target,
            restore_db
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tbd-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn move_never_replaces_a_different_file() {
        let d = tmpdir("move");
        let (a, b) = (d.join("notes.pdf"), d.join("other.pdf"));
        fs::write(&a, "A").unwrap();
        fs::write(&b, "B").unwrap();
        let s = |p: &Path| p.to_string_lossy().to_string();
        assert!(move_path(s(&a), s(&b)).is_err());
        assert_eq!(fs::read_to_string(&b).unwrap(), "B");

        // Names differing only by case: a different file on case-sensitive disks must survive.
        let upper = d.join("Notes.pdf");
        fs::write(&upper, "U").unwrap();
        if fs::read_to_string(&a).unwrap() == "A" {
            assert!(move_path(s(&a), s(&upper)).is_err());
            assert_eq!(fs::read_to_string(&upper).unwrap(), "U");
        }

        // A plain rename and a case-only rename of the same file both work.
        assert!(move_path(s(&b), s(&d.join("renamed.pdf"))).is_ok());
        assert!(move_path(s(&d.join("renamed.pdf")), s(&d.join("Renamed.pdf"))).is_ok());
        assert_eq!(fs::read_to_string(d.join("Renamed.pdf")).unwrap(), "B");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn decodes_percent_encoded_paths() {
        assert_eq!(urlencoding_decode("C%3A%5CNotes%5C%E0%A4%A8%20a.pdf").unwrap(), "C:\\Notes\\न a.pdf");
        assert!(urlencoding_decode("%zz").is_err());
    }

    #[test]
    fn only_databases_count_as_backups() {
        let d = tmpdir("backup");
        let (db, txt) = (d.join("b.db"), d.join("notes.db"));
        fs::write(&db, b"SQLite format 3\0rest").unwrap();
        fs::write(&txt, "hello").unwrap();
        assert!(clear_backup_target(txt.to_string_lossy().into()).is_err());
        assert!(txt.exists());
        assert!(clear_backup_target(db.to_string_lossy().into()).is_ok());
        assert!(!db.exists());
        fs::remove_dir_all(&d).unwrap();
    }
}
