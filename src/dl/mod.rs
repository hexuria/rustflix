//! The desktop downloader behind `dl.*` (`host.call` in
//! `app/lib/downloads.ts`, gated by capabilities.host "dl.*") — the same
//! host API as the iPhone's native downloader (`ios/Rustflix/Downloads.swift`),
//! in-process: no external program, no helper server.
//!
//! - `dl.list` → records, newest first. Every change of a record is a
//!   `dl.event` with the same shape: at once on a status change, at most
//!   once a second for progress.
//! - `dl.start {url, name?, kind?, headers?, meta?, id?}` starts a record,
//!   or continues an unfinished one (optionally with a fresh link);
//!   `dl.cancel {id}` stops it keeping its files; `dl.remove {id}` stops it
//!   and moves its folder to the Trash.
//! - `dl.playUrl {id}` → the local player page of a finished download;
//!   `dl.reveal {id}` shows it in Finder.
//! - `dl.space`, `dl.nextId`, `dl.options {dir?}` (the download folder:
//!   moving every record folder when it changes), `dl.adopt` (files of the
//!   vid-dl era).
//!
//! Transfers ([`job`]) run on threads of their own. A record that is
//! `running` always has a job behind it: at launch, records left running
//! are resumed (or marked expired when their link has expired).

pub(crate) mod folder;
pub(crate) mod hls;
pub(crate) mod http;
mod job;
pub(crate) mod policy;
pub(crate) mod server;
pub(crate) mod store;

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use nsh_engine::{HostCall, HostChannel};
use serde_json::{Value, json};

use store::Record;

/// Free space a download needs to start.
pub(crate) const MIN_FREE: u64 = 1024 * 1024 * 1024;
/// Below this while downloads run, they stop with `reason: "space"`.
pub(crate) const MIN_FREE_RUNNING: u64 = 200 * 1024 * 1024;

pub(crate) fn now_secs() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64())
}

fn now_ms() -> f64 {
    (now_secs() * 1000.0).round()
}

/// An id from JS: a positive integral number or numeric string.
pub(crate) fn id_of(v: Option<&Value>) -> Option<u64> {
    let n = match v? {
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                u
            } else {
                let f = n.as_f64()?;
                if !f.is_finite() || f.fract() != 0.0 || !(1.0..1e15).contains(&f) {
                    return None;
                }
                f as u64
            }
        }
        Value::String(s) => s.trim().parse().ok()?,
        _ => return None,
    };
    (n > 0).then_some(n)
}

fn int_of(v: Option<&Value>) -> Option<i64> {
    let f = v?.as_f64()?;
    (f.is_finite() && f.fract() == 0.0).then_some(f as i64)
}

fn str_of(v: Option<&Value>) -> Option<String> {
    v?.as_str().map(str::to_owned)
}

pub(crate) type FreeSpace = Arc<dyn Fn(&Path) -> Option<u64> + Send + Sync>;
/// Moves a record folder to the Trash: (its parent, the folder, the id).
pub(crate) type Trash = Arc<dyn Fn(&Path, &Path, u64) -> bool + Send + Sync>;

/// What the manager reaches outside itself (swapped in tests).
pub(crate) struct Config {
    /// The records file.
    pub store: PathBuf,
    pub default_dir: PathBuf,
    pub home: String,
    /// Folders the download folder may not be in.
    pub forbidden: Vec<PathBuf>,
    pub min_free: u64,
    pub min_free_running: u64,
    pub free_space: FreeSpace,
    /// Where `dl.event`s go.
    pub sink: Arc<dyn Fn(Value) + Send + Sync>,
    pub trash: Trash,
    pub reveal: Arc<dyn Fn(&Path) -> bool + Send + Sync>,
    /// Folder moves always take the cross-volume path (tests).
    pub force_copy: bool,
}

struct Job {
    epoch: u64,
    stop: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
}

struct State {
    records: BTreeMap<u64, Record>,
    next_id: u64,
    dir: PathBuf,
    configured: bool,
    jobs: HashMap<u64, Job>,
    last_emit: HashMap<u64, Instant>,
    emit_pending: HashSet<u64>,
    dirty: bool,
    last_save: Instant,
    /// The download folder is being changed: no starts, removes wait.
    moving: bool,
    shutting_down: bool,
}

pub(crate) struct Manager {
    st: Mutex<State>,
    cfg: Config,
    pub(crate) http: http::Http,
    server: Mutex<Option<server::Server>>,
}

impl Manager {
    pub(crate) fn new(cfg: Config) -> Arc<Manager> {
        let saved = store::load(&cfg.store);
        let mut records = BTreeMap::new();
        let mut next_id = saved.next_id.max(1);
        for mut r in saved.records.into_iter().filter(|r| r.id > 0) {
            if r.status == "done" {
                r.headers = None;
            }
            next_id = next_id.max(r.id + 1);
            records.insert(r.id, r);
        }
        let dir = if saved.dir.is_empty() { cfg.default_dir.clone() } else { PathBuf::from(&saved.dir) };
        let m = Arc::new(Manager {
            st: Mutex::new(State {
                records,
                next_id,
                dir,
                configured: saved.configured,
                jobs: HashMap::new(),
                last_emit: HashMap::new(),
                emit_pending: HashSet::new(),
                dirty: false,
                last_save: Instant::now(),
                moving: false,
                shutting_down: false,
            }),
            cfg,
            http: http::Http::new(),
            server: Mutex::new(None),
        });
        m.reconcile();
        let weak = Arc::downgrade(&m);
        let _ = std::thread::Builder::new().name("rustflix-dl-tick".into()).spawn(move || ticker(weak));
        m
    }

    fn st(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn save(&self, st: &mut State) {
        let saved = store::Saved {
            v: 1,
            next_id: st.next_id,
            dir: st.dir.to_string_lossy().into_owned(),
            configured: st.configured,
            records: st.records.values().cloned().collect(),
        };
        if let Err(e) = store::save(&self.cfg.store, &saved) {
            log::warn!("dl: could not save the records: {e}");
        }
        st.dirty = false;
        st.last_save = Instant::now();
    }

    fn emit(&self, st: &mut State, id: u64) {
        st.emit_pending.remove(&id);
        if let Some(r) = st.records.get(&id) {
            st.last_emit.insert(id, Instant::now());
            (self.cfg.sink)(r.json());
        }
    }

    /// Persists and emits a status change of record `id`.
    fn changed(&self, st: &mut State, id: u64) {
        self.save(st);
        self.emit(st, id);
    }

    /// Records left running by the previous session: resumed when their
    /// link may still work, else `error` / `expired` (the app fetches a
    /// fresh one).
    fn reconcile(self: &Arc<Self>) {
        let mut st = self.st();
        let running: Vec<u64> = st.records.values().filter(|r| r.running()).map(|r| r.id).collect();
        let now = now_secs();
        for id in running {
            let r = st.records.get_mut(&id).expect("listed");
            if r.url.is_empty() || policy::url_expired(&r.url, now) {
                r.status = "error".into();
                r.reason = Some(if r.url.is_empty() { "failed" } else { "expired" }.into());
                r.message = "link expired — open the episode again to continue".into();
                continue;
            }
            r.message = "resuming…".into();
            self.spawn_job(&mut st, id);
        }
        self.save(&mut st);
    }

    /// Starts the job of record `id` (a new generation; an older job is
    /// told to stop and the new one waits for it to end).
    fn spawn_job(self: &Arc<Self>, st: &mut State, id: u64) {
        let Some(r) = st.records.get_mut(&id) else { return };
        r.epoch += 1;
        let epoch = r.epoch;
        let prev = st.jobs.remove(&id).map(|j| {
            j.stop.store(true, Ordering::Relaxed);
            j.done
        });
        let stop = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        st.jobs.insert(id, Job { epoch, stop: stop.clone(), done: done.clone() });
        let m = self.clone();
        let (stop2, done2) = (stop.clone(), done.clone());
        let spawned = std::thread::Builder::new().name(format!("rustflix-dl-{id}")).spawn(move || {
            if let Some(prev) = prev {
                while !prev.load(Ordering::Relaxed) && !stop2.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job::run(&m, id, epoch, &stop2)));
            if ran.is_err() {
                log::error!("dl: the job of #{id} panicked");
                m.job_fail(id, epoch, "failed", "internal error");
            } else if !stop2.load(Ordering::Relaxed) && m.current(id, epoch).is_some() {
                // Never `running` with no job behind it.
                m.job_fail(id, epoch, "failed", "the download stopped unexpectedly");
            }
            done2.store(true, Ordering::Relaxed);
            let mut st = m.st();
            if st.jobs.get(&id).is_some_and(|j| j.epoch == epoch) {
                st.jobs.remove(&id);
            }
        });
        if let Err(e) = spawned {
            done.store(true, Ordering::Relaxed);
            st.jobs.remove(&id);
            if let Some(r) = st.records.get_mut(&id) {
                r.status = "error".into();
                r.reason = Some("failed".into());
                r.message = format!("no thread for the download: {e}");
            }
        }
    }

    /// Tells the job of `id` to stop; its "ended" flag.
    fn stop_job(st: &mut State, id: u64) -> Option<Arc<AtomicBool>> {
        let j = st.jobs.remove(&id)?;
        j.stop.store(true, Ordering::Relaxed);
        Some(j.done)
    }

    // --- What jobs call ----------------------------------------------------------

    /// The record, while generation `epoch` of it runs.
    pub(crate) fn current(&self, id: u64, epoch: u64) -> Option<Record> {
        let st = self.st();
        st.records.get(&id).filter(|r| r.epoch == epoch && r.running()).cloned()
    }

    /// Changes the running record (generation `epoch`); false when it is not
    /// that any more. `now`: persist and emit at once, else lazily
    /// (progress: at most one event a second).
    pub(crate) fn update(&self, id: u64, epoch: u64, now: bool, f: impl FnOnce(&mut Record)) -> bool {
        let mut st = self.st();
        let Some(r) = st.records.get_mut(&id).filter(|r| r.epoch == epoch && r.running()) else { return false };
        f(r);
        if now {
            self.changed(&mut st, id);
        } else {
            st.dirty = true;
            let due = st.last_emit.get(&id).is_none_or(|t| t.elapsed() >= Duration::from_secs(1));
            if due {
                self.emit(&mut st, id);
            } else {
                st.emit_pending.insert(id);
            }
        }
        true
    }

    pub(crate) fn job_fail(&self, id: u64, epoch: u64, reason: &str, message: &str) {
        let mut st = self.st();
        let Some(r) = st.records.get_mut(&id).filter(|r| r.epoch == epoch && r.running()) else { return };
        log::info!("dl: #{id} failed ({reason}): {message}");
        r.status = "error".into();
        r.reason = Some(reason.into());
        r.message = message.into();
        self.changed(&mut st, id);
    }

    pub(crate) fn job_done(&self, id: u64, epoch: u64, f: impl FnOnce(&mut Record)) {
        let mut st = self.st();
        let Some(r) = st.records.get_mut(&id).filter(|r| r.epoch == epoch && r.running()) else { return };
        f(r);
        r.status = "done".into();
        r.progress = Some(100.0);
        r.message = "finished".into();
        r.reason = None;
        r.headers = None;
        let _ = fs::remove_file(r.folder.join(store::MANIFEST));
        log::info!("dl: #{id} finished");
        self.changed(&mut st, id);
    }

    // --- Handlers ---------------------------------------------------------------

    pub(crate) fn list(&self) -> Value {
        let st = self.st();
        let mut list: Vec<&Record> = st.records.values().collect();
        list.sort_by(|a, b| b.created_at.total_cmp(&a.created_at).then(b.id.cmp(&a.id)));
        Value::Array(list.into_iter().map(Record::json).collect())
    }

    pub(crate) fn next_id(&self) -> Value {
        let mut st = self.st();
        let id = st.next_id;
        st.next_id += 1;
        self.save(&mut st);
        json!({ "id": id })
    }

    fn space_error(&self, dir: &Path) -> Option<Value> {
        let free = (self.cfg.free_space)(dir)?;
        if free >= self.cfg.min_free {
            return None;
        }
        let mb = free / (1024 * 1024);
        let need = if self.cfg.min_free >= 1024 * 1024 * 1024 {
            format!("{} GB", self.cfg.min_free / (1024 * 1024 * 1024))
        } else {
            format!("{} MB", self.cfg.min_free / (1024 * 1024))
        };
        Some(json!({
            "ok": false, "reason": "space", "free": free,
            "error": format!("Not enough free space ({mb} MB left, {need} needed). Remove some downloads or free up space."),
        }))
    }

    pub(crate) fn start(self: &Arc<Self>, data: &Value) -> Value {
        let req_id = id_of(data.get("id"));
        let mut new_url = None;
        if let Some(s) = data.get("url").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
            let ok = url::Url::parse(s).is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some());
            if !ok {
                return json!({ "ok": false, "error": "bad url", "reason": "failed" });
            }
            new_url = Some(s.to_owned());
        }
        let headers = http::parse_headers(data.get("headers"));
        let meta = data.get("meta").cloned().unwrap_or(Value::Null);
        let name = str_of(data.get("name")).filter(|n| !n.is_empty()).map(|n| n.chars().take(200).collect::<String>());
        let kind = str_of(data.get("kind")).filter(|k| k == "hls" || k == "file");
        if self.st().moving {
            return json!({ "ok": false, "error": "the download folder is being moved — try again in a moment", "reason": "failed" });
        }
        if let Some(id) = req_id
            && self.st().records.contains_key(&id)
        {
            return self.resume(id, new_url, headers, kind, name, &meta);
        }
        let Some(url) = new_url else { return json!({ "ok": false, "error": "bad url", "reason": "failed" }) };
        let dir = self.st().dir.clone();
        if let Some(err) = self.space_error(&dir) {
            return err;
        }
        if let Err(e) = fs::create_dir_all(&dir) {
            return json!({ "ok": false, "reason": "failed", "error": format!("can't create the download folder {}: {e}", dir.display()) });
        }
        let mut st = self.st();
        let id = match req_id {
            Some(id) if !st.records.contains_key(&id) => {
                st.next_id = st.next_id.max(id + 1);
                id
            }
            _ => {
                let id = st.next_id;
                st.next_id += 1;
                id
            }
        };
        let name = name.unwrap_or_else(|| "video".into());
        let folder = store::unique_folder(&st.dir, &name);
        if let Err(e) = store::prepare_folder(&folder, id) {
            return json!({ "ok": false, "reason": "failed", "error": format!("can't create {}: {e}", folder.display()) });
        }
        let kind = kind.unwrap_or_else(|| if url.to_ascii_lowercase().contains(".m3u8") { "hls".into() } else { "file".into() });
        let r = Record {
            id,
            name,
            status: "running".into(),
            message: "starting…".into(),
            kind,
            url,
            headers: Some(headers.unwrap_or_default()),
            folder,
            key: str_of(meta.get("key")),
            media_type: str_of(meta.get("type")),
            media_id: int_of(meta.get("mediaId")),
            season: int_of(meta.get("season")),
            episode: int_of(meta.get("episode")),
            title: str_of(meta.get("title")),
            created_at: now_ms(),
            ..Default::default()
        };
        log::info!("dl: #{id} start {} ({}) in {}", r.name, r.kind, r.folder.display());
        st.records.insert(id, r);
        self.spawn_job(&mut st, id);
        self.changed(&mut st, id);
        json!({ "ok": true, "id": id })
    }

    /// `dl.start` of an existing record: continue it from its files,
    /// optionally with a fresh (re-signed) link and headers.
    fn resume(
        self: &Arc<Self>,
        id: u64,
        url: Option<String>,
        headers: Option<http::Headers>,
        kind: Option<String>,
        name: Option<String>,
        meta: &Value,
    ) -> Value {
        let (status, cur_url, cur_kind, cur_headers, folder, busy) = {
            let st = self.st();
            let Some(r) = st.records.get(&id) else { return json!({ "ok": false, "error": "removed", "reason": "failed" }) };
            let busy = st.jobs.get(&id).is_some_and(|j| j.epoch == r.epoch && !j.done.load(Ordering::Relaxed));
            (r.status.clone(), r.url.clone(), r.kind.clone(), r.headers.clone(), r.folder.clone(), busy)
        };
        if status == "done" {
            return json!({ "ok": true, "id": id, "status": "done" });
        }
        let url_changed = url.as_ref().is_some_and(|u| *u != cur_url);
        let headers_changed = headers.is_some() && headers != cur_headers;
        if status == "running" && busy && !url_changed && !headers_changed {
            return json!({ "ok": true, "id": id, "resumed": false });
        }
        let parent = folder.parent().map(Path::to_path_buf).unwrap_or_else(|| self.st().dir.clone());
        if let Some(err) = self.space_error(&parent) {
            return err;
        }
        let new_kind = if url_changed {
            kind.unwrap_or_else(|| if url.as_deref().unwrap_or("").to_ascii_lowercase().contains(".m3u8") { "hls".into() } else { "file".into() })
        } else {
            cur_kind.clone()
        };
        let mut st = self.st();
        let Some(r) = st.records.get(&id) else { return json!({ "ok": false, "error": "removed", "reason": "failed" }) };
        if r.status == "done" {
            return json!({ "ok": true, "id": id, "status": "done" });
        }
        let folder = r.folder.clone();
        let _ = Self::stop_job(&mut st, id);
        if new_kind != cur_kind {
            store::clear_folder(&folder);
        } else if new_kind == "file"
            && url_changed
            && hls::Manifest::path_key(url.as_deref().unwrap_or("")) != hls::Manifest::path_key(&cur_url)
        {
            // Another file: its partial bytes are not this one's.
            let _ = fs::remove_file(folder.join(store::FILE_PART));
        }
        let r = st.records.get_mut(&id).expect("checked");
        r.status = "running".into();
        r.reason = None;
        r.message = "resuming…".into();
        if let Some(u) = url.filter(|_| url_changed) {
            r.url = u;
        }
        r.kind = new_kind;
        if let Some(h) = headers {
            r.headers = Some(h);
        } else if r.headers.is_none() {
            r.headers = Some(BTreeMap::new());
        }
        if let Some(n) = name {
            r.name = n;
        }
        if let Some(k) = str_of(meta.get("key")) {
            r.key = Some(k);
        }
        log::info!("dl: #{id} resume (new link: {url_changed})");
        self.spawn_job(&mut st, id);
        self.changed(&mut st, id);
        json!({ "ok": true, "id": id, "resumed": true })
    }

    pub(crate) fn cancel(&self, data: &Value) -> Value {
        let Some(id) = id_of(data.get("id")) else { return Value::Null };
        let mut st = self.st();
        let Some(r) = st.records.get_mut(&id).filter(|r| r.status != "done") else { return Value::Null };
        r.status = "error".into();
        r.reason = Some("cancelled".into());
        r.message = "cancelled".into();
        let _ = Self::stop_job(&mut st, id);
        self.changed(&mut st, id);
        Value::Null
    }

    /// Waits up to `limit` for `flag`.
    fn wait_for(flag: &AtomicBool, limit: Duration) -> bool {
        let end = Instant::now() + limit;
        while !flag.load(Ordering::Relaxed) {
            if Instant::now() >= end {
                return false;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        true
    }

    pub(crate) fn remove(&self, data: &Value) -> Value {
        let Some(id) = id_of(data.get("id")) else { return json!({ "ok": false }) };
        // A folder move in progress finishes first.
        let end = Instant::now() + Duration::from_secs(600);
        while self.st().moving && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(100));
        }
        let (rec, done) = {
            let mut st = self.st();
            let Some(rec) = st.records.remove(&id) else { return json!({ "ok": false }) };
            let done = Self::stop_job(&mut st, id);
            st.emit_pending.remove(&id);
            st.last_emit.remove(&id);
            self.save(&mut st);
            (rec, done)
        };
        if let Some(done) = done
            && !Self::wait_for(&done, Duration::from_secs(45))
        {
            log::warn!("dl: #{id} did not stop in time; trashing its folder anyway");
        }
        let trashed = match rec.folder.parent() {
            Some(parent) if store::marker_id(&rec.folder) == Some(id) => (self.cfg.trash)(parent, &rec.folder, id),
            _ => false,
        };
        log::info!("dl: #{id} removed (folder trashed: {trashed})");
        json!({ "ok": true, "trashed": trashed })
    }

    fn served(&self, id: u64) -> Option<server::Served> {
        let st = self.st();
        let r = st.records.get(&id).filter(|r| r.status == "done")?;
        Some(server::Served { folder: r.folder.clone(), file: r.file.clone()? })
    }

    pub(crate) fn play_url(self: &Arc<Self>, data: &Value) -> Value {
        let Some(id) = id_of(data.get("id")) else { return json!({ "ok": false }) };
        let Some(served) = self.served(id) else { return json!({ "ok": false }) };
        let mut srv = self.server.lock().unwrap_or_else(|e| e.into_inner());
        if srv.is_none() {
            let weak: Weak<Manager> = Arc::downgrade(self);
            match server::Server::start(Arc::new(move |id| weak.upgrade()?.served(id))) {
                Ok(s) => {
                    log::info!("dl: local playback server on 127.0.0.1:{}", s.port);
                    *srv = Some(s);
                }
                Err(e) => {
                    log::warn!("dl: no local playback server: {e}");
                    return json!({ "ok": false });
                }
            }
        }
        let s = srv.as_ref().expect("started");
        json!({ "ok": true, "url": s.player_url(id, &served.file) })
    }

    pub(crate) fn reveal(&self, data: &Value) -> Value {
        let Some(id) = id_of(data.get("id")) else { return json!({ "ok": false }) };
        let target = {
            let st = self.st();
            let Some(r) = st.records.get(&id) else { return json!({ "ok": false }) };
            match (&r.file, r.kind.as_str(), r.status.as_str()) {
                (Some(f), "file", "done") => r.folder.join(f),
                _ => r.folder.clone(),
            }
        };
        if fs::symlink_metadata(&target).is_err() {
            return json!({ "ok": false });
        }
        json!({ "ok": (self.cfg.reveal)(&target) })
    }

    pub(crate) fn space(&self) -> Value {
        let (dir, folders) = {
            let st = self.st();
            (st.dir.clone(), st.records.values().map(|r| r.folder.clone()).collect::<Vec<_>>())
        };
        let used: u64 = folders.iter().map(|f| crate::cache::dir_size(f)).sum();
        let free = (self.cfg.free_space)(&dir).unwrap_or(0);
        json!({ "used": used, "free": free, "minFree": self.cfg.min_free })
    }

    fn info(&self, st: &State) -> Value {
        json!({
            "ok": true,
            "dir": st.dir.to_string_lossy(),
            "defaultDir": self.cfg.default_dir.to_string_lossy(),
            "home": self.cfg.home,
            "configured": st.configured,
            "minFree": self.cfg.min_free,
        })
    }

    pub(crate) fn options(self: &Arc<Self>, data: &Value) -> Value {
        if let Some(dir) = data.get("dir").and_then(Value::as_str) {
            return self.change_dir(dir);
        }
        let st = self.st();
        self.info(&st)
    }

    fn expand(&self, path: &str) -> String {
        let p = path.trim();
        if p == "~" || p.starts_with("~/") {
            format!("{}{}", self.cfg.home.trim_end_matches('/'), &p[1..])
        } else {
            p.to_owned()
        }
    }

    /// Makes `path` the download folder, moving every record folder there.
    fn change_dir(self: &Arc<Self>, path: &str) -> Value {
        let fail = |e: String| json!({ "ok": false, "moved": 0, "error": e });
        let path = self.expand(path);
        // Jobs that are stopping (a cancel just now) get a moment.
        let stopping: Vec<Arc<AtomicBool>> = {
            let st = self.st();
            if st.records.values().any(Record::running) {
                return fail("Downloads are in progress — let them finish or cancel them first.".into());
            }
            if st.moving {
                return fail("The download folder is already being moved.".into());
            }
            st.jobs.values().map(|j| j.done.clone()).collect()
        };
        for d in &stopping {
            if !Self::wait_for(d, Duration::from_secs(10)) {
                return fail("A download is still stopping — try again in a moment.".into());
            }
        }
        let (current, folders) = {
            let mut st = self.st();
            if st.records.values().any(Record::running) || st.moving {
                return fail("Downloads are in progress — let them finish or cancel them first.".into());
            }
            st.moving = true;
            (st.dir.clone(), st.records.values().map(|r| (r.id, r.name.clone(), r.folder.clone())).collect::<Vec<_>>())
        };
        let record_dirs: Vec<PathBuf> = folders.iter().map(|(_, _, f)| f.clone()).collect();
        let new = match folder::validate(&path, &current, &self.cfg.forbidden, &record_dirs) {
            Ok(n) => n,
            Err(e) => {
                self.st().moving = false;
                return fail(e);
            }
        };
        let mut moved = Vec::new();
        let mut stayed = Vec::new();
        for (id, name, src) in folders {
            let Ok(meta) = fs::symlink_metadata(&src) else { continue };
            if !meta.is_dir() || src.parent() == Some(new.as_path()) {
                continue;
            }
            match folder::move_into(&src, &new, self.cfg.force_copy) {
                Ok(dest) => moved.push((id, dest)),
                Err(e) => {
                    log::warn!("dl: #{id} stays in {}: {e}", src.display());
                    stayed.push(format!("{name} ({e})"));
                }
            }
        }
        let mut st = self.st();
        for (id, dest) in &moved {
            if let Some(r) = st.records.get_mut(id) {
                r.folder = dest.clone();
            }
        }
        st.dir = new.clone();
        st.configured = true;
        st.moving = false;
        self.save(&mut st);
        for (id, _) in &moved {
            self.emit(&mut st, *id);
        }
        log::info!("dl: download folder is now {} ({} moved, {} stayed)", new.display(), moved.len(), stayed.len());
        let mut out = self.info(&st);
        out["moved"] = json!(moved.len());
        if !stayed.is_empty() {
            out["error"] = json!(format!(
                "{} download(s) stayed in {}: {}",
                stayed.len(),
                current.display(),
                stayed.join("; ")
            ));
            out["stayed"] = json!(stayed.len());
        }
        out
    }

    /// `dl.adopt {file, name?, meta?, createdAt?, subs?, page?}`: a file a
    /// vid-dl era download left in the download folder becomes a finished
    /// record — moved into a record folder of its own (beside it, the same
    /// volume). Its old subtitle file (`.rustflix-subs-<n>.json`) is read
    /// and returned (`subs`), it and the old player page are deleted.
    pub(crate) fn adopt(&self, data: &Value) -> Value {
        let bad = || json!({ "ok": false });
        let Some(file) = str_of(data.get("file")).map(PathBuf::from) else { return bad() };
        if !file.is_absolute() || file.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
            return bad();
        }
        let Some(parent) = file.parent().map(Path::to_path_buf) else { return bad() };
        let canon = |p: &Path| fs::canonicalize(p).ok();
        let allowed = {
            let st = self.st();
            let pc = canon(&parent);
            pc.is_some() && (pc == canon(&st.dir) || pc == canon(&self.cfg.default_dir))
        };
        let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        let video = ["mp4", "m4v", "webm", "mov", "mkv", "ts", "m2ts"].contains(&ext.as_str());
        let Ok(meta) = fs::symlink_metadata(&file) else { return bad() };
        if !allowed || !video || !meta.is_file() {
            return bad();
        }
        let file_name = file.file_name().and_then(|n| n.to_str()).unwrap_or("video.mp4").to_owned();
        if file_name.starts_with('.') {
            return bad();
        }
        let name = str_of(data.get("name")).filter(|n| !n.is_empty()).unwrap_or_else(|| {
            file.file_stem().and_then(|s| s.to_str()).unwrap_or("video").to_owned()
        });
        let meta_v = data.get("meta").cloned().unwrap_or(Value::Null);
        // Old dot-files of that download, only by their exact names.
        let legacy = |key: &str, prefix: &str, suffix: &str| -> Option<PathBuf> {
            let p = PathBuf::from(str_of(data.get(key))?);
            let n = p.file_name()?.to_str()?;
            let mid = n.strip_prefix(prefix)?.strip_suffix(suffix)?;
            let ok = !mid.is_empty() && mid.bytes().all(|b| b.is_ascii_digit()) && p.parent() == Some(parent.as_path());
            (ok && fs::symlink_metadata(&p).is_ok_and(|m| m.is_file())).then_some(p)
        };
        let subs_path = legacy("subs", ".rustflix-subs-", ".json");
        let page_path = legacy("page", ".rustflix-player-", ".html");

        let mut st = self.st();
        let id = st.next_id;
        st.next_id += 1;
        let folder = store::unique_folder(&parent, &name);
        if store::prepare_folder(&folder, id).is_err() {
            let _ = fs::remove_dir_all(&folder);
            return bad();
        }
        if let Err(e) = fs::rename(&file, folder.join(&file_name)) {
            log::warn!("dl: could not adopt {}: {e}", file.display());
            let _ = fs::remove_dir_all(&folder);
            return bad();
        }
        let r = Record {
            id,
            name,
            status: "done".into(),
            progress: Some(100.0),
            message: "finished".into(),
            kind: "file".into(),
            folder,
            file: Some(file_name),
            key: str_of(meta_v.get("key")),
            media_type: str_of(meta_v.get("type")),
            media_id: int_of(meta_v.get("mediaId")),
            season: int_of(meta_v.get("season")),
            episode: int_of(meta_v.get("episode")),
            title: str_of(meta_v.get("title")),
            created_at: data.get("createdAt").and_then(Value::as_f64).unwrap_or_else(now_ms),
            bytes: Some(meta.len()),
            total_bytes: Some(meta.len()),
            ..Default::default()
        };
        st.records.insert(id, r);
        self.changed(&mut st, id);
        let record = st.records[&id].json();
        drop(st);
        let subs = subs_path.as_ref().and_then(|p| {
            let text = (fs::metadata(p).ok()?.len() <= 2 * 1024 * 1024).then(|| fs::read_to_string(p).ok()).flatten();
            let _ = fs::remove_file(p);
            text
        });
        if let Some(p) = page_path {
            let _ = fs::remove_file(p);
        }
        json!({ "ok": true, "id": id, "record": record, "subs": subs })
    }

    /// Stops every job (their files stay; the next launch resumes them)
    /// and saves. Waits up to `wait` for them to end.
    pub(crate) fn shutdown(&self, wait: Duration) {
        let flags: Vec<Arc<AtomicBool>> = {
            let mut st = self.st();
            st.shutting_down = true;
            for j in st.jobs.values() {
                j.stop.store(true, Ordering::Relaxed);
            }
            self.save(&mut st);
            st.jobs.values().map(|j| j.done.clone()).collect()
        };
        let end = Instant::now() + wait;
        for f in flags {
            let left = end.saturating_duration_since(Instant::now());
            Self::wait_for(&f, left);
        }
        let mut st = self.st();
        self.save(&mut st);
    }

    /// Trailing progress events, lazy saves, the running space check.
    fn tick(&self, check_space: bool) {
        let mut st = self.st();
        if st.shutting_down {
            return;
        }
        let due: Vec<u64> = st
            .emit_pending
            .iter()
            .copied()
            .filter(|id| st.last_emit.get(id).is_none_or(|t| t.elapsed() >= Duration::from_secs(1)))
            .collect();
        for id in due {
            self.emit(&mut st, id);
        }
        if st.dirty && st.last_save.elapsed() >= Duration::from_secs(3) {
            self.save(&mut st);
        }
        if !check_space || !st.records.values().any(Record::running) {
            return;
        }
        let dir = st.dir.clone();
        drop(st);
        let Some(free) = (self.cfg.free_space)(&dir) else { return };
        if free >= self.cfg.min_free_running {
            return;
        }
        let mut st = self.st();
        let running: Vec<u64> = st.records.values().filter(|r| r.running()).map(|r| r.id).collect();
        for id in running {
            let _ = Self::stop_job(&mut st, id);
            if let Some(r) = st.records.get_mut(&id) {
                r.status = "error".into();
                r.reason = Some("space".into());
                r.message = "storage almost full — free up space, then retry".into();
            }
            self.changed(&mut st, id);
        }
    }
}

fn ticker(weak: Weak<Manager>) {
    let mut n = 0u64;
    loop {
        std::thread::sleep(Duration::from_millis(250));
        let Some(m) = weak.upgrade() else { return };
        n += 1;
        m.tick(n.is_multiple_of(40));
    }
}

// --- Registration -------------------------------------------------------------------

static MANAGER: std::sync::OnceLock<Arc<Manager>> = std::sync::OnceLock::new();

/// Answers `call` from a thread of its own (handlers must return at once).
fn answer(call: HostCall, work: impl FnOnce(&Value) -> Value + Send + 'static) {
    let spawned = std::thread::Builder::new().name("rustflix-dl-call".to_owned()).spawn(move || {
        let value = work(call.data());
        call.resolve(value);
    });
    if let Err(err) = spawned {
        log::warn!("dl: no thread for the call: {err}");
    }
}

/// The folders a download folder may never be inside: system locations,
/// `~/Library`, and the app bundle this runs from.
fn forbidden(home: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = folder::SYSTEM.iter().map(PathBuf::from).collect();
    if !home.is_empty() {
        out.push(Path::new(home).join("Library"));
        out.push(Path::new(home).join(".Trash"));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(bundle) = exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app"))
    {
        out.push(bundle.to_path_buf());
    }
    out
}

/// Registers the `dl.*` handlers on `host` for app `app_id`.
pub(crate) fn register(host: &HostChannel, app_id: &str) -> Arc<Manager> {
    let home = std::env::var("HOME").unwrap_or_default();
    let data = nsh_engine::data_dir()
        .map(|d| d.join(nsh_engine::app_dir_name(Some(app_id))))
        .unwrap_or_else(|| std::env::temp_dir().join("rustflix"));
    let sink_host = host.clone();
    let cfg = Config {
        store: data.join("rustflix-downloads.json"),
        default_dir: Path::new(&home).join("Downloads").join("rustflix"),
        forbidden: forbidden(&home),
        home,
        min_free: MIN_FREE,
        min_free_running: MIN_FREE_RUNNING,
        free_space: Arc::new(crate::files::free_space),
        sink: Arc::new(move |v| {
            let _ = sink_host.send("dl.event", v);
        }),
        trash: Arc::new(|parent: &Path, folder: &Path, id: u64| crate::files::trash_record_folder(parent, folder, Some(id))),
        reveal: Arc::new(crate::files::reveal_path),
        force_copy: false,
    };
    log::info!("dl: records in {}", cfg.store.display());
    let m = Manager::new(cfg);
    let _ = MANAGER.set(m.clone());

    let mm = m.clone();
    host.handle("dl.list", move |call| call.resolve(mm.list()));
    let mm = m.clone();
    host.handle("dl.nextId", move |call| call.resolve(mm.next_id()));
    macro_rules! threaded {
        ($name:literal, $method:ident) => {{
            let mm = m.clone();
            host.handle($name, move |call| {
                let mm = mm.clone();
                answer(call, move |data| mm.$method(data));
            });
        }};
    }
    threaded!("dl.start", start);
    threaded!("dl.cancel", cancel);
    threaded!("dl.remove", remove);
    threaded!("dl.playUrl", play_url);
    threaded!("dl.reveal", reveal);
    threaded!("dl.options", options);
    threaded!("dl.adopt", adopt);
    let mm = m.clone();
    host.handle("dl.space", move |call| {
        let mm = mm.clone();
        answer(call, move |_| mm.space());
    });
    #[cfg(unix)]
    {
        extern "C" fn at_exit() {
            if let Some(m) = MANAGER.get() {
                m.shutdown(Duration::from_millis(500));
            }
        }
        // SAFETY: registering a plain `extern "C"` function with no state.
        unsafe {
            libc::atexit(at_exit);
        }
    }
    m
}

/// On quit: stop the transfers cleanly (files stay; the next launch resumes).
pub(crate) fn shutdown() {
    if let Some(m) = MANAGER.get() {
        m.shutdown(Duration::from_secs(2));
    }
}

#[cfg(test)]
mod tests;
