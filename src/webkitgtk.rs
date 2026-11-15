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

use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use gtk::prelude::*;
use webkit2gtk::glib::translate::ToGlibPtr;
use serde_json::{json, Value};
use webkit2gtk::{
    ffi, glib, gio, CookieManagerExt as _, NavigationPolicyDecisionExt as _,
    PolicyDecisionExt as _, URIRequestExt as _,
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

/// `decide-policy` on one web view (connected once): pop-up windows are
/// always refused (the macOS navigation delegate's "pop-ups never
/// open"), and navigations to non-web schemes are refused through the
/// shared `verdict` — with `main = false` it reduces to the scheme
/// rule, which is the only part safe to apply: WebKitGTK 4.1 exposes no
/// is-main-frame on navigation actions, so subframe navigations must
/// not be site-checked (embed players live in iframes).
fn connect_policy(wv: &webkit2gtk::WebView) {
    let key = wv.as_ptr() as usize;
    if !policy_connected().lock().unwrap().insert(key) {
        return;
    }
    wv.connect_decide_policy(|_wv, decision, ptype| {
        use webkit2gtk::PolicyDecisionType::*;
        match ptype {
            NewWindowAction => {
                decision.ignore();
                true
            }
            NavigationAction => {
                let url = decision
                    .downcast_ref::<webkit2gtk::NavigationPolicyDecision>()
                    .and_then(|n| n.navigation_action())
                    .and_then(|a| a.request())
                    .and_then(|r| r.uri())
                    .map(|u| u.to_string());
                let url = match url {
                    Some(u) => u,
                    None => return false,
                };
                let emb = embeds().lock().unwrap().clone();
                if crate::webguard::verdict(&url, false, None, false, &emb)
                    == crate::webguard::Verdict::Deny
                {
                    log::info!("webkitgtk: refused navigation to {url}");
                    decision.ignore();
                    return true;
                }
                false
            }
            _ => false,
        }
    });
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
        connect_policy(&wv);
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
                ensure_filters();
            }
        });
    });
}

// --- Content filters (sys.webGuard `rules` / `resolverRules`) ---------------
//
// The same WebKit content-blocker JSON WKContentRuleList takes on macOS,
// compiled by WebKitUserContentFilterStore and attached to each web
// view's UserContentManager. Ad rules go on every view while `on`;
// resolver rules (no images/fonts/pings — the resolver only needs
// scripts, XHR and media) go on the views `markResolver` marked, found
// by the `__rf_resolver__` title the resolver sets on its about:blank
// page — the widget pointer is remembered, like macOS remembers the
// controller.

/// What the filters should be: `on` gates the ad list; `ad`/`res` are the
/// compiled-rule identifiers (the JSON only matters until compilation is
/// queued).
#[derive(Default, Clone)]
struct GuardFilters {
    on: bool,
    ad: Option<String>,
    res: Option<String>,
}

static GUARD_FILTERS: OnceLock<Mutex<GuardFilters>> = OnceLock::new();
/// Compiled filters by identifier (kept alive for the app's run).
/// Raw WebKit pointers are only touched on the GTK thread; the wrappers
/// say so to the compiler.
struct SendPtr<T>(*mut T);
unsafe impl<T> Send for SendPtr<T> {}
unsafe impl<T> Sync for SendPtr<T> {}

static COMPILED: OnceLock<Mutex<HashMap<String, SendPtr<ffi::WebKitUserContentFilter>>>> =
    OnceLock::new();
/// Widget pointers `markResolver` marked.
static RESOLVERS: OnceLock<Mutex<HashSet<usize>>> = OnceLock::new();
/// Web view -> filter generation last applied to it.
static FILTER_VIEWS: OnceLock<Mutex<HashMap<usize, u64>>> = OnceLock::new();
static FILTER_GEN: AtomicU64 = AtomicU64::new(0);
static FILTER_DIRTY: AtomicBool = AtomicBool::new(false);
/// Rulesets waiting for the first web view: compiling before any
/// WebKitWebView exists crashes WebKitGTK's filter store (the compile
/// runs through the WebKit network process a web view spawns).
static PENDING_RULES: OnceLock<Mutex<Vec<(String, String)>>> = OnceLock::new();
/// Web views whose decide-policy signal is already connected.
static POLICY_CONNECTED: OnceLock<Mutex<HashSet<usize>>> = OnceLock::new();
/// Embed hosts from `sys.webGuard {embeds}` (site() names, lowercase).
static EMBEDS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn pending_rules() -> &'static Mutex<Vec<(String, String)>> {
    PENDING_RULES.get_or_init(|| Mutex::new(Vec::new()))
}
fn policy_connected() -> &'static Mutex<HashSet<usize>> {
    POLICY_CONNECTED.get_or_init(|| Mutex::new(HashSet::new()))
}
fn embeds() -> &'static Mutex<HashSet<String>> {
    EMBEDS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn guard_filters() -> &'static Mutex<GuardFilters> {
    GUARD_FILTERS.get_or_init(|| Mutex::new(GuardFilters::default()))
}
fn compiled() -> &'static Mutex<HashMap<String, SendPtr<ffi::WebKitUserContentFilter>>> {
    COMPILED.get_or_init(|| Mutex::new(HashMap::new()))
}
fn resolvers() -> &'static Mutex<HashSet<usize>> {
    RESOLVERS.get_or_init(|| Mutex::new(HashSet::new()))
}
fn filter_views() -> &'static Mutex<HashMap<usize, u64>> {
    FILTER_VIEWS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn rule_id(kind: &str, json: &str) -> String {
    format!("rustflix-{kind}-{:x}", fnv(json))
}

/// The filter store under the app's cache dir; filters compile once and
/// are reused across runs.
fn filter_store() -> Option<*mut ffi::WebKitUserContentFilterStore> {
    static STORE: OnceLock<SendPtr<ffi::WebKitUserContentFilterStore>> = OnceLock::new();
    let p = STORE
        .get_or_init(|| {
            let home = std::env::var_os("HOME").map(PathBuf::from);
            let base = std::env::var_os("XDG_CACHE_HOME")
                .map(PathBuf::from)
                .or_else(|| home.map(|h| h.join(".cache")));
            let Some(dir) = base.map(|b| b.join("com.hexuria.rustflix/webkit-filters")) else {
                return SendPtr(std::ptr::null_mut());
            };
            if std::fs::create_dir_all(&dir).is_err() {
                return SendPtr(std::ptr::null_mut());
            }
            let Ok(c) = CString::new(dir.to_string_lossy().as_bytes()) else {
                return SendPtr(std::ptr::null_mut());
            };
            // SAFETY: path outlives the call (the store copies it).
            SendPtr(unsafe { ffi::webkit_user_content_filter_store_new(c.as_ptr()) })
        })
        .0;
    if p.is_null() {
        None
    } else {
        Some(p)
    }
}

/// A `save` completion: stores the compiled filter and re-applies.
/// SAFETY: GAsyncReadyCallback contract; runs on the default main
/// context's thread.
unsafe extern "C" fn save_done(
    _src: *mut glib::gobject_ffi::GObject,
    res: *mut gio::ffi::GAsyncResult,
    data: glib::ffi::gpointer,
) {
    let job = Box::from_raw(data as *mut String);
    let id = *job;
    let Some(store) = filter_store() else { return };
    let mut err = std::ptr::null_mut();
    // SAFETY: `res` is this save's result; `err` is a GError** we own.
    let filter = unsafe {
        ffi::webkit_user_content_filter_store_save_finish(store, res, &mut err)
    };
    if filter.is_null() {
        let why = if err.is_null() {
            "unknown".to_owned()
        } else {
            // SAFETY: GError from save_finish; message is valid UTF-8-ish.
            let e = unsafe { &*err };
            let m = e.message;
            let s = if m.is_null() {
                String::new()
            } else {
                unsafe { std::ffi::CStr::from_ptr(m) }.to_string_lossy().into_owned()
            };
            if !err.is_null() {
                unsafe { glib::ffi::g_error_free(err) };
            }
            s
        };
        log::warn!("webkitgtk: content rules failed ({id}): {why}");
        return;
    }
    compiled().lock().unwrap().insert(id.clone(), SendPtr(filter));
    log::info!("webkitgtk: content rules compiled ({id})");
    sync_filters();
}

/// Compiles `json` under `id` through the filter store (async; the
/// callback applies it). Called on the GTK thread. Before the first web
/// view exists the compile is queued: WebKitGTK's store crashes without
/// a live WebContext (verified: 27 KB ruleset aborts the process,
/// deferred it compiles).
fn compile_rules(id: String, json: &str) {
    if webviews().is_empty() {
        pending_rules().lock().unwrap().push((id, json.to_owned()));
        return;
    }
    let Some(store) = filter_store() else {
        log::warn!("webkitgtk: no filter store for content rules");
        return;
    };
    if compiled().lock().unwrap().contains_key(&id) {
        return;
    }
    let bytes = glib::Bytes::from(json.as_bytes());
    // `to_glib_full` hands us a ref on the GBytes; `save` does not take
    // ownership, so it is intentionally never freed (a ruleset is sent
    // once per session — a few hundred KB at most).
    let bptr = bytes.to_glib_full();
    let job = Box::into_raw(Box::new(id.clone()));
    let Ok(cid) = CString::new(id.as_str()) else {
        unsafe { drop(Box::from_raw(job)) };
        return;
    };
    // SAFETY: valid store/bytes/job pointers; the callback frees `job`.
    unsafe {
        ffi::webkit_user_content_filter_store_save(
            store,
            cid.as_ptr(),
            bptr,
            std::ptr::null_mut(),
            Some(save_done),
            job as glib::ffi::gpointer,
        );
    }
}

/// Adds/removes the current filters on one web view's content manager.
/// SAFETY-free: the ffi calls borrow live objects.
fn apply_filters_to(wv: &webkit2gtk::WebView, st: &GuardFilters) {
    let Some(ucm) = wv.user_content_manager() else {
        return;
    };
    // The stash must outlive the ffi calls: dropping it unrefs the
    // manager and `ucm_ptr` would dangle.
    let ucm_stash = ucm.to_glib_none();
    let ucm_ptr = ucm_stash.0;
    let is_res = resolvers()
        .lock()
        .unwrap()
        .contains(&(wv.as_ptr() as usize));
    let compiled = compiled().lock().unwrap();
    for (id, want) in [
        (st.ad.as_deref(), st.on),
        (st.res.as_deref(), is_res),
    ] {
        let Some(id) = id else { continue };
        let Ok(cid) = CString::new(id) else { continue };
        // SAFETY: `ucm` and `cid` outlive the calls; `f` is our own ref.
        unsafe {
            ffi::webkit_user_content_manager_remove_filter_by_id(ucm_ptr, cid.as_ptr());
            if want {
                if let Some(f) = compiled.get(id) {
                    ffi::webkit_user_content_manager_add_filter(ucm_ptr, f.0);
                }
            }
        }
    }
}

/// (Re)applies the wanted filters to every web view at the current
/// generation. GTK thread only.
fn sync_filters() {
    if !gtk::is_initialized_main_thread() {
        return;
    }
    FILTER_DIRTY.store(false, Ordering::SeqCst);
    let generation = FILTER_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let st = guard_filters().lock().unwrap().clone();
    for wv in webviews() {
        apply_filters_to(&wv, &st);
        filter_views()
            .lock()
            .unwrap()
            .insert(wv.as_ptr() as usize, generation);
    }
}

/// Keeps filters on web views created after `sys.webGuard` ran: the
/// rescan applies scripts and fills in filters for views not yet synced
/// at the current generation.
fn ensure_filters() {
    if !gtk::is_initialized_main_thread() {
        return;
    }
    if !webviews().is_empty() {
        let pending: Vec<(String, String)> =
            std::mem::take(&mut *pending_rules().lock().unwrap());
        for (id, json) in pending {
            compile_rules(id, &json);
        }
    }
    let generation = FILTER_GEN.load(Ordering::SeqCst);
    for wv in webviews() {
        let key = wv.as_ptr() as usize;
        if filter_views().lock().unwrap().get(&key) == Some(&generation) {
            continue;
        }
        let st = guard_filters().lock().unwrap().clone();
        apply_filters_to(&wv, &st);
        filter_views().lock().unwrap().insert(key, generation);
    }
}

/// `sys.webGuard` on the GTK thread. Handles `script`, `stats`, `on`,
/// `rules`, `resolverRules` and `markResolver`; `embeds`, `hosts`,
/// `patterns` and `allow` describe macOS's navigation policy, which has
/// no WebKitGTK wiring yet (the in-page guard covers JS-level cases).
fn guard(d: &Value) -> Value {
    if d.get("stats").and_then(Value::as_bool) == Some(true) {
        return json!({
            "ok": true,
            "views": webviews().len(),
            "scripted": scripted().lock().unwrap().len(),
            "filters": compiled().lock().unwrap().len(),
            "resolverViews": resolvers().lock().unwrap().len(),
        });
    }
    if let Some(src) = d.get("script").and_then(Value::as_str) {
        if !src.is_empty() {
            *script().lock().unwrap() = src.to_owned();
        }
    }
    let mut marked = 0usize;
    {
        let mut st = guard_filters().lock().unwrap();
        // macOS: `on` defaults to true on every call.
        st.on = d.get("on").and_then(Value::as_bool).unwrap_or(true);
        if let Some(json) = d.get("rules").and_then(Value::as_str) {
            let id = rule_id("adblock", json);
            st.ad = Some(id.clone());
            compile_rules(id, json);
        }
        if let Some(json) = d.get("resolverRules").and_then(Value::as_str) {
            let id = rule_id("resolver", json);
            st.res = Some(id.clone());
            compile_rules(id, json);
        }
    }
    if let Some(e) = d.get("embeds").and_then(Value::as_array) {
        *embeds().lock().unwrap() = e
            .iter()
            .filter_map(Value::as_str)
            .map(|s| s.to_ascii_lowercase())
            .collect();
    }
    if let Some(title) = d.get("markResolver").and_then(Value::as_str) {
        // Same protocol as macOS: the resolver sets this title on its
        // idle about:blank page; the widget is remembered as the
        // resolver's (it keeps it across navigations).
        for wv in webviews() {
            if wv.title().is_some_and(|t| t.as_str() == title) {
                resolvers().lock().unwrap().insert(wv.as_ptr() as usize);
                marked += 1;
            }
        }
    }
    sync_filters();
    apply_script();
    ensure_rescan();
    ensure_eval_loop();
    log::info!(
        "webkitgtk: webGuard script={} bytes, views={} scripted={} filters={} marked={}",
        script().lock().unwrap().len(),
        webviews().len(),
        scripted().lock().unwrap().len(),
        compiled().lock().unwrap().len(),
        marked,
    );
    json!({ "ok": true, "marked": marked })
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
