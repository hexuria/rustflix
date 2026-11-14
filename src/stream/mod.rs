//! Streaming sessions: a stream the hidden web view resolved (URL + the
//! headers the page sent) played by the app's own player through a local
//! proxy that adds those headers to every upstream request
//! (`dl.stream.*`, gated by capabilities.host "dl.*"). The contract all
//! platforms implement is `scratchpad/native/contract.md` §2.
//!
//! - `dl.stream.open {url, kind?, headers?, cookies?, key?}` → `{ok, sid,
//!   url}`: `http://127.0.0.1:<port>/<token>/s/<sid>/index.m3u8` (HLS) or
//!   `…/f0.mp4` (a progressive file). A `key` with a live session returns
//!   that session (reference counted: `close` releases one reference).
//! - `dl.stream.update {sid, url, headers?, cookies?}`: a fresh link for the
//!   same stream; the local URLs stay the same.
//! - `dl.stream.close {sid}`; `dl.stream.stats {sid}`;
//!   `dl.stream.debug {sid, status?, count?}` makes the next `count`
//!   upstream answers `status` (403) without asking upstream (tests).
//! - Events `dl.stream.event {sid, type}`: `expiring {expiresAt, inSec}`
//!   (the link's expiry timestamp is within [`EARLY`]: re-resolve now),
//!   `expired {status}` (upstream refused with 401/403/410: the player's
//!   request is held until `dl.stream.update` or [`HOLD`]), `updated
//!   {generation}`, `error {reason, message, fatal}` (`drm`, `expired`,
//!   `relink`, `upstream`), `stats` (at most every 5 s while used).
//!
//! A fresh link may come from another CDN with another variant ladder,
//! order, bandwidths, rendition groups, segment names and media-sequence
//! base: entries are matched by what they are ([`playlist::Desc`]), not by
//! URL or position, and a name with no exact counterpart is served from the
//! nearest one (the segment covering the same time; the nearest lower
//! variant) — a name the player was given is never answered 404 because of
//! a fresh link. When nothing can stand for it the app gets `error {reason:
//! "relink"}` (rebuild the item at the current time).
//!
//! Not an open proxy: the server has its own random port and per-launch
//! token; a session serves only the ids of its own table, which only its
//! playlists fill ([`playlist::rewrite`]); no request carries a URL.
//!
//! Media goes through with back-pressure: one 64 KB buffer per request,
//! blocking reads and writes (a slow player slows the upstream read), no
//! whole-segment buffering; chunked when the length is unknown. `Range`
//! is forwarded; an upstream that answers 200 to a range request is
//! skipped/capped into the 206 the player asked for. Segments disguised as
//! images (a PNG/JPEG/GIF/BMP header before MPEG-TS or fMP4) lose the fake
//! header.
//!
//! Built only from `crate::dl` items (HTTP client, HLS attribute parsing,
//! expiry rules, the server's token / range / content-type helpers), std
//! and ureq; NSH's host channel only in [`register`]. The Android library
//! includes this module and drives it with [`init`] + [`call`].

pub(crate) mod playlist;
#[cfg(test)]
mod tests;

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::{self, BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Condvar, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use ureq::ResponseExt;

use crate::dl::{
    http::{self, Headers, Http},
    policy, server,
};
use playlist::{Desc, Role, RewriteError, Table};

/// Where events go (`dl.stream.event`).
pub(crate) type Sink = Arc<dyn Fn(Value) + Send + Sync>;

/// How long a refused request waits for a fresh link.
pub(crate) const HOLD: Duration = Duration::from_secs(20);
/// How long before a link's expiry timestamp `expiring` is sent.
pub(crate) const EARLY: f64 = 90.0;
/// Sessions kept at most (the least recently used closes).
const MAX_SESSIONS: usize = 16;
/// A session no one holds and no one asked anything of for this long ends.
const IDLE: Duration = Duration::from_secs(30 * 60);
/// … and one that is held but unused for this long.
const IDLE_HELD: Duration = Duration::from_secs(6 * 3600);
/// Playlist bodies read at most.
const PLAYLIST_LIMIT: u64 = 16 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;
/// How far into a segment a disguised one's real start is looked for.
const SNIFF: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Hls,
    File,
}

struct Entry {
    url: String,
    /// Its local name, fixed when it was first listed.
    name: String,
    role: Role,
    parent: usize,
    /// What it is — as the player knows it (kept across fresh links:
    /// remapping looks for the same time / quality).
    desc: Desc,
    /// What it is in the link it was last read in (re-reads match this).
    seen: Desc,
    /// The link generation it was last read in.
    gen_: u64,
}

#[derive(Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Stats {
    /// Requests from the player.
    pub requests: u64,
    /// Requests made upstream (forced ones included).
    pub upstream: u64,
    /// Upstream requests sent with every session header (all of them: the
    /// one client path adds them; the end-to-end test checks at the origin).
    pub with_headers: u64,
    /// The session's header names (no values).
    pub header_names: Vec<String>,
    /// Body bytes sent to the player.
    pub bytes: u64,
    /// Upstream statuses ("200": n, …; "forced403" for debug ones).
    pub statuses: BTreeMap<String, u64>,
    pub playlists: u64,
    pub segments: u64,
    /// Range requests from the player; how many upstream answered 200 to.
    pub ranges: u64,
    pub ranges_emulated: u64,
    pub expired: u64,
    pub updates: u64,
    /// Requests held for a fresh link, and the longest hold (ms).
    pub holds: u64,
    pub hold_ms_max: u64,
    /// Held requests that got their answer after an update.
    pub recovered: u64,
    /// Names served from the nearest counterpart after a fresh link.
    pub remapped: u64,
    /// The first few remaps: "<what the player has> -> <what serves it>".
    pub remaps: Vec<String>,
    /// Segments whose fake image header was stripped.
    pub stripped_headers: u64,
    pub errors: u64,
    /// Entries in the table.
    pub table: usize,
}

struct State {
    /// The link generation: `dl.stream.update` moves it on.
    gen_: u64,
    headers: Headers,
    entries: Vec<Entry>,
    /// Entries by (parent, role), in listing order.
    kids: HashMap<(usize, Role), Vec<usize>>,
    /// Entries a rewrite in progress has claimed, and its position per role.
    claimed: HashSet<usize>,
    pos: HashMap<Role, usize>,
    closed: Option<String>,
    expired_for: Option<u64>,
    expiring_for: Option<u64>,
    relink_for: Option<u64>,
    /// The earliest expiry timestamp in the current link's URLs.
    expires: Option<f64>,
    /// Debug: the next `n` upstream answers are this status.
    force: Option<(u16, u32)>,
    stats: Stats,
    last_stats: Instant,
    last_used: Instant,
    refs: u32,
}

impl State {
    fn note_expiry(&mut self, url: &str) {
        if let Some(t) = expiry_of(url) {
            self.expires = Some(self.expires.map_or(t, |e| e.min(t)));
        }
    }
}

impl Table for State {
    fn begin(&mut self, _parent: usize) {
        self.claimed.clear();
        self.pos.clear();
    }

    fn register(&mut self, parent: usize, desc: Desc, url: String, role: Role) -> String {
        let gen_ = self.gen_;
        self.note_expiry(&url);
        let pos = {
            let p = self.pos.entry(role).or_insert(0);
            *p += 1;
            *p - 1
        };
        let kids = self.kids.get(&(parent, role)).cloned().unwrap_or_default();
        let free = |i: &usize| !self.claimed.contains(i);
        // The same thing: at its old position first (the usual re-read),
        // else anywhere.
        let found = kids
            .get(pos)
            .copied()
            .filter(|i| free(i) && self.entries[*i].seen.same(&desc))
            .or_else(|| kids.iter().copied().find(|i| free(i) && self.entries[*i].seen.same(&desc)))
            // Not the same, close enough: only entries the current link
            // has not placed yet.
            .or_else(|| {
                kids.iter()
                    .copied()
                    .filter(|i| free(i) && self.entries[*i].gen_ != gen_)
                    .filter_map(|i| self.entries[i].seen.near(&desc).map(|s| (s, i)))
                    .min()
                    .map(|(_, i)| i)
            });
        if let Some(id) = found {
            self.claimed.insert(id);
            let e = &mut self.entries[id];
            e.url = url;
            e.gen_ = gen_;
            e.seen = desc;
            return e.name.clone();
        }
        let id = self.entries.len();
        let name = playlist::local_name(id, role, &url);
        self.entries.push(Entry { url, name: name.clone(), role, parent, seen: desc.clone(), desc, gen_ });
        self.kids.entry((parent, role)).or_default().push(id);
        self.claimed.insert(id);
        self.stats.table = self.entries.len();
        name
    }
}

pub(crate) struct Session {
    sid: String,
    key: Option<String>,
    st: Mutex<State>,
    cv: Condvar,
    /// One playlist refresh at a time after a fresh link.
    refresh: Mutex<()>,
}

impl Session {
    fn st(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub(crate) struct Proxy {
    pub(crate) port: u16,
    pub(crate) token: String,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    http: Http,
    sink: Sink,
    hold: Duration,
}

/// Why a local request cannot be answered with media.
#[derive(Debug)]
enum Fail {
    /// Answer this status (an upstream one, or 404 / 502 of our own).
    Status(u16),
    /// The player hung up: nothing more to write.
    Gone,
}

impl From<io::Error> for Fail {
    fn from(_: io::Error) -> Fail {
        Fail::Gone
    }
}

fn valid_url(s: &str) -> bool {
    url::Url::parse(s).is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some())
}

const EXPIRY_KEYS: [&str; 8] = ["expires", "expire", "exp", "expiry", "e", "validto", "valid_to", "deadline"];

/// The expiry timestamp (unix seconds) a signed URL carries — the same
/// keys and rules as the downloader's `policy::url_expired`.
pub(crate) fn expiry_of(url: &str) -> Option<f64> {
    let b = url.as_bytes();
    let lower = url.to_ascii_lowercase();
    let lb = lower.as_bytes();
    let mut best: Option<f64> = None;
    for start in 0..b.len() {
        if start > 0 && !b"?&/~;,=".contains(&b[start - 1]) {
            continue;
        }
        for key in EXPIRY_KEYS {
            let k = key.as_bytes();
            if !lb[start..].starts_with(k) || lb.get(start + k.len()) != Some(&b'=') {
                continue;
            }
            let at = start + k.len() + 1;
            let n = b[at..].iter().take_while(|c| c.is_ascii_digit()).count();
            let end = at + n;
            let bounded = end == b.len() || b"&/~;,#".contains(&b[end]);
            if (n == 10 || n == 13) && bounded {
                let v: f64 = url[at..end].parse().unwrap_or(f64::MAX);
                let secs = if v > 1e12 { v / 1000.0 } else { v };
                best = Some(best.map_or(secs, |x: f64| x.min(secs)));
            }
        }
    }
    best
}

fn host_of(u: &str) -> Option<String> {
    url::Url::parse(u).ok()?.host_str().map(|h| h.to_ascii_lowercase())
}

/// The last two labels of a host ("a.b.example.com" → "example.com").
fn site_of(host: &str) -> &str {
    let mut dots = host.rmatch_indices('.');
    let _ = dots.next();
    match dots.next() {
        Some((i, _)) => &host[i + 1..],
        None => host,
    }
}

/// The page's headers plus what a browser sends with every media request
/// and the page did not report — `Accept`, `Accept-Language`, the
/// `Sec-Fetch-*` trio and, for a Chromium user agent, its client hints.
/// Some CDNs refuse a request without them: Aether's (`*.tnmr.org`, plain
/// nginx, HTTP/1.1) answered 403 to the page's Referer + Origin + UA alone
/// and 200 to the same URL with this set (macOS, 2026-11-14). The page's
/// own values always win.
pub(crate) fn browser_headers(page: &Headers, url: &str) -> Headers {
    let mut h = page.clone();
    let has = |h: &Headers, k: &str| h.keys().any(|x| x.eq_ignore_ascii_case(k));
    let get = |k: &str| page.iter().find(|(x, _)| x.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str());
    let add = |h: &mut Headers, k: &str, v: String| {
        if !has(h, k) {
            h.insert(k.to_owned(), v);
        }
    };
    add(&mut h, "Accept", "*/*".into());
    add(&mut h, "Accept-Language", "en-US,en;q=0.9".into());
    // Where the request comes from: the page's Origin, else its Referer.
    let from = get("Origin").or_else(|| get("Referer")).and_then(host_of);
    let to = host_of(url);
    let site = match (&from, &to) {
        (Some(a), Some(b)) if a == b => "same-origin",
        (Some(a), Some(b)) if site_of(a) == site_of(b) => "same-site",
        (Some(_), _) => "cross-site",
        (None, _) => "none",
    };
    add(&mut h, "Sec-Fetch-Site", site.into());
    // hls.js and fetch-based players request with CORS (an Origin header);
    // a <video> element without it.
    let cors = get("Origin").is_some();
    add(&mut h, "Sec-Fetch-Mode", if cors { "cors" } else { "no-cors" }.into());
    add(&mut h, "Sec-Fetch-Dest", if cors { "empty" } else { "video" }.into());
    let ua = get("User-Agent").unwrap_or_default();
    if let Some(major) = ua.split("Chrome/").nth(1).and_then(|v| v.split('.').next()).filter(|m| !m.is_empty() && m.bytes().all(|b| b.is_ascii_digit())) {
        add(&mut h, "sec-ch-ua", format!("\"Chromium\";v=\"{major}\", \"Not_A Brand\";v=\"24\""));
        add(&mut h, "sec-ch-ua-mobile", if ua.contains("Mobile") { "?1" } else { "?0" }.into());
        let platform = if ua.contains("Android") {
            "Android"
        } else if ua.contains("Windows") {
            "Windows"
        } else if ua.contains("Mac OS X") {
            "macOS"
        } else if ua.contains("CrOS") {
            "Chrome OS"
        } else {
            "Linux"
        };
        add(&mut h, "sec-ch-ua-platform", format!("\"{platform}\""));
    }
    h
}

/// The session's headers from `headers` + `cookies` (a Cookie value).
fn session_headers(data: &Value) -> Option<Headers> {
    let mut h = http::parse_headers(data.get("headers"));
    if let Some(c) = data.get("cookies").and_then(Value::as_str).filter(|c| !c.is_empty() && !c.contains(['\r', '\n', '\0'])) {
        let h = h.get_or_insert_with(Headers::new);
        h.retain(|k, _| !k.eq_ignore_ascii_case("cookie"));
        h.insert("Cookie".into(), c.to_owned());
    }
    h
}

fn is_image(head: &[u8]) -> bool {
    head.starts_with(b"\x89PNG") || head.starts_with(b"\xFF\xD8\xFF") || head.starts_with(b"GIF8") || head.starts_with(b"BM")
}

/// Where a disguised segment's real data starts: after an image header,
/// the first offset with 5 MPEG-TS sync bytes 188 apart, or an fMP4 box.
pub(crate) fn disguise_offset(head: &[u8]) -> Option<usize> {
    if !is_image(head) {
        return None;
    }
    for k in 1..head.len() {
        if head[k] == 0x47 && (1..5).all(|n| head.get(k + 188 * n) == Some(&0x47)) {
            return Some(k);
        }
        if k + 8 <= head.len() && matches!(&head[k + 4..k + 8], b"ftyp" | b"styp" | b"moof" | b"sidx") {
            let size = u32::from_be_bytes([head[k], head[k + 1], head[k + 2], head[k + 3]]) as usize;
            if (8..1 << 26).contains(&size) {
                return Some(k);
            }
        }
    }
    None
}

impl Proxy {
    /// Starts the server (127.0.0.1, a port the system picks) and its
    /// housekeeping (expiry warnings, idle sessions).
    pub(crate) fn start(sink: Sink, hold: Duration) -> io::Result<Arc<Proxy>> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        let proxy = Arc::new(Proxy {
            port,
            token: server::random_token(),
            sessions: Mutex::new(HashMap::new()),
            http: Http::new(),
            sink,
            hold,
        });
        let weak = Arc::downgrade(&proxy);
        std::thread::Builder::new().name("rustflix-stream".into()).spawn(move || {
            for conn in listener.incoming() {
                let Ok(conn) = conn else { continue };
                let Some(p) = weak.upgrade() else { return };
                let _ = std::thread::Builder::new().name("rustflix-stream-conn".into()).spawn(move || {
                    let _ = p.serve(conn);
                });
            }
        })?;
        let weak = Arc::downgrade(&proxy);
        std::thread::Builder::new().name("rustflix-stream-tick".into()).spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(2));
                let Some(p) = weak.upgrade() else { return };
                p.housekeep(crate::dl::now_secs());
            }
        })?;
        Ok(proxy)
    }

    fn sessions(&self) -> MutexGuard<'_, HashMap<String, Arc<Session>>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn session(&self, sid: &str) -> Option<Arc<Session>> {
        self.sessions().get(sid).cloned()
    }

    fn emit(&self, sid: &str, kind: &str, extra: Value) {
        let mut v = json!({ "sid": sid, "type": kind });
        if let (Some(o), Value::Object(e)) = (v.as_object_mut(), extra) {
            o.extend(e);
        }
        (self.sink)(v);
    }

    pub(crate) fn base_url(&self, sid: &str) -> String {
        format!("http://127.0.0.1:{}/{}/s/{sid}/", self.port, self.token)
    }

    /// `expiring` before a link's expiry timestamp; idle sessions end.
    pub(crate) fn housekeep(&self, now: f64) {
        self.housekeep_with(now, IDLE, IDLE_HELD);
    }

    pub(crate) fn housekeep_with(&self, now: f64, idle_free: Duration, idle_held: Duration) {
        let all: Vec<Arc<Session>> = self.sessions().values().cloned().collect();
        for s in all {
            let (warn, idle) = {
                let mut st = s.st();
                let g = st.gen_;
                let warn = match st.expires {
                    Some(t) if st.closed.is_none() && st.expiring_for != Some(g) && t - now <= EARLY => {
                        st.expiring_for = Some(g);
                        Some(t)
                    }
                    _ => None,
                };
                let used = st.last_used.elapsed();
                (warn, (st.refs == 0 && used >= idle_free) || used >= idle_held)
            };
            if let Some(t) = warn {
                self.emit(&s.sid, "expiring", json!({ "expiresAt": t, "inSec": (t - now).max(0.0).round() }));
            }
            if idle {
                self.sessions().remove(&s.sid);
                close_session(&s, "idle");
            }
        }
    }

    // --- Host operations -------------------------------------------------------------

    pub(crate) fn open(&self, data: &Value) -> Value {
        let Some(url) = data.get("url").and_then(Value::as_str).map(str::trim).filter(|u| valid_url(u)) else {
            return json!({ "ok": false, "error": "bad url" });
        };
        let key = data.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()).map(|k| k.chars().take(200).collect::<String>());
        if let Some(k) = &key {
            let shared = self.sessions().values().find(|s| s.key.as_deref() == Some(k.as_str())).cloned();
            if let Some(s) = shared {
                let mut st = s.st();
                if st.closed.is_none() {
                    st.refs += 1;
                    st.last_used = Instant::now();
                    let name = st.entries[0].name.clone();
                    drop(st);
                    return json!({ "ok": true, "sid": s.sid, "url": format!("{}{name}", self.base_url(&s.sid)), "shared": true });
                }
            }
        }
        let kind = match data.get("kind").and_then(Value::as_str) {
            Some("file") => Kind::File,
            Some("hls") => Kind::Hls,
            _ if url.to_ascii_lowercase().contains(".m3u8") => Kind::Hls,
            _ => Kind::File,
        };
        let headers = session_headers(data).unwrap_or_default();
        let sid = server::random_token()[..16].to_owned();
        let role = if kind == Kind::Hls { Role::Playlist } else { Role::File };
        let mut stats = Stats { header_names: headers.keys().cloned().collect(), table: 1, ..Default::default() };
        stats.header_names.sort();
        let name = playlist::local_name(0, role, url);
        let mut state = State {
            gen_: 0,
            headers,
            entries: vec![Entry { url: url.to_owned(), name: name.clone(), role, parent: 0, desc: Desc::Entry, seen: Desc::Entry, gen_: 0 }],
            kids: HashMap::new(),
            claimed: HashSet::new(),
            pos: HashMap::new(),
            closed: None,
            expired_for: None,
            expiring_for: None,
            relink_for: None,
            expires: None,
            force: None,
            stats,
            last_stats: Instant::now(),
            last_used: Instant::now(),
            refs: 1,
        };
        state.note_expiry(url);
        let session = Arc::new(Session { sid: sid.clone(), key, st: Mutex::new(state), cv: Condvar::new(), refresh: Mutex::new(()) });
        let mut all = self.sessions();
        while all.len() >= MAX_SESSIONS {
            let Some(oldest) = all.values().min_by_key(|s| s.st().last_used).map(|s| s.sid.clone()) else { break };
            if let Some(s) = all.remove(&oldest) {
                close_session(&s, "replaced");
            }
        }
        all.insert(sid.clone(), session);
        drop(all);
        log::info!("stream: session {sid} opened ({kind:?})");
        json!({ "ok": true, "sid": sid, "url": format!("{}{name}", self.base_url(&sid)) })
    }

    pub(crate) fn update(&self, data: &Value) -> Value {
        let Some(s) = data.get("sid").and_then(Value::as_str).and_then(|sid| self.session(sid)) else {
            return json!({ "ok": false, "error": "no such session" });
        };
        let Some(url) = data.get("url").and_then(Value::as_str).map(str::trim).filter(|u| valid_url(u)) else {
            return json!({ "ok": false, "error": "bad url" });
        };
        let mut st = s.st();
        if st.closed.is_some() {
            return json!({ "ok": false, "error": "closed" });
        }
        st.gen_ += 1;
        let g = st.gen_;
        st.entries[0].url = url.to_owned();
        st.entries[0].gen_ = g;
        st.expires = None;
        st.note_expiry(url);
        if let Some(h) = session_headers(data) {
            st.stats.header_names = h.keys().cloned().collect();
            st.stats.header_names.sort();
            st.headers = h;
        }
        st.stats.updates += 1;
        st.last_used = Instant::now();
        drop(st);
        s.cv.notify_all();
        log::info!("stream: session {} has a fresh link (generation {g})", s.sid);
        self.emit(&s.sid, "updated", json!({ "generation": g }));
        json!({ "ok": true })
    }

    pub(crate) fn close(&self, data: &Value) -> Value {
        let Some(sid) = data.get("sid").and_then(Value::as_str) else { return json!({ "ok": false }) };
        let Some(s) = self.session(sid) else { return json!({ "ok": false }) };
        let last = {
            let mut st = s.st();
            st.refs = st.refs.saturating_sub(1);
            st.refs == 0
        };
        if last {
            self.sessions().remove(sid);
            close_session(&s, "closed");
        }
        json!({ "ok": true, "closed": last })
    }

    pub(crate) fn stats(&self, data: &Value) -> Value {
        let Some(s) = data.get("sid").and_then(Value::as_str).and_then(|sid| self.session(sid)) else {
            return json!({ "ok": false });
        };
        let st = s.st();
        json!({ "ok": true, "stats": st.stats, "closed": st.closed, "generation": st.gen_, "refs": st.refs })
    }

    pub(crate) fn debug(&self, data: &Value) -> Value {
        let Some(s) = data.get("sid").and_then(Value::as_str).and_then(|sid| self.session(sid)) else {
            return json!({ "ok": false });
        };
        let status = data.get("status").and_then(Value::as_u64).filter(|c| (400..600).contains(c)).unwrap_or(403) as u16;
        let count = data.get("count").and_then(Value::as_u64).unwrap_or(1).min(100) as u32;
        s.st().force = (count > 0).then_some((status, count));
        json!({ "ok": true })
    }

    /// Every op of the contract by its full name.
    pub(crate) fn call(&self, name: &str, data: &Value) -> Value {
        match name {
            "dl.stream.open" => self.open(data),
            "dl.stream.update" => self.update(data),
            "dl.stream.close" => self.close(data),
            "dl.stream.stats" => self.stats(data),
            "dl.stream.debug" => self.debug(data),
            _ => json!({ "ok": false, "error": "unknown op" }),
        }
    }

    // --- The server -------------------------------------------------------------------

    fn serve(&self, conn: TcpStream) -> io::Result<()> {
        conn.set_read_timeout(Some(Duration::from_secs(30)))?;
        conn.set_write_timeout(Some(Duration::from_secs(60)))?;
        let mut out = conn.try_clone()?;
        let mut reader = BufReader::new(conn);
        while let Some(req) = read_request(&mut reader)? {
            let head = req.method == "HEAD";
            if req.method != "GET" && !head {
                simple(&mut out, 405, true)?;
                return Ok(());
            }
            match self.respond(&mut out, &req, head) {
                Ok(()) => {}
                Err(Fail::Gone) => return Ok(()),
                Err(Fail::Status(code)) => simple(&mut out, code, req.close)?,
            }
            out.flush()?;
            if req.close {
                return Ok(());
            }
        }
        Ok(())
    }

    /// `/<token>/s/<sid>/<name>`, the query ignored.
    fn route(&self, path: &str) -> Option<(Arc<Session>, usize, char)> {
        let path = path.split(['?', '#']).next()?;
        let mut it = path.strip_prefix('/')?.split('/');
        let (t, s, sid, name) = (it.next()?, it.next()?, it.next()?, it.next()?);
        if it.next().is_some() || t != self.token || s != "s" {
            return None;
        }
        let (id, letter) = playlist::parse_name(name)?;
        let session = self.session(sid)?;
        let st = session.st();
        let e = st.entries.get(id)?;
        // Exactly the name the session gave it.
        if e.role.letter() != letter || e.name != name {
            return None;
        }
        drop(st);
        Some((session, id, letter))
    }

    fn respond(&self, out: &mut TcpStream, req: &Request, head: bool) -> Result<(), Fail> {
        let Some((s, id, letter)) = self.route(&req.path) else { return Err(Fail::Status(404)) };
        {
            let mut st = s.st();
            if st.closed.is_some() {
                return Err(Fail::Status(410));
            }
            st.stats.requests += 1;
            st.last_used = Instant::now();
        }
        let r = if letter == 'p' { self.serve_playlist(&s, id, out, req, head) } else { self.serve_media(&s, id, out, req, head) };
        if let Err(Fail::Status(code)) = &r
            && *code != 404
        {
            s.st().stats.errors += 1;
        }
        self.maybe_stats(&s, false);
        r
    }

    /// The upstream URL of entry `id` for the current link (reading its
    /// playlist again after a fresh link), with the generation it is of.
    fn fresh_url(&self, s: &Session, id: usize) -> Result<(String, u64, Role), Fail> {
        if let Some(r) = Self::current_url(s, id)? {
            return Ok(r);
        }
        // One refresh at a time: requests that wait meanwhile find their
        // entry fresh.
        let _one = s.refresh.lock().unwrap_or_else(|e| e.into_inner());
        self.refresh_url(s, id, 0)
    }

    /// Entry `id`'s URL when it is of the current link (the entry playlist
    /// always is: `update` sets it).
    fn current_url(s: &Session, id: usize) -> Result<Option<(String, u64, Role)>, Fail> {
        let st = s.st();
        let e = st.entries.get(id).ok_or(Fail::Status(404))?;
        Ok((e.gen_ == st.gen_ || id == 0).then(|| (e.url.clone(), st.gen_, e.role)))
    }

    fn refresh_url(&self, s: &Session, id: usize, depth: usize) -> Result<(String, u64, Role), Fail> {
        if let Some(r) = Self::current_url(s, id)? {
            return Ok(r);
        }
        if depth > 6 {
            return Err(Fail::Status(502));
        }
        let parent = s.st().entries[id].parent;
        // Read the parent playlist with the fresh link: its rewrite moves
        // the entries it lists to the new URLs.
        let (purl, pgen, _) = self.refresh_url(s, parent, depth + 1)?;
        let (text, base) = match self.fetch_playlist(s, &purl)? {
            Fetched::Text(text, base) => (text, base),
            Fetched::Status(code) => return Err(Fail::Status(code)),
        };
        let mut st = s.st();
        if st.gen_ != pgen {
            return Err(Fail::Status(503));
        }
        if playlist::rewrite(&text, &base, parent, &mut *st).is_err() {
            return Err(Fail::Status(502));
        }
        if st.entries[id].gen_ != st.gen_ && !Self::remap(&mut st, id) {
            // Nothing in the fresh link can stand for it.
            let g = st.gen_;
            let first = st.relink_for != Some(g);
            st.relink_for = Some(g);
            drop(st);
            if first {
                self.emit(
                    &s.sid,
                    "error",
                    json!({ "reason": "relink", "fatal": false, "message": "the fresh link does not have what the player is playing: rebuild the item at the current time" }),
                );
            }
            return Err(Fail::Status(404));
        }
        let e = &st.entries[id];
        Ok((e.url.clone(), st.gen_, e.role))
    }

    /// Points stale entry `id` at the fresh entry nearest to it among its
    /// siblings: the segment covering its start time, the nearest lower
    /// variant, the rendition of its type and language. False when none.
    fn remap(st: &mut State, id: usize) -> bool {
        let g = st.gen_;
        let (parent, role, desc) = {
            let e = &st.entries[id];
            (e.parent, e.role, e.desc.clone())
        };
        let fresh: Vec<usize> = st.kids.get(&(parent, role)).map(|k| k.iter().copied().filter(|i| st.entries[*i].gen_ == g).collect()).unwrap_or_default();
        let pick = match &desc {
            Desc::Segment { start, .. } => {
                let at = start + 0.05;
                fresh
                    .iter()
                    .copied()
                    .find(|i| matches!(st.entries[*i].desc, Desc::Segment { start: s2, dur, .. } if s2 <= at && at < s2 + dur.max(0.001)))
                    .or_else(|| {
                        fresh
                            .iter()
                            .copied()
                            .filter_map(|i| match st.entries[i].desc {
                                Desc::Segment { start: s2, .. } => Some((((s2 - start).abs() * 1000.0) as u64, i)),
                                _ => None,
                            })
                            .min()
                            .map(|(_, i)| i)
                    })
            }
            Desc::Variant { bw, .. } => {
                let vs: Vec<(u64, usize)> = fresh.iter().filter_map(|i| match st.entries[*i].desc { Desc::Variant { bw: b, .. } => Some((b, *i)), _ => None }).collect();
                vs.iter().filter(|(b, _)| b <= bw).max().or_else(|| vs.iter().min()).map(|(_, i)| *i)
            }
            Desc::Rendition { kind, lang, .. } => {
                let same_kind = |i: &usize| matches!(&st.entries[*i].desc, Desc::Rendition { kind: k, .. } if k == kind);
                fresh
                    .iter()
                    .copied()
                    .find(|i| same_kind(i) && matches!(&st.entries[*i].desc, Desc::Rendition { lang: l, .. } if l == lang))
                    .or_else(|| fresh.iter().copied().find(same_kind))
            }
            Desc::IFrame { bw, .. } => fresh
                .iter()
                .copied()
                .filter_map(|i| match st.entries[i].desc { Desc::IFrame { bw: b, .. } => Some((b.abs_diff(*bw), i)), _ => None })
                .min()
                .map(|(_, i)| i),
            Desc::Key { ord, .. } | Desc::Map { ord, .. } => fresh
                .iter()
                .copied()
                .find(|i| matches!(st.entries[*i].desc, Desc::Key { ord: o, .. } | Desc::Map { ord: o, .. } if o == *ord))
                .or_else(|| fresh.first().copied()),
            Desc::Entry => None,
        };
        let Some(src) = pick else { return false };
        // An alias: it keeps its own identity (`seen`), so re-reads never
        // take it for the entry it borrows from.
        let url = st.entries[src].url.clone();
        if st.stats.remaps.len() < 8 {
            let line = format!("{:?} -> {:?}", st.entries[id].seen, st.entries[src].seen);
            st.stats.remaps.push(line);
        }
        let e = &mut st.entries[id];
        e.url = url;
        e.gen_ = g;
        st.stats.remapped += 1;
        true
    }

    /// One upstream GET with the session's headers (or a forced answer).
    fn upstream(&self, s: &Session, url: &str, extra: &[(&str, String)]) -> Result<Upstream, Fail> {
        let headers = {
            let mut st = s.st();
            st.stats.upstream += 1;
            if let Some((code, n)) = st.force {
                st.force = (n > 1).then_some((code, n - 1));
                *st.stats.statuses.entry(format!("forced{code}")).or_default() += 1;
                return Ok(Upstream::Forced(code));
            }
            st.stats.with_headers += 1;
            browser_headers(&st.headers, url)
        };
        match self.http.get(url, &headers, extra) {
            Ok(resp) => {
                let code = resp.status().as_u16();
                *s.st().stats.statuses.entry(code.to_string()).or_default() += 1;
                Ok(Upstream::Resp(Box::new(resp)))
            }
            Err(e) => {
                log::info!("stream: upstream request failed: {}", e.text);
                *s.st().stats.statuses.entry("network".into()).or_default() += 1;
                Err(Fail::Status(502))
            }
        }
    }

    fn fetch_playlist(&self, s: &Session, url: &str) -> Result<Fetched, Fail> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let resp = match self.upstream(s, url, &[]) {
                Ok(Upstream::Forced(code)) => return Ok(Fetched::Status(code)),
                Ok(Upstream::Resp(r)) => r,
                Err(_) if attempt < 3 => {
                    std::thread::sleep(Duration::from_millis(300));
                    continue;
                }
                Err(f) => return Err(f),
            };
            let mut resp = *resp;
            let code = resp.status().as_u16();
            if (code >= 500 || code == 429) && attempt < 3 {
                std::thread::sleep(Duration::from_millis(500));
                continue;
            }
            if !(200..300).contains(&code) {
                return Ok(Fetched::Status(code));
            }
            let base = resp.get_uri().to_string();
            let mut buf = Vec::new();
            resp.body_mut()
                .with_config()
                .limit(PLAYLIST_LIMIT)
                .reader()
                .read_to_end(&mut buf)
                .map_err(|_| Fail::Status(502))?;
            let base = if valid_url(&base) { base } else { url.to_owned() };
            return Ok(Fetched::Text(String::from_utf8_lossy(&buf).into_owned(), base));
        }
    }

    /// Holds a refused request (link generation `seen`) for a fresh link:
    /// emits `expired` once per generation and waits up to the hold. True
    /// when a fresh link came.
    fn hold(&self, s: &Session, seen: u64, code: u16) -> bool {
        let start = Instant::now();
        let first = {
            let mut st = s.st();
            st.stats.holds += 1;
            if st.expired_for == Some(seen) || st.gen_ != seen {
                false
            } else {
                st.expired_for = Some(seen);
                st.stats.expired += 1;
                true
            }
        };
        if first {
            log::info!("stream: session {} upstream answered {code}: holding for a fresh link", s.sid);
            self.emit(&s.sid, "expired", json!({ "status": code }));
        }
        let mut st = s.st();
        loop {
            if st.closed.is_some() {
                return false;
            }
            if st.gen_ != seen {
                break;
            }
            let left = self.hold.saturating_sub(start.elapsed());
            if left.is_zero() {
                break;
            }
            st = s.cv.wait_timeout(st, left).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
        }
        let ms = start.elapsed().as_millis() as u64;
        st.stats.hold_ms_max = st.stats.hold_ms_max.max(ms);
        let fresh = st.gen_ != seen;
        drop(st);
        if !fresh {
            self.emit(
                &s.sid,
                "error",
                json!({ "reason": "expired", "fatal": false, "message": format!("upstream answered {code} and no fresh link came within {} s", self.hold.as_secs()) }),
            );
        }
        fresh
    }

    fn serve_playlist(&self, s: &Session, id: usize, out: &mut TcpStream, req: &Request, head: bool) -> Result<(), Fail> {
        let mut held = false;
        loop {
            let (url, seen, _) = self.fresh_url(s, id)?;
            match self.fetch_playlist(s, &url)? {
                Fetched::Status(code) if policy::is_auth_status(code) => {
                    if self.hold(s, seen, code) {
                        held = true;
                        continue;
                    }
                    return Err(Fail::Status(code));
                }
                Fetched::Status(code) => return Err(Fail::Status(code)),
                Fetched::Text(text, base) => {
                    let body = {
                        let mut st = s.st();
                        st.stats.playlists += 1;
                        if held {
                            st.stats.recovered += 1;
                        }
                        playlist::rewrite(&text, &base, id, &mut *st)
                    };
                    let body = match body {
                        Ok(b) => b,
                        Err(RewriteError::Drm) => {
                            close_session(s, "drm");
                            self.emit(&s.sid, "error", json!({ "reason": "drm", "fatal": true, "message": "DRM-protected stream" }));
                            return Err(Fail::Status(403));
                        }
                        Err(RewriteError::NotPlaylist) => {
                            self.emit(&s.sid, "error", json!({ "reason": "upstream", "fatal": false, "message": "upstream playlist is not a playlist" }));
                            return Err(Fail::Status(502));
                        }
                    };
                    write!(
                        out,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nCache-Control: no-store\r\n{}\r\n",
                        body.len(),
                        conn_hdr(req.close)
                    )?;
                    if !head {
                        out.write_all(body.as_bytes())?;
                        s.st().stats.bytes += body.len() as u64;
                    }
                    return Ok(());
                }
            }
        }
    }

    fn serve_media(&self, s: &Session, id: usize, out: &mut TcpStream, req: &Request, head: bool) -> Result<(), Fail> {
        if req.range.is_some() {
            s.st().stats.ranges += 1;
        }
        let mut held = false;
        let mut attempt = 0;
        loop {
            attempt += 1;
            let (url, seen, role) = self.fresh_url(s, id)?;
            let mut extra = vec![("Accept-Encoding", "identity".to_owned())];
            if let Some(r) = &req.range {
                extra.push(("Range", r.clone()));
            }
            let up = match self.upstream(s, &url, &extra) {
                Err(_) if attempt < 3 => {
                    std::thread::sleep(Duration::from_millis(300));
                    continue;
                }
                r => r?,
            };
            let resp = match up {
                Upstream::Forced(code) => Err(code),
                Upstream::Resp(r) => {
                    let code = r.status().as_u16();
                    if (200..300).contains(&code) { Ok(r) } else { Err(code) }
                }
            };
            let resp = match resp {
                Ok(r) => r,
                Err(code) if policy::is_auth_status(code) => {
                    if self.hold(s, seen, code) {
                        held = true;
                        continue;
                    }
                    return Err(Fail::Status(code));
                }
                Err(code) if (code >= 500 || code == 429) && attempt < 3 => {
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                }
                Err(code) => return Err(Fail::Status(code)),
            };
            {
                let mut st = s.st();
                if role == Role::Segment {
                    st.stats.segments += 1;
                }
                if held {
                    st.stats.recovered += 1;
                }
            }
            return self.stream_body(s, id, role, *resp, out, req, head);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn stream_body(
        &self,
        s: &Session,
        id: usize,
        role: Role,
        mut resp: http::Response,
        out: &mut TcpStream,
        req: &Request,
        head: bool,
    ) -> Result<(), Fail> {
        let code = resp.status().as_u16();
        // A body the client decodes (gzip) has no known length any more.
        let encoded = http::header(&resp, "content-encoding").is_some_and(|v| !v.trim().eq_ignore_ascii_case("identity"));
        let len = if encoded { None } else { http::content_length(&resp) };
        let ctype = server::content_type(&s.st().entries[id].name);
        let conn = conn_hdr(req.close);
        // (status line, extra headers, bytes to skip, bytes to send).
        let (status, range_hdr, skip, mut take): (&str, String, u64, Option<u64>) = match (code, &req.range) {
            (206, _) => {
                let cr = http::header(&resp, "content-range").filter(|v| !v.contains(['\r', '\n']));
                ("206 Partial Content", cr.map(|v| format!("Content-Range: {v}\r\n")).unwrap_or_default(), 0, len)
            }
            (_, Some(range)) => match len {
                Some(total) => match server::parse_range(Some(range), total) {
                    Ok(Some((a, b))) => {
                        s.st().stats.ranges_emulated += 1;
                        ("206 Partial Content", format!("Content-Range: bytes {a}-{b}/{total}\r\n"), a, Some(b - a + 1))
                    }
                    Ok(None) => ("200 OK", String::new(), 0, Some(total)),
                    Err(()) => {
                        write!(out, "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\n{conn}\r\n")?;
                        return Ok(());
                    }
                },
                // Unknown length: only an open range from 0 is the whole body.
                None if range.trim().replace(' ', "") == "bytes=0-" => ("200 OK", String::new(), 0, None),
                None => return Err(Fail::Status(502)),
            },
            _ => ("200 OK", String::new(), 0, len),
        };
        let mut reader = resp.body_mut().as_reader();
        if skip > 0 {
            let skipped = io::copy(&mut (&mut reader).take(skip), &mut io::sink()).map_err(|_| Fail::Gone)?;
            if skipped < skip {
                return Err(Fail::Gone);
            }
        }
        // A whole segment: look at its start for a fake image header.
        let mut first: Vec<u8> = Vec::new();
        if role == Role::Segment && req.range.is_none() && code == 200 && !head {
            let mut buf = vec![0u8; SNIFF];
            let mut got = 0;
            while got < SNIFF {
                match reader.read(&mut buf[got..]) {
                    Ok(0) => break,
                    Ok(n) => got += n,
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => return Err(Fail::Gone),
                }
                // Only an image start is worth reading further for.
                if got >= 8 && !is_image(&buf[..got]) {
                    break;
                }
            }
            buf.truncate(got);
            if let Some(k) = disguise_offset(&buf) {
                buf.drain(..k);
                take = take.map(|t| t.saturating_sub(k as u64));
                s.st().stats.stripped_headers += 1;
            }
            first = buf;
        }
        let chunked = take.is_none();
        let length_hdr = match take {
            Some(n) => format!("Content-Length: {n}\r\n"),
            None => "Transfer-Encoding: chunked\r\n".to_owned(),
        };
        write!(out, "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nAccept-Ranges: bytes\r\n{length_hdr}{range_hdr}Cache-Control: no-store\r\n{conn}\r\n")?;
        if head {
            return Ok(());
        }
        let mut left = take;
        let mut sent = 0u64;
        let mut write = |out: &mut TcpStream, data: &[u8]| -> Result<(), Fail> {
            if data.is_empty() {
                return Ok(());
            }
            if chunked {
                write!(out, "{:x}\r\n", data.len())?;
                out.write_all(data)?;
                out.write_all(b"\r\n")?;
            } else {
                out.write_all(data)?;
            }
            sent += data.len() as u64;
            Ok(())
        };
        if !first.is_empty() {
            let n = left.map_or(first.len(), |l| (l as usize).min(first.len()));
            write(out, &first[..n])?;
            if let Some(l) = left.as_mut() {
                *l -= n as u64;
            }
        }
        drop(first);
        let mut buf = vec![0u8; CHUNK];
        loop {
            let want = left.map_or(CHUNK, |l| (l.min(CHUNK as u64)) as usize);
            if want == 0 {
                break;
            }
            let n = match reader.read(&mut buf[..want]) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                // Upstream broke mid-body: the promised length cannot be kept.
                Err(_) => return Err(Fail::Gone),
            };
            write(out, &buf[..n])?;
            if let Some(l) = left.as_mut() {
                *l -= n as u64;
            }
        }
        s.st().stats.bytes += sent;
        if chunked {
            out.write_all(b"0\r\n\r\n")?;
        } else if left.is_some_and(|l| l > 0) {
            return Err(Fail::Gone);
        }
        Ok(())
    }

    /// A `stats` event, at most every 5 s (or now when `force`).
    fn maybe_stats(&self, s: &Session, force: bool) {
        let stats = {
            let mut st = s.st();
            if !force && st.last_stats.elapsed() < Duration::from_secs(5) {
                return;
            }
            st.last_stats = Instant::now();
            serde_json::to_value(&st.stats).unwrap_or(Value::Null)
        };
        self.emit(&s.sid, "stats", json!({ "stats": stats }));
    }
}

fn close_session(s: &Session, why: &str) {
    let mut st = s.st();
    if st.closed.is_none() {
        st.closed = Some(why.to_owned());
        log::info!("stream: session {} ended ({why})", s.sid);
    }
    drop(st);
    s.cv.notify_all();
}

enum Upstream {
    Resp(Box<http::Response>),
    Forced(u16),
}

enum Fetched {
    /// The body and the URL it came from (after redirects).
    Text(String, String),
    Status(u16),
}

fn conn_hdr(close: bool) -> &'static str {
    if close { "Connection: close\r\n" } else { "" }
}

struct Request {
    method: String,
    path: String,
    range: Option<String>,
    close: bool,
}

fn read_request(r: &mut BufReader<TcpStream>) -> io::Result<Option<Request>> {
    let mut line = String::new();
    if r.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_owned();
    let path = parts.next().unwrap_or("").to_owned();
    let mut close = parts.next().is_some_and(|v| v == "HTTP/1.0");
    let mut range = None;
    let mut total = 0usize;
    loop {
        let mut h = String::new();
        let n = r.read_line(&mut h)?;
        total += n;
        if n == 0 || total > 64 * 1024 {
            return Ok(None);
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            let k = k.trim().to_ascii_lowercase();
            let v = v.trim();
            if k == "range" && !v.contains(['\r', '\n']) {
                range = Some(v.to_owned());
            } else if k == "connection" {
                close = v.eq_ignore_ascii_case("close");
            }
        }
    }
    Ok(Some(Request { method, path, range, close }))
}

fn simple(out: &mut TcpStream, code: u16, close: bool) -> io::Result<()> {
    let text = match code {
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        410 => "Gone",
        416 => "Range Not Satisfiable",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Error",
    };
    write!(out, "HTTP/1.1 {code} {text}\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n{}\r\n", conn_hdr(close))
}

// --- The process-wide proxy --------------------------------------------------------------

static SINK: Mutex<Option<Sink>> = Mutex::new(None);
static PROXY: Mutex<Option<Arc<Proxy>>> = Mutex::new(None);

/// Where `dl.stream.event`s go; call once before [`call`] (Android, the
/// desktop's [`register`]).
pub(crate) fn init(sink: Sink) {
    *SINK.lock().unwrap_or_else(|e| e.into_inner()) = Some(sink);
}

/// The proxy, started on first use.
fn proxy() -> Option<Arc<Proxy>> {
    let mut p = PROXY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = p.as_ref() {
        return Some(p.clone());
    }
    let sink = SINK.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_else(|| Arc::new(|_| {}));
    match Proxy::start(sink, HOLD) {
        Ok(started) => {
            log::info!("stream: proxy on 127.0.0.1:{}", started.port);
            *p = Some(started.clone());
            Some(started)
        }
        Err(e) => {
            log::warn!("stream: no proxy: {e}");
            None
        }
    }
}

/// Op `name` (`"dl.stream.open"`, …) with `data`; blocks (call it off the
/// UI thread). Unknown names → `{ok: false, error: "unknown op"}`.
pub(crate) fn call(name: &str, data: &Value) -> Value {
    match proxy() {
        Some(p) => p.call(name, data),
        None => json!({ "ok": false, "error": "no local proxy" }),
    }
}

/// Registers `dl.stream.*` on the desktop's host channel.
pub(crate) fn register(host: &nsh_engine::HostChannel) {
    let events = host.clone();
    init(Arc::new(move |v| {
        let _ = events.send("dl.stream.event", v);
    }));
    for name in ["dl.stream.open", "dl.stream.update", "dl.stream.close", "dl.stream.stats", "dl.stream.debug"] {
        host.handle(name, move |call: nsh_engine::HostCall| {
            // Handlers must return at once: the ops may wait on the network.
            let spawned = std::thread::Builder::new().name("rustflix-stream-call".into()).spawn(move || {
                let value = self::call(name, call.data());
                call.resolve(value);
            });
            if let Err(err) = spawned {
                log::warn!("stream: no thread for the call: {err}");
            }
        });
    }
}
