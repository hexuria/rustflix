//! The `dl.*` host API as JSON in, JSON out (what the JNI layer forwards),
//! over one [`Manager`]: the same calls and answers as the desktop shell's
//! `dl::register`, with Android's differences:
//!
//! - `dl.options {dir}` is refused (downloads stay in the app's external
//!   files directory); `dl.options {wifiOnly}` sets the Wi-Fi-only gate.
//! - Wi-Fi only: while it is on and the network is metered, `dl.start`
//!   answers `{ok: false, reason: "network"}` and the transfers that run are
//!   stopped (cancelled, their files kept); they continue by themselves once
//!   the network is unmetered again (or Wi-Fi only is turned off).
//! - `dl.reveal` / `dl.adopt` answer `{ok: false}` (no file manager, no
//!   vid-dl era files).

use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use serde_json::{Value, json};

use crate::dl::{self, Config, Manager};

/// Where events go (`dl.event` records), from any thread.
pub type Sink = Arc<dyn Fn(Value) + Send + Sync>;

pub struct Bridge {
    m: Arc<Manager>,
    wifi_only: AtomicBool,
    metered: AtomicBool,
    /// Ids cancelled by the Wi-Fi gate (their events say why).
    gated: Mutex<Vec<u64>>,
}

pub const WIFI_MESSAGE: &str = "Waiting for Wi-Fi — Wi-Fi only is on in Settings";

impl Bridge {
    /// A downloader keeping its records in `data_dir` and downloads in
    /// `downloads_dir`. Records left running by the last session resume.
    pub fn new(data_dir: &Path, downloads_dir: &Path, sink: Sink) -> Bridge {
        Bridge::with_min_free(data_dir, downloads_dir, sink, dl::MIN_FREE, dl::MIN_FREE_RUNNING)
    }

    pub(crate) fn with_min_free(
        data_dir: &Path,
        downloads_dir: &Path,
        sink: Sink,
        min_free: u64,
        min_free_running: u64,
    ) -> Bridge {
        let _ = std::fs::create_dir_all(data_dir);
        let _ = std::fs::create_dir_all(downloads_dir);
        let cfg = Config {
            store: data_dir.join("rustflix-downloads.json"),
            default_dir: downloads_dir.to_path_buf(),
            home: downloads_dir.to_string_lossy().into_owned(),
            forbidden: Vec::<PathBuf>::new(),
            min_free,
            min_free_running,
            free_space: Arc::new(crate::files::free_space),
            sink,
            trash: Arc::new(|parent: &Path, folder: &Path, id: u64| {
                crate::files::trash_record_folder(parent, folder, Some(id))
            }),
            reveal: Arc::new(crate::files::reveal_path),
            force_copy: false,
        };
        log::info!("dl: records in {}, downloads in {}", cfg.store.display(), downloads_dir.display());
        Bridge {
            m: Manager::new(cfg),
            wifi_only: AtomicBool::new(false),
            metered: AtomicBool::new(false),
            gated: Mutex::new(Vec::new()),
        }
    }

    fn blocked(&self) -> bool {
        self.wifi_only.load(Ordering::Relaxed) && self.metered.load(Ordering::Relaxed)
    }

    /// The network became metered (mobile data) or not.
    pub fn set_metered(&self, metered: bool) {
        self.metered.store(metered, Ordering::Relaxed);
        self.enforce();
        self.release();
    }

    /// The gate opened (unmetered network, or Wi-Fi only turned off): the
    /// transfers it stopped continue from their files, as on iOS where they
    /// wait for Wi-Fi.
    fn release(&self) {
        if self.blocked() {
            return;
        }
        let ids: Vec<u64> = std::mem::take(&mut *self.gated.lock().unwrap_or_else(|e| e.into_inner()));
        for id in ids {
            let v = self.m.start(&json!({ "id": id }));
            log::info!("dl: #{id} continues on an unmetered network: {v}");
        }
    }

    /// Wi-Fi only blocks the network now: cancel what runs (files stay).
    fn enforce(&self) {
        if !self.blocked() {
            return;
        }
        for id in self.running_ids() {
            self.gated.lock().unwrap_or_else(|e| e.into_inner()).push(id);
            self.m.cancel(&json!({ "id": id }));
        }
    }

    /// Ids of the records whose status is `running`.
    pub fn running_ids(&self) -> Vec<u64> {
        match self.m.list() {
            Value::Array(list) => list
                .iter()
                .filter(|r| r["status"] == "running")
                .filter_map(|r| r["id"].as_u64())
                .collect(),
            _ => Vec::new(),
        }
    }

    /// One call: `name` with `data` (JSON text; empty or invalid = `{}`),
    /// answered as JSON text. Blocking (a `dl.remove` waits for its job):
    /// call it off the UI thread.
    pub fn call(&self, name: &str, data: &str) -> String {
        let data: Value = serde_json::from_str(data).unwrap_or_else(|_| json!({}));
        let data = if data.is_object() { data } else { json!({}) };
        self.dispatch(name, &data).to_string()
    }

    fn dispatch(&self, name: &str, data: &Value) -> Value {
        match name {
            "dl.list" => self.m.list(),
            "dl.nextId" => self.m.next_id(),
            "dl.start" => {
                if self.blocked() {
                    return json!({ "ok": false, "reason": "network", "error": WIFI_MESSAGE });
                }
                self.m.start(data)
            }
            "dl.cancel" => self.m.cancel(data),
            "dl.remove" => self.m.remove(data),
            "dl.playUrl" => self.m.play_url(data),
            "dl.space" => self.m.space(),
            "dl.options" => self.options(data),
            "dl.reveal" | "dl.adopt" => json!({ "ok": false }),
            n if n.starts_with("dl.stream.") => crate::streams::call(n, data),
            _ => json!({ "ok": false, "error": format!("unknown call {name}") }),
        }
    }

    fn options(&self, data: &Value) -> Value {
        if data.get("dir").is_some() {
            return json!({ "ok": false, "moved": 0, "error": "The download folder can't be changed on Android." });
        }
        if let Some(on) = data.get("wifiOnly").and_then(Value::as_bool) {
            self.wifi_only.store(on, Ordering::Relaxed);
            self.enforce();
            self.release();
        }
        let mut out = self.m.options(&json!({}));
        out["wifiOnly"] = json!(self.wifi_only.load(Ordering::Relaxed));
        out
    }

    /// Stops the transfers (files stay; the next launch resumes them).
    pub fn shutdown(&self) {
        self.m.shutdown(std::time::Duration::from_secs(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rustflix-dl-bridge-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn bridge(name: &str) -> (Bridge, Arc<StdMutex<Vec<Value>>>, PathBuf) {
        let d = temp(name);
        let events = Arc::new(StdMutex::new(Vec::new()));
        let ev = events.clone();
        let b = Bridge::with_min_free(&d.join("data"), &d.join("dl"), Arc::new(move |v| ev.lock().unwrap().push(v)), 0, 0);
        (b, events, d)
    }

    fn parse(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn unknown_calls_and_bad_input_answer_json() {
        let (b, _, _) = bridge("unknown");
        let v = parse(&b.call("dl.nope", "{}"));
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("dl.nope"));
        // Invalid JSON and non-objects are taken as {}.
        assert_eq!(parse(&b.call("dl.list", "not json")), json!([]));
        assert_eq!(parse(&b.call("dl.cancel", "[1,2]")), Value::Null);
    }

    #[test]
    fn options_refuse_a_folder_and_keep_wifi_only() {
        let (b, _, d) = bridge("options");
        let v = parse(&b.call("dl.options", r#"{"dir":"/sdcard"}"#));
        assert_eq!(v["ok"], false);
        let v = parse(&b.call("dl.options", r#"{"wifiOnly":true}"#));
        assert_eq!(v["ok"], true);
        assert_eq!(v["wifiOnly"], true);
        assert_eq!(v["dir"], d.join("dl").to_string_lossy().as_ref());
        let v = parse(&b.call("dl.options", "{}"));
        assert_eq!(v["wifiOnly"], true);
    }

    #[test]
    fn wifi_only_gates_starts_on_metered_networks() {
        let (b, _, _) = bridge("wifi");
        b.call("dl.options", r#"{"wifiOnly":true}"#);
        b.set_metered(true);
        let v = parse(&b.call("dl.start", r#"{"url":"https://example.invalid/a.mp4"}"#));
        assert_eq!(v["ok"], false);
        assert_eq!(v["reason"], "network");
        // Wi-Fi only off: the gate opens (a bad URL is the next answer).
        b.call("dl.options", r#"{"wifiOnly":false}"#);
        let v = parse(&b.call("dl.start", r#"{"url":"notaurl"}"#));
        assert_eq!(v["reason"], "failed");
    }

    #[test]
    fn wifi_only_stops_running_transfers_and_continues_them_on_wifi() {
        let (b, _, _) = bridge("wifi-resume");
        // A transfer that keeps running: a server that accepts and never answers.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let mut held = Vec::new();
            for c in listener.incoming().flatten() {
                held.push(c);
            }
        });
        let v = parse(&b.call("dl.start", &format!(r#"{{"url":"http://127.0.0.1:{port}/v.mp4","name":"W","kind":"file"}}"#)));
        let id = v["id"].as_u64().unwrap();
        assert_eq!(b.running_ids(), vec![id]);
        b.call("dl.options", r#"{"wifiOnly":true}"#);
        b.set_metered(true);
        assert!(b.running_ids().is_empty());
        b.set_metered(false);
        assert_eq!(b.running_ids(), vec![id]);
        b.call("dl.remove", &format!(r#"{{"id":{id}}}"#));
    }

    #[test]
    fn stream_calls_go_to_the_proxy() {
        let (b, _, _) = bridge("stream");
        assert_eq!(parse(&b.call("dl.stream.nope", "{}"))["error"], "unknown op");
        // An upstream that answers one HLS playlist.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            for mut c in listener.incoming().flatten() {
                let mut buf = [0u8; 4096];
                let _ = c.read(&mut buf);
                let body = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n";
                let _ = write!(c, "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        let v = parse(&b.call(
            "dl.stream.open",
            &format!(r#"{{"url":"http://127.0.0.1:{port}/a/index.m3u8","headers":{{"Referer":"https://embed.example/"}}}}"#),
        ));
        assert_eq!(v["ok"], true, "{v}");
        let local = v["url"].as_str().unwrap().to_owned();
        assert!(local.starts_with("http://127.0.0.1:"), "{local}");
        let sid = v["sid"].as_str().unwrap().to_owned();
        // The player's first request, through the proxy.
        let resp = ureq::get(&local).call().unwrap();
        let text = resp.into_body().read_to_string().unwrap();
        assert!(text.starts_with("#EXTM3U"), "{text}");
        let s = parse(&b.call("dl.stream.stats", &format!(r#"{{"sid":"{sid}"}}"#)));
        assert_eq!(s["ok"], true, "{s}");
        assert!(s["stats"]["withHeaders"].as_u64().unwrap_or(0) >= 1, "{s}");
        assert_eq!(parse(&b.call("dl.stream.close", &format!(r#"{{"sid":"{sid}"}}"#)))["ok"], true);
    }

    #[test]
    fn reveal_and_adopt_are_not_offered() {
        let (b, _, _) = bridge("reveal");
        assert_eq!(parse(&b.call("dl.reveal", r#"{"id":1}"#))["ok"], false);
        assert_eq!(parse(&b.call("dl.adopt", r#"{"file":"/x.mp4"}"#))["ok"], false);
    }

    #[test]
    fn ids_space_and_a_started_record() {
        let (b, events, d) = bridge("start");
        let id = parse(&b.call("dl.nextId", ""))["id"].as_u64().unwrap();
        assert!(id >= 1);
        let space = parse(&b.call("dl.space", ""));
        assert!(space["free"].as_u64().unwrap() > 0);
        // A real start against a closed port: a record, an event, then an error.
        let v = parse(&b.call("dl.start", r#"{"url":"http://127.0.0.1:9/v.mp4","name":"Test","kind":"file"}"#));
        assert_eq!(v["ok"], true);
        let rid = v["id"].as_u64().unwrap();
        let list = parse(&b.call("dl.list", ""));
        assert_eq!(list[0]["id"], rid);
        assert!(!events.lock().unwrap().is_empty());
        // Removing deletes its folder (no Trash on Android).
        let folder = d.join("dl").join("Test");
        assert!(folder.exists());
        let v = parse(&b.call("dl.remove", &format!(r#"{{"id":{rid}}}"#)));
        assert_eq!(v["ok"], true);
        assert!(!folder.exists());
        assert_eq!(parse(&b.call("dl.list", "")), json!([]));
    }
}
