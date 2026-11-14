//! The streaming proxy: playlist rewrite fixtures, and sessions end to end
//! against a scriptable local origin (as `src/dl/tests.rs` does).

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use serde_json::{Value, json};

use super::playlist::{self, Desc, Role, RewriteError, Table};
use super::*;

// --- Rewrite fixtures --------------------------------------------------------------------

#[derive(Default)]
struct Fake {
    rows: Vec<(usize, Desc, String, Role)>,
}

impl Table for Fake {
    fn register(&mut self, parent: usize, desc: Desc, url: String, role: Role) -> String {
        if let Some(i) = self.rows.iter().position(|r| r.0 == parent && r.3 == role && r.1.same(&desc)) {
            let name = playlist::local_name(i + 1, role, &self.rows[i].2);
            self.rows[i].2 = url;
            return name;
        }
        let name = playlist::local_name(self.rows.len() + 1, role, &url);
        self.rows.push((parent, desc, url, role));
        name
    }
}

impl Fake {
    fn url(&self, id: usize) -> &str {
        &self.rows[id - 1].2
    }
    fn role(&self, id: usize) -> Role {
        self.rows[id - 1].3
    }
}

const MASTER: &str = "#EXTM3U\r\n\
#EXT-X-VERSION:6\r\n\
#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"https://keys.example.com/k0?t=1\"\r\n\
#EXT-X-SESSION-DATA:DATA-ID=\"com.x.title\",VALUE=\"Movie\"\r\n\
#EXT-X-SESSION-DATA:DATA-ID=\"com.x.more\",URI=\"https://evil.example.com/data.json\"\r\n\
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"English\",LANGUAGE=\"en\",DEFAULT=YES,URI=\"audio/en.m3u8\"\r\n\
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"Deutsch\",LANGUAGE=\"de\",URI=\"https://cdn2.example.com/audio/de.m3u8?sig=a\"\r\n\
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"English\",LANGUAGE=\"en\",URI=\"subs/en.m3u8\"\r\n\
#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID=\"cc\",NAME=\"CC1\",INSTREAM-ID=\"CC1\"\r\n\
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS=\"avc1.4d401e,mp4a.40.2\",AUDIO=\"aud\",SUBTITLES=\"subs\"\r\n\
low/index.m3u8?token=abc\r\n\
\r\n\
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO=\"aud\"\r\n\
https://cdn2.example.com/hi/index.m3u8\r\n\
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x360,URI=\"iframes.m3u8\"\r\n";

#[test]
fn rewrites_a_master_playlist() {
    let mut t = Fake::default();
    let out = playlist::rewrite(MASTER, "https://cdn.example.com/v/master.m3u8?sig=1", 0, &mut t).unwrap();
    // Nothing upstream is left; every URI is a local name of the table.
    assert!(!out.contains("http") && !out.contains("audio/") && !out.contains('\r'), "{out}");
    assert!(out.contains("#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"k1.key\""), "{out}");
    assert!(out.contains("DATA-ID=\"com.x.title\""), "kept: no URI");
    assert!(!out.contains("com.x.more"), "a session data URI would go unproxied");
    assert!(out.contains("NAME=\"English\",LANGUAGE=\"en\",DEFAULT=YES,URI=\"p2.m3u8\""), "{out}");
    assert!(out.contains("NAME=\"Deutsch\",LANGUAGE=\"de\",URI=\"p3.m3u8\""), "{out}");
    assert!(out.contains("TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"English\",LANGUAGE=\"en\",URI=\"p4.m3u8\""), "{out}");
    assert!(out.contains("INSTREAM-ID=\"CC1\""), "a rendition with no URI stays");
    assert!(out.contains("SUBTITLES=\"subs\"\np5.m3u8\n"), "{out}");
    assert!(out.contains("AUDIO=\"aud\"\np6.m3u8\n"), "{out}");
    assert!(out.contains("#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x360,URI=\"p7.m3u8\""), "{out}");
    assert_eq!(t.url(1), "https://keys.example.com/k0?t=1");
    assert_eq!(t.url(2), "https://cdn.example.com/v/audio/en.m3u8");
    assert_eq!(t.url(3), "https://cdn2.example.com/audio/de.m3u8?sig=a");
    assert_eq!(t.url(5), "https://cdn.example.com/v/low/index.m3u8?token=abc");
    assert_eq!(t.url(6), "https://cdn2.example.com/hi/index.m3u8");
    assert_eq!(t.url(7), "https://cdn.example.com/v/iframes.m3u8");
    assert_eq!(t.role(1), Role::Key);
    assert!((2..=7).all(|i| t.role(i) == Role::Playlist));
    assert_eq!(t.rows.len(), 7);
}

const MEDIA: &str = "#EXTM3U\r\n\
#EXT-X-VERSION:7\r\n\
#EXT-X-TARGETDURATION:6\r\n\
#EXT-X-MEDIA-SEQUENCE:100\r\n\
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.0\r\n\
#EXT-X-PART-INF:PART-TARGET=0.5\r\n\
#EXT-X-KEY:METHOD=AES-128,URI=\"/keys/k1?sig=1\",IV=0x01\r\n\
#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"700@0\"\r\n\
#EXTINF:6,\r\n\
seg0.m4s?sig=1\r\n\
#EXTINF:6,\r\n\
../hi/seg1.m4s?sig=1\r\n\
#EXTINF:6,\r\n\
?part=3\r\n\
#EXT-X-KEY:METHOD=NONE\r\n\
#EXTINF:6,\r\n\
#EXT-X-BYTERANGE:1000@700\r\n\
https://other.example.com/all.mp4\r\n\
#EXTINF:6,\r\n\
#EXT-X-BYTERANGE:1000\r\n\
//edge.example.com/all.mp4\r\n\
#EXT-X-PART:DURATION=0.5,URI=\"part.m4s\"\r\n\
#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"hint.m4s\"\r\n\
#EXT-X-RENDITION-REPORT:URI=\"../lo/index.m3u8\",LAST-MSN=104\r\n\
#EXTINF:6,\r\n\
disguised.png\r\n\
#EXT-X-ENDLIST\r\n";

#[test]
fn rewrites_media_playlists() {
    let mut t = Fake::default();
    let base = "https://cdn2.example.com/hi/index.m3u8?sig=1";
    let out = playlist::rewrite(MEDIA, base, 6, &mut t).unwrap();
    assert!(!out.contains("http") && !out.contains("sig=") && !out.contains('\r'), "{out}");
    assert!(out.contains("#EXT-X-MEDIA-SEQUENCE:100\n"));
    assert!(out.contains("#EXT-X-KEY:METHOD=AES-128,URI=\"k1.key\",IV=0x01\n"), "{out}");
    assert!(out.contains("#EXT-X-MAP:URI=\"m2.mp4\",BYTERANGE=\"700@0\"\n"), "{out}");
    assert!(out.contains("#EXTINF:6,\nr3.m4s\n#EXTINF:6,\nr4.m4s\n#EXTINF:6,\nr5.ts\n#EXT-X-KEY:METHOD=NONE\n"), "{out}");
    // Byte ranges stay with their (local) URI: the player sends them as Range.
    assert!(out.contains("#EXT-X-BYTERANGE:1000@700\nr6.mp4\n#EXTINF:6,\n#EXT-X-BYTERANGE:1000\nr7.mp4\n"), "{out}");
    // A segment disguised as an image is named as TS.
    assert!(out.contains("\nr8.ts\n#EXT-X-ENDLIST\n"), "{out}");
    for gone in ["PART", "PRELOAD", "RENDITION-REPORT", "SERVER-CONTROL"] {
        assert!(!out.contains(gone), "{gone}: {out}");
    }
    assert_eq!(t.url(1), "https://cdn2.example.com/keys/k1?sig=1");
    assert_eq!(t.url(2), "https://cdn2.example.com/hi/init.mp4");
    assert_eq!(t.url(3), "https://cdn2.example.com/hi/seg0.m4s?sig=1");
    assert_eq!(t.url(4), "https://cdn2.example.com/hi/seg1.m4s?sig=1");
    assert_eq!(t.url(5), "https://cdn2.example.com/hi/index.m3u8?part=3");
    assert_eq!(t.url(6), "https://other.example.com/all.mp4");
    assert_eq!(t.url(7), "https://edge.example.com/all.mp4");
    // Segments are slotted by media sequence number.
    // Segments: media sequence number, start time (sum of EXTINF), duration.
    let segs: Vec<(u64, f64)> = t.rows.iter().filter_map(|r| match r.1 { Desc::Segment { seq, start, .. } => Some((seq, start)), _ => None }).collect();
    assert_eq!(segs, [(100, 0.0), (101, 6.0), (102, 12.0), (103, 18.0), (104, 24.0), (105, 30.0)]);
    assert!(t.rows.iter().all(|r| r.0 == 6));
}

#[test]
fn slots_keep_local_names_across_a_fresh_link() {
    let mut t = Fake::default();
    let a = playlist::rewrite(MEDIA, "https://cdn2.example.com/hi/index.m3u8?sig=1", 6, &mut t).unwrap();
    let n = t.rows.len();
    let fresh = MEDIA.replace("sig=1", "sig=2");
    let b = playlist::rewrite(&fresh, "https://cdn3.example.com/hi/index.m3u8?sig=2", 6, &mut t).unwrap();
    assert_eq!(a, b, "the same local playlist");
    assert_eq!(t.rows.len(), n, "no new entries");
    assert_eq!(t.url(3), "https://cdn3.example.com/hi/seg0.m4s?sig=2");
    let mut m = Fake::default();
    let x = playlist::rewrite(MASTER, "https://cdn.example.com/v/master.m3u8?sig=1", 0, &mut m).unwrap();
    let y = playlist::rewrite(&MASTER.replace("token=abc", "token=def"), "https://cdn.example.com/v/master.m3u8?sig=2", 0, &mut m).unwrap();
    assert_eq!(x, y);
    assert_eq!(m.url(5), "https://cdn.example.com/v/low/index.m3u8?token=def");
}

#[test]
fn drm_and_non_playlists_are_refused() {
    for key in [
        "#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://x\",KEYFORMAT=\"com.apple.streamingkeydelivery\"",
        "#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI=\"data:x\"",
        "#EXT-X-KEY:METHOD=AES-128,URI=\"k\",KEYFORMAT=\"com.apple.streamingkeydelivery\"",
        "#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI=\"skd://x\"",
    ] {
        let text = format!("#EXTM3U\n{key}\n#EXTINF:4,\na.ts\n");
        assert_eq!(playlist::rewrite(&text, "http://h/p.m3u8", 0, &mut Fake::default()), Err(RewriteError::Drm), "{key}");
    }
    let ok = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k.bin\",KEYFORMAT=\"identity\"\n#EXTINF:4,\na.ts\n";
    assert!(playlist::rewrite(ok, "http://h/p.m3u8", 0, &mut Fake::default()).is_ok());
    for bad in ["<html>403</html>", "", "\u{1}\u{2}binary"] {
        assert_eq!(playlist::rewrite(bad, "http://h/p.m3u8", 0, &mut Fake::default()), Err(RewriteError::NotPlaylist));
    }
    assert!(playlist::is_playlist("\u{feff}\n #EXTM3U\n"));
}

#[test]
fn local_names() {
    assert_eq!(playlist::local_name(0, Role::Playlist, "x"), "index.m3u8");
    assert_eq!(playlist::local_name(3, Role::Segment, "https://h/a/b.TS?x=1"), "r3.ts");
    assert_eq!(playlist::local_name(3, Role::Segment, "https://h/a/b.jpg"), "r3.ts");
    assert_eq!(playlist::local_name(4, Role::Map, "https://h/init"), "m4.mp4");
    assert_eq!(playlist::local_name(0, Role::File, "https://h/v.m4v?e=1"), "f0.m4v");
    assert_eq!(playlist::local_name(0, Role::File, "https://h/v"), "f0.mp4");
    for (name, want) in [("index.m3u8", Some((0, 'p'))), ("p12.m3u8", Some((12, 'p'))), ("r7.ts", Some((7, 'r'))), ("k1.key", Some((1, 'k')))] {
        assert_eq!(playlist::parse_name(name), want, "{name}");
    }
    for bad in ["x1.ts", "r.ts", "r1", "r1.", "r-1.ts", "r1.t/s", "r1.ts%2F..", "p1234567890.m3u8", "index.m3u8x"] {
        assert_eq!(playlist::parse_name(bad), None, "{bad}");
    }
}

// --- A scriptable origin ------------------------------------------------------------------

#[derive(Clone, Default)]
struct Route {
    body: Vec<u8>,
    /// Always answer this status (empty body).
    status: Option<u16>,
    /// Answer 403 unless the query contains this.
    need: Option<String>,
    ranges: bool,
    /// No Content-Length: the body ends when the connection closes.
    no_length: bool,
    /// A generated body of this many bytes (counted in `written`).
    big: Option<u64>,
}

#[derive(Default)]
struct OriginState {
    routes: HashMap<String, Route>,
    log: Vec<(String, HashMap<String, String>)>,
}

#[derive(Clone)]
struct Origin {
    port: u16,
    st: Arc<Mutex<OriginState>>,
    written: Arc<AtomicU64>,
}

impl Origin {
    fn start() -> Origin {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let o = Origin { port, st: Arc::default(), written: Arc::default() };
        let o2 = o.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                let o = o2.clone();
                std::thread::spawn(move || o.serve(conn));
            }
        });
        o
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn set(&self, path: &str, route: Route) {
        self.st.lock().unwrap().routes.insert(path.to_owned(), route);
    }

    fn text(&self, path: &str, body: &str) {
        self.set(path, Route { body: body.as_bytes().to_vec(), ..Default::default() });
    }

    fn log(&self) -> Vec<(String, HashMap<String, String>)> {
        self.st.lock().unwrap().log.clone()
    }

    fn serve(&self, conn: TcpStream) {
        let mut out = conn.try_clone().unwrap();
        let mut r = BufReader::new(conn);
        loop {
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
            let (path, query) = target.split_once('?').unwrap_or((&target, ""));
            let route = {
                let mut s = self.st.lock().unwrap();
                s.log.push((target.clone(), headers.clone()));
                s.routes.get(path).cloned()
            };
            let Some(rt) = route else {
                let _ = write!(out, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                continue;
            };
            let refused = rt.status.or_else(|| rt.need.as_ref().filter(|n| !query.contains(n.as_str())).map(|_| 403));
            if let Some(code) = refused {
                let _ = write!(out, "HTTP/1.1 {code} X\r\nContent-Length: 0\r\n\r\n");
                continue;
            }
            if let Some(n) = rt.big {
                let _ = write!(out, "HTTP/1.1 200 OK\r\nContent-Length: {n}\r\nConnection: close\r\n\r\n");
                let chunk = vec![7u8; 64 * 1024];
                let mut left = n;
                while left > 0 {
                    let k = left.min(chunk.len() as u64) as usize;
                    if out.write_all(&chunk[..k]).is_err() {
                        return;
                    }
                    self.written.fetch_add(k as u64, Ordering::Relaxed);
                    left -= k as u64;
                }
                return;
            }
            let size = rt.body.len();
            let range = headers.get("range").filter(|_| rt.ranges).and_then(|v| crate::dl::server::parse_range(Some(v), size as u64).ok().flatten());
            let (head, body) = match range {
                Some((a, b)) => (
                    format!("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {a}-{b}/{size}\r\nContent-Length: {}\r\n", b - a + 1),
                    &rt.body[a as usize..=b as usize],
                ),
                None if rt.no_length => ("HTTP/1.1 200 OK\r\nConnection: close\r\n".to_owned(), &rt.body[..]),
                None => (format!("HTTP/1.1 200 OK\r\nContent-Length: {size}\r\n"), &rt.body[..]),
            };
            let _ = write!(out, "{head}\r\n");
            let _ = out.write_all(body);
            if rt.no_length {
                return;
            }
        }
    }
}

/// A request to the proxy: (status, headers, body), chunked bodies decoded.
fn get(port: u16, path: &str, extra: &str) -> (u16, HashMap<String, String>, Vec<u8>) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(s, "GET {path} HTTP/1.1\r\nHost: x\r\n{extra}Connection: close\r\n\r\n").unwrap();
    let mut all = Vec::new();
    s.read_to_end(&mut all).unwrap();
    let split = all.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&all[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
    let headers: HashMap<String, String> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let mut body = all[split + 4..].to_vec();
    if headers.get("transfer-encoding").is_some_and(|v| v == "chunked") {
        let mut out = Vec::new();
        let mut rest = &body[..];
        loop {
            let eol = rest.windows(2).position(|w| w == b"\r\n").unwrap();
            let n = usize::from_str_radix(std::str::from_utf8(&rest[..eol]).unwrap(), 16).unwrap();
            rest = &rest[eol + 2..];
            if n == 0 {
                break;
            }
            out.extend_from_slice(&rest[..n]);
            rest = &rest[n + 2..];
        }
        body = out;
    }
    (status, headers, body)
}

struct Rig {
    proxy: Arc<Proxy>,
    events: mpsc::Receiver<Value>,
}

impl Rig {
    fn new(hold: Duration) -> Rig {
        let (tx, events) = mpsc::channel();
        let tx = Mutex::new(tx);
        let proxy = Proxy::start(Arc::new(move |v| {
            let _ = tx.lock().unwrap().send(v);
        }), hold)
        .unwrap();
        Rig { proxy, events }
    }

    fn open(&self, url: &str, kind: &str) -> (String, String) {
        let r = self.proxy.open(&json!({
            "url": url, "kind": kind,
            "headers": { "Referer": "https://embed.example/", "User-Agent": "TestKit/1", "X-Test": "yes", "Range": "bytes=0-1" },
        }));
        assert_eq!(r["ok"], true, "{r}");
        let url = r["url"].as_str().unwrap().to_owned();
        (r["sid"].as_str().unwrap().to_owned(), url.strip_prefix(&format!("http://127.0.0.1:{}", self.proxy.port)).unwrap().to_owned())
    }

    /// The next event of `kind`, waiting up to `limit`.
    fn wait(&self, kind: &str, limit: Duration) -> Option<Value> {
        let end = Instant::now() + limit;
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match self.events.recv_timeout(left) {
                Ok(v) if v["type"] == kind => return Some(v),
                Ok(_) => continue,
                Err(_) => return None,
            }
        }
        None
    }
}

/// The local names a playlist lists (URI lines and URI attributes).
fn names(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for l in text.lines() {
        if let Some(u) = crate::dl::hls::attr(l, "URI") {
            out.push(u);
        } else if !l.starts_with('#') && !l.is_empty() {
            out.push(l.to_owned());
        }
    }
    out
}

fn segment(i: u8) -> Vec<u8> {
    (0..5000u32).map(|n| (n as u8).wrapping_mul(i).wrapping_add(i)).collect()
}

// --- Sessions end to end -------------------------------------------------------------------

#[test]
fn plays_hls_through_the_proxy_with_the_page_headers_on_every_request() {
    let o = Origin::start();
    o.text(
        "/v/master.m3u8",
        "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"en\",URI=\"audio/en.m3u8\"\n\
#EXT-X-STREAM-INF:BANDWIDTH=900000,AUDIO=\"a\"\nhi/index.m3u8?sig=1\n",
    );
    let abs = o.url("/v/hi/s1.ts?sig=1");
    o.text(
        "/v/hi/index.m3u8",
        &format!("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"/keys/k?sig=1\"\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\ns0.ts?sig=1\n#EXTINF:4,\n{abs}\n#EXT-X-ENDLIST\n"),
    );
    o.text("/v/audio/en.m3u8", "#EXTM3U\n#EXTINF:4,\na0.aac\n#EXT-X-ENDLIST\n");
    o.set("/keys/k", Route { body: b"0123456789abcdef".to_vec(), ..Default::default() });
    o.set("/v/hi/init.mp4", Route { body: b"\0\0\0\x18ftypiso6".to_vec(), ..Default::default() });
    o.set("/v/hi/s0.ts", Route { body: segment(1), ..Default::default() });
    o.set("/v/hi/s1.ts", Route { body: segment(2), ..Default::default() });
    o.set("/v/audio/a0.aac", Route { body: segment(3), ..Default::default() });

    let rig = Rig::new(Duration::from_secs(2));
    let (sid, entry) = rig.open(&o.url("/v/master.m3u8"), "hls");
    let p = rig.proxy.port;
    assert!(entry.ends_with(&format!("/s/{sid}/index.m3u8")));
    let dir = entry.trim_end_matches("index.m3u8").to_owned();

    let (st, h, master) = get(p, &entry, "");
    assert_eq!(st, 200);
    assert_eq!(h["content-type"], "application/vnd.apple.mpegurl");
    let master = String::from_utf8(master).unwrap();
    assert!(!master.contains("http") && !master.contains("sig"), "{master}");
    let mut bodies = Vec::new();
    for pl in names(&master) {
        let (st, _, text) = get(p, &format!("{dir}{pl}"), "");
        assert_eq!(st, 200, "{pl}");
        let text = String::from_utf8(text).unwrap();
        assert!(!text.contains("http"), "{text}");
        for n in names(&text) {
            let (st, _, body) = get(p, &format!("{dir}{n}"), "");
            assert_eq!(st, 200, "{n}");
            bodies.push(body);
        }
    }
    assert_eq!(bodies.len(), 5);
    assert!(bodies.contains(&segment(1)) && bodies.contains(&segment(2)) && bodies.contains(&segment(3)));
    assert!(bodies.contains(&b"0123456789abcdef".to_vec()));

    // Every upstream request carried the page's headers (and not the Range
    // JS tried to set: transfer headers are the proxy's own).
    let log = o.log();
    assert_eq!(log.len(), 8, "{log:?}");
    for (target, hdrs) in &log {
        assert_eq!(hdrs.get("referer").map(String::as_str), Some("https://embed.example/"), "{target}");
        assert_eq!(hdrs.get("user-agent").map(String::as_str), Some("TestKit/1"), "{target}");
        assert_eq!(hdrs.get("x-test").map(String::as_str), Some("yes"), "{target}");
        assert!(!hdrs.contains_key("range"), "{target}");
    }
    let stats = rig.proxy.stats(&json!({ "sid": sid }));
    assert_eq!(stats["stats"]["upstream"], 8);
    assert_eq!(stats["stats"]["withHeaders"], 8);
    assert_eq!(stats["stats"]["statuses"]["200"], 8);
    assert_eq!(stats["stats"]["headerNames"], json!(["Referer", "User-Agent", "X-Test"]));

    // Not an open proxy: only the session's own table is served.
    let before = o.log().len();
    let tok = &rig.proxy.token;
    for bad in [
        format!("{dir}r99.ts"),
        format!("{dir}p1.ts"),
        format!("{dir}r1.m3u8"),
        format!("{dir}x1.ts"),
        format!("{dir}index.m3u8/../../x"),
        format!("{dir}r2.ts/extra"),
        format!("/{tok}/s/0000000000000000/index.m3u8"),
        format!("/nottoken/s/{sid}/index.m3u8"),
        format!("/{tok}/x/{sid}/index.m3u8"),
        format!("{dir}r99.ts?url=http://evil.example/x.ts"),
        format!("{dir}index.m3u8?url={}", o.url("/keys/k")),
        format!("/{tok}/s/{sid}/"),
    ] {
        let (st, _, body) = get(p, &bad, "");
        if bad.contains("index.m3u8?url=") {
            // The query is ignored: it is the session's own entry.
            assert_eq!(st, 200, "{bad}");
            assert!(!String::from_utf8_lossy(&body).contains("0123456789abcdef"));
        } else {
            assert_eq!(st, 404, "{bad}");
        }
    }
    assert!(o.log()[before..].iter().all(|(t, _)| t.starts_with("/v/master.m3u8")), "{:?}", &o.log()[before..]);
    assert!(rig.proxy.close(&json!({ "sid": sid }))["ok"] == true);
    assert_eq!(get(p, &entry, "").0, 404, "closed sessions serve nothing");
}

#[test]
fn ranges_pass_through_and_a_200_is_cut_into_the_206_asked_for() {
    let o = Origin::start();
    let body: Vec<u8> = (0..100_000u32).map(|n| (n % 251) as u8).collect();
    o.set("/m/ranged.mp4", Route { body: body.clone(), ranges: true, ..Default::default() });
    o.set("/m/plain.mp4", Route { body: body.clone(), ..Default::default() });
    let rig = Rig::new(Duration::from_secs(1));
    let p = rig.proxy.port;
    for (path, emulated) in [("/m/ranged.mp4", false), ("/m/plain.mp4", true)] {
        let (sid, local) = rig.open(&o.url(path), "file");
        assert!(local.ends_with("/f0.mp4"), "{local}");
        let (st, h, b) = get(p, &local, "Range: bytes=1000-1999\r\n");
        assert_eq!(st, 206, "{path}");
        assert_eq!(h["content-range"], "bytes 1000-1999/100000", "{path}");
        assert_eq!(h["content-type"], "video/mp4");
        assert_eq!(b, &body[1000..2000], "{path}");
        let (st, h, b) = get(p, &local, "Range: bytes=99990-\r\n");
        assert_eq!((st, h["content-range"].as_str()), (206, "bytes 99990-99999/100000"));
        assert_eq!(b, &body[99990..]);
        let (st, _, b) = get(p, &local, "Range: bytes=-10\r\n");
        assert_eq!(st, 206);
        assert_eq!(b, &body[99990..]);
        let (st, _, b) = get(p, &local, "");
        assert_eq!((st, b.len()), (200, body.len()));
        let stats = rig.proxy.stats(&json!({ "sid": sid }));
        assert_eq!(stats["stats"]["rangesEmulated"].as_u64().unwrap() > 0, emulated, "{stats}");
        // Range is the player's, forwarded as is.
        let last = o.log().into_iter().rev().find(|(_, h)| h.contains_key("range")).unwrap();
        assert_eq!(last.1["range"], "bytes=-10");
    }
    let (_, local) = rig.open(&o.url("/m/plain.mp4"), "file");
    assert_eq!(get(p, &local, "Range: bytes=200000-\r\n").0, 416);
}

#[test]
fn bodies_of_unknown_length_go_chunked() {
    let o = Origin::start();
    let body = segment(9).repeat(40);
    o.set("/c/x.ts", Route { body: body.clone(), no_length: true, ..Default::default() });
    o.text("/c/p.m3u8", "#EXTM3U\n#EXTINF:4,\nx.ts\n#EXT-X-ENDLIST\n");
    let rig = Rig::new(Duration::from_secs(1));
    let (_, entry) = rig.open(&o.url("/c/p.m3u8"), "hls");
    let dir = entry.trim_end_matches("index.m3u8").to_owned();
    let (_, _, text) = get(rig.proxy.port, &entry, "");
    let seg = names(&String::from_utf8(text).unwrap()).remove(0);
    let (st, h, b) = get(rig.proxy.port, &format!("{dir}{seg}"), "");
    assert_eq!(st, 200);
    assert_eq!(h["transfer-encoding"], "chunked");
    assert_eq!(h["content-type"], "video/mp2t");
    assert_eq!(b, body);
}

/// An origin whose signed links expire: playlists and segments need the
/// current `sig`.
fn expiring_origin(sig: &str) -> Origin {
    let o = Origin::start();
    publish(&o, sig);
    o.set("/e/s0.ts", Route { body: segment(4), need: Some(format!("sig={sig}")), ..Default::default() });
    o.set("/e/s1.ts", Route { body: segment(5), need: Some(format!("sig={sig}")), ..Default::default() });
    o
}

fn publish(o: &Origin, sig: &str) {
    o.set(
        "/e/master.m3u8",
        Route {
            body: format!("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8?sig={sig}\n").into_bytes(),
            need: Some(format!("sig={sig}")),
            ..Default::default()
        },
    );
    o.set(
        "/e/v.m3u8",
        Route {
            body: format!("#EXTM3U\n#EXTINF:4,\ns0.ts?sig={sig}\n#EXTINF:4,\ns1.ts?sig={sig}\n#EXT-X-ENDLIST\n").into_bytes(),
            need: Some(format!("sig={sig}")),
            ..Default::default()
        },
    );
    for s in ["/e/s0.ts", "/e/s1.ts"] {
        if let Some(r) = o.st.lock().unwrap().routes.get_mut(s) {
            r.need = Some(format!("sig={sig}"));
        }
    }
}

/// (dir, local segment names) of a session's variant.
fn segments_of(port: u16, entry: &str) -> (String, Vec<String>) {
    let dir = entry.trim_end_matches("index.m3u8").to_owned();
    let (_, _, master) = get(port, entry, "");
    let variant = names(&String::from_utf8(master).unwrap()).remove(0);
    let (_, _, text) = get(port, &format!("{dir}{variant}"), "");
    (dir, names(&String::from_utf8(text).unwrap()))
}

#[test]
fn an_expired_link_holds_the_request_until_a_fresh_one_comes() {
    let o = expiring_origin("1");
    let rig = Arc::new(Rig::new(Duration::from_secs(10)));
    let (sid, entry) = rig.open(&o.url("/e/master.m3u8?sig=1"), "hls");
    let p = rig.proxy.port;
    let (dir, segs) = segments_of(p, &entry);
    assert_eq!(get(p, &format!("{dir}{}", segs[0]), "").2, segment(4));

    // The link expires upstream: the next segment is refused.
    publish(&o, "2");
    let path = format!("{dir}{}", segs[1]);
    let t0 = Instant::now();
    let player = std::thread::spawn(move || get(p, &path, ""));
    let ev = rig.wait("expired", Duration::from_secs(5)).expect("an expired event");
    assert_eq!(ev["sid"], sid.as_str());
    assert_eq!(ev["status"], 403);
    // The app resolves again and hands the fresh link over; the player's
    // request is still open meanwhile.
    std::thread::sleep(Duration::from_millis(300));
    assert!(!player.is_finished());
    let r = rig.proxy.update(&json!({ "sid": sid, "url": o.url("/e/master.m3u8?sig=2") }));
    assert_eq!(r["ok"], true);
    let (st, _, body) = player.join().unwrap();
    assert_eq!(st, 200);
    assert_eq!(body, segment(5), "the same local name, the fresh upstream URL");
    assert!(t0.elapsed() < Duration::from_secs(5));
    let stats = rig.proxy.stats(&json!({ "sid": sid }))["stats"].clone();
    assert_eq!(stats["expired"], 1);
    assert_eq!(stats["recovered"], 1);
    assert_eq!(stats["updates"], 1);
    assert!(stats["holdMsMax"].as_u64().unwrap() >= 300, "{stats}");
    // Local names never changed: the variant read again lists the same ones.
    let (_, again) = segments_of(p, &entry);
    assert_eq!(again, segs);
    assert!(o.log().iter().rev().take(3).all(|(t, _)| t.contains("sig=2")));
}

#[test]
fn without_a_fresh_link_the_player_gets_the_refusal_after_the_hold() {
    let o = expiring_origin("1");
    let rig = Rig::new(Duration::from_millis(400));
    let (sid, entry) = rig.open(&o.url("/e/master.m3u8?sig=1"), "hls");
    let p = rig.proxy.port;
    let (dir, segs) = segments_of(p, &entry);
    publish(&o, "2");
    let t0 = Instant::now();
    let (st, _, _) = get(p, &format!("{dir}{}", segs[0]), "");
    assert_eq!(st, 403);
    assert!(t0.elapsed() >= Duration::from_millis(400));
    assert!(rig.wait("expired", Duration::from_secs(1)).is_some());
    let err = rig.wait("error", Duration::from_secs(1)).expect("an error event");
    assert_eq!(err["reason"], "expired");
    assert_eq!(err["sid"], sid.as_str());
}

#[test]
fn a_forced_403_recovers_through_update() {
    let o = expiring_origin("1");
    let rig = Rig::new(Duration::from_secs(10));
    let (sid, entry) = rig.open(&o.url("/e/master.m3u8?sig=1"), "hls");
    let p = rig.proxy.port;
    let (dir, segs) = segments_of(p, &entry);
    assert_eq!(rig.proxy.debug(&json!({ "sid": sid, "status": 403, "count": 1 }))["ok"], true);
    let upstream_before = o.log().len();
    let path = format!("{dir}{}", segs[0]);
    let player = std::thread::spawn(move || get(p, &path, ""));
    assert!(rig.wait("expired", Duration::from_secs(5)).is_some());
    assert_eq!(o.log().len(), upstream_before, "a forced answer never reaches upstream");
    rig.proxy.update(&json!({ "sid": sid, "url": o.url("/e/master.m3u8?sig=1") }));
    let (st, _, body) = player.join().unwrap();
    assert_eq!((st, body), (200, segment(4)));
    let stats = rig.proxy.stats(&json!({ "sid": sid }))["stats"].clone();
    assert_eq!(stats["statuses"]["forced403"], 1);
    assert_eq!(stats["recovered"], 1);
}

#[test]
fn drm_ends_the_session() {
    let o = Origin::start();
    o.text("/d/p.m3u8", "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://k\"\n#EXTINF:4,\na.ts\n");
    let rig = Rig::new(Duration::from_secs(1));
    let (sid, entry) = rig.open(&o.url("/d/p.m3u8"), "hls");
    assert_eq!(get(rig.proxy.port, &entry, "").0, 403);
    let err = rig.wait("error", Duration::from_secs(1)).unwrap();
    assert_eq!((err["reason"].as_str(), err["sid"].as_str()), (Some("drm"), Some(sid.as_str())));
    assert_eq!(get(rig.proxy.port, &entry, "").0, 410, "ended");
}

#[test]
fn a_slow_player_slows_the_upstream_read() {
    const SIZE: u64 = 256 * 1024 * 1024;
    let o = Origin::start();
    o.set("/b/big.mp4", Route { big: Some(SIZE), ..Default::default() });
    let rig = Rig::new(Duration::from_secs(1));
    let (_, local) = rig.open(&o.url("/b/big.mp4"), "file");
    let mut s = TcpStream::connect(("127.0.0.1", rig.proxy.port)).unwrap();
    write!(s, "GET {local} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").unwrap();
    let mut got = 0u64;
    let mut buf = vec![0u8; 16 * 1024];
    // Read 2 MB, then stall: the proxy reads upstream only as fast as the
    // player takes the bytes (socket buffers aside), never the whole body.
    while got < 2 * 1024 * 1024 {
        got += s.read(&mut buf).unwrap() as u64;
    }
    std::thread::sleep(Duration::from_millis(1500));
    let written = o.written.load(Ordering::Relaxed);
    assert!(written < got + 48 * 1024 * 1024, "upstream sent {written} B while the player read {got} B");
    // It keeps flowing as the player reads on.
    let mark = written;
    let t0 = Instant::now();
    while got < 64 * 1024 * 1024 && t0.elapsed() < Duration::from_secs(20) {
        got += s.read(&mut buf).unwrap() as u64;
    }
    assert!(o.written.load(Ordering::Relaxed) > mark);
    drop(s);
    // Hanging up stops the upstream transfer too.
    std::thread::sleep(Duration::from_millis(500));
    let after = o.written.load(Ordering::Relaxed);
    std::thread::sleep(Duration::from_millis(500));
    assert!(o.written.load(Ordering::Relaxed) - after < 8 * 1024 * 1024);
    assert!(after < SIZE);
}


// --- Fresh links with another structure ------------------------------------------------------

/// A segment body that says which copy, variant and time it is.
fn seg_body(copy: &str, variant: &str, start: u32) -> Vec<u8> {
    format!("{copy}/{variant}/t={start}").into_bytes()
}

/// Copy A: 1080p + 720p + 360p, audio en/de, 4 s segments from sequence 0.
fn publish_a(o: &Origin) {
    o.text(
        "/a/master.m3u8",
        "#EXTM3U\n\
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"English\",LANGUAGE=\"en\",DEFAULT=YES,URI=\"en.m3u8?sig=1\"\n\
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"Deutsch\",LANGUAGE=\"de\",URI=\"de.m3u8?sig=1\"\n\
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS=\"avc1.640028,mp4a.40.2\",AUDIO=\"aud\"\nfhd.m3u8?sig=1\n\
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS=\"avc1.64001f,mp4a.40.2\",AUDIO=\"aud\"\nhd.m3u8?sig=1\n\
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS=\"avc1.64001e,mp4a.40.2\",AUDIO=\"aud\"\nsd.m3u8?sig=1\n",
    );
    for v in ["fhd", "hd", "sd", "en", "de"] {
        let mut text = String::from("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n");
        for i in 0..6u32 {
            text.push_str(&format!("#EXTINF:4.000,\n{v}-{i}.ts?sig=1\n"));
            o.set(&format!("/a/{v}-{i}.ts"), Route { body: seg_body("A", v, i * 4), ..Default::default() });
        }
        text.push_str("#EXT-X-ENDLIST\n");
        o.text(&format!("/a/{v}.m3u8"), &text);
    }
}

/// Copy B (the fresh link): another host path, variants in another order
/// with other bandwidths and no codecs, no 1080p, audio group renamed and
/// no German, media sequence from 7, other segment names; 720p cut in
/// 6 s segments.
fn publish_b(o: &Origin) {
    o.text(
        "/cdn2/b/master.m3u8",
        "#EXTM3U\n\
#EXT-X-STREAM-INF:BANDWIDTH=850000,RESOLUTION=640x360,AUDIO=\"a1\"\nv0/index.m3u8?tok=2\n\
#EXT-X-STREAM-INF:BANDWIDTH=2100000,RESOLUTION=1280x720,AUDIO=\"a1\"\nv1/index.m3u8?tok=2\n\
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a1\",NAME=\"English\",LANGUAGE=\"en\",DEFAULT=YES,URI=\"aud/en/index.m3u8?tok=2\"\n",
    );
    for (dir, v, step) in [("v0", "sd", 4u32), ("v1", "hd", 6), ("aud/en", "en", 4)] {
        let mut text = String::from("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:7\n");
        let mut t = 0;
        let mut i = 0;
        while t < 24 {
            text.push_str(&format!("#EXTINF:{step}.0,\nchunk-{i}.ts?tok=2\n"));
            o.set(&format!("/cdn2/b/{dir}/chunk-{i}.ts"), Route { body: seg_body("B", v, t), ..Default::default() });
            t += step;
            i += 1;
        }
        text.push_str("#EXT-X-ENDLIST\n");
        o.text(&format!("/cdn2/b/{dir}/index.m3u8"), &text);
    }
}

/// Every name the player has (master → playlists → segments), by playlist.
fn all_names(port: u16, entry: &str) -> (String, Vec<(String, Vec<String>)>) {
    let dir = entry.trim_end_matches("index.m3u8").to_owned();
    let (_, _, master) = get(port, entry, "");
    let mut out = Vec::new();
    for pl in names(&String::from_utf8(master).unwrap()) {
        let (st, _, text) = get(port, &format!("{dir}{pl}"), "");
        assert_eq!(st, 200, "{pl}");
        out.push((pl, names(&String::from_utf8(text).unwrap())));
    }
    (dir, out)
}

#[test]
fn a_fresh_link_with_another_structure_keeps_every_name() {
    let o = Origin::start();
    publish_a(&o);
    let rig = Rig::new(Duration::from_secs(5));
    let p = rig.proxy.port;
    let (sid, entry) = rig.open(&o.url("/a/master.m3u8"), "hls");
    let (dir, lists) = all_names(p, &entry);
    assert_eq!(lists.len(), 5, "en, de, fhd, hd, sd");
    // The player has played a little of each.
    for (_, segs) in &lists {
        assert_eq!(get(p, &format!("{dir}{}", segs[0]), "").0, 200);
    }
    // The link expires; the re-resolve gives copy B.
    for v in ["fhd", "hd", "sd", "en", "de"] {
        for i in 0..6 {
            o.set(&format!("/a/{v}-{i}.ts"), Route { status: Some(403), ..Default::default() });
        }
    }
    publish_b(&o);
    assert_eq!(rig.proxy.update(&json!({ "sid": sid, "url": o.url("/cdn2/b/master.m3u8") }))["ok"], true);
    assert!(rig.wait("updated", Duration::from_secs(1)).is_some());
    // Every name the player was given still answers, with the same time.
    let order = ["en", "de", "fhd", "hd", "sd"];
    for ((pl, segs), v) in lists.iter().zip(order) {
        for (i, seg) in segs.iter().enumerate() {
            let (st, _, body) = get(p, &format!("{dir}{seg}"), "");
            assert_eq!(st, 200, "{pl} {v} #{i} {seg}");
            let body = String::from_utf8(body).unwrap();
            let t = i as u32 * 4;
            let want = match v {
                // Same cut: the segment of the same time.
                "sd" | "en" => format!("B/{v}/t={t}"),
                // Cut in 6 s: the segment covering its start.
                "hd" => format!("B/hd/t={}", t / 6 * 6),
                // No 1080p any more: the nearest lower variant, same time.
                "fhd" => format!("B/hd/t={}", t / 6 * 6),
                // No German: the other audio of the group.
                "de" => format!("B/en/t={t}"),
                _ => unreachable!(),
            };
            assert_eq!(body, want, "{pl} #{i}");
        }
    }
    // Re-reading the (now fresh) master lists the names the player already
    // has for what has a counterpart — 360p, 720p, English — and nothing
    // new; the playlists cut the same way list the same segment names.
    let (_, again) = all_names(p, &entry);
    let old: HashMap<&str, &Vec<String>> = lists.iter().map(|(n, s)| (n.as_str(), s)).collect();
    let names_now: Vec<&str> = again.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names_now, [lists[4].0.as_str(), lists[3].0.as_str(), lists[0].0.as_str()], "sd, hd, en");
    assert_eq!(&again[0].1, old[lists[4].0.as_str()], "360p: same cut, same names");
    assert_eq!(&again[2].1, old[lists[0].0.as_str()], "English: same cut, same names");
    // A third read changes nothing.
    assert_eq!(all_names(p, &entry).1, again);
    let stats = rig.proxy.stats(&json!({ "sid": sid }))["stats"].clone();
    assert!(stats["remapped"].as_u64().unwrap() > 0, "{stats}");
    assert_eq!(stats["statuses"].get("404"), None, "{stats}");
    assert!(o.log().iter().rev().take(10).all(|(t, _)| t.starts_with("/cdn2/b/")));
}

#[test]
fn a_forced_403_with_a_structurally_different_fresh_link_recovers_at_once() {
    let o = Origin::start();
    publish_a(&o);
    publish_b(&o);
    let rig = Rig::new(Duration::from_secs(10));
    let p = rig.proxy.port;
    let (sid, entry) = rig.open(&o.url("/a/master.m3u8"), "hls");
    let (dir, lists) = all_names(p, &entry);
    rig.proxy.debug(&json!({ "sid": sid, "count": 1 }));
    let hd = lists[3].1[3].clone();
    let path = format!("{dir}{hd}");
    let t0 = Instant::now();
    let player = std::thread::spawn(move || get(p, &path, ""));
    assert!(rig.wait("expired", Duration::from_secs(2)).is_some());
    rig.proxy.update(&json!({ "sid": sid, "url": o.url("/cdn2/b/master.m3u8") }));
    let (st, _, body) = player.join().unwrap();
    assert_eq!((st, String::from_utf8(body).unwrap()), (200, "B/hd/t=12".to_owned()));
    assert!(t0.elapsed() < Duration::from_secs(2));
}

#[test]
fn nothing_to_stand_for_a_name_asks_for_a_relink() {
    let o = Origin::start();
    o.text("/r/a.m3u8", "#EXTM3U\n#EXTINF:4,\ns0.ts?sig=1\n#EXT-X-ENDLIST\n");
    o.set("/r/s0.ts", Route { body: b"x".to_vec(), ..Default::default() });
    o.text("/r/b.m3u8", "#EXTM3U\n#EXT-X-ENDLIST\n");
    let rig = Rig::new(Duration::from_secs(1));
    let (sid, entry) = rig.open(&o.url("/r/a.m3u8"), "hls");
    let (dir, segs) = {
        let dir = entry.trim_end_matches("index.m3u8").to_owned();
        let (_, _, t) = get(rig.proxy.port, &entry, "");
        (dir, names(&String::from_utf8(t).unwrap()))
    };
    rig.proxy.update(&json!({ "sid": sid, "url": o.url("/r/b.m3u8") }));
    assert_eq!(get(rig.proxy.port, &format!("{dir}{}", segs[0]), "").0, 404);
    let e = rig.wait("error", Duration::from_secs(1)).unwrap();
    assert_eq!((e["reason"].as_str(), e["fatal"].as_bool()), (Some("relink"), Some(false)));
}

#[test]
fn expiring_comes_before_the_link_expires() {
    let o = Origin::start();
    o.text("/x/p.m3u8", "#EXTM3U\n#EXTINF:4,\ns0.ts\n#EXT-X-ENDLIST\n");
    let rig = Rig::new(Duration::from_secs(1));
    let now = crate::dl::now_secs();
    let soon = now as u64 + 60;
    let (sid, _) = rig.open(&o.url(&format!("/x/p.m3u8?exp={soon}")), "hls");
    rig.proxy.housekeep(now);
    let e = rig.wait("expiring", Duration::from_secs(1)).expect("expiring");
    assert_eq!(e["sid"], sid.as_str());
    assert_eq!(e["expiresAt"].as_f64().unwrap() as u64, soon);
    // Once per link.
    rig.proxy.housekeep(now);
    assert!(rig.wait("expiring", Duration::from_millis(200)).is_none());
    // A fresh link far from expiry: nothing.
    rig.proxy.update(&json!({ "sid": sid, "url": o.url(&format!("/x/p.m3u8?exp={}", now as u64 + 7200)) }));
    rig.proxy.housekeep(now);
    assert!(rig.wait("expiring", Duration::from_millis(200)).is_none());
    assert_eq!(super::expiry_of("https://c/x.ts?a=1&Expires=1700000000000"), Some(1_700_000_000.0));
    assert_eq!(super::expiry_of("https://c/x.ts?type=1700000000"), None);
}

#[test]
fn sessions_are_shared_by_key_and_end_when_released_or_idle() {
    let o = Origin::start();
    o.text("/k/p.m3u8", "#EXTM3U\n#EXTINF:4,\ns0.ts\n#EXT-X-ENDLIST\n");
    let rig = Rig::new(Duration::from_secs(1));
    let a = rig.proxy.open(&json!({ "url": o.url("/k/p.m3u8"), "key": "tv:1:1:2" }));
    let b = rig.proxy.open(&json!({ "url": o.url("/k/p.m3u8?other=1"), "key": "tv:1:1:2" }));
    assert_eq!(a["sid"], b["sid"]);
    assert_eq!(b["shared"], true);
    let c = rig.proxy.open(&json!({ "url": o.url("/k/p.m3u8"), "key": "tv:1:1:3" }));
    assert_ne!(a["sid"], c["sid"]);
    let sid = a["sid"].as_str().unwrap();
    assert_eq!(rig.proxy.close(&json!({ "sid": sid }))["closed"], false, "still held");
    assert_eq!(rig.proxy.stats(&json!({ "sid": sid }))["refs"], 1);
    assert_eq!(rig.proxy.close(&json!({ "sid": sid }))["closed"], true);
    assert_eq!(rig.proxy.stats(&json!({ "sid": sid }))["ok"], false);
    // Idle: housekeeping ends sessions no one used (here with no wait).
    let csid = c["sid"].as_str().unwrap().to_owned();
    rig.proxy.housekeep_with(crate::dl::now_secs(), Duration::ZERO, Duration::from_secs(3600));
    assert_eq!(rig.proxy.stats(&json!({ "sid": csid }))["ok"], true, "held: kept");
    rig.proxy.housekeep_with(crate::dl::now_secs(), Duration::ZERO, Duration::ZERO);
    assert_eq!(rig.proxy.stats(&json!({ "sid": csid }))["ok"], false);
}

/// MPEG-TS packets (188 bytes, sync byte 0x47) numbered in their payload.
fn ts_packets(n: u8) -> Vec<u8> {
    (0..n).flat_map(|i| {
        let mut p = vec![i; 188];
        p[0] = 0x47;
        p
    }).collect()
}

#[test]
fn disguised_segments_lose_their_fake_image_header() {
    let o = Origin::start();
    let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89\0\0\0\nIDATx\x9cc\0\x01\0\0\x05\0\x01\r\n-\xb4\0\0\0\0IEND\xaeB`\x82".to_vec();
    png.extend(ts_packets(40));
    o.set("/d/a.png", Route { body: png, ..Default::default() });
    o.set("/d/b.ts", Route { body: ts_packets(10), ..Default::default() });
    let mut jpg = b"\xFF\xD8\xFF\xE0fakejpeg".to_vec();
    jpg.extend(ts_packets(8));
    o.set("/d/c.jpg", Route { body: jpg, no_length: true, ..Default::default() });
    o.text("/d/p.m3u8", "#EXTM3U\n#EXTINF:4,\na.png\n#EXTINF:4,\nb.ts\n#EXTINF:4,\nc.jpg\n#EXT-X-ENDLIST\n");
    let rig = Rig::new(Duration::from_secs(1));
    let (sid, entry) = rig.open(&o.url("/d/p.m3u8"), "hls");
    let dir = entry.trim_end_matches("index.m3u8").to_owned();
    let (_, _, t) = get(rig.proxy.port, &entry, "");
    let segs = names(&String::from_utf8(t).unwrap());
    assert!(segs.iter().all(|s| s.ends_with(".ts")), "{segs:?}");
    let (st, h, body) = get(rig.proxy.port, &format!("{dir}{}", segs[0]), "");
    assert_eq!(st, 200);
    assert_eq!(body, ts_packets(40));
    assert_eq!(h["content-length"], (40 * 188).to_string());
    assert_eq!(h["content-type"], "video/mp2t");
    assert_eq!(get(rig.proxy.port, &format!("{dir}{}", segs[1]), "").2, ts_packets(10), "real TS untouched");
    assert_eq!(get(rig.proxy.port, &format!("{dir}{}", segs[2]), "").2, ts_packets(8), "chunked too");
    assert_eq!(rig.proxy.stats(&json!({ "sid": sid }))["stats"]["strippedHeaders"], 2);
    assert_eq!(super::disguise_offset(b"\x47abc"), None);
}

#[test]
fn cookies_go_with_every_request() {
    let o = Origin::start();
    o.text("/c2/p.m3u8", "#EXTM3U\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST\n");
    o.set("/c2/s.ts", Route { body: b"x".to_vec(), ..Default::default() });
    let rig = Rig::new(Duration::from_secs(1));
    let r = rig.proxy.open(&json!({ "url": o.url("/c2/p.m3u8"), "headers": { "Referer": "https://e/", "Cookie": "old=1" }, "cookies": "cf_clearance=abc; s=1" }));
    let entry = r["url"].as_str().unwrap().strip_prefix(&format!("http://127.0.0.1:{}", rig.proxy.port)).unwrap().to_owned();
    let dir = entry.trim_end_matches("index.m3u8").to_owned();
    let (_, _, t) = get(rig.proxy.port, &entry, "");
    let seg = names(&String::from_utf8(t).unwrap()).remove(0);
    assert_eq!(get(rig.proxy.port, &format!("{dir}{seg}"), "").0, 200);
    let log = o.log();
    assert_eq!(log.len(), 2);
    assert!(log.iter().all(|(_, h)| h.get("cookie").map(String::as_str) == Some("cf_clearance=abc; s=1")), "{log:?}");
}

#[test]
fn many_sessions_at_once() {
    let o = Origin::start();
    o.text("/m/p.m3u8", "#EXTM3U\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST\n");
    o.set("/m/s.ts", Route { body: segment(7), ..Default::default() });
    let rig = Rig::new(Duration::from_secs(1));
    let threads: Vec<_> = (0..6)
        .map(|_| {
            let proxy = rig.proxy.clone();
            let url = o.url("/m/p.m3u8");
            std::thread::spawn(move || {
                let r = proxy.open(&json!({ "url": url }));
                let entry = r["url"].as_str().unwrap().strip_prefix(&format!("http://127.0.0.1:{}", proxy.port)).unwrap().to_owned();
                let dir = entry.trim_end_matches("index.m3u8").to_owned();
                let (_, _, t) = get(proxy.port, &entry, "");
                let seg = names(&String::from_utf8(t).unwrap()).remove(0);
                (0..5).all(|_| get(proxy.port, &format!("{dir}{seg}"), "").2 == segment(7))
            })
        })
        .collect();
    assert!(threads.into_iter().all(|t| t.join().unwrap()));
}

#[test]
fn browser_like_headers_fill_in_what_the_page_did_not_send() {
    let page: crate::dl::http::Headers = [
        ("Referer".to_owned(), "https://aether.ist/".to_owned()),
        ("Origin".to_owned(), "https://aether.ist".to_owned()),
        ("User-Agent".to_owned(), "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36".to_owned()),
        ("accept-language".to_owned(), "de-DE".to_owned()),
    ]
    .into_iter()
    .collect();
    let h = super::browser_headers(&page, "https://bs4.tnmr.org/hls2/x/master.m3u8?t=1");
    assert_eq!(h["Accept"], "*/*");
    assert_eq!(h["accept-language"], "de-DE", "the page's own value wins");
    assert!(!h.contains_key("Accept-Language"));
    assert_eq!(h["Sec-Fetch-Site"], "cross-site");
    assert_eq!(h["Sec-Fetch-Mode"], "cors");
    assert_eq!(h["Sec-Fetch-Dest"], "empty");
    assert_eq!(h["sec-ch-ua"], "\"Chromium\";v=\"120\", \"Not_A Brand\";v=\"24\"");
    assert_eq!(h["sec-ch-ua-mobile"], "?1");
    assert_eq!(h["sec-ch-ua-platform"], "\"Android\"");
    // Safari: no client hints; no Origin: a <video> request; same site.
    let safari: crate::dl::http::Headers = [
        ("Referer".to_owned(), "https://www.example.com/watch".to_owned()),
        ("User-Agent".to_owned(), "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15".to_owned()),
    ]
    .into_iter()
    .collect();
    let h = super::browser_headers(&safari, "https://cdn.example.com/a.m3u8");
    assert_eq!((h["Sec-Fetch-Site"].as_str(), h["Sec-Fetch-Mode"].as_str(), h["Sec-Fetch-Dest"].as_str()), ("same-site", "no-cors", "video"));
    assert!(!h.contains_key("sec-ch-ua"));
}

#[test]
fn the_browser_set_reaches_the_origin() {
    let o = Origin::start();
    o.text("/h/p.m3u8", "#EXTM3U\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST\n");
    let rig = Rig::new(Duration::from_secs(1));
    let (_, entry) = rig.open(&o.url("/h/p.m3u8"), "hls");
    assert_eq!(get(rig.proxy.port, &entry, "").0, 200);
    let (_, h) = o.log().remove(0);
    for k in ["accept", "accept-language", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"] {
        assert!(h.contains_key(k), "{k}: {h:?}");
    }
    assert_eq!(h["x-test"], "yes");
}
