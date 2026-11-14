//! rustflix: a native streaming app — a GPUI window hosting the NSH (TSX)
//! interface in `app/`, built by `build.rs`.
//!
//! The shell is deliberately thin: `run_app` opens a native GPUI window
//! for the bundle and nsh's engine runs the whole interface (navigation,
//! TMDB client, library storage, the WebView/Video player). The host
//! only chooses the window and serves `nsh/base`.

use std::path::{Path, PathBuf};

use nsh_engine::HostChannel;
use nsh_platform_gpui::{AppOptions, AppSource, AssetBase, Bundle};

mod dl;
mod appkit;
mod webguard;
mod perf;
mod player;
mod stream;

/// The bundle to run: an explicit argument (a `.nshc` or its directory),
/// else `Contents/Resources/nsh` when running inside `rustflix.app`, else
/// `app/` as `build.rs` built it.
fn bundle_path() -> PathBuf {
    if let Some(arg) = std::env::args_os().skip(1).map(PathBuf::from).next() {
        return if arg.is_dir() { arg.join("bundle.nshc") } else { arg };
    }
    if let Ok(exe) = std::env::current_exe() {
        // <App>.app/Contents/MacOS/rustflix -> <App>.app/Contents/Resources/nsh
        if let Some(resources) = exe
            .parent()
            .and_then(|macos| macos.parent())
            .map(|contents| contents.join("Resources").join("nsh"))
        {
            let bundled = resources.join("bundle.nshc");
            if bundled.is_file() {
                return bundled;
            }
        }
    }
    let path = Path::new(env!("OUT_DIR")).join("app");
    if path.is_dir() {
        path.join("bundle.nshc")
    } else {
        path
    }
}

fn main() -> std::process::ExitCode {
    // env_logger, with the engine's `nsh::perf` lines going to the perf
    // recorder (src/perf.rs) instead of stderr.
    perf::init_logging();

    // SAFETY: the bundle is this app's own build output (`build.rs`), or
    // one its developer names, the same trust as the app's resources.
    let path = bundle_path();
    let bundle = match unsafe { Bundle::read_trusted(&path) } {
        Ok(bundle) => bundle,
        Err(err) => {
            log::error!("cannot read {}: {err}", path.display());
            return std::process::ExitCode::FAILURE;
        }
    };
    let app_id = "com.hexuria.rustflix".to_owned();
    // The engine names the app's cache directory by the bundle's id
    // (`nsh.json` "id", `App::app_id`), so the storage handlers do too.
    let host = HostChannel::new();
    let id = bundle.app_id.clone().unwrap_or_else(|| app_id.clone());
    cache::register(&host, &id);
    files::register(&host);
    // The built-in downloader behind `dl.*` (no external program).
    dl::register(&host, &id);
    // The native player spike: the streaming proxy (`dl.stream.*`) and
    // `sys.nativePlayers`.
    stream::register(&host);
    player::register_host(&host);
    appkit::register(&host);
    // Ad blocking in the web views (before any is made).
    webguard::register(&host);
    // The FPS monitor (⌘⇧F) and the perf recorder (`rustflix.perf`).
    perf::register(
        &host,
        nsh_engine::data_dir().map(|d| d.join(nsh_engine::app_dir_name(Some(id.as_str())))),
    );
    let options = AppOptions {
        asset_base: path
            .parent()
            .map(|dir| AssetBase::Directory(dir.join("assets"))),
        app_id,
        title: "rustflix".to_owned(),
        size: (1440, 900),
        host,
        // The engine's per-commit timings (`nsh::perf` lines), which the
        // perf monitor reads; dropped at the logger while it is off.
        trace: true,
        ..AppOptions::default()
    };
    // The native player spike's component (`rustflix.video`).
    player::register(&options.components);
    // `run_app`, with the FPS monitor's panel over the app's view.
    let code = perf::run(AppSource::Bundle(bundle), options);
    // Quit: the transfers stop cleanly (their files stay; the next launch
    // resumes them). Where the platform exits inside `run_app`, the same
    // happens from an `atexit` hook.
    dl::shutdown();
    code
}

/// `cache.info` / `cache.clear` (`host.call` in `app/lib/cache.ts`, gated by
/// capabilities.host "cache.*"): the sizes of the app's caches and clearing
/// them. Only the app's own directories, named by its id, are ever read or
/// emptied:
///
/// - images: `<Caches>/<id>/images`, NSH's image disk cache (the engine's
///   `CacheOptions::dir`: `cache_dir()` + `app_dir_name(id)` + "images").
///   Safe to empty while it runs: a missing entry is a miss.
/// - web: `~/Library/Caches/<id>/WebKit`, WebKit's network cache.
/// - site: `~/Library/WebKit/<id>/WebsiteData`, the video sites' cookies,
///   local storage and databases.
///
/// WebKit names its directories by the process's bundle identifier. In the
/// packaged app that is `<id>`, the web views' live data store: web and
/// site go through `WKWebsiteDataStore`, so they apply at once. Anywhere
/// else (`cargo run`: WebKit's directories are named by the executable)
/// the live store is not `<id>`'s and is left alone; the `<id>` directories
/// are emptied on disk instead, which a running packaged app sees once it
/// relaunches.
mod cache {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::Duration,
    };

    use nsh_engine::{HostCall, HostChannel, JsonValue};
    use serde_json::json;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum What {
        Images,
        Web,
        Site,
    }

    impl What {
        fn parse(data: &JsonValue) -> Option<What> {
            match data.get("what")?.as_str()? {
                "images" => Some(What::Images),
                "web" => Some(What::Web),
                "site" => Some(What::Site),
                _ => None,
            }
        }
    }

    /// The app's cache directories; `None` where it keeps none.
    #[derive(Clone, Debug)]
    pub(crate) struct Paths {
        pub(crate) app_id: String,
        pub(crate) images: Option<PathBuf>,
        pub(crate) web: Option<PathBuf>,
        pub(crate) site: Option<PathBuf>,
    }

    impl Paths {
        /// The directories of app `id` under home directory `home`, as the
        /// engine and WebKit name them on `os`. An id that names no
        /// directory of its own (`app_dir_name` would make it "default")
        /// gets none.
        pub(crate) fn new(id: &str, os: &str, env: impl Fn(&str) -> Option<PathBuf>) -> Paths {
            let env = |name: &str| env(name).filter(|v| !v.as_os_str().is_empty());
            let own = nsh_engine::app_dir_name(Some(id)) == id;
            let home = env("HOME");
            // The engine's `storage::cache_dir`.
            let caches = match os {
                "macos" => home.as_ref().map(|h| h.join("Library/Caches")),
                "windows" => env("LOCALAPPDATA"),
                _ => env("XDG_CACHE_HOME").or_else(|| home.as_ref().map(|h| h.join(".cache"))),
            };
            let mac_home = home.filter(|_| own && os == "macos");
            Paths {
                app_id: id.to_owned(),
                images: caches.filter(|_| own).map(|c| c.join(id).join("images")),
                web: mac_home
                    .as_ref()
                    .map(|h| h.join("Library/Caches").join(id).join("WebKit")),
                site: mac_home.map(|h| h.join("Library/WebKit").join(id).join("WebsiteData")),
            }
        }

        fn of(&self, what: What) -> Option<&Path> {
            match what {
                What::Images => self.images.as_deref(),
                What::Web => self.web.as_deref(),
                What::Site => self.site.as_deref(),
            }
        }
    }

    /// Bytes of the files under `dir` (symlinks not followed); 0 when it is
    /// missing or unreadable.
    pub(crate) fn dir_size(dir: &Path) -> u64 {
        let Ok(entries) = fs::read_dir(dir) else {
            return 0;
        };
        entries
            .flatten()
            .map(|entry| match entry.path().symlink_metadata() {
                Ok(meta) if meta.is_dir() => dir_size(&entry.path()),
                Ok(meta) => meta.len(),
                Err(_) => 0,
            })
            .sum()
    }

    /// Deletes what `dir` holds, keeping `dir`; what cannot be deleted
    /// stays. Returns the bytes freed.
    pub(crate) fn clear_dir(dir: &Path) -> u64 {
        let before = dir_size(dir);
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                // A symlink is removed itself, never what it points at.
                let _ = match path.symlink_metadata() {
                    Ok(meta) if meta.is_dir() => fs::remove_dir_all(&path),
                    Ok(_) => fs::remove_file(&path),
                    Err(_) => continue,
                };
            }
        }
        before.saturating_sub(dir_size(dir))
    }

    fn size(path: Option<&Path>) -> u64 {
        path.map_or(0, dir_size)
    }

    pub(crate) fn info(paths: &Paths) -> JsonValue {
        json!({
            "images": size(paths.images.as_deref()),
            "web": size(paths.web.as_deref()),
            "site": size(paths.site.as_deref()),
        })
    }

    pub(crate) fn clear(paths: &Paths, what: What) -> u64 {
        let Some(dir) = paths.of(what) else {
            return 0;
        };
        if what != What::Images {
            let before = dir_size(dir);
            if webkit::remove(&paths.app_id, what == What::Site) {
                return before.saturating_sub(dir_size(dir));
            }
        }
        clear_dir(dir)
    }

    /// Answers `call` from a thread of its own: handlers must return at once
    /// and the walks take a while. A panic drops the call, failing it in the
    /// app, which `cache.ts` reads as zeros.
    fn answer(call: HostCall, work: impl FnOnce(&JsonValue) -> JsonValue + Send + 'static) {
        let spawned = std::thread::Builder::new()
            .name("rustflix-cache".to_owned())
            .spawn(move || {
                let value = work(call.data());
                call.resolve(value);
            });
        if let Err(err) = spawned {
            log::warn!("cache: no thread for the call: {err}");
        }
    }

    pub(crate) fn register(host: &HostChannel, app_id: &str) {
        let paths = Paths::new(app_id, std::env::consts::OS, |name| {
            std::env::var_os(name).map(PathBuf::from)
        });
        log::debug!("cache: {paths:?}");
        let p = paths.clone();
        host.handle("cache.info", move |call| {
            let p = p.clone();
            answer(call, move |_| info(&p));
        });
        host.handle("cache.clear", move |call| {
            let p = paths.clone();
            answer(call, move |data| {
                let freed = What::parse(data).map_or(0, |what| clear(&p, what));
                json!({ "freed": freed })
            });
        });
    }

    /// The web views' data store (`WKWebsiteDataStore.default()`), when it is
    /// the app id's: the process's bundle identifier is the id.
    #[cfg(target_os = "macos")]
    mod webkit {
        use std::{sync::mpsc, time::Duration};

        use block2::RcBlock;
        use objc2::MainThreadMarker;
        use objc2_foundation::{NSBundle, NSDate, NSSet, NSString};
        use objc2_web_kit::{
            WKWebsiteDataStore, WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeFetchCache,
            WKWebsiteDataTypeMemoryCache, WKWebsiteDataTypeOfflineWebApplicationCache,
        };

        /// How long a removal may take before the walk measures anyway.
        const WAIT: Duration = Duration::from_secs(30);

        /// Removes the web caches (`all`: every kind of website data) from
        /// the live data store, waiting for WebKit to finish. False when the
        /// live store is not the app id's, or it did not answer in time.
        pub(super) fn remove(app_id: &str, all: bool) -> bool {
            let ours = NSBundle::mainBundle()
                .bundleIdentifier()
                .is_some_and(|id| id.to_string() == app_id);
            if !ours {
                return false;
            }
            let (tx, rx) = mpsc::channel::<()>();
            dispatch2::DispatchQueue::main().exec_async(move || {
                let Some(mtm) = MainThreadMarker::new() else {
                    return;
                };
                // SAFETY: on the main thread (`mtm`); the statics are
                // WebKit's constant strings; the block lives until WebKit
                // calls it (it retains it).
                unsafe {
                    let store = WKWebsiteDataStore::defaultDataStore(mtm);
                    let types = if all {
                        WKWebsiteDataStore::allWebsiteDataTypes(mtm)
                    } else {
                        NSSet::<NSString>::from_slice(&[
                            WKWebsiteDataTypeDiskCache,
                            WKWebsiteDataTypeMemoryCache,
                            WKWebsiteDataTypeFetchCache,
                            WKWebsiteDataTypeOfflineWebApplicationCache,
                        ])
                    };
                    let done = RcBlock::new(move || {
                        let _ = tx.send(());
                    });
                    store.removeDataOfTypes_modifiedSince_completionHandler(
                        &types,
                        &NSDate::distantPast(),
                        &done,
                    );
                }
            });
            match rx.recv_timeout(WAIT) {
                Ok(()) => {
                    // WebKit's processes finish deleting files after it answers.
                    std::thread::sleep(super::SETTLE);
                    true
                }
                Err(_) => {
                    log::warn!("cache: WebKit did not finish removing website data");
                    false
                }
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    mod webkit {
        pub(super) fn remove(_app_id: &str, _all: bool) -> bool {
            false
        }
    }

    /// A moment for WebKit's processes to let go of what they deleted.
    const SETTLE: Duration = Duration::from_millis(300);

    #[cfg(test)]
    mod tests {
        use super::*;

        fn temp(name: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("rustflix-cache-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            dir
        }

        #[test]
        fn sizes_and_clears_a_directory_keeping_it() {
            let dir = temp("clear");
            fs::write(dir.join("a"), vec![0u8; 1000]).unwrap();
            fs::create_dir_all(dir.join("sub/deeper")).unwrap();
            fs::write(dir.join("sub/b"), vec![0u8; 200]).unwrap();
            fs::write(dir.join("sub/deeper/c"), vec![0u8; 30]).unwrap();
            assert_eq!(dir_size(&dir), 1230);
            assert_eq!(clear_dir(&dir), 1230);
            assert!(dir.is_dir());
            assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
            assert_eq!(dir_size(&dir), 0);
            fs::remove_dir_all(&dir).unwrap();
        }

        #[cfg(unix)]
        #[test]
        fn never_follows_symlinks_out() {
            let dir = temp("link");
            let outside = temp("outside");
            fs::write(outside.join("keep"), vec![0u8; 500]).unwrap();
            std::os::unix::fs::symlink(&outside, dir.join("out")).unwrap();
            fs::write(dir.join("x"), vec![0u8; 10]).unwrap();
            assert_eq!(dir_size(&dir), 10 + fs::symlink_metadata(dir.join("out")).unwrap().len());
            clear_dir(&dir);
            assert!(outside.join("keep").is_file());
            assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
            fs::remove_dir_all(&dir).unwrap();
            fs::remove_dir_all(&outside).unwrap();
        }

        #[test]
        fn missing_directories_are_zero() {
            let gone = std::env::temp_dir().join("rustflix-cache-does-not-exist");
            assert_eq!(dir_size(&gone), 0);
            assert_eq!(clear_dir(&gone), 0);
            let paths = Paths {
                app_id: "x".into(),
                images: Some(gone),
                web: None,
                site: None,
            };
            assert_eq!(info(&paths), json!({ "images": 0, "web": 0, "site": 0 }));
            assert_eq!(clear(&paths, What::Web), 0);
        }

        #[test]
        fn paths_are_the_app_ids_own() {
            let env = |name: &str| (name == "HOME").then(|| PathBuf::from("/Users/a"));
            let p = Paths::new("com.hexuria.rustflix", "macos", env);
            assert_eq!(
                p.images.unwrap(),
                Path::new("/Users/a/Library/Caches/com.hexuria.rustflix/images")
            );
            assert_eq!(
                p.web.unwrap(),
                Path::new("/Users/a/Library/Caches/com.hexuria.rustflix/WebKit")
            );
            assert_eq!(
                p.site.unwrap(),
                Path::new("/Users/a/Library/WebKit/com.hexuria.rustflix/WebsiteData")
            );
            for bad in ["", ".", "..", "a/b", "../rustflix"] {
                let p = Paths::new(bad, "macos", env);
                assert!(p.images.is_none() && p.web.is_none() && p.site.is_none(), "{bad}");
            }
            let linux = Paths::new("com.hexuria.rustflix", "linux", env);
            assert!(linux.web.is_none() && linux.site.is_none());
            let none = Paths::new("com.hexuria.rustflix", "macos", |_| None);
            assert!(none.images.is_none() && none.web.is_none());
        }

        #[test]
        fn bad_input_frees_nothing() {
            for data in [json!(null), json!({}), json!({ "what": 3 }), json!({ "what": "all" })] {
                assert_eq!(What::parse(&data), None);
            }
            assert_eq!(What::parse(&json!({ "what": "site" })), Some(What::Site));
        }
    }
}

/// `fs.space` / `fs.trash` / `fs.reveal` / `fs.size` (`host.call` in
/// `app/lib/downloads.ts`, gated by capabilities.host "fs.*"): the desktop
/// download folder's free space, moving finished downloads to the Trash,
/// showing one in Finder, and file sizes.
///
/// `fs.trash` and `fs.reveal` only act on paths inside the download folder
/// the app passes as `dir` ([`inside`]): no `..`, no symlinked folder on
/// the way, the entry itself never followed. `fs.trash` takes files and
/// symlinks, and folders only when they are a download record's own
/// folder ([`record_folder`]: a direct child of `dir` carrying the
/// record's marker file) — never any other folder.
mod files {
    use std::{
        fs,
        path::{Component, Path, PathBuf},
    };

    use nsh_engine::{HostCall, HostChannel, JsonValue};
    use serde_json::json;

    /// `path` as an entry of folder `dir` (canonical `dir` + the rest), when
    /// it is one: both absolute, `path` below `dir` (as given or
    /// canonical), no `.`/`..`, every folder between them a real folder
    /// (not a symlink), and the entry present (not followed).
    pub(crate) fn inside(dir: &Path, path: &Path) -> Option<PathBuf> {
        if !dir.is_absolute() || !path.is_absolute() {
            return None;
        }
        if path
            .components()
            .chain(dir.components())
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        {
            return None;
        }
        let canon = fs::canonicalize(dir).ok()?;
        if !canon.is_dir() {
            return None;
        }
        let rest = path
            .strip_prefix(dir)
            .or_else(|_| path.strip_prefix(&canon))
            .ok()?;
        let parts: Vec<_> = rest.components().collect();
        let (last, folders) = parts.split_last()?;
        let mut cur = canon;
        for part in folders {
            let Component::Normal(name) = part else {
                return None;
            };
            cur.push(name);
            let meta = fs::symlink_metadata(&cur).ok()?;
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return None;
            }
        }
        let Component::Normal(name) = last else {
            return None;
        };
        cur.push(name);
        fs::symlink_metadata(&cur).ok()?;
        Some(cur)
    }

    /// The nearest existing folder at or above `path`.
    pub(crate) fn existing_parent(path: &Path) -> Option<PathBuf> {
        let mut cur = Some(path);
        while let Some(p) = cur {
            if p.is_dir() {
                return Some(p.to_path_buf());
            }
            cur = p.parent();
        }
        None
    }

    /// Bytes free (for this user) on the volume holding `path` (or its
    /// nearest existing parent).
    pub(crate) fn free_space(path: &Path) -> Option<u64> {
        let dir = existing_parent(path)?;
        statvfs_free(&dir)
    }

    #[cfg(unix)]
    fn statvfs_free(dir: &Path) -> Option<u64> {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let c = CString::new(dir.as_os_str().as_bytes()).ok()?;
        let mut st = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
        // SAFETY: `c` is a NUL-terminated path; `st` is written by statvfs
        // and only read when it succeeded.
        let rc = unsafe { libc::statvfs(c.as_ptr(), st.as_mut_ptr()) };
        if rc != 0 {
            return None;
        }
        // SAFETY: statvfs returned 0, so `st` is initialised.
        let st = unsafe { st.assume_init() };
        #[allow(clippy::unnecessary_cast)]
        Some((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
    }

    #[cfg(not(unix))]
    fn statvfs_free(_dir: &Path) -> Option<u64> {
        None
    }

    /// Sizes of `paths` (symlinks not followed; 0 when missing).
    pub(crate) fn sizes(paths: &[PathBuf]) -> Vec<u64> {
        paths
            .iter()
            .map(|p| match fs::symlink_metadata(p) {
                Ok(meta) if meta.is_file() => meta.len(),
                _ => 0,
            })
            .collect()
    }

    /// The paths of `data[key]` (strings only).
    fn paths(data: &JsonValue, key: &str) -> Vec<PathBuf> {
        data.get(key)
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str()).map(PathBuf::from).collect())
            .unwrap_or_default()
    }

    fn path(data: &JsonValue, key: &str) -> Option<PathBuf> {
        data.get(key)?.as_str().filter(|s| !s.is_empty()).map(PathBuf::from)
    }

    /// `folder` as a download record's folder in `dir`, when it is one: a
    /// direct child of `dir` ([`inside`]), a real folder (not a symlink),
    /// holding the record marker (a plain file) — naming record `id` when
    /// given.
    pub(crate) fn record_folder(dir: &Path, folder: &Path, id: Option<u64>) -> Option<PathBuf> {
        let p = inside(dir, folder)?;
        let canon_dir = fs::canonicalize(dir).ok()?;
        if p.parent()? != canon_dir {
            return None;
        }
        let meta = fs::symlink_metadata(&p).ok()?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return None;
        }
        let named = crate::dl::store::marker_id(&p)?;
        if id.is_some_and(|id| id != named) {
            return None;
        }
        Some(p)
    }

    /// The trashable entries of `list` inside `dir`: files and symlinks,
    /// and download record folders ([`record_folder`]).
    pub(crate) fn trashable(dir: &Path, list: &[PathBuf]) -> Vec<PathBuf> {
        list.iter()
            .filter_map(|p| {
                let e = inside(dir, p)?;
                match fs::symlink_metadata(&e) {
                    Ok(m) if !m.is_dir() => Some(e),
                    Ok(_) => record_folder(dir, p, None),
                    Err(_) => None,
                }
            })
            .collect()
    }

    /// Moves record `id`'s folder (a direct child of `dir`) to the Trash.
    pub(crate) fn trash_record_folder(dir: &Path, folder: &Path, id: Option<u64>) -> bool {
        match record_folder(dir, folder, id) {
            Some(p) => {
                let ok = os::trash(&p);
                if !ok {
                    log::warn!("dl: could not move {} to the Trash", p.display());
                }
                ok
            }
            None => false,
        }
    }

    /// Shows `path` in Finder (the downloader checked it is a record's).
    pub(crate) fn reveal_path(path: &Path) -> bool {
        os::reveal(path)
    }

    pub(crate) fn trash(data: &JsonValue) -> JsonValue {
        let Some(dir) = path(data, "dir") else {
            return json!({ "trashed": 0 });
        };
        let mut n = 0;
        for p in trashable(&dir, &paths(data, "paths")) {
            if os::trash(&p) {
                n += 1;
            } else {
                log::warn!("fs.trash: could not move {} to the Trash", p.display());
            }
        }
        json!({ "trashed": n })
    }

    pub(crate) fn reveal(data: &JsonValue) -> JsonValue {
        let (Some(dir), Some(p)) = (path(data, "dir"), path(data, "path")) else {
            return json!({ "ok": false });
        };
        let target = if p == dir {
            fs::canonicalize(&dir).ok().filter(|d| d.is_dir())
        } else {
            inside(&dir, &p)
        };
        let Some(target) = target else {
            return json!({ "ok": false });
        };
        json!({ "ok": os::reveal(&target) })
    }

    #[cfg(target_os = "macos")]
    mod os {
        use std::path::Path;

        use objc2_foundation::{NSFileManager, NSString, NSURL};

        /// NSFileManager's trashItemAtURL (Finder's "Move to Trash",
        /// collision-safe names included).
        pub(super) fn trash(path: &Path) -> bool {
            let Some(s) = path.to_str() else { return false };
            let url = NSURL::fileURLWithPath(&NSString::from_str(s));
            NSFileManager::defaultManager()
                .trashItemAtURL_resultingItemURL_error(&url, None)
                .is_ok()
        }

        pub(super) fn reveal(path: &Path) -> bool {
            std::process::Command::new("/usr/bin/open")
                .arg("-R")
                .arg(path)
                .spawn()
                .is_ok()
        }
    }

    #[cfg(not(target_os = "macos"))]
    mod os {
        use std::path::Path;

        /// No Trash API here: the file (or record folder) is deleted.
        pub(super) fn trash(path: &Path) -> bool {
            match std::fs::symlink_metadata(path) {
                Ok(m) if m.is_dir() => std::fs::remove_dir_all(path).is_ok(),
                Ok(_) => std::fs::remove_file(path).is_ok(),
                Err(_) => false,
            }
        }

        pub(super) fn reveal(path: &Path) -> bool {
            #[cfg(windows)]
            let r = std::process::Command::new("explorer")
                .arg(format!("/select,{}", path.display()))
                .spawn();
            #[cfg(not(windows))]
            let r = std::process::Command::new("xdg-open")
                .arg(path.parent().unwrap_or(path))
                .spawn();
            r.is_ok()
        }
    }

    /// Answers `call` from a thread of its own (the walks and Finder may
    /// take a moment).
    fn answer(call: HostCall, work: impl FnOnce(&JsonValue) -> JsonValue + Send + 'static) {
        let spawned = std::thread::Builder::new()
            .name("rustflix-fs".to_owned())
            .spawn(move || {
                let value = work(call.data());
                call.resolve(value);
            });
        if let Err(err) = spawned {
            log::warn!("fs: no thread for the call: {err}");
        }
    }

    pub(crate) fn register(host: &HostChannel) {
        host.handle("fs.space", |call| {
            answer(call, |data| {
                let free = path(data, "path").and_then(|p| free_space(&p));
                json!({ "free": free })
            });
        });
        host.handle("fs.size", |call| {
            answer(call, |data| json!({ "sizes": sizes(&paths(data, "paths")) }));
        });
        host.handle("fs.trash", |call| answer(call, trash));
        host.handle("fs.reveal", |call| answer(call, reveal));
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn temp(name: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("rustflix-fs-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            fs::canonicalize(&dir).unwrap()
        }

        #[test]
        fn accepts_only_entries_inside_the_folder() {
            let dir = temp("inside");
            fs::write(dir.join("a.mp4"), b"x").unwrap();
            fs::create_dir_all(dir.join("sub")).unwrap();
            fs::write(dir.join("sub/b.json"), b"y").unwrap();
            assert_eq!(inside(&dir, &dir.join("a.mp4")), Some(dir.join("a.mp4")));
            assert_eq!(inside(&dir, &dir.join("sub/b.json")), Some(dir.join("sub/b.json")));
            // Missing, the folder itself, outside, relative, dot-dot.
            assert_eq!(inside(&dir, &dir.join("missing.mp4")), None);
            assert_eq!(inside(&dir, &dir), None);
            assert_eq!(inside(&dir, Path::new("/etc/hosts")), None);
            assert_eq!(inside(&dir, Path::new("a.mp4")), None);
            assert_eq!(inside(&dir, &dir.join("sub/../a.mp4")), None);
            assert_eq!(inside(&dir, &dir.join("../x")), None);
            // A sibling folder whose name starts with the folder's.
            let sib = PathBuf::from(format!("{}-other", dir.display()));
            fs::create_dir_all(&sib).unwrap();
            fs::write(sib.join("c"), b"z").unwrap();
            assert_eq!(inside(&dir, &sib.join("c")), None);
            fs::remove_dir_all(&sib).unwrap();
            fs::remove_dir_all(&dir).unwrap();
        }

        #[cfg(unix)]
        #[test]
        fn never_follows_symlinks() {
            let dir = temp("links");
            let outside = temp("links-outside");
            fs::write(outside.join("keep"), b"secret").unwrap();
            std::os::unix::fs::symlink(&outside, dir.join("out")).unwrap();
            std::os::unix::fs::symlink(outside.join("keep"), dir.join("link.mp4")).unwrap();
            // Through a symlinked folder: refused.
            assert_eq!(inside(&dir, &dir.join("out/keep")), None);
            // The link itself is an entry of the folder (trashing moves the
            // link, never its target), and a symlinked folder is never
            // trashable as a folder.
            assert_eq!(inside(&dir, &dir.join("link.mp4")), Some(dir.join("link.mp4")));
            let t = trashable(&dir, &[dir.join("link.mp4"), dir.join("out/keep"), outside.join("keep")]);
            assert_eq!(t, vec![dir.join("link.mp4")]);
            // Sizes do not follow links either.
            assert_eq!(sizes(&[dir.join("link.mp4")]), vec![0]);
            fs::remove_dir_all(&dir).unwrap();
            fs::remove_dir_all(&outside).unwrap();
        }

        #[test]
        fn only_record_folders_are_trashable() {
            let dir = temp("folders");
            fs::create_dir_all(dir.join("season 1")).unwrap();
            fs::write(dir.join("e1.mp4"), b"1").unwrap();
            // A record folder: a direct child with the marker.
            fs::create_dir_all(dir.join("Movie")).unwrap();
            fs::write(dir.join("Movie/.rustflix-download"), b"{\"id\":4}").unwrap();
            // Nested record folder: not a direct child.
            fs::create_dir_all(dir.join("season 1/Deep")).unwrap();
            fs::write(dir.join("season 1/Deep/.rustflix-download"), b"{\"id\":5}").unwrap();
            // A marker that is a folder / a symlink does not count.
            fs::create_dir_all(dir.join("Fake/.rustflix-download")).unwrap();
            let t = trashable(
                &dir,
                &[dir.join("season 1"), dir.join("e1.mp4"), dir.join("Movie"), dir.join("season 1/Deep"), dir.join("Fake")],
            );
            assert_eq!(t, vec![dir.join("e1.mp4"), dir.join("Movie")]);
            assert_eq!(record_folder(&dir, &dir.join("Movie"), Some(4)), Some(dir.join("Movie")));
            assert_eq!(record_folder(&dir, &dir.join("Movie"), Some(9)), None);
            assert_eq!(record_folder(&dir, &dir, None), None);
            assert!(!trash_record_folder(&dir, &dir.join("season 1"), None));
            assert!(!trash_record_folder(&dir, &dir.join("Movie"), Some(9)));
            #[cfg(unix)]
            {
                let outside = temp("folders-outside");
                fs::write(outside.join(".rustflix-download"), b"{\"id\":6}").unwrap();
                std::os::unix::fs::symlink(&outside, dir.join("Linked")).unwrap();
                assert_eq!(record_folder(&dir, &dir.join("Linked"), Some(6)), None);
                assert!(outside.join(".rustflix-download").exists());
                fs::remove_dir_all(&outside).unwrap();
            }
            assert_eq!(trash(&json!({ "paths": [dir.join("e1.mp4")] })), json!({ "trashed": 0 }));
            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn sizes_and_space() {
            let dir = temp("sizes");
            fs::write(dir.join("a"), vec![0u8; 1234]).unwrap();
            assert_eq!(sizes(&[dir.join("a"), dir.join("missing"), dir.clone()]), vec![1234, 0, 0]);
            let free = free_space(&dir).unwrap();
            assert!(free > 0);
            // A folder that does not exist yet: its nearest parent's volume.
            let later = dir.join("not/yet/made");
            assert_eq!(existing_parent(&later), Some(dir.clone()));
            assert!(free_space(&later).is_some());
            assert_eq!(paths(&json!({ "paths": ["/a", 3, "/b"] }), "paths"), vec![PathBuf::from("/a"), PathBuf::from("/b")]);
            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn reveal_refuses_outside_paths() {
            let dir = temp("reveal");
            assert_eq!(reveal(&json!({ "dir": dir, "path": "/etc/hosts" })), json!({ "ok": false }));
            assert_eq!(reveal(&json!({ "path": "/etc/hosts" })), json!({ "ok": false }));
            fs::remove_dir_all(&dir).unwrap();
        }
    }
}
