//! End-to-end tests of the downloader: a [`Manager`] on temp folders against
//! a scriptable local origin serving a tiny generated HLS stream and an mp4.

use std::{
    collections::{HashMap, VecDeque},
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use serde_json::{Value, json};

use super::*;

// --- A scriptable origin ---------------------------------------------------------------

#[derive(Clone, Default)]
struct Route {
    body: Vec<u8>,
    /// Statuses answered (with an empty body) before the real one.
    fail_first: VecDeque<u16>,
    /// Always this status.
    always: Option<u16>,
    /// Honour `Range: bytes=N-`.
    ranges: bool,
    /// Close the connection after this many body bytes, once.
    cut_after: Option<usize>,
    content_type: Option<&'static str>,
}

#[derive(Default)]
struct OriginState {
    routes: HashMap<String, Route>,
    /// (path with query, headers) of every request.
    log: Vec<(String, HashMap<String, String>)>,
}

#[derive(Clone)]
struct Origin {
    port: u16,
    st: Arc<Mutex<OriginState>>,
}

impl Origin {
    fn start() -> Origin {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let st = Arc::new(Mutex::new(OriginState::default()));
        let st2 = st.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                let st = st2.clone();
                std::thread::spawn(move || serve_origin(conn, &st));
            }
        });
        Origin { port, st }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn set(&self, path: &str, route: Route) {
        self.st.lock().unwrap().routes.insert(path.to_owned(), route);
    }

    fn edit(&self, path: &str, f: impl FnOnce(&mut Route)) {
        f(self.st.lock().unwrap().routes.get_mut(path).unwrap());
    }

    /// Requests whose path (without query) is `path`.
    fn hits(&self, path: &str) -> usize {
        self.st.lock().unwrap().log.iter().filter(|(p, _)| p.split('?').next() == Some(path)).count()
    }

    fn log(&self) -> Vec<(String, HashMap<String, String>)> {
        self.st.lock().unwrap().log.clone()
    }
}

fn serve_origin(conn: TcpStream, st: &Mutex<OriginState>) {
    let mut out = conn.try_clone().unwrap();
    let mut r = BufReader::new(conn);
    let mut line = String::new();
    if r.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let target = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
    let mut headers = HashMap::new();
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).unwrap_or(0) == 0 || h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
        }
    }
    let path = target.split('?').next().unwrap_or("/").to_owned();
    let route = {
        let mut s = st.lock().unwrap();
        s.log.push((target.clone(), headers.clone()));
        // Exact target first (queries matter for some routes), then the path.
        let key = if s.routes.contains_key(&target) { target.clone() } else { path };
        match s.routes.get_mut(&key) {
            None => None,
            Some(rt) => {
                let status = rt.always.or_else(|| rt.fail_first.pop_front());
                let cut = if status.is_none() { rt.cut_after.take() } else { None };
                Some((rt.clone(), status, cut))
            }
        }
    };
    let Some((rt, status, cut)) = route else {
        let _ = write!(out, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    };
    if let Some(code) = status {
        let _ = write!(out, "HTTP/1.1 {code} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    let ctype = rt.content_type.unwrap_or("application/octet-stream");
    let size = rt.body.len();
    let start = headers
        .get("range")
        .filter(|_| rt.ranges)
        .and_then(|v| v.strip_prefix("bytes="))
        .and_then(|v| v.strip_suffix('-'))
        .and_then(|v| v.parse::<usize>().ok());
    let (head, body) = match start {
        Some(a) if a >= size => {
            let _ = write!(out, "HTTP/1.1 416 X\r\nContent-Range: bytes */{size}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return;
        }
        Some(a) => (
            format!("HTTP/1.1 206 Partial Content\r\nContent-Type: {ctype}\r\nContent-Range: bytes {a}-{}/{size}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", size - 1, size - a),
            &rt.body[a..],
        ),
        None => (
            format!("HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n"),
            &rt.body[..],
        ),
    };
    let _ = out.write_all(head.as_bytes());
    let body = match cut {
        Some(n) => &body[..n.min(body.len())],
        None => body,
    };
    let _ = out.write_all(body);
}

fn ok(body: impl Into<Vec<u8>>) -> Route {
    Route { body: body.into(), ..Default::default() }
}

fn ts(n: u8) -> Vec<u8> {
    let mut v = vec![0x47u8; 188 * 4];
    v[1] = n;
    v
}

fn init_map() -> Vec<u8> {
    let mut v = b"\0\0\0\x18ftypiso6".to_vec();
    v.extend_from_slice(&[0u8; 64]);
    v
}

const SEGS: u8 = 6;

/// A master playlist (two variants), the chosen variant with an AES-128
/// key, an init map and [`SEGS`] segments, plus an unselected variant.
fn hls_origin(o: &Origin, base: &str, query: &str) {
    o.set(
        &format!("{base}/master.m3u8"),
        ok(format!(
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180\nlow.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nhi/index.m3u8{query}\n"
        )),
    );
    let mut media = format!(
        "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n\
#EXT-X-KEY:METHOD=AES-128,URI=\"/keys/k.bin{query}\",IV=0x0102\n#EXT-X-MAP:URI=\"init.mp4{query}\"\n"
    );
    for i in 0..SEGS {
        media.push_str(&format!("#EXTINF:4.0,\nseg{i}.ts{query}\n"));
    }
    media.push_str("#EXT-X-ENDLIST\n");
    o.set(&format!("{base}/hi/index.m3u8"), ok(media));
    o.set("/keys/k.bin", ok(vec![7u8; 16]));
    o.set(&format!("{base}/hi/init.mp4"), ok(init_map()));
    for i in 0..SEGS {
        o.set(&format!("{base}/hi/seg{i}.ts"), ok(ts(i)));
    }
}

// --- A manager on temp folders ----------------------------------------------------------

struct Rig {
    m: Arc<Manager>,
    root: PathBuf,
    events: Arc<Mutex<Vec<Value>>>,
    free: Arc<AtomicU64>,
    trashed: Arc<Mutex<Vec<PathBuf>>>,
}

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rustflix-dl-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::canonicalize(&dir).unwrap()
}

fn rig_in(root: &Path, force_copy: bool) -> Rig {
    let events = Arc::new(Mutex::new(Vec::new()));
    let free = Arc::new(AtomicU64::new(50_000_000_000));
    let trashed = Arc::new(Mutex::new(Vec::new()));
    let (ev, fr, tr) = (events.clone(), free.clone(), trashed.clone());
    let cfg = Config {
        store: root.join("data/rustflix-downloads.json"),
        default_dir: root.join("Downloads/rustflix"),
        home: root.to_string_lossy().into_owned(),
        forbidden: vec![root.join("forbidden")],
        min_free: MIN_FREE,
        min_free_running: MIN_FREE_RUNNING,
        free_space: Arc::new(move |_| Some(fr.load(Ordering::Relaxed))),
        sink: Arc::new(move |v| ev.lock().unwrap().push(v)),
        trash: Arc::new(move |parent: &Path, folder: &Path, id: u64| {
            if crate::files::record_folder(parent, folder, Some(id)).is_none() {
                return false;
            }
            tr.lock().unwrap().push(folder.to_path_buf());
            fs::remove_dir_all(folder).is_ok()
        }),
        reveal: Arc::new(|_| true),
        force_copy,
    };
    Rig { m: Manager::new(cfg), root: root.to_path_buf(), events, free, trashed }
}

fn rig(name: &str) -> Rig {
    rig_in(&temp(name), false)
}

impl Rig {
    fn rec(&self, id: u64) -> Value {
        self.m.list().as_array().unwrap().iter().find(|r| r["id"] == id).cloned().unwrap_or(Value::Null)
    }

    /// Waits for record `id` to leave `running`; its record.
    fn settle(&self, id: u64, secs: u64) -> Value {
        let end = Instant::now() + Duration::from_secs(secs);
        loop {
            let r = self.rec(id);
            if r["status"] != "running" {
                // Let the job thread end.
                std::thread::sleep(Duration::from_millis(30));
                return r;
            }
            assert!(Instant::now() < end, "still running: {r}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn start(&self, data: Value) -> Value {
        self.m.start(&data)
    }

    fn folder(&self, id: u64) -> PathBuf {
        PathBuf::from(self.rec(id)["dir"].as_str().unwrap())
    }
}

fn names_of(dir: &Path) -> Vec<String> {
    let mut v = store::names(dir);
    v.sort();
    v
}

fn meta() -> Value {
    json!({ "key": "tv:1:1:2", "type": "tv", "mediaId": 1, "season": 1, "episode": 2, "title": "Show" })
}

// --- Tests -------------------------------------------------------------------------------

#[test]
fn ids_from_js() {
    assert_eq!(id_of(Some(&json!(3))), Some(3));
    assert_eq!(id_of(Some(&json!(3.0))), Some(3));
    assert_eq!(id_of(Some(&json!("12"))), Some(12));
    for bad in [json!(0), json!(-1), json!(1.5), json!(true), json!(null), json!("x")] {
        assert_eq!(id_of(Some(&bad)), None, "{bad}");
    }
}

#[test]
fn hls_end_to_end_with_local_playback() {
    let o = Origin::start();
    hls_origin(&o, "/v", "?sig=1");
    o.edit("/v/hi/seg2.ts", |r| r.fail_first = [503, 500].into());
    o.edit("/v/hi/seg4.ts", |r| r.fail_first = [429].into());
    let r = rig("hls");
    let res = r.start(json!({
        "url": o.url("/v/master.m3u8?sig=1"), "name": "Show S1E2", "kind": "hls",
        "headers": { "Referer": "https://embed.example/", "User-Agent": "TestUA", "Range": "bytes=9-" },
        "meta": meta(),
    }));
    assert_eq!(res["ok"], true, "{res}");
    let id = res["id"].as_u64().unwrap();
    let rec = r.settle(id, 20);
    assert_eq!(rec["status"], "done", "{rec}");
    assert_eq!(rec["kind"], "hls");
    assert_eq!(rec["progress"], 100.0);
    assert_eq!(rec["done"], 8); // key + map + 6 segments
    assert_eq!(rec["total"], 8);
    assert_eq!(rec["type"], "tv");
    assert_eq!(rec["episode"], 2);
    let folder = r.folder(id);
    assert_eq!(folder, r.root.join("Downloads/rustflix/Show S1E2"));
    assert_eq!(rec["file"], folder.join("index.m3u8").to_string_lossy().as_ref());
    let names = names_of(&folder);
    assert!(!names.contains(&".manifest.json".to_owned()), "{names:?}");
    assert!(names.contains(&".rustflix-download".to_owned()));
    assert!(names.iter().all(|n| !n.ends_with(".part")), "{names:?}");
    assert_eq!(names.iter().filter(|n| n.ends_with(".ts")).count(), SEGS as usize);
    // Local playlists only: no network, the unselected variant gone.
    let root_pl = fs::read_to_string(folder.join("index.m3u8")).unwrap();
    assert!(!root_pl.contains("low.m3u8") && !root_pl.contains("http"), "{root_pl}");
    assert!(root_pl.contains("p1.m3u8"));
    let media = fs::read_to_string(folder.join("p1.m3u8")).unwrap();
    assert!(!media.contains("http") && !media.contains("sig="), "{media}");
    let key_name = media.split("URI=\"").nth(1).unwrap().split('"').next().unwrap().to_owned();
    assert_eq!(fs::read(folder.join(&key_name)).unwrap(), vec![7u8; 16], "the key was saved and its URI rewritten");
    assert!(media.contains(".m4s\"") || media.contains("#EXT-X-MAP:URI=\"f"), "{media}");
    // Every request carried the record's headers (never the reserved Range).
    let log = o.log();
    assert!(log.len() >= 10);
    for (path, h) in &log {
        assert_eq!(h.get("referer").map(String::as_str), Some("https://embed.example/"), "{path}");
        assert_eq!(h.get("user-agent").map(String::as_str), Some("TestUA"), "{path}");
        assert!(!h.contains_key("range"), "{path}");
    }
    assert_eq!(o.hits("/v/hi/seg2.ts"), 3);
    assert_eq!(o.hits("/v/low.m3u8"), 0);
    // Headers are stripped once done; the record persisted.
    let saved = store::load(&r.root.join("data/rustflix-downloads.json"));
    let srec = saved.records.iter().find(|x| x.id == id).unwrap();
    assert!(srec.headers.is_none());
    assert_eq!(srec.status, "done");
    // Events: a status change goes out at once, ending with done.
    let evs = r.events.lock().unwrap().clone();
    assert_eq!(evs.first().unwrap()["status"], "running");
    assert_eq!(evs.last().unwrap()["status"], "done");

    // Local playback through the media server.
    let pu = r.m.play_url(&json!({ "id": id }));
    assert_eq!(pu["ok"], true);
    let url = pu["url"].as_str().unwrap().to_owned();
    let rest = url.strip_prefix("http://127.0.0.1:").unwrap();
    let (port, path) = rest.split_once('/').unwrap();
    let port: u16 = port.parse().unwrap();
    let base = format!("/{}", path.rsplit_once('/').unwrap().0);
    let (st, _, body) = server::tests::get(port, &format!("/{path}"), "");
    assert!(st.contains("200"), "{st}");
    assert!(String::from_utf8_lossy(&body).contains("src=\"index.m3u8\""));
    let (st, h, _) = server::tests::get(port, &format!("{base}/index.m3u8"), "");
    assert!(st.contains("200"));
    assert_eq!(h["content-type"], "application/vnd.apple.mpegurl");
    let seg = names.iter().find(|n| n.ends_with(".ts")).unwrap();
    let (st, h, body) = server::tests::get(port, &format!("{base}/{seg}"), "Range: bytes=0-9\r\n");
    assert!(st.contains("206"), "{st}");
    assert_eq!(h["content-type"], "video/mp2t");
    assert_eq!(body.len(), 10);
    let (st, _, _) = server::tests::get(port, &format!("{base}/.rustflix-download"), "");
    assert!(st.contains("404"));
    assert_eq!(r.m.play_url(&json!({ "id": 999 }))["ok"], false);

    // A done id: dl.start says so.
    assert_eq!(r.start(json!({ "id": id }))["status"], "done");
    // Remove: the record goes, its folder to the Trash.
    assert_eq!(r.m.remove(&json!({ "id": id }))["trashed"], true);
    assert!(!folder.exists());
    assert_eq!(r.trashed.lock().unwrap().as_slice(), [folder]);
    assert_eq!(r.rec(id), Value::Null);
    let (st, _, _) = server::tests::get(port, &format!("{base}/index.m3u8"), "");
    assert!(st.contains("404"));
    fs::remove_dir_all(&r.root).unwrap();
}

#[test]
fn hls_failure_then_resume_fetches_only_what_is_missing() {
    let o = Origin::start();
    hls_origin(&o, "/r", "");
    o.edit("/r/hi/seg3.ts", |r| r.always = Some(404));
    let r = rig("resume");
    let id = r.start(json!({ "url": o.url("/r/master.m3u8"), "name": "Movie", "kind": "hls" }))["id"].as_u64().unwrap();
    let rec = r.settle(id, 20);
    assert_eq!(rec["status"], "error");
    assert_eq!(rec["reason"], "failed");
    assert!(rec["message"].as_str().unwrap().contains("HTTP 404"), "{rec}");
    let folder = r.folder(id);
    assert!(folder.join(".manifest.json").exists(), "the manifest stays for a resume");
    assert_eq!(o.hits("/r/hi/seg3.ts"), 3, "other 4xx: 3 attempts");
    let before: HashMap<String, usize> = (0..SEGS).map(|i| (format!("/r/hi/seg{i}.ts"), o.hits(&format!("/r/hi/seg{i}.ts")))).collect();
    // The origin heals; the same record continues (no new link).
    o.edit("/r/hi/seg3.ts", |r| r.always = None);
    let res = r.start(json!({ "id": id }));
    assert_eq!(res["resumed"], true, "{res}");
    assert_eq!(r.settle(id, 20)["status"], "done");
    for i in 0..SEGS {
        let p = format!("/r/hi/seg{i}.ts");
        let again = o.hits(&p) - before[&p];
        assert_eq!(again, usize::from(i == 3), "{p} fetched again {again} times");
    }
    assert_eq!(o.hits("/r/master.m3u8"), 1, "the saved manifest is used, no re-read");
    fs::remove_dir_all(&r.root).unwrap();
}

#[test]
fn expiry_then_a_fresh_link_maps_saved_segments() {
    let o = Origin::start();
    hls_origin(&o, "/e", "?sig=old");
    // The old link: segments 4 and 5 are refused (a signed link that ran out).
    o.set("/e/hi/seg4.ts?sig=old", Route { always: Some(403), ..Default::default() });
    o.set("/e/hi/seg5.ts?sig=old", Route { always: Some(403), ..Default::default() });
    let r = rig("expiry");
    let id = r.start(json!({ "url": o.url("/e/master.m3u8?sig=old"), "name": "Ep", "kind": "hls", "id": 40 }))["id"]
        .as_u64()
        .unwrap();
    assert_eq!(id, 40, "an unknown id creates the record with that id");
    let rec = r.settle(id, 20);
    assert_eq!(rec["status"], "error");
    assert_eq!(rec["reason"], "expired", "{rec}");
    assert_eq!(rec["done"], 6, "{rec}");
    let seg0 = o.hits("/e/hi/seg0.ts");
    // The app resolves a fresh link (new query, another master URL).
    let fresh = o.url("/e/master.m3u8?sig=new");
    hls_origin(&o, "/e", "?sig=new");
    let res = r.start(json!({ "id": id, "url": fresh, "headers": { "Referer": "https://x/" } }));
    assert_eq!(res["ok"], true);
    let rec = r.settle(id, 20);
    assert_eq!(rec["status"], "done", "{rec}");
    assert_eq!(o.hits("/e/hi/seg0.ts"), seg0, "saved segments are not fetched again");
    let log = o.log();
    let refetched: Vec<&String> = log.iter().map(|(p, _)| p).filter(|p| p.contains("sig=new") && p.contains("seg")).collect();
    assert_eq!(refetched.len(), 2, "{refetched:?}");
    fs::remove_dir_all(&r.root).unwrap();
}

#[test]
fn expiry_rules_end_to_end() {
    let o = Origin::start();
    // A 410 for the playlist: expired at once.
    o.set("/gone.m3u8", Route { always: Some(410), ..Default::default() });
    // A 403 for a segment of a link whose timestamp has passed: expired at once.
    o.set("/old.m3u8", ok("#EXTM3U\n#EXTINF:4,\ns.ts?Expires=1500000000\n#EXT-X-ENDLIST\n"));
    o.set("/s.ts", Route { always: Some(403), ..Default::default() });
    // A 403 for the playlist itself.
    o.set("/forbidden.m3u8", Route { always: Some(403), ..Default::default() });
    // DRM.
    o.set("/drm.m3u8", ok("#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://k\",KEYFORMAT=\"com.apple.streamingkeydelivery\"\n#EXTINF:4,\na.ts\n"));
    let r = rig("expiry-rules");
    let mut out = vec![];
    for (p, want) in [("/gone.m3u8", "expired"), ("/old.m3u8", "expired"), ("/forbidden.m3u8", "expired"), ("/drm.m3u8", "drm")] {
        let id = r.start(json!({ "url": o.url(p), "name": p, "kind": "hls" }))["id"].as_u64().unwrap();
        out.push((id, want));
    }
    for (id, want) in out {
        let rec = r.settle(id, 10);
        assert_eq!(rec["status"], "error");
        assert_eq!(rec["reason"], want, "{rec}");
    }
    assert_eq!(o.hits("/s.ts"), 1);
    assert_eq!(o.hits("/gone.m3u8"), 1);
    fs::remove_dir_all(&r.root).unwrap();
}

#[test]
fn progressive_file_resumes_with_ranges() {
    let o = Origin::start();
    let body: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    o.set("/v/movie.mp4", Route { body: body.clone(), ranges: true, cut_after: Some(70_000), content_type: Some("video/mp4"), ..Default::default() });
    let r = rig("file");
    let id = r.start(json!({ "url": o.url("/v/movie.mp4?token=1"), "name": "A Movie: Part 2", "meta": meta() }))["id"].as_u64().unwrap();
    let rec = r.settle(id, 20);
    assert_eq!(rec["status"], "done", "{rec}");
    assert_eq!(rec["kind"], "file");
    assert_eq!(rec["totalBytes"], 200_000);
    let folder = r.folder(id);
    assert_eq!(folder.file_name().unwrap(), "A Movie- Part 2");
    let file = PathBuf::from(rec["file"].as_str().unwrap());
    assert_eq!(file, folder.join("A Movie- Part 2.mp4"));
    assert_eq!(fs::read(&file).unwrap(), body);
    let log = o.log();
    assert_eq!(log.len(), 2);
    assert_eq!(log[1].1.get("range").map(String::as_str), Some("bytes=70000-"), "the second request continued");
    assert_eq!(log[0].1.get("accept-encoding").map(String::as_str), Some("identity"));
    assert_eq!(names_of(&folder), [".rustflix-download", "A Movie- Part 2.mp4"]);

    // A server that ignores ranges: the partial file restarts from 0.
    o.set("/v/norange.webm", Route { body: body.clone(), cut_after: Some(50_000), ..Default::default() });
    let id = r.start(json!({ "url": o.url("/v/norange.webm"), "name": "B" }))["id"].as_u64().unwrap();
    let rec = r.settle(id, 20);
    assert_eq!(rec["status"], "done");
    assert!(rec["file"].as_str().unwrap().ends_with("B.webm"));
    assert_eq!(fs::read(rec["file"].as_str().unwrap()).unwrap(), body);
    // An HTML error page with 200: retried as a server error, then failed.
    o.set("/v/err.mp4", Route { body: b"<!DOCTYPE html><title>Error</title>".to_vec(), ..Default::default() });
    let id = r.start(json!({ "url": o.url("/v/err.mp4"), "name": "C" }))["id"].as_u64().unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    assert!(o.hits("/v/err.mp4") >= 2, "retried");
    r.m.cancel(&json!({ "id": id }));
    assert_eq!(r.rec(id)["reason"], "cancelled");
    fs::remove_dir_all(&r.root).unwrap();
}

#[test]
fn cancel_keeps_files_and_start_continues() {
    let o = Origin::start();
    let body = vec![5u8; 300_000];
    o.set("/big.mp4", Route { body: body.clone(), ranges: true, cut_after: Some(100_000), ..Default::default() });
    // The first transfer breaks off; every attempt after it fails, so the
    // record is cancelled mid-way with a partial file.
    let r = rig("cancel");
    let id = r.start(json!({ "url": o.url("/big.mp4"), "name": "Big" }))["id"].as_u64().unwrap();
    let end = Instant::now() + Duration::from_secs(5);
    let folder = r.folder(id);
    while !folder.join(store::FILE_PART).exists() || o.hits("/big.mp4") < 1 {
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(5));
    }
    o.edit("/big.mp4", |r| r.always = Some(503));
    std::thread::sleep(Duration::from_millis(300));
    r.m.cancel(&json!({ "id": id }));
    let rec = r.rec(id);
    assert_eq!(rec["status"], "error");
    assert_eq!(rec["reason"], "cancelled");
    std::thread::sleep(Duration::from_millis(200));
    assert!(fs::metadata(folder.join(store::FILE_PART)).unwrap().len() >= 100_000, "the partial file stays");
    o.edit("/big.mp4", |r| r.always = None);
    assert_eq!(r.start(json!({ "id": id }))["resumed"], true);
    let rec = r.settle(id, 20);
    assert_eq!(rec["status"], "done", "{rec}");
    assert_eq!(fs::read(rec["file"].as_str().unwrap()).unwrap(), body);
    assert!(o.log().iter().any(|(_, h)| h.get("range").is_some_and(|v| v != "bytes=0-")));
    fs::remove_dir_all(&r.root).unwrap();
}

#[test]
fn space_refusal_and_bad_input() {
    let r = rig("space");
    r.free.store(500 * 1024 * 1024, Ordering::Relaxed);
    let res = r.start(json!({ "url": "https://cdn.example/x.m3u8", "name": "X" }));
    assert_eq!(res["ok"], false);
    assert_eq!(res["reason"], "space");
    assert_eq!(res["free"], 500 * 1024 * 1024);
    assert!(res["error"].as_str().unwrap().contains("1 GB"));
    r.free.store(50_000_000_000, Ordering::Relaxed);
    for bad in [json!({}), json!({ "url": "ftp://x/y" }), json!({ "url": "not a url" }), json!({ "id": 77 })] {
        assert_eq!(r.start(bad.clone())["ok"], false, "{bad}");
    }
    let sp = r.m.space();
    assert_eq!(sp["used"], 0);
    assert_eq!(sp["minFree"], MIN_FREE);
    let a = r.m.next_id()["id"].as_u64().unwrap();
    assert_eq!(r.m.next_id()["id"].as_u64().unwrap(), a + 1);
    fs::remove_dir_all(&r.root).unwrap();
}

#[test]
fn launch_reconciliation() {
    let root = temp("reconcile");
    let o = Origin::start();
    o.set("/ok.mp4", Route { body: vec![1u8; 1000], ranges: true, ..Default::default() });
    let dir = root.join("Downloads/rustflix");
    let rec = |id: u64, url: String, folder: &str| store::Record {
        id,
        name: folder.into(),
        status: "running".into(),
        kind: "file".into(),
        url,
        headers: Some(BTreeMap::new()),
        folder: dir.join(folder),
        created_at: id as f64,
        ..Default::default()
    };
    let saved = store::Saved {
        v: 1,
        next_id: 3,
        dir: String::new(),
        configured: false,
        records: vec![
            rec(1, format!("{}?exp=1500000000", o.url("/ok.mp4")), "Expired"),
            rec(2, o.url("/ok.mp4"), "Valid"),
            store::Record { id: 5, status: "done".into(), headers: Some(BTreeMap::new()), folder: dir.join("Done"), ..Default::default() },
        ],
    };
    store::save(&root.join("data/rustflix-downloads.json"), &saved).unwrap();
    let r = rig_in(&root, false);
    let a = r.rec(1);
    assert_eq!(a["status"], "error");
    assert_eq!(a["reason"], "expired");
    let b = r.settle(2, 10);
    assert_eq!(b["status"], "done", "{b}");
    assert_eq!(r.m.next_id()["id"], 6);
    // Newest first.
    let ids: Vec<u64> = r.m.list().as_array().unwrap().iter().map(|x| x["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, [2, 1, 5]);
    let opts = r.m.options(&json!({}));
    assert_eq!(opts["dir"], dir.to_string_lossy().as_ref());
    assert_eq!(opts["configured"], false);
    drop(r);
    // Done records lost their headers on load.
    let s = store::load(&root.join("data/rustflix-downloads.json"));
    assert!(s.records.iter().find(|x| x.id == 5).unwrap().headers.is_none());
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn shutdown_leaves_running_records_to_resume() {
    let root = temp("quit");
    let o = Origin::start();
    o.set("/slow.mp4", Route { always: Some(503), ..Default::default() });
    let r = rig_in(&root, false);
    let id = r.start(json!({ "url": o.url("/slow.mp4"), "name": "Slow" }))["id"].as_u64().unwrap();
    std::thread::sleep(Duration::from_millis(100));
    r.m.shutdown(Duration::from_secs(2));
    let s = store::load(&root.join("data/rustflix-downloads.json"));
    assert_eq!(s.records[0].status, "running", "resumed on the next launch");
    drop(r);
    o.edit("/slow.mp4", |r| {
        r.always = None;
        r.body = vec![2u8; 10];
    });
    let r = rig_in(&root, false);
    assert_eq!(r.settle(id, 10)["status"], "done");
    fs::remove_dir_all(&root).unwrap();
}

fn done_file_record(r: &Rig, o: &Origin, name: &str) -> u64 {
    let path = format!("/f/{}.mp4", name.replace(' ', "_"));
    o.set(&path, ok(vec![3u8; 2048]));
    let id = r.start(json!({ "url": o.url(&path), "name": name }))["id"].as_u64().unwrap();
    assert_eq!(r.settle(id, 10)["status"], "done");
    id
}

#[test]
fn changing_the_download_folder_moves_every_download() {
    for force_copy in [false, true] {
        let root = temp(&format!("move-{force_copy}"));
        let o = Origin::start();
        let r = rig_in(&root, force_copy);
        let a = done_file_record(&r, &o, "Alpha");
        let b = done_file_record(&r, &o, "Beta");
        let old_a = r.folder(a);
        let new_dir = root.join("Elsewhere/Movies");
        // A different "Beta" already waits there: Beta stays behind.
        fs::create_dir_all(new_dir.join("Beta")).unwrap();
        fs::write(new_dir.join("Beta/theirs.txt"), b"keep").unwrap();
        r.events.lock().unwrap().clear();
        let res = r.m.options(&json!({ "dir": new_dir.to_string_lossy() }));
        assert_eq!(res["ok"], true, "{res}");
        assert_eq!(res["moved"], 1);
        assert!(res["error"].as_str().unwrap().contains("Beta"), "{res}");
        assert_eq!(res["dir"], new_dir.to_string_lossy().as_ref());
        assert!(!old_a.exists());
        assert_eq!(r.folder(a), new_dir.join("Alpha"));
        assert!(new_dir.join("Alpha/Alpha.mp4").is_file());
        assert_eq!(r.rec(a)["file"], new_dir.join("Alpha/Alpha.mp4").to_string_lossy().as_ref());
        assert_eq!(r.folder(b), root.join("Downloads/rustflix/Beta"), "kept where it was");
        assert!(root.join("Downloads/rustflix/Beta/Beta.mp4").is_file());
        assert_eq!(fs::read(new_dir.join("Beta/theirs.txt")).unwrap(), b"keep");
        assert_eq!(r.events.lock().unwrap().len(), 1, "an event for the moved record");
        // Records and the folder were saved together.
        let s = store::load(&root.join("data/rustflix-downloads.json"));
        assert_eq!(s.dir, new_dir.to_string_lossy());
        assert!(s.configured);
        assert_eq!(s.records.iter().find(|x| x.id == a).unwrap().folder, new_dir.join("Alpha"));
        // Playback still works from the new place; new downloads go there.
        assert_eq!(r.m.play_url(&json!({ "id": a }))["ok"], true);
        let c = done_file_record(&r, &o, "Gamma");
        assert_eq!(r.folder(c), new_dir.join("Gamma"));
        assert!(r.m.space()["used"].as_u64().unwrap() >= 3 * 2048);
        // Refusals: the same folder, a forbidden one, a relative one.
        assert!(r.m.options(&json!({ "dir": new_dir.to_string_lossy() })).get("error").is_some());
        assert_eq!(r.m.options(&json!({ "dir": root.join("forbidden/x").to_string_lossy() }))["ok"], false);
        assert_eq!(r.m.options(&json!({ "dir": "relative" }))["ok"], false);
        // `~` is the home directory.
        let res = r.m.options(&json!({ "dir": "~/Third" }));
        assert_eq!(res["ok"], true, "{res}");
        assert_eq!(r.folder(a), root.join("Third/Alpha"));
        assert_eq!(r.folder(b), root.join("Third/Beta"), "the one left behind follows now");
        drop(r);
        fs::remove_dir_all(&root).unwrap();
    }
}

#[test]
fn no_folder_change_while_downloading() {
    let o = Origin::start();
    o.set("/busy.mp4", Route { always: Some(503), ..Default::default() });
    let r = rig("busy");
    let id = r.start(json!({ "url": o.url("/busy.mp4"), "name": "Busy" }))["id"].as_u64().unwrap();
    let res = r.m.options(&json!({ "dir": r.root.join("other").to_string_lossy() }));
    assert_eq!(res["ok"], false);
    assert!(res["error"].as_str().unwrap().contains("in progress"));
    // Cancelled: the change goes through.
    r.m.cancel(&json!({ "id": id }));
    let res = r.m.options(&json!({ "dir": r.root.join("other").to_string_lossy() }));
    assert_eq!(res["ok"], true, "{res}");
    assert_eq!(res["moved"], 1);
    assert_eq!(r.folder(id), r.root.join("other/Busy"));
    // Its resume continues in the new place.
    o.edit("/busy.mp4", |x| {
        x.always = None;
        x.body = vec![1; 100];
    });
    assert_eq!(r.start(json!({ "id": id }))["resumed"], true);
    let rec = r.settle(id, 10);
    assert_eq!(rec["status"], "done");
    assert!(rec["file"].as_str().unwrap().starts_with(&*r.root.join("other/Busy").to_string_lossy()));
    fs::remove_dir_all(&r.root).unwrap();
}

#[test]
fn removing_an_unfinished_download_trashes_its_partial_files() {
    let o = Origin::start();
    hls_origin(&o, "/u", "");
    o.edit("/u/hi/seg5.ts", |r| r.always = Some(503));
    let r = rig("remove");
    let id = r.start(json!({ "url": o.url("/u/master.m3u8"), "name": "Half", "kind": "hls" }))["id"].as_u64().unwrap();
    let folder = r.folder(id);
    let end = Instant::now() + Duration::from_secs(10);
    while o.hits("/u/hi/seg5.ts") < 2 {
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(20));
    }
    let res = r.m.remove(&json!({ "id": id }));
    assert_eq!(res["trashed"], true);
    assert!(!folder.exists());
    assert_eq!(r.rec(id), Value::Null);
    // A folder that is not the record's (no marker) is never trashed.
    let id2 = done_file_record(&r, &o, "Keep");
    let f2 = r.folder(id2);
    fs::remove_file(f2.join(store::MARKER)).unwrap();
    assert_eq!(r.m.remove(&json!({ "id": id2 }))["trashed"], false);
    assert!(f2.join("Keep.mp4").exists());
    fs::remove_dir_all(&r.root).unwrap();
}

#[test]
fn adopting_vid_dl_era_files() {
    let r = rig("adopt");
    let dir = r.root.join("Downloads/rustflix");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("Old Movie.mp4"), vec![9u8; 4096]).unwrap();
    fs::write(dir.join(".rustflix-subs-4.json"), br#"{"v":1,"lang":"en","cues":[]}"#).unwrap();
    fs::write(dir.join(".rustflix-player-4.html"), b"<video>").unwrap();
    let res = r.m.adopt(&json!({
        "file": dir.join("Old Movie.mp4"), "name": "Old Movie",
        "meta": { "key": "movie:40:0:0", "type": "movie", "mediaId": 40, "title": "Old Movie" },
        "createdAt": 1234,
        "subs": dir.join(".rustflix-subs-4.json"), "page": dir.join(".rustflix-player-4.html"),
    }));
    assert_eq!(res["ok"], true, "{res}");
    let id = res["id"].as_u64().unwrap();
    let rec = &res["record"];
    assert_eq!(rec["status"], "done");
    assert_eq!(rec["createdAt"], 1234.0);
    assert_eq!(rec["mediaId"], 40);
    assert_eq!(rec["file"], dir.join("Old Movie/Old Movie.mp4").to_string_lossy().as_ref());
    assert_eq!(res["subs"], r#"{"v":1,"lang":"en","cues":[]}"#);
    assert!(!dir.join(".rustflix-subs-4.json").exists() && !dir.join(".rustflix-player-4.html").exists());
    assert_eq!(names_of(&dir), ["Old Movie"]);
    assert_eq!(r.m.play_url(&json!({ "id": id }))["ok"], true);
    // Refused: a missing file, a file outside the download folder, not a video.
    assert_eq!(r.m.adopt(&json!({ "file": dir.join("Gone.mp4") }))["ok"], false);
    let outside = r.root.join("elsewhere");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("x.mp4"), b"x").unwrap();
    assert_eq!(r.m.adopt(&json!({ "file": outside.join("x.mp4") }))["ok"], false);
    fs::write(dir.join("notes.txt"), b"x").unwrap();
    assert_eq!(r.m.adopt(&json!({ "file": dir.join("notes.txt") }))["ok"], false);
    assert!(outside.join("x.mp4").exists() && dir.join("notes.txt").exists());
    fs::remove_dir_all(&r.root).unwrap();
}

#[test]
fn a_running_download_stops_when_space_runs_out() {
    let o = Origin::start();
    o.set("/s.mp4", Route { always: Some(503), ..Default::default() });
    let r = rig("lowspace");
    let id = r.start(json!({ "url": o.url("/s.mp4"), "name": "S" }))["id"].as_u64().unwrap();
    r.free.store(100 * 1024 * 1024, Ordering::Relaxed);
    r.m.tick(true);
    let rec = r.rec(id);
    assert_eq!(rec["status"], "error");
    assert_eq!(rec["reason"], "space");
    fs::remove_dir_all(&r.root).unwrap();
}
