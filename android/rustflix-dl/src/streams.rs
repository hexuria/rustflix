//! `dl.stream.*` on Android: the desktop's streaming proxy (`src/stream`,
//! included as is next to `src/dl`) behind the same JSON calls the desktop
//! registers (`stream::register`), which the JNI layer forwards. The proxy
//! listens on 127.0.0.1 (a random port, a per-launch token) and starts on
//! the first call; its events go to the sink set by [`set_sink`]
//! (`dl.stream.event` in the app).

use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Value, json};

use crate::stream::{HOLD, Proxy, Sink};

static SINK: OnceLock<Sink> = OnceLock::new();
static PROXY: Mutex<Option<Arc<Proxy>>> = Mutex::new(None);

/// Where `dl.stream.event`s go. The first sink set stays.
pub fn set_sink(sink: Arc<dyn Fn(Value) + Send + Sync>) {
    let _ = SINK.set(sink);
}

fn proxy() -> Option<Arc<Proxy>> {
    let mut p = PROXY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = p.as_ref() {
        return Some(p.clone());
    }
    let sink: Sink = SINK.get().cloned().unwrap_or_else(|| Arc::new(|_| {}));
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

/// One `dl.stream.*` call (blocking: off the UI thread).
pub fn call(name: &str, data: &Value) -> Value {
    let known = matches!(name, "dl.stream.open" | "dl.stream.update" | "dl.stream.close" | "dl.stream.stats" | "dl.stream.debug");
    if !known {
        return json!({ "ok": false, "error": "unknown op" });
    }
    let Some(p) = proxy() else { return json!({ "ok": false, "error": "no local proxy" }) };
    match name {
        "dl.stream.open" => p.open(data),
        "dl.stream.update" => p.update(data),
        "dl.stream.close" => p.close(data),
        "dl.stream.stats" => p.stats(data),
        _ => p.debug(data),
    }
}
