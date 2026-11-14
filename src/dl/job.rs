//! One download's work, on threads of its own: a progressive file (ranged,
//! resumable) or an HLS stream (plan the playlists, then 4 workers fetch
//! the resources). Every result goes through the [`Manager`], which drops
//! what a stale generation reports.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::Path,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use super::{
    Manager,
    hls::{self, HlsError, Manifest, Planner},
    http::{self, Headers, NetError, PumpError},
    now_secs,
    policy::{Failure, Retries, Verdict, classify_status},
    store::{self, FILE_PART, MANIFEST, MARKER, Record},
};

/// Parallel transfers of one HLS download.
pub(crate) const WORKERS: usize = 4;
/// Attempts at a playlist before the walk gives up.
const PLAYLIST_ATTEMPTS: u32 = 20;
const PLAYLIST_LIMIT: u64 = 16 * 1024 * 1024;
/// The resource index a progressive file uses in the retry bookkeeping.
const FILE_IDX: usize = usize::MAX;

/// Sleeps `d` unless `stop` is set meanwhile; false when stopped.
pub(crate) fn sleep_unless_stopped(d: Duration, stop: &AtomicBool) -> bool {
    let end = Instant::now() + d;
    while Instant::now() < end {
        if stop.load(Ordering::Relaxed) {
            return false;
        }
        std::thread::sleep((end - Instant::now()).min(Duration::from_millis(100)));
    }
    !stop.load(Ordering::Relaxed)
}

fn jitter() -> Duration {
    Duration::from_millis(u64::from(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos())) % 300)
}

pub(crate) fn run(m: &Arc<Manager>, id: u64, epoch: u64, stop: &AtomicBool) {
    let Some(rec) = m.current(id, epoch) else { return };
    if let Err(e) = store::prepare_folder(&rec.folder, id) {
        m.job_fail(id, epoch, "failed", &format!("could not create the download folder: {e}"));
        return;
    }
    let headers = rec.headers.clone().unwrap_or_default();
    if rec.kind == "hls" {
        hls_job(m, &rec, epoch, stop, &headers);
    } else {
        file_job(m, &rec, epoch, stop, &headers);
    }
}

// --- HLS ------------------------------------------------------------------------

pub(crate) fn read_manifest(folder: &Path) -> Option<Manifest> {
    let m: Manifest = serde_json::from_slice(&fs::read(folder.join(MANIFEST)).ok()?).ok()?;
    (!m.resources.is_empty()).then_some(m)
}

fn write_manifest(folder: &Path, m: &Manifest) {
    if let Ok(bytes) = serde_json::to_vec(m)
        && let Err(e) = store::write_atomic(&folder.join(MANIFEST), &bytes)
    {
        log::warn!("dl: could not write the manifest in {}: {e}", folder.display());
    }
}

fn mark(m: &mut Manifest, folder: &Path) {
    let names: HashSet<String> = store::names(folder).into_iter().collect();
    m.mark_from_disk(&names, |n| fs::metadata(folder.join(n)).map_or(0, |x| x.len()));
}

/// The text of playlist `url`: retries 5xx / 429 / 408 / network errors and
/// error pages; any other 4xx fails at once (401/403/410: expired).
pub(crate) fn fetch_playlist(h: &http::Http, url: &str, headers: &Headers, stop: &AtomicBool, attempts: u32) -> Result<String, HlsError> {
    if url::Url::parse(url).is_err() {
        return Err(HlsError::BadUrl(url.to_owned()));
    }
    let mut last = HlsError::BadUrl(url.to_owned());
    for attempt in 0..attempts {
        if stop.load(Ordering::Relaxed) {
            return Err(HlsError::Stopped);
        }
        match h.text(url, headers, PLAYLIST_LIMIT) {
            Ok((code, text)) if (200..300).contains(&code) => {
                if hls::looks_like_error_page(text.as_bytes(), text.len() as u64) {
                    last = HlsError::NotText;
                } else if text.contains("#EXT") {
                    return Ok(text);
                } else {
                    return Err(HlsError::NotText);
                }
            }
            Ok((code, _)) if (400..500).contains(&code) && code != 429 && code != 408 => {
                return Err(HlsError::Http(code));
            }
            Ok((code, _)) => last = HlsError::Http(code),
            Err(e) => last = HlsError::Network(e.text),
        }
        if attempt + 1 < attempts {
            let base = (0.4 * 2f64.powi(attempt.min(4) as i32)).min(6.0);
            if !sleep_unless_stopped(Duration::from_secs_f64(base) + jitter(), stop) {
                return Err(HlsError::Stopped);
            }
        }
    }
    Err(last)
}

/// Removes partial transfers an earlier run left (`.f<N>.<epoch>.part`).
fn clean_partials(folder: &Path) {
    for n in store::names(folder) {
        if n.starts_with(".f") && n.ends_with(".part") {
            let _ = fs::remove_file(folder.join(n));
        }
    }
}

fn hls_job(m: &Arc<Manager>, rec: &Record, epoch: u64, stop: &AtomicBool, headers: &Headers) {
    let (id, folder) = (rec.id, rec.folder.as_path());
    clean_partials(folder);
    let old = read_manifest(folder);
    let mut man = match old {
        Some(mut o) if o.source == rec.url => {
            mark(&mut o, folder);
            o
        }
        old => {
            m.update(id, epoch, true, |r| r.message = "reading playlist…".into());
            let mut fetch = |u: &str| fetch_playlist(&m.http, u, headers, stop, PLAYLIST_ATTEMPTS);
            match Planner::new(&mut fetch).plan(&rec.url) {
                Ok(mut plan) => {
                    let names = store::names(folder);
                    plan.adopt(old.as_ref(), hls::next_index(&names));
                    mark(&mut plan, folder);
                    plan.source = rec.url.clone();
                    write_manifest(folder, &plan);
                    plan
                }
                Err(HlsError::Stopped) => return,
                Err(e) => {
                    m.job_fail(id, epoch, e.reason(), &e.message());
                    return;
                }
            }
        }
    };
    hls_progress(m, id, epoch, &man);
    if !man.is_complete() {
        match fetch_all(m, rec, epoch, stop, headers, man) {
            Some(done) => man = done,
            None => return,
        }
    }
    finalize(m, rec, epoch, &man);
}

fn hls_progress(m: &Manager, id: u64, epoch: u64, man: &Manifest) {
    let (done, total, bytes) = (man.done_count() as u64, man.resources.len() as u64, man.done_bytes());
    m.update(id, epoch, false, |r| {
        r.seg_done = Some(done);
        r.seg_total = Some(total);
        r.bytes = Some(bytes);
        r.progress = (total > 0).then(|| (((done as f64 / total as f64) * 1000.0).round() / 10.0).min(99.0));
        r.message = format!("{done}/{total}");
    });
}

struct Sched {
    man: Manifest,
    queue: VecDeque<usize>,
    wait_until: HashMap<usize, Instant>,
    in_flight: usize,
    retries: Retries,
    outcome: Option<(&'static str, String)>,
    last_write: Instant,
    dirty: bool,
}

/// Fetches every missing resource with [`WORKERS`] threads. The complete
/// manifest, or None when the download stopped or failed (already
/// reported).
fn fetch_all(m: &Arc<Manager>, rec: &Record, epoch: u64, stop: &AtomicBool, headers: &Headers, man: Manifest) -> Option<Manifest> {
    let folder = rec.folder.as_path();
    let queue = (0..man.resources.len()).filter(|&i| !man.resources[i].done).collect();
    let sched = Mutex::new(Sched {
        man,
        queue,
        wait_until: HashMap::new(),
        in_flight: 0,
        retries: Retries::default(),
        outcome: None,
        last_write: Instant::now(),
        dirty: false,
    });
    let cv = Condvar::new();
    std::thread::scope(|s| {
        for w in 0..WORKERS {
            let (sched, cv) = (&sched, &cv);
            let spawned = std::thread::Builder::new()
                .name(format!("rustflix-dl-{}-{w}", rec.id))
                .spawn_scoped(s, move || {
                    // A panicking worker ends the download as failed.
                    let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        worker(m, rec, epoch, stop, headers, sched, cv)
                    }));
                    if ran.is_err() {
                        let mut st = lk(sched);
                        st.outcome.get_or_insert(("failed", "internal error in a download worker".into()));
                        cv.notify_all();
                    }
                });
            if let Err(e) = spawned {
                let mut st = lk(sched);
                if w == 0 {
                    st.outcome = Some(("failed", format!("no thread for the download: {e}")));
                }
                break;
            }
        }
    });
    let st = sched.into_inner().unwrap_or_else(|e| e.into_inner());
    write_manifest(folder, &st.man);
    if let Some((reason, msg)) = st.outcome {
        m.job_fail(rec.id, epoch, reason, &msg);
        return None;
    }
    if stop.load(Ordering::Relaxed) || !st.man.is_complete() {
        return None;
    }
    Some(st.man)
}

fn lk(m: &Mutex<Sched>) -> std::sync::MutexGuard<'_, Sched> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn worker(m: &Arc<Manager>, rec: &Record, epoch: u64, stop: &AtomicBool, headers: &Headers, sched: &Mutex<Sched>, cv: &Condvar) {
    let folder = rec.folder.as_path();
    loop {
        let (idx, url, file, kind) = {
            let mut st = lk(sched);
            loop {
                if stop.load(Ordering::Relaxed) || st.outcome.is_some() || m.current(rec.id, epoch).is_none() {
                    cv.notify_all();
                    return;
                }
                if st.queue.is_empty() && st.in_flight == 0 {
                    cv.notify_all();
                    return;
                }
                let now = Instant::now();
                let ready = st.queue.iter().position(|i| st.wait_until.get(i).is_none_or(|t| *t <= now));
                if let Some(pos) = ready {
                    let idx = st.queue.remove(pos).unwrap_or_default();
                    st.in_flight += 1;
                    let r = &st.man.resources[idx];
                    break (idx, r.url.clone(), r.file.clone(), r.kind());
                }
                let next = st.queue.iter().filter_map(|i| st.wait_until.get(i)).min().copied();
                let wait = next.map_or(Duration::from_millis(500), |t| t.saturating_duration_since(now)).min(Duration::from_millis(500));
                st = cv.wait_timeout(st, wait.max(Duration::from_millis(10))).unwrap_or_else(|e| e.into_inner()).0;
            }
        };
        let res = fetch_resource(&m.http, &url, headers, folder, &file, kind, epoch, stop);
        let mut st = lk(sched);
        st.in_flight -= 1;
        match res {
            Ok((ext, bytes)) => {
                let r = &mut st.man.resources[idx];
                r.done = true;
                r.ext = ext.map(str::to_owned);
                r.bytes = bytes;
                st.retries.success(idx);
                st.dirty = true;
                if st.last_write.elapsed() >= Duration::from_secs(3) {
                    write_manifest(folder, &st.man);
                    st.last_write = Instant::now();
                    st.dirty = false;
                }
                hls_progress(m, rec.id, epoch, &st.man);
            }
            Err(PumpError::Stopped) => {}
            Err(PumpError::Io(e)) => {
                st.outcome.get_or_insert(("failed", format!("could not save: {e}")));
            }
            Err(PumpError::Net(e)) => match st.retries.failure(idx, &url, e.failure, now_secs()) {
                Verdict::Retry(d) => {
                    st.wait_until.insert(idx, Instant::now() + d);
                    st.queue.push_back(idx);
                }
                Verdict::Expired => {
                    st.outcome.get_or_insert(("expired", "link expired — open the episode again to continue".into()));
                }
                Verdict::Failed => {
                    st.outcome.get_or_insert(("failed", format!("segment {} failed: {}", idx + 1, e.text)));
                }
            },
        }
        cv.notify_all();
    }
}

/// Downloads one HLS resource to `.<file>.<epoch>.part` and renames it to
/// `<file>[.<ext>]` once complete and checked: a file under its final name
/// is a saved resource.
#[allow(clippy::too_many_arguments)]
pub(crate) fn fetch_resource(
    h: &http::Http,
    url: &str,
    headers: &Headers,
    folder: &Path,
    file: &str,
    kind: char,
    epoch: u64,
    stop: &AtomicBool,
) -> Result<(Option<&'static str>, u64), PumpError> {
    let mut resp = h.get(url, headers, &[]).map_err(PumpError::Net)?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(PumpError::Net(NetError::new(classify_status(status), format!("HTTP {status}"))));
    }
    let expected = http::content_length(&resp);
    let part = folder.join(format!(".{file}.{epoch}.part"));
    let mut out = fs::File::create(&part).map_err(|e| PumpError::Io(e.to_string()))?;
    let mut head = Vec::with_capacity(512);
    let mut reader = resp.body_mut().as_reader();
    let pumped = http::pump(&mut reader, &mut out, stop, &mut head, |_| {});
    drop(out);
    let fail = |e: PumpError| {
        let _ = fs::remove_file(&part);
        Err(e)
    };
    let n = match pumped {
        Ok(n) => n,
        Err(e) => return fail(e),
    };
    if n == 0 {
        return fail(PumpError::Net(NetError::new(Failure::Server, "empty response")));
    }
    if hls::looks_like_error_page(&head, n) {
        return fail(PumpError::Net(NetError::new(Failure::Server, "error page instead of media")));
    }
    if expected.is_some_and(|e| e != n) {
        return fail(PumpError::Net(NetError::new(Failure::Network, "connection closed early")));
    }
    let ext = if kind == 'k' { Some("key") } else { hls::sniff_ext(&head) };
    let dest = folder.join(match ext {
        Some(e) => format!("{file}.{e}"),
        None => file.to_owned(),
    });
    if stop.load(Ordering::Relaxed) {
        return fail(PumpError::Stopped);
    }
    if let Err(e) = fs::rename(&part, &dest) {
        return fail(PumpError::Io(e.to_string()));
    }
    Ok((ext, n))
}

fn finalize(m: &Manager, rec: &Record, epoch: u64, man: &Manifest) {
    let folder = rec.folder.as_path();
    for (pi, p) in man.playlists.iter().enumerate() {
        if let Err(e) = store::write_atomic(&folder.join(&p.local), man.render(pi).as_bytes()) {
            m.job_fail(rec.id, epoch, "failed", &format!("could not write the playlist: {e}"));
            return;
        }
    }
    // Leftovers: resources of older reads, the manifest (signed URLs).
    let mut keep = man.referenced_files();
    keep.insert(MARKER.to_owned());
    for n in store::names(folder) {
        if keep.contains(&n) {
            continue;
        }
        let p = folder.join(&n);
        let _ = match fs::symlink_metadata(&p) {
            Ok(x) if x.is_dir() => fs::remove_dir_all(&p),
            Ok(_) => fs::remove_file(&p),
            Err(_) => continue,
        };
    }
    let bytes = crate::cache::dir_size(folder);
    let total = man.resources.len() as u64;
    let entry = man.entry();
    m.job_done(rec.id, epoch, |r| {
        r.file = Some(entry);
        r.bytes = Some(bytes);
        r.total_bytes = Some(bytes);
        r.seg_done = Some(total);
        r.seg_total = Some(total);
    });
}

// --- Progressive files ------------------------------------------------------------

fn file_progress(m: &Manager, id: u64, epoch: u64, written: u64, total: Option<u64>) {
    m.update(id, epoch, false, |r| {
        r.bytes = Some(written);
        r.total_bytes = total;
        r.progress = total.filter(|t| *t > 0).map(|t| (((written as f64 / t as f64) * 1000.0).round() / 10.0).min(99.0));
        r.message = match r.progress {
            Some(p) => format!("{}%", p as u64),
            None => "downloading".into(),
        };
    });
}

/// Handles a failure; false when the download is over (reported).
fn retry_after(m: &Manager, id: u64, epoch: u64, retries: &mut Retries, url: &str, e: &NetError, stop: &AtomicBool) -> bool {
    match retries.failure(FILE_IDX, url, e.failure, now_secs()) {
        Verdict::Retry(d) => sleep_unless_stopped(d, stop),
        Verdict::Expired => {
            m.job_fail(id, epoch, "expired", "link expired — open the episode again to continue");
            false
        }
        Verdict::Failed => {
            m.job_fail(id, epoch, "failed", &e.text);
            false
        }
    }
}

fn file_job(m: &Arc<Manager>, rec: &Record, epoch: u64, stop: &AtomicBool, headers: &Headers) {
    let (id, folder) = (rec.id, rec.folder.as_path());
    let part = folder.join(FILE_PART);
    let mut retries = Retries::default();
    let mut restarts = 0;
    let url_path = url::Url::parse(&rec.url).map(|u| u.path().to_owned()).unwrap_or_default();
    loop {
        if stop.load(Ordering::Relaxed) || m.current(id, epoch).is_none() {
            return;
        }
        let offset = fs::metadata(&part).map_or(0, |x| x.len());
        let mut extra = vec![("Accept-Encoding", "identity".to_owned())];
        if offset > 0 {
            extra.push(("Range", format!("bytes={offset}-")));
        }
        let mut resp = match m.http.get(&rec.url, headers, &extra) {
            Ok(r) => r,
            Err(e) => {
                if !retry_after(m, id, epoch, &mut retries, &rec.url, &e, stop) {
                    return;
                }
                continue;
            }
        };
        let status = resp.status().as_u16();
        let range = http::header(&resp, "content-range").and_then(|v| http::content_range(&v));
        let mime = http::header(&resp, "content-type");
        let (append, total) = match status {
            206 => match range {
                Some((Some(a), total)) if a == offset => (true, total.or_else(|| http::content_length(&resp).map(|n| n + offset))),
                _ => {
                    // Not the range asked for: start over.
                    let _ = fs::remove_file(&part);
                    restarts += 1;
                    if restarts > 3 {
                        m.job_fail(id, epoch, "failed", "the server sent the wrong part of the file");
                        return;
                    }
                    continue;
                }
            },
            200..=299 => (false, http::content_length(&resp)),
            416 => {
                if offset > 0 && matches!(range, Some((None, Some(t))) if t == offset) {
                    drop(resp);
                    finish_file(m, rec, epoch, &part, &url_path, mime.as_deref(), offset);
                    return;
                }
                let _ = fs::remove_file(&part);
                restarts += 1;
                if restarts > 3 {
                    m.job_fail(id, epoch, "failed", "the server refused the download range");
                    return;
                }
                continue;
            }
            _ => {
                let e = NetError::new(classify_status(status), format!("HTTP {status}"));
                drop(resp);
                if !retry_after(m, id, epoch, &mut retries, &rec.url, &e, stop) {
                    return;
                }
                continue;
            }
        };
        let start = if append { offset } else { 0 };
        let opened = if append {
            fs::OpenOptions::new().append(true).open(&part)
        } else {
            fs::File::create(&part)
        };
        let mut out = match opened {
            Ok(f) => f,
            Err(e) => {
                m.job_fail(id, epoch, "failed", &format!("could not save: {e}"));
                return;
            }
        };
        file_progress(m, id, epoch, start, total);
        let mut head = Vec::with_capacity(if start == 0 { 512 } else { 0 });
        let mut reader = resp.body_mut().as_reader();
        let pumped = http::pump(&mut reader, &mut out, stop, &mut head, |n| file_progress(m, id, epoch, start + n, total));
        drop(out);
        let written = match pumped {
            Ok(n) => start + n,
            Err(PumpError::Stopped) => return,
            Err(PumpError::Io(e)) => {
                m.job_fail(id, epoch, "failed", &format!("could not save: {e}"));
                return;
            }
            Err(PumpError::Net(e)) => {
                // The part file stays: the next attempt continues it.
                if !retry_after(m, id, epoch, &mut retries, &rec.url, &e, stop) {
                    return;
                }
                continue;
            }
        };
        if total.is_some_and(|t| written < t) {
            let e = NetError::new(Failure::Network, "connection closed early");
            if !retry_after(m, id, epoch, &mut retries, &rec.url, &e, stop) {
                return;
            }
            continue;
        }
        if written == 0 || (start == 0 && hls::looks_like_error_page(&head, written)) {
            let _ = fs::remove_file(&part);
            let e = NetError::new(Failure::Server, "error page instead of the video");
            if !retry_after(m, id, epoch, &mut retries, &rec.url, &e, stop) {
                return;
            }
            continue;
        }
        finish_file(m, rec, epoch, &part, &url_path, mime.as_deref(), written);
        return;
    }
}

fn finish_file(m: &Manager, rec: &Record, epoch: u64, part: &Path, url_path: &str, mime: Option<&str>, bytes: u64) {
    let name = format!("{}.{}", store::safe_name(&rec.name), store::file_ext(url_path, mime));
    let dest = rec.folder.join(&name);
    if let Err(e) = fs::rename(part, &dest) {
        m.job_fail(rec.id, epoch, "failed", &format!("could not save the file: {e}"));
        return;
    }
    m.job_done(rec.id, epoch, |r| {
        r.file = Some(name);
        r.bytes = Some(bytes);
        r.total_bytes = Some(bytes);
    });
}
