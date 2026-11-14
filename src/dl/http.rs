//! HTTP for the downloader: one `ureq` agent (rustls, gzip — the features
//! nsh-engine already builds), timeouts on connect and every read, the
//! record's headers on every request, statuses handled by the caller.

use std::{collections::BTreeMap, io::Read, sync::atomic::AtomicBool, sync::atomic::Ordering, time::Duration};

use super::policy::{Failure, classify_status};

/// A failed request: what kind of failure, and a short description.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NetError {
    pub failure: Failure,
    pub text: String,
}

impl NetError {
    pub(crate) fn new(failure: Failure, text: impl Into<String>) -> NetError {
        NetError { failure, text: text.into() }
    }
}

pub(crate) type Headers = BTreeMap<String, String>;

pub(crate) type Response = ureq::http::Response<ureq::Body>;

#[derive(Clone)]
pub(crate) struct Http {
    agent: ureq::Agent,
}

/// A browser-like UA for requests whose page gave none (the CDNs refuse
/// a library's default).
const FALLBACK_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

impl Http {
    pub(crate) fn new() -> Http {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(20)))
            .timeout_recv_response(Some(Duration::from_secs(40)))
            .timeout_per_read(Some(Duration::from_secs(30)))
            .max_redirects(10)
            .user_agent(FALLBACK_UA)
            .build();
        Http { agent: config.into() }
    }

    /// GET `url` with `headers` (and `extra`, which win). Any status is a
    /// response; only transport failures are errors.
    pub(crate) fn get(&self, url: &str, headers: &Headers, extra: &[(&str, String)]) -> Result<Response, NetError> {
        let mut req = self.agent.get(url);
        for (k, v) in headers {
            if extra.iter().any(|(e, _)| e.eq_ignore_ascii_case(k)) {
                continue;
            }
            req = req.header(k.as_str(), v.as_str());
        }
        for (k, v) in extra {
            req = req.header(*k, v.as_str());
        }
        req.call().map_err(map_error)
    }

    /// The text of `url` (2xx only, at most `limit` bytes).
    pub(crate) fn text(&self, url: &str, headers: &Headers, limit: u64) -> Result<(u16, String), NetError> {
        let mut resp = self.get(url, headers, &[])?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) {
            return Ok((status, String::new()));
        }
        let mut buf = Vec::new();
        resp.body_mut()
            .with_config()
            .limit(limit)
            .reader()
            .read_to_end(&mut buf)
            .map_err(|e| NetError::new(Failure::Network, e.to_string()))?;
        Ok((status, String::from_utf8_lossy(&buf).into_owned()))
    }
}

pub(crate) fn map_error(e: ureq::Error) -> NetError {
    use ureq::Error as E;
    let failure = match &e {
        E::StatusCode(code) => classify_status(*code),
        E::Io(_) | E::Timeout(_) | E::HostNotFound | E::ConnectionFailed | E::Tls(_) | E::Rustls(_)
        | E::BodyStalled | E::Protocol(_) | E::Decompress(..) => Failure::Network,
        _ => Failure::Other,
    };
    NetError::new(failure, e.to_string())
}

/// A body read error: the connection broke mid-transfer.
pub(crate) fn read_error(e: std::io::Error) -> NetError {
    NetError::new(Failure::Network, e.to_string())
}

/// Content-Length of a response, when it has one.
pub(crate) fn content_length(resp: &Response) -> Option<u64> {
    resp.headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok())
}

pub(crate) fn header(resp: &Response, name: &str) -> Option<String> {
    resp.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

/// `Content-Range: bytes a-b/total` → (a, total); `bytes */total` → (None, total).
pub(crate) fn content_range(v: &str) -> Option<(Option<u64>, Option<u64>)> {
    let rest = v.trim().strip_prefix("bytes")?.trim_start();
    let (range, total) = rest.split_once('/')?;
    let total = total.trim().parse().ok();
    let start = if range.trim() == "*" {
        None
    } else {
        Some(range.split_once('-')?.0.trim().parse().ok()?)
    };
    Some((start, total))
}

/// Request headers from JS: strings (or numbers) only, no header the
/// transfer itself controls, nothing that could split a request.
pub(crate) fn parse_headers(v: Option<&serde_json::Value>) -> Option<Headers> {
    let obj = v?.as_object()?;
    const RESERVED: [&str; 6] = ["range", "host", "content-length", "connection", "accept-encoding", "transfer-encoding"];
    let mut out = Headers::new();
    for (k, raw) in obj {
        let val = match raw {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            _ => continue,
        };
        let bad_key = k.is_empty()
            || k.len() >= 256
            || !k.bytes().all(|b| b.is_ascii_graphic() && b != b':')
            || RESERVED.contains(&k.to_ascii_lowercase().as_str());
        let bad_val = val.len() >= 8192 || val.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0);
        if bad_key || bad_val {
            continue;
        }
        out.insert(k.clone(), val);
    }
    Some(out)
}

/// Copies `reader` into `out` in chunks, checking `stop` between them;
/// `on_chunk` sees the running total. The first `head.capacity()` bytes
/// are kept in `head`.
pub(crate) fn pump(
    reader: &mut dyn Read,
    out: &mut dyn std::io::Write,
    stop: &AtomicBool,
    head: &mut Vec<u8>,
    mut on_chunk: impl FnMut(u64),
) -> Result<u64, PumpError> {
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        if stop.load(Ordering::Relaxed) {
            return Err(PumpError::Stopped);
        }
        let n = match reader.read(&mut buf) {
            Ok(0) => return Ok(total),
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(PumpError::Net(read_error(e))),
        };
        if head.len() < head.capacity() {
            let take = (head.capacity() - head.len()).min(n);
            head.extend_from_slice(&buf[..take]);
        }
        out.write_all(&buf[..n]).map_err(|e| PumpError::Io(e.to_string()))?;
        total += n as u64;
        on_chunk(total);
    }
}

#[derive(Debug)]
pub(crate) enum PumpError {
    Stopped,
    Net(NetError),
    /// Writing the file failed.
    Io(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn headers_from_js_are_filtered() {
        let h = parse_headers(Some(&json!({
            "Referer": "https://a/",
            "User-Agent": "UA",
            "X-N": 3,
            "Range": "bytes=0-",
            "Host": "evil",
            "Bad Key": "x",
            "X-Split": "a\r\nInjected: 1",
            "X-Obj": {},
        })))
        .unwrap();
        assert_eq!(h.len(), 3);
        assert_eq!(h["Referer"], "https://a/");
        assert_eq!(h["X-N"], "3");
        assert!(parse_headers(Some(&json!("x"))).is_none());
        assert!(parse_headers(None).is_none());
    }

    #[test]
    fn content_ranges() {
        assert_eq!(content_range("bytes 100-199/1000"), Some((Some(100), Some(1000))));
        assert_eq!(content_range("bytes 0-9/*"), Some((Some(0), None)));
        assert_eq!(content_range("bytes */1000"), Some((None, Some(1000))));
        assert_eq!(content_range("items 1-2/3"), None);
    }
}
