//! Linux: reaching the WebKitGTK web views that NSH builds through wry.
//!
//! wry has no configuration hook, but its web view is an ordinary
//! `WebKitWebView` GtkWidget in this process, and GTK's toplevel list
//! reaches every one. What macOS gets from WKWebView /
//! WKUserContentController, WebKitGTK gives through
//! WebKitUserContentManager (user scripts that run in EVERY frame — the
//! all-frames media sniffer needs this; NSH only injects its own scripts
//! into the main frame), WebKitCookieManager and the decide-policy
//! signal.
//!
//! Everything here must run on the GTK thread (the app's main thread,
//! which pumps GTK's events). `host` calls arrive elsewhere, so they are
//! marshalled with `MainContext::invoke`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use gtk::prelude::*;
use serde_json::{json, Value};
use webkit2gtk::{
    glib, CookieManagerExt as _,
    UserContentInjectedFrames, UserContentManagerExt as _, UserScript, UserScriptInjectionTime,
    WebContextExt as _, WebViewExt as _,
};

// `MainContext::invoke` can run its callback on whichever thread iterates
// the context, so this state is shared, not thread-local. Every GTK call
// stays behind `is_initialized_main_thread`.
static SCRIPTED: OnceLock<Mutex<HashMap<usize, u64>>> = OnceLock::new();
static SCRIPT: OnceLock<Mutex<String>> = OnceLock::new();
static RESCANNING: AtomicBool = AtomicBool::new(false);

fn scripted() -> &'static Mutex<HashMap<usize, u64>> {
    SCRIPTED.get_or_init(|| Mutex::new(HashMap::new()))
}
fn script() -> &'static Mutex<String> {
    SCRIPT.get_or_init(|| Mutex::new(String::new()))
}

fn fnv(s: &str) -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Every WebKitWebView widget under the GTK toplevels (wry parents each
/// web view in its own GtkWindow/GtkFixed).
pub(crate) fn webviews() -> Vec<webkit2gtk::WebView> {
    if !gtk::is_initialized_main_thread() {
        return Vec::new();
    }
    fn collect(w: &gtk::Widget, out: &mut Vec<webkit2gtk::WebView>) {
        if let Ok(wv) = w.clone().dynamic_cast::<webkit2gtk::WebView>() {
            out.push(wv);
            return;
        }
        if let Ok(c) = w.clone().dynamic_cast::<gtk::Container>() {
            for ch in c.children() {
                collect(&ch, out);
            }
        }
    }
    let mut out = Vec::new();
    for w in gtk::Window::list_toplevels() {
        collect(&w, &mut out);
    }
    out
}

/// wry only calls `set_bounds` while a web view is shown, so a hidden one
/// (the resolver) keeps its tiny initial allocation and the page lays out
/// at ~200x200 CSS px: embed players never initialize and the media
/// sniffer finds nothing. Mirror `set_bounds` for web views that are not
/// shown: resize the foreign X window and re-allocate the widget chain
/// (wry's GtkWindow -> GtkBox -> WebKitWebView). wry re-allocates the ones
/// it shows.
fn ensure_viewport(wv: &webkit2gtk::WebView) {
    if wv.is_visible() || (wv.allocated_width() >= 800 && wv.allocated_height() >= 600) {
        return;
    }
    // The toplevel ancestor is wry's GtkWindow (a GtkWindow has no parent).
    let mut top = wv.clone().upcast::<gtk::Widget>();
    while let Some(p) = top.parent() {
        top = p;
    }
    wv.set_size_request(1600, 900);
    if let Some(gdk) = top.window() {
        gdk.resize(1600, 900);
    }
    top.size_allocate(&gtk::Allocation::new(0, 0, 1600, 900));
    if let Some(gdk) = wv.window() {
        gdk.resize(1600, 900);
    }
    wv.size_allocate(&gtk::Allocation::new(0, 0, 1600, 900));
}

/// Gives the stored guard script to every web view that does not have this
/// exact source yet. WebKitGTK user scripts run at document start in every
/// frame (`AllFrames`), which is what the resolver's media sniffer needs.
fn apply_script() {
    if !gtk::is_initialized_main_thread() {
        return;
    }
    let src = script().lock().unwrap().clone();
    let hash = if src.is_empty() { 0 } else { fnv(&src) };
    for wv in webviews() {
        ensure_viewport(&wv);
        if src.is_empty() {
            continue;
        }
        let key = wv.as_ptr() as usize;
        if scripted().lock().unwrap().get(&key) == Some(&hash) {
            continue;
        }
        let Some(ucm) = wv.user_content_manager() else {
            continue;
        };
        let script = UserScript::new(
            &src,
            UserContentInjectedFrames::AllFrames,
            UserScriptInjectionTime::Start,
            &[],
            &[],
        );
        ucm.add_script(&script);
        scripted().lock().unwrap().insert(key, hash);
    }
}

/// Web views are created after `sys.webGuard` may already have run (the
/// resolver host at boot, the player web view on demand), so a slow
/// rescan keeps every new web view scripted. The invokes queue on GTK's
/// main context, which only runs once a web view exists and NSH pumps
/// GTK's events — before that they are a few no-ops.
fn ensure_rescan() {
    if RESCANNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(700));
        let _ = glib::MainContext::default().invoke(|| {
            if gtk::is_initialized_main_thread() {
                apply_script();
            }
        });
    });
}

/// `sys.webGuard` on the GTK thread. Only `script` and `stats` are
/// handled for now; `rules`, `on`, `embeds` and `markResolver` have no
/// WebKitGTK equivalent wired yet (the content-filter store is the same
/// JSON rules format — a later milestone).
fn guard(d: &Value) -> Value {
    if d.get("stats").and_then(Value::as_bool) == Some(true) {
        return json!({
            "ok": true,
            "views": webviews().len(),
            "scripted": scripted().lock().unwrap().len(),
        });
    }
    if let Some(src) = d.get("script").and_then(Value::as_str) {
        if !src.is_empty() {
            *script().lock().unwrap() = src.to_owned();
        }
    }
    apply_script();
    ensure_rescan();
    ensure_eval_loop();
    log::info!(
        "webkitgtk: webGuard script={} bytes, views={} scripted={}",
        script().lock().unwrap().len(),
        webviews().len(),
        scripted().lock().unwrap().len()
    );
    json!({ "ok": true })
}

/// `sys.webGuard` from a host call (any thread): marshal to GTK's thread.
pub(crate) fn handle_guard(data: Value, call: nsh_engine::HostCall) {
    let _ = glib::MainContext::default().invoke(move || {
        let out = guard(&data);
        call.resolve(out);
    });
}

/// `sys.webCookies {url}` on the GTK thread: the `Cookie` header
/// WebKitGTK would send, from the default web context's cookie manager —
/// the store the app's web views share. The cookie callback needs this
/// thread, so `call` is resolved inside it.
fn cookies_for(url: String, call: nsh_engine::HostCall) {
    let Ok(u) = url::Url::parse(&url) else {
        call.resolve(json!({ "ok": false, "error": "bad url" }));
        return;
    };
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    let secure = u.scheme() == "https";
    let path = u.path().to_owned();
    let Some(ctx) = webkit2gtk::WebContext::default() else {
        call.resolve(json!({ "ok": false, "error": "no WebKit context" }));
        return;
    };
    let Some(mgr) = ctx.cookie_manager() else {
        call.resolve(json!({ "ok": false, "error": "no cookie store" }));
        return;
    };
    mgr.cookies(&url, None::<&webkit2gtk::gio::Cancellable>, move |res| {
        let out = match res {
            Ok(cookies) => {
                let mut parts = Vec::new();
                let mut http_only = 0;
                for mut c in cookies {
                    let domain = c.domain().unwrap_or_default().to_string().to_ascii_lowercase();
                    let d = domain.trim_start_matches('.');
                    if !(host == d || host.ends_with(&format!(".{d}"))) {
                        continue;
                    }
                    let cpath = c.path().unwrap_or_else(|| "/".into()).to_string();
                    if !path.starts_with(&cpath) {
                        continue;
                    }
                    if c.is_secure() && !secure {
                        continue;
                    }
                    let name = c.name().unwrap_or_default().to_string();
                    let value = c.value().unwrap_or_default().to_string();
                    if c.is_http_only() {
                        http_only += 1;
                    }
                    parts.push(format!("{name}={value}"));
                }
                json!({ "ok": true, "cookie": parts.join("; "), "count": parts.len(), "httpOnly": http_only })
            }
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        };
        call.resolve(out);
    });
}

/// `sys.webCookies {url}` from a host call (any thread).
pub(crate) fn handle_cookies(url: String, call: nsh_engine::HostCall) {
    let _ = glib::MainContext::default().invoke(move || cookies_for(url, call));
}

/// `sys.webViews` diagnostic: every WebKitWebView widget's URL, title,
/// allocated size and visibility.
pub(crate) fn views_info() -> Value {
    let views: Vec<Value> = webviews()
        .iter()
        .map(|wv| {
            json!({
                "url": wv.uri().map(|u| u.to_string()),
                "title": wv.title().map(|t| t.to_string()),
                "w": wv.allocated_width(),
                "h": wv.allocated_height(),
                "visible": wv.is_visible(),
            })
        })
        .collect();
    json!({ "ok": true, "count": views.len(), "views": views })
}

/// `sys.webViews` from a host call (any thread).
pub(crate) fn handle_views(call: nsh_engine::HostCall) {
    let _ = glib::MainContext::default().invoke(move || {
        let out = views_info();
        call.resolve(out);
    });
}

/// `sys.webBackground {color}` on the GTK thread: every web view draws no
/// background of its own until its page paints (macOS: the WKWebView's
/// under-page color). `#rrggbb` or a name GTK knows; anything else is
/// black. Resolves with how many web views changed.
fn web_background(color: &str) -> Value {
    let c = glib::GString::from(color.trim().trim_start_matches('#'));
    let rgba = if c.len() == 6 && c.bytes().all(|b| b.is_ascii_hexdigit()) {
        let v = u32::from_str_radix(&c, 16).unwrap_or(0);
        gtk::gdk::RGBA::new(
            ((v >> 16) & 0xff) as f64 / 255.0,
            ((v >> 8) & 0xff) as f64 / 255.0,
            (v & 0xff) as f64 / 255.0,
            1.0,
        )
    } else {
        gtk::gdk::RGBA::new(0.0, 0.0, 0.0, 1.0)
    };
    let mut n = 0;
    for wv in webviews() {
        wv.set_background_color(&rgba);
        n += 1;
    }
    json!({ "ok": true, "count": n })
}

/// `sys.webBackground` from a host call (any thread).
pub(crate) fn handle_web_background(data: Value, call: nsh_engine::HostCall) {
    let color = data
        .get("color")
        .and_then(Value::as_str)
        .unwrap_or("black")
        .to_owned();
    let _ = glib::MainContext::default().invoke(move || {
        let out = web_background(&color);
        call.resolve(out);
    });
}

/// `sys.pickFolder {start?}` on the GTK thread: a modal
/// GtkFileChooserDialog (SelectFolder). GTK dialogs run their own nested
/// main loop, so the app's GTK pump keeps working while it is open.
fn pick_folder(start: Option<String>, call: nsh_engine::HostCall) {
    let dlg = gtk::FileChooserDialog::with_buttons(
        Some("Choose a folder"),
        None::<&gtk::Window>,
        gtk::FileChooserAction::SelectFolder,
        &[("_Cancel", gtk::ResponseType::Cancel), ("_Open", gtk::ResponseType::Accept)],
    );
    if let Some(dir) = start.filter(|s| !s.is_empty()) {
        dlg.set_current_folder(&dir);
    }
    let res = dlg.run();
    let out = match res {
        gtk::ResponseType::Accept => match dlg.filename() {
            Some(p) => json!({ "ok": true, "path": p.to_string_lossy().into_owned() }),
            None => json!({ "ok": false }),
        },
        gtk::ResponseType::Cancel => json!({ "ok": true, "cancelled": true }),
        _ => json!({ "ok": false }),
    };
    dlg.close();
    call.resolve(out);
}

/// `sys.pickFolder` from a host call (any thread): GTK widgets need the
/// main thread, and `MainContext::invoke` can land elsewhere, so retry
/// briefly until it does.
pub(crate) fn handle_pick_folder(start: Option<String>, call: nsh_engine::HostCall) {
    fn try_invoke(start: Option<String>, call: nsh_engine::HostCall, tries: u32) {
        if gtk::is_initialized_main_thread() {
            pick_folder(start, call);
            return;
        }
        if tries == 0 {
            call.resolve(json!({ "ok": false, "error": "GTK is not running" }));
            return;
        }
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            try_invoke(start, call, tries - 1);
        });
    }
    let _ = glib::MainContext::default().invoke(move || try_invoke(start, call, 40));
}

/// File-driven eval for debugging (the app's Storage caches its JSON, so
/// storage keys cannot be injected while it runs): write
/// `{"index"?: n, "js": "..."}` to /tmp/rf-webeval.json and the string
/// result lands in /tmp/rf-webeval-result.json.
const EVAL_IN: &str = "/tmp/rf-webeval.json";
const EVAL_OUT: &str = "/tmp/rf-webeval-result.json";

fn eval_file_once() {
    let Ok(raw) = std::fs::read_to_string(EVAL_IN) else {
        return;
    };
    let _ = std::fs::remove_file(EVAL_IN);
    let out = (|| -> Value {
        let d: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
        let index = d.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let js = d.get("js").and_then(Value::as_str).unwrap_or("");
        let Some(wv) = webviews().into_iter().nth(index) else {
            return json!({ "ok": false, "error": "no such web view" });
        };
        // The callback needs this (the GTK) thread, so it cannot be waited
        // on here: it writes the result file itself.
        wv.evaluate_javascript(js, None::<&str>, None::<&str>, None::<&webkit2gtk::gio::Cancellable>, move |res| {
            let out = match res {
                Ok(v) => json!({ "ok": true, "result": v.to_string() }),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            };
            let _ = std::fs::write(EVAL_OUT, out.to_string());
        });
        json!({ "ok": true, "pending": true })
    })();
    if !out.get("pending").is_some() {
        let _ = std::fs::write(EVAL_OUT, out.to_string());
    }
}

fn ensure_eval_loop() {
    static ONCE: AtomicBool = AtomicBool::new(false);
    if ONCE.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(400));
        let _ = glib::MainContext::default().invoke(|| {
            if gtk::is_initialized_main_thread() {
                eval_file_once();
            }
        });
    });
}

/// `sys.webEval {index?, js}` diagnostic: runs `js` in web view `index`
/// (default 0) and resolves with its string result.
#[allow(dead_code)]
pub(crate) fn handle_eval(data: Value, call: nsh_engine::HostCall) {
    let _ = glib::MainContext::default().invoke(move || {
        let index = data.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let js = data.get("js").and_then(Value::as_str).unwrap_or("").to_owned();
        let Some(wv) = webviews().into_iter().nth(index) else {
            call.resolve(json!({ "ok": false, "error": "no such web view" }));
            return;
        };
        wv.evaluate_javascript(&js, None::<&str>, None::<&str>, None::<&webkit2gtk::gio::Cancellable>, move |res| {
            match res {
                Ok(v) => call.resolve(json!({ "ok": true, "result": v.to_string() })),
                Err(e) => call.resolve(json!({ "ok": false, "error": e.to_string() })),
            }
        });
    });
}
