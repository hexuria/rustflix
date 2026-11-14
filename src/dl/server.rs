//! The local playback server: finished downloads play in the app's web
//! view from `http://127.0.0.1:<port>/<token>/<id>/…` (the webview
//! capability grants http(s) hosts, not file://).
//!
//! - bound to 127.0.0.1 on a port the system picks, started on demand;
//! - every path starts with a random per-launch token, so other local
//!   programs cannot guess URLs;
//! - `<id>` names a download record; only plain files directly inside that
//!   record's folder are served (one path component, no dot-files, no
//!   symlinks, the canonical parent must be the record's folder);
//! - `player.html` is generated: a page with a `<video>` of the record's
//!   media file (the app's page bridge draws its controls over it);
//! - single `Range` requests (`bytes=a-b`, `a-`, `-n`) and HEAD.

use std::{
    fs,
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

/// What a record serves: its folder and its media file's name in it.
#[derive(Clone, Debug)]
pub(crate) struct Served {
    pub folder: PathBuf,
    pub file: String,
}

pub(crate) type Lookup = Arc<dyn Fn(u64) -> Option<Served> + Send + Sync>;

pub(crate) const PLAYER_PAGE: &str = "player.html";

pub(crate) struct Server {
    pub port: u16,
    pub token: String,
}

/// A random token (hex) from the system's generator.
pub(crate) fn random_token() -> String {
    let mut bytes = [0u8; 16];
    let ok = fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).is_ok();
    if !ok {
        use std::hash::{BuildHasher, Hasher};
        for chunk in bytes.chunks_mut(8) {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
            h.write_u32(std::process::id());
            chunk.copy_from_slice(&h.finish().to_le_bytes()[..chunk.len()]);
        }
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Server {
    pub(crate) fn start(lookup: Lookup) -> io::Result<Server> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        let token = random_token();
        let tok = token.clone();
        std::thread::Builder::new().name("rustflix-media".into()).spawn(move || {
            for conn in listener.incoming() {
                let Ok(conn) = conn else { continue };
                let lookup = lookup.clone();
                let tok = tok.clone();
                let _ = std::thread::Builder::new().name("rustflix-media-conn".into()).spawn(move || {
                    let _ = serve(conn, &tok, &lookup);
                });
            }
        })?;
        Ok(Server { port, token })
    }

    /// The player page of record `id`.
    pub(crate) fn player_url(&self, id: u64, file: &str) -> String {
        format!("http://127.0.0.1:{}/{}/{id}/{PLAYER_PAGE}?f={}", self.port, self.token, encode(file))
    }
}

/// Percent-encodes everything but unreserved characters.
pub(crate) fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub(crate) fn content_type(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "m3u8" => "application/vnd.apple.mpegurl",
        "ts" | "m2ts" => "video/mp2t",
        "mp4" | "m4v" => "video/mp4",
        "m4s" => "video/iso.segment",
        "aac" => "audio/aac",
        "vtt" => "text/vtt",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "html" | "htm" => "text/html; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// The page that plays `file` (a name in the same folder).
pub(crate) fn player_page(file: &str) -> String {
    let src = encode(file);
    format!(
        "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\">\
<style>html,body{{margin:0;height:100%;background:#000}}video{{width:100%;height:100%;object-fit:contain}}</style>\
<video src=\"{src}\" playsinline webkit-playsinline preload=\"metadata\"></video>\
<script>var v=document.querySelector('video');v.play().catch(function(){{}});</script>"
    )
}

/// The file `name` of a record folder, if it may be served: a single plain
/// path component, no dot-file, a regular file (not a symlink) whose
/// canonical parent is the folder's canonical path.
pub(crate) fn servable(folder: &Path, name: &str) -> Option<PathBuf> {
    if name.is_empty()
        || name.starts_with('.')
        || name.contains(['/', '\\', '\0'])
        || name == ".."
    {
        return None;
    }
    let meta = fs::symlink_metadata(folder).ok()?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return None;
    }
    let path = folder.join(name);
    let meta = fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let canon = fs::canonicalize(&path).ok()?;
    if canon.parent()? != fs::canonicalize(folder).ok()? {
        return None;
    }
    Some(canon)
}

/// `Range` → (start, end inclusive) for a file of `size`; `Err(())` when it
/// cannot be satisfied; `Ok(None)` for none / one we ignore (multi-range).
pub(crate) fn parse_range(v: Option<&str>, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(v) = v else { return Ok(None) };
    let Some(spec) = v.trim().strip_prefix("bytes=") else { return Ok(None) };
    if spec.contains(',') {
        return Ok(None);
    }
    let Some((a, b)) = spec.split_once('-') else { return Ok(None) };
    let (a, b) = (a.trim(), b.trim());
    let range = if a.is_empty() {
        let n: u64 = b.parse().map_err(|_| ())?;
        if n == 0 || size == 0 {
            return Err(());
        }
        (size.saturating_sub(n), size - 1)
    } else {
        let start: u64 = a.parse().map_err(|_| ())?;
        let end = if b.is_empty() { size.saturating_sub(1) } else { b.parse::<u64>().map_err(|_| ())?.min(size.saturating_sub(1)) };
        (start, end)
    };
    if size == 0 || range.0 >= size || range.0 > range.1 {
        return Err(());
    }
    Ok(Some(range))
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
    let http10 = parts.next().is_some_and(|v| v == "HTTP/1.0");
    let mut range = None;
    let mut close = http10;
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
            if k == "range" {
                range = Some(v.trim().to_owned());
            } else if k == "connection" {
                close = v.trim().eq_ignore_ascii_case("close");
            }
        }
    }
    Ok(Some(Request { method, path, range, close }))
}

fn simple(out: &mut TcpStream, status: &str, extra: &str, close: bool) -> io::Result<()> {
    let body = status.as_bytes();
    write!(
        out,
        "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n{extra}{}\r\n",
        body.len(),
        if close { "Connection: close\r\n" } else { "" }
    )?;
    out.write_all(body)
}

fn serve(conn: TcpStream, token: &str, lookup: &Lookup) -> io::Result<()> {
    conn.set_read_timeout(Some(Duration::from_secs(20)))?;
    conn.set_write_timeout(Some(Duration::from_secs(60)))?;
    let mut out = conn.try_clone()?;
    let mut reader = BufReader::new(conn);
    while let Some(req) = read_request(&mut reader)? {
        let head = req.method == "HEAD";
        if req.method != "GET" && !head {
            simple(&mut out, "405 Method Not Allowed", "Allow: GET, HEAD\r\n", true)?;
            return Ok(());
        }
        respond(&mut out, &req, head, token, lookup)?;
        out.flush()?;
        if req.close {
            return Ok(());
        }
    }
    Ok(())
}

/// Splits `/<token>/<id>/<name>?query`.
fn route(path: &str, token: &str) -> Option<(u64, String)> {
    let path = path.split(['?', '#']).next()?;
    let mut it = path.strip_prefix('/')?.split('/');
    let (t, id, name) = (it.next()?, it.next()?, it.next()?);
    if it.next().is_some() || t != token {
        return None;
    }
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((id.parse().ok()?, decode(name)?))
}

fn respond(out: &mut TcpStream, req: &Request, head: bool, token: &str, lookup: &Lookup) -> io::Result<()> {
    let not_found = |out: &mut TcpStream| simple(out, "404 Not Found", "", req.close);
    let Some((id, name)) = route(&req.path, token) else { return not_found(out) };
    let Some(served) = lookup(id) else { return not_found(out) };
    let conn_hdr = if req.close { "Connection: close\r\n" } else { "" };
    if name == PLAYER_PAGE {
        let page = player_page(&served.file);
        write!(
            out,
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\n{conn_hdr}\r\n",
            page.len()
        )?;
        if !head {
            out.write_all(page.as_bytes())?;
        }
        return Ok(());
    }
    let Some(path) = servable(&served.folder, &name) else { return not_found(out) };
    let Ok(mut file) = fs::File::open(&path) else { return not_found(out) };
    let size = file.metadata()?.len();
    let ctype = content_type(&name);
    let (status, start, len, range_hdr) = match parse_range(req.range.as_deref(), size) {
        Err(()) => {
            return simple(out, "416 Range Not Satisfiable", &format!("Content-Range: bytes */{size}\r\n"), req.close);
        }
        Ok(None) => ("200 OK", 0, size, String::new()),
        Ok(Some((a, b))) => ("206 Partial Content", a, b - a + 1, format!("Content-Range: bytes {a}-{b}/{size}\r\n")),
    };
    write!(
        out,
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nAccept-Ranges: bytes\r\nContent-Length: {len}\r\n{range_hdr}{conn_hdr}\r\n"
    )?;
    if head {
        return Ok(());
    }
    file.seek(SeekFrom::Start(start))?;
    let copied = io::copy(&mut (&mut file).take(len), out)?;
    if copied < len {
        // The file shrank meanwhile: the length promised cannot be kept.
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "short file"));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;

    pub(crate) fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rustflix-srv-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(&dir).unwrap()
    }

    /// A raw HTTP/1.1 request; (status line, headers, body).
    pub(crate) fn get(port: u16, path: &str, extra: &str) -> (String, HashMap<String, String>, Vec<u8>) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET {path} HTTP/1.1\r\nHost: x\r\n{extra}Connection: close\r\n\r\n").unwrap();
        let mut all = Vec::new();
        s.read_to_end(&mut all).unwrap();
        let split = all.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&all[..split]).into_owned();
        let mut lines = head.split("\r\n");
        let status = lines.next().unwrap().to_owned();
        let headers = lines
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
            .collect();
        (status, headers, all[split + 4..].to_vec())
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range(None, 10), Ok(None));
        assert_eq!(parse_range(Some("bytes=0-3"), 10), Ok(Some((0, 3))));
        assert_eq!(parse_range(Some("bytes=4-"), 10), Ok(Some((4, 9))));
        assert_eq!(parse_range(Some("bytes=-3"), 10), Ok(Some((7, 9))));
        assert_eq!(parse_range(Some("bytes=5-100"), 10), Ok(Some((5, 9))));
        assert_eq!(parse_range(Some("bytes=10-"), 10), Err(()));
        assert_eq!(parse_range(Some("bytes=5-2"), 10), Err(()));
        assert_eq!(parse_range(Some("bytes=0-1,4-5"), 10), Ok(None));
        assert_eq!(parse_range(Some("items=0-1"), 10), Ok(None));
    }

    #[test]
    fn serves_record_files_with_ranges_and_restrictions() {
        let root = temp("serve");
        let rec = root.join("Movie");
        fs::create_dir_all(&rec).unwrap();
        fs::write(rec.join("Movie.mp4"), b"0123456789").unwrap();
        fs::write(rec.join("index.m3u8"), b"#EXTM3U\n").unwrap();
        fs::write(rec.join(".manifest.json"), b"{\"secret\":1}").unwrap();
        fs::write(root.join("outside.txt"), b"no").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("outside.txt"), rec.join("link.mp4")).unwrap();
        let folder = rec.clone();
        let srv = Server::start(Arc::new(move |id| {
            (id == 7).then(|| Served { folder: folder.clone(), file: "Movie.mp4".into() })
        }))
        .unwrap();
        let t = &srv.token;
        let p = srv.port;

        let (st, h, body) = get(p, &format!("/{t}/7/Movie.mp4"), "");
        assert_eq!(st, "HTTP/1.1 200 OK");
        assert_eq!(h["content-type"], "video/mp4");
        assert_eq!(h["accept-ranges"], "bytes");
        assert_eq!(body, b"0123456789");
        let (st, h, body) = get(p, &format!("/{t}/7/Movie.mp4"), "Range: bytes=2-5\r\n");
        assert_eq!(st, "HTTP/1.1 206 Partial Content");
        assert_eq!(h["content-range"], "bytes 2-5/10");
        assert_eq!(body, b"2345");
        let (_, _, body) = get(p, &format!("/{t}/7/Movie.mp4"), "Range: bytes=-3\r\n");
        assert_eq!(body, b"789");
        let (st, h, _) = get(p, &format!("/{t}/7/Movie.mp4"), "Range: bytes=50-\r\n");
        assert!(st.contains("416"), "{st}");
        assert_eq!(h["content-range"], "bytes */10");
        let (st, h, _) = get(p, &format!("/{t}/7/index.m3u8"), "");
        assert!(st.contains("200"));
        assert_eq!(h["content-type"], "application/vnd.apple.mpegurl");

        // The generated page plays the record's file.
        let (st, _, body) = get(p, &format!("/{t}/7/player.html?f=Movie.mp4"), "");
        assert!(st.contains("200"));
        assert!(String::from_utf8_lossy(&body).contains("<video src=\"Movie.mp4\""));
        assert_eq!(srv.player_url(7, "A B.mp4"), format!("http://127.0.0.1:{p}/{t}/7/player.html?f=A%20B.mp4"));

        // Refused: wrong token, unknown record, dot-files, traversal,
        // nested paths, symlinks out.
        for bad in [
            "/nottoken/7/Movie.mp4".to_owned(),
            format!("/{t}/8/Movie.mp4"),
            format!("/{t}/7/.manifest.json"),
            format!("/{t}/7/..%2Foutside.txt"),
            format!("/{t}/7/%2E%2E"),
            format!("/{t}/7/../outside.txt"),
            format!("/{t}/7/sub/x"),
            format!("/{t}/7/link.mp4"),
            format!("/{t}/7/missing.mp4"),
            format!("/{t}/x7/Movie.mp4"),
        ] {
            let (st, _, body) = get(p, &bad, "");
            assert!(st.contains("404"), "{bad}: {st}");
            assert!(!String::from_utf8_lossy(&body).contains("secret"));
        }
        // Keep-alive: two requests on one connection.
        let mut s = TcpStream::connect(("127.0.0.1", p)).unwrap();
        write!(s, "GET /{t}/7/Movie.mp4 HTTP/1.1\r\nRange: bytes=0-0\r\n\r\nGET /{t}/7/Movie.mp4 HTTP/1.1\r\nRange: bytes=9-\r\nConnection: close\r\n\r\n").unwrap();
        let mut all = String::new();
        s.read_to_string(&mut all).unwrap();
        assert_eq!(all.matches("206 Partial Content").count(), 2, "{all}");
        assert!(all.ends_with('9'));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn content_types_and_encoding() {
        assert_eq!(content_type("f1.ts"), "video/mp2t");
        assert_eq!(content_type("f1.m4s"), "video/iso.segment");
        assert_eq!(content_type("f1.vtt"), "text/vtt");
        assert_eq!(content_type("f2"), "application/octet-stream");
        assert_eq!(encode("a b/ü"), "a%20b%2F%C3%BC");
        assert_eq!(decode("a%20b%2F%C3%BC").as_deref(), Some("a b/ü"));
        assert_eq!(decode("%zz"), None);
    }
}
