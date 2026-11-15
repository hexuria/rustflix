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
use webkit2gtk::glib::translate::{from_glib_none, IntoGlib, ToGlibPtr};
use serde_json::{json, Value};
use webkit2gtk::{
    ffi, glib, gio, CookieManagerExt as _, NavigationPolicyDecisionExt as _,
    PolicyDecisionExt as _, URIRequestExt as _,
    UserContentInjectedFrames, UserContentManagerExt as _, UserScript, UserScriptInjectionTime,
    WebContextExt as _, WebViewExt as _,
};

/// What this module has done to one web view.
#[derive(Default)]
struct ViewState {
    /// Hash of the guard script it was given.
    script: Option<u64>,
    /// The filter generation last applied to it.
    filters: Option<u64>,
    /// `markResolver` marked it.
    resolver: bool,
}

// `MainContext::invoke` can run its callback on whichever thread iterates
// the context, so this state is shared, not thread-local. Every GTK call
// stays behind `is_initialized_main_thread`.
//
// VIEWS is keyed by the widget's address. An entry is made by `adopt`
// and removed by that widget's `destroy` handler, and an address is only
// reused after that, so a new web view never inherits an old one's entry.
// No GTK call is made while the lock is held (`destroy` takes it).
static VIEWS: OnceLock<Mutex<HashMap<usize, ViewState>>> = OnceLock::new();
static SCRIPT: OnceLock<Mutex<String>> = OnceLock::new();

fn views() -> &'static Mutex<HashMap<usize, ViewState>> {
    VIEWS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn script() -> &'static Mutex<String> {
    SCRIPT.get_or_init(|| Mutex::new(String::new()))
}

fn key_of(wv: &webkit2gtk::WebView) -> usize {
    wv.as_ptr() as usize
}

/// `markResolver` marked this web view.
fn is_resolver(wv: &webkit2gtk::WebView) -> bool {
    views().lock().unwrap().get(&key_of(wv)).is_some_and(|v| v.resolver)
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

/// wry only calls `set_bounds` while a web view is shown, so one that is
/// never shown (the resolver's) keeps its tiny initial allocation and the
/// page lays out at ~200x200 CSS px: embed players never initialize and
/// the media sniffer finds nothing. Mirror `set_bounds` for it: resize
/// the foreign X window and re-allocate the widget chain (wry's GtkWindow
/// -> GtkBox -> WebKitWebView).
///
/// Only for the resolver's view. The size request made here is a minimum
/// that stays: on the player's web view, which is shown and sized by wry,
/// it kept the widget at 1600x900 whatever the video area was, wry's
/// allocation changed nothing, and WebKit never laid the page out again —
/// the page drew its controls squeezed into the top left corner.
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

/// wry's `set_bounds` sizes a web view's GtkWindow whether or not the view
/// is shown, but GTK allocates nothing to a hidden widget, and showing it
/// afterwards allocates nothing either: the window's size has not changed
/// since. The player's web view is built hidden at wry's default 200x200
/// and shown when a page plays; it kept that size, and the page drew its
/// controls squeezed into the window's top left corner. So a web view
/// that has just been mapped takes the size of its window.
fn fit_to_window(wv: &webkit2gtk::WebView) {
    if !wv.is_mapped() {
        return;
    }
    // The toplevel ancestor is wry's GtkWindow.
    let mut top = wv.clone().upcast::<gtk::Widget>();
    while let Some(p) = top.parent() {
        top = p;
    }
    let Some(window) = top.window() else { return };
    // From the X server: GDK's own idea of the size waits for an event.
    let (_, _, w, h) = window.geometry();
    let fits = |wv: &webkit2gtk::WebView| wv.allocated_width() == w && wv.allocated_height() == h;
    if w <= 1 || h <= 1 || fits(wv) {
        return;
    }
    top.size_allocate(&gtk::Allocation::new(0, 0, w, h));
    if !fits(wv) {
        wv.size_allocate(&gtk::Allocation::new(0, 0, w, h));
    }
    log::debug!("webkitgtk: web view sized to its window, {w}x{h}");
}

/// `decide-policy` on one web view (`adopt` connects it once): pop-up windows are
/// always refused (the macOS navigation delegate's "pop-ups never
/// open"), and navigations to non-web schemes are refused through the
/// shared `verdict` — with `main = false` it reduces to the scheme
/// rule, which is the only part safe to apply: WebKitGTK 4.1 exposes no
/// is-main-frame on navigation actions, so subframe navigations must
/// not be site-checked (embed players live in iframes).
fn connect_policy(wv: &webkit2gtk::WebView) {
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

/// First sight of a web view: its entry in VIEWS, the handler that takes
/// the entry out again, the navigation policy, and the viewport fix
/// before each of its loads. False when it was already known.
fn adopt(wv: &webkit2gtk::WebView) -> bool {
    let key = key_of(wv);
    {
        let mut all = views().lock().unwrap();
        if all.contains_key(&key) {
            return false;
        }
        all.insert(key, ViewState::default());
    }
    wv.connect_destroy(move |_| {
        if let Ok(mut all) = views().lock() {
            all.remove(&key);
        }
    });
    connect_policy(wv);
    wv.connect_load_changed(|wv, event| {
        if event == webkit2gtk::LoadEvent::Started && is_resolver(wv) {
            ensure_viewport(wv);
        }
    });
    // After wry's own show sequence has run (it maps the view, then its
    // window).
    wv.connect_map(move |_| {
        glib::idle_add_once(move || {
            if !gtk::is_initialized_main_thread() {
                return;
            }
            if let Some(wv) = webviews().into_iter().find(|w| key_of(w) == key) {
                fit_to_window(&wv);
            }
        });
    });
    true
}

/// Gives one web view the stored guard script unless it has this exact
/// source already. WebKitGTK user scripts run at document start in every
/// frame (`AllFrames`), which is what the resolver's media sniffer needs.
fn give_script(wv: &webkit2gtk::WebView) {
    let src = script().lock().unwrap().clone();
    if src.is_empty() {
        return;
    }
    let (key, hash) = (key_of(wv), fnv(&src));
    if views().lock().unwrap().get(&key).is_some_and(|v| v.script == Some(hash)) {
        return;
    }
    let Some(ucm) = wv.user_content_manager() else {
        return;
    };
    let script = UserScript::new(
        &src,
        UserContentInjectedFrames::AllFrames,
        UserScriptInjectionTime::Start,
        &[],
        &[],
    );
    ucm.add_script(&script);
    if let Some(v) = views().lock().unwrap().get_mut(&key) {
        v.script = Some(hash);
    }
}

/// Every web view there is now: known, with a real viewport and the
/// current guard script (`sys.webGuard` runs this).
fn apply_script() {
    if !gtk::is_initialized_main_thread() {
        return;
    }
    for wv in webviews() {
        adopt(&wv);
        if is_resolver(&wv) {
            ensure_viewport(&wv);
        }
        give_script(&wv);
    }
}

/// A web view wry has just built (the `parent-set` hook): script and
/// filters at once, before its first load. Rules that were waiting for a
/// first web view compile on the next turn of GTK's loop, when wry has
/// finished building it.
fn on_new_view(wv: &webkit2gtk::WebView) {
    if !adopt(wv) {
        // `parent-set` again: it only moved.
        return;
    }
    give_script(wv);
    give_filters(wv);
    glib::idle_add_once(|| {
        if gtk::is_initialized_main_thread() {
            flush_pending_rules();
        }
    });
}

/// SAFETY: the GSignalEmissionHook contract. `values[0]` holds the
/// emitting instance, borrowed for the call; GTK emits on its own thread.
unsafe extern "C" fn on_parent_set(
    _hint: *mut glib::gobject_ffi::GSignalInvocationHint,
    n_values: std::ffi::c_uint,
    values: *const glib::gobject_ffi::GValue,
    _data: glib::ffi::gpointer,
) -> glib::ffi::gboolean {
    if n_values > 0 && !values.is_null() {
        // A panic must not cross into GLib.
        let _ = std::panic::catch_unwind(|| {
            // SAFETY: `values` points at `n_values` initialised GValues;
            // the first is a GtkWidget (the signal's owner type).
            let obj = unsafe { glib::gobject_ffi::g_value_get_object(values) };
            if obj.is_null() {
                return;
            }
            // SAFETY: a live GObject; `from_glib_none` takes its own ref.
            let obj: glib::Object = unsafe { from_glib_none(obj) };
            if let Ok(wv) = obj.downcast::<webkit2gtk::WebView>()
                && wv.parent().is_some()
            {
                on_new_view(&wv);
            }
        });
    }
    // Stay connected.
    glib::ffi::GTRUE
}

/// Web views are created after `sys.webGuard` may already have run (the
/// resolver host at boot, the player web view on demand). wry has no
/// construction hook, but it puts every web view it builds into a
/// container, and GTK emits `parent-set` for that. An emission hook on
/// that signal sees each new web view as it is built, so it is set up
/// once, before its first load, and nothing has to poll for it.
fn ensure_hook() {
    static HOOKED: AtomicBool = AtomicBool::new(false);
    if HOOKED.swap(true, Ordering::SeqCst) {
        return;
    }
    let widget = gtk::Widget::static_type().into_glib();
    // SAFETY: GtkWidget is a registered classed type. Its signals exist
    // once the class is initialised; the class reference is kept for the
    // app's run, like the hook. `on_parent_set` matches GSignalEmissionHook
    // and takes no data.
    let id = unsafe {
        glib::gobject_ffi::g_type_class_ref(widget);
        let id = glib::gobject_ffi::g_signal_lookup(c"parent-set".as_ptr(), widget);
        if id != 0 {
            glib::gobject_ffi::g_signal_add_emission_hook(
                id,
                0,
                Some(on_parent_set),
                std::ptr::null_mut(),
                None,
            );
        }
        id
    };
    if id == 0 {
        log::warn!("webkitgtk: no parent-set signal; web views made later wait for the next sys.webGuard");
    }
}

// --- Content filters (sys.webGuard `rules` / `resolverRules`) ---------------
//
// The same WebKit content-blocker JSON WKContentRuleList takes on macOS,
// compiled by WebKitUserContentFilterStore and attached to each web
// view's UserContentManager. Ad rules go on every view while `on`;
// resolver rules (no images/fonts/pings — the resolver only needs
// scripts, XHR and media) go on the views `markResolver` marked, found
// by the `__rf_resolver__` title the resolver sets on its about:blank
// page — the mark is kept in the view's `ViewState`, like macOS remembers
// the controller.

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
/// Bumped whenever the wanted filters change (`ViewState::filters`).
static FILTER_GEN: AtomicU64 = AtomicU64::new(0);
/// Rulesets waiting for the first web view: compiling before any
/// WebKitWebView exists crashes WebKitGTK's filter store (the compile
/// runs through the WebKit network process a web view spawns).
static PENDING_RULES: OnceLock<Mutex<Vec<(String, String)>>> = OnceLock::new();
/// Embed hosts from `sys.webGuard {embeds}` (site() names, lowercase).
static EMBEDS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn pending_rules() -> &'static Mutex<Vec<(String, String)>> {
    PENDING_RULES.get_or_init(|| Mutex::new(Vec::new()))
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
    let is_res = views().lock().unwrap().get(&key_of(wv)).is_some_and(|v| v.resolver);
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

/// (Re)applies the wanted filters to every web view, at a new
/// generation. GTK thread only.
fn sync_filters() {
    if !gtk::is_initialized_main_thread() {
        return;
    }
    let generation = FILTER_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let st = guard_filters().lock().unwrap().clone();
    for wv in webviews() {
        adopt(&wv);
        apply_filters_to(&wv, &st);
        if let Some(v) = views().lock().unwrap().get_mut(&key_of(&wv)) {
            v.filters = Some(generation);
        }
    }
}

/// Filters for one web view that is not at the current generation yet
/// (one created after the last `sync_filters`).
fn give_filters(wv: &webkit2gtk::WebView) {
    let key = key_of(wv);
    let generation = FILTER_GEN.load(Ordering::SeqCst);
    if views().lock().unwrap().get(&key).is_some_and(|v| v.filters == Some(generation)) {
        return;
    }
    let st = guard_filters().lock().unwrap().clone();
    apply_filters_to(wv, &st);
    if let Some(v) = views().lock().unwrap().get_mut(&key) {
        v.filters = Some(generation);
    }
}

/// Compiles the rulesets that were waiting for a first web view.
fn flush_pending_rules() {
    if webviews().is_empty() {
        return;
    }
    let pending: Vec<(String, String)> = std::mem::take(&mut *pending_rules().lock().unwrap());
    for (id, json) in pending {
        compile_rules(id, &json);
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
            "scripted": views().lock().unwrap().values().filter(|v| v.script.is_some()).count(),
            "filters": compiled().lock().unwrap().len(),
            "resolverViews": views().lock().unwrap().values().filter(|v| v.resolver).count(),
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
                adopt(&wv);
                if let Some(v) = views().lock().unwrap().get_mut(&key_of(&wv)) {
                    v.resolver = true;
                }
                ensure_viewport(&wv);
                marked += 1;
            }
        }
    }
    flush_pending_rules();
    sync_filters();
    apply_script();
    ensure_hook();
    log::info!(
        "webkitgtk: webGuard script={} bytes, views={} scripted={} filters={} marked={}",
        script().lock().unwrap().len(),
        webviews().len(),
        views().lock().unwrap().values().filter(|v| v.script.is_some()).count(),
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
