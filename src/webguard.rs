//! Ad blocking in the app's web views (`sys.webGuard`; the macOS side of
//! app/lib/adblock.ts — iOS: ios/Rustflix/WebGuard.swift).
//!
//! NSH (nsh-platform-gpui) builds its WKWebViews through wry with no
//! configuration hook, so WebKit's own entry points are hooked at startup,
//! before any web view exists:
//!
//! - `-[WKWebView initWithFrame:configuration:]` (wry calls it with
//!   `msg_send![super(webview), …]`, which still lands on WKWebView's
//!   method): before WebKit copies the configuration, its user content
//!   controller gets the compiled content blocker (WKContentRuleList) and
//!   the guard script for every frame at document start. Both are in place
//!   before the view's first navigation; the long-lived player and resolver
//!   views keep them across all their navigations. A view made before the
//!   app handed over the lists gets them once they are compiled (from its
//!   next request on).
//! - `-[WKWebView setNavigationDelegate:]` / `setUIDelegate:`: the delegate
//!   classes (wry's) get a check in front of
//!   `webView:decidePolicyForNavigationAction:decisionHandler:` (the main
//!   frame may only go to the embed hosts, the site it shows, or on through
//!   the redirects of a navigation it was allowed to start, tracked with
//!   `webView:didCommitNavigation:`; no frame may open a non-web scheme) and
//!   in front of `…requestMediaCapturePermission…` (wry grants camera and
//!   microphone to any page; refused while on). Pop-up windows never open:
//!   NSH gives wry no new-window handler, so its UI delegate makes none.
//!
//! Every hook runs on the main thread (WebKit's); the state lives there.

use nsh_engine::HostChannel;

pub(crate) fn register(host: &HostChannel) {
    // Any platform with this crate: a GET with the page's headers, for the
    // subtitle files a source's page offers (their hosts are arbitrary; the
    // app's own fetch only reaches nsh.json's hosts).
    host.handle("sys.webFetch", |call| {
        let data = call.data().clone();
        std::thread::spawn(move || call.resolve(web_fetch(&data)));
    });
    #[cfg(target_os = "macos")]
    {
        mac::install();
        host.handle("sys.webGuard", |call| {
            let data = call.data().clone();
            dispatch2::DispatchQueue::main().exec_async(move || {
                let out = mac::handle(&data);
                call.resolve(out);
            });
        });
        host.handle("sys.webCookies", |call| {
            let url = call.data().get("url").and_then(|v| v.as_str()).unwrap_or("").to_owned();
            dispatch2::DispatchQueue::main().exec_async(move || mac::cookies(url, call));
        });
    }
    #[cfg(not(target_os = "macos"))]
    for name in ["sys.webGuard", "sys.webCookies"] {
        host.handle(name, |call| call.resolve(serde_json::json!({ "ok": false })));
    }
}

/// Headers a caller may not set (the transport's own).
const HOP: [&str; 6] = ["host", "content-length", "connection", "transfer-encoding", "range", "accept-encoding"];

/// `sys.webFetch {url, headers?, max?}` → `{ok, status, b64, contentType}`
/// (2xx, at most `max` bytes, default 8 MB, never above 16 MB) or
/// `{ok:false, status?, error?}`. GET over http(s) only.
fn web_fetch(d: &serde_json::Value) -> serde_json::Value {
    use serde_json::json;
    use std::io::Read;
    let url = d.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let Ok(parsed) = url::Url::parse(url) else { return json!({ "ok": false, "error": "bad url" }) };
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return json!({ "ok": false, "error": "not http(s)" });
    }
    let mut headers = crate::dl::http::Headers::new();
    if let Some(h) = d.get("headers").and_then(|v| v.as_object()) {
        for (k, v) in h {
            let Some(v) = v.as_str() else { continue };
            if k.is_empty() || k.contains(['\r', '\n', ':']) || v.contains(['\r', '\n']) {
                continue;
            }
            if HOP.contains(&k.to_ascii_lowercase().as_str()) {
                continue;
            }
            headers.insert(k.clone(), v.to_owned());
        }
    }
    let max = d.get("max").and_then(|v| v.as_u64()).unwrap_or(8 << 20).min(16 << 20);
    let http = crate::dl::http::Http::new();
    let mut resp = match http.get(url, &headers, &[]) {
        Ok(r) => r,
        Err(e) => return json!({ "ok": false, "error": e.text }),
    };
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return json!({ "ok": false, "status": status });
    }
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let mut buf = Vec::new();
    if let Err(e) = resp.body_mut().with_config().limit(max).reader().read_to_end(&mut buf) {
        return json!({ "ok": false, "status": status, "error": e.to_string() });
    }
    json!({ "ok": true, "status": status, "b64": base64(&buf), "contentType": ct })
}

/// Standard base64 (with padding).
fn base64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// The registrable part of a host ("a.b.example.co.uk" → "example.co.uk"),
/// as app/lib/adblock.ts `siteOf`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn site(host: &str) -> String {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    let p: Vec<&str> = h.split('.').collect();
    if p.len() <= 2 {
        return h;
    }
    let (sl, tl) = (p[p.len() - 2], p[p.len() - 1]);
    let n = if tl.len() == 2 && ["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go"].contains(&sl) {
        3
    } else {
        2
    };
    p[p.len() - n..].join(".")
}

/// Whether a main-frame navigation to `url` may go ahead.
/// `current`: the page's URL now; `pending`: a navigation the view was
/// allowed to start has not committed yet (its redirects pass).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, PartialEq)]
enum Verdict {
    Allow,
    /// Allowed, and it starts a navigation whose redirects pass.
    Start,
    Deny,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn verdict(
    url: &str,
    main: bool,
    current: Option<&str>,
    pending: bool,
    embeds: &std::collections::HashSet<String>,
) -> Verdict {
    let Ok(u) = url::Url::parse(url) else { return Verdict::Allow };
    let scheme = u.scheme();
    if matches!(scheme, "about" | "data" | "blob" | "javascript") {
        return Verdict::Allow;
    }
    if scheme != "http" && scheme != "https" {
        return Verdict::Deny;
    }
    if !main {
        return Verdict::Allow;
    }
    let host = u.host_str().unwrap_or("");
    // The app's own local pages (downloads play from a localhost server).
    if matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
        return Verdict::Start;
    }
    let target = site(host);
    if embeds.contains(&target) {
        return Verdict::Start;
    }
    let cur = current.and_then(|c| url::Url::parse(c).ok());
    // Leaving one of the app's own pages (a download's localhost player):
    // the app navigates; no guard there.
    if cur.as_ref().is_some_and(|c| matches!(c.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))) {
        return Verdict::Start;
    }
    match cur {
        Some(c) if c.scheme() == "http" || c.scheme() == "https" => {
            if site(c.host_str().unwrap_or("")) == target {
                Verdict::Start
            } else if pending {
                Verdict::Allow
            } else {
                Verdict::Deny
            }
        }
        // Nothing shown yet (about:blank, a new view): the app's own load.
        _ => Verdict::Start,
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};
    use std::ffi::{CStr, c_char};
    use std::sync::Once;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    use block2::{Block, RcBlock};
    use objc2::ffi;
    use objc2::rc::{Retained, Weak};
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::msg_send;
    use objc2_foundation::NSString;
    use serde_json::{Value, json};

    use super::{Verdict, verdict};

    type Obj = Retained<AnyObject>;

    /// One compiled content rule list.
    #[derive(Default)]
    struct Rules {
        list: Option<Obj>,
        id: String,
        state: String,
    }

    #[derive(Default)]
    struct State {
        on: bool,
        /// The ad/tracker blocker (every web view, while on).
        ad: Rules,
        /// The resolver's extra list (images, fonts…; the marked views only).
        res: Rules,
        /// Controllers of the hidden resolver web view(s).
        res_ctrls: Vec<Weak<AnyObject>>,
        script: Option<Obj>,
        script_src: String,
        embeds: HashSet<String>,
        controllers: Vec<Weak<AnyObject>>,
        pending: HashMap<usize, Instant>,
        hooked: HashSet<usize>,
        /// Original implementations: (class, selector name) → IMP.
        originals: HashMap<(usize, &'static str), Imp>,
        nav_denied: u32,
        denied_hosts: HashMap<String, u32>,
        scheme_denied: u32,
        capture_denied: u32,
    }

    thread_local! {
        static STATE: RefCell<State> = RefCell::new(State { on: true, ad: Rules { state: "none".into(), ..Default::default() }, ..Default::default() });
    }

    static INSTALL: Once = Once::new();
    static ORIG_INIT: AtomicUsize = AtomicUsize::new(0);
    static ORIG_SET_NAV: AtomicUsize = AtomicUsize::new(0);
    static ORIG_SET_UI: AtomicUsize = AtomicUsize::new(0);

    const DECIDE: &str = "webView:decidePolicyForNavigationAction:decisionHandler:";
    const COMMIT: &str = "webView:didCommitNavigation:";
    const CAPTURE: &str = "webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:";

    /// `CGRect`, passed by value as WebKit declares it.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }

    fn sel_of(name: &str) -> Sel {
        Sel::register(&std::ffi::CString::new(name).unwrap())
    }

    /// Replaces `cls`'s `name` with `imp`; the old IMP, if the class (or a
    /// superclass) had one. Added to `cls` itself when only a superclass
    /// had it, so siblings are untouched.
    unsafe fn replace(cls: *const AnyClass, name: &str, imp: Imp, types: &CStr) -> Option<Imp> {
        let sel = sel_of(name);
        unsafe {
            let m = ffi::class_getInstanceMethod(cls, sel);
            if m.is_null() {
                ffi::class_addMethod(cls as *mut AnyClass, sel, imp, types.as_ptr());
                return None;
            }
            let orig = ffi::method_getImplementation(m);
            let enc: *const c_char = ffi::method_getTypeEncoding(m);
            if !ffi::class_addMethod(cls as *mut AnyClass, sel, imp, enc).as_bool() {
                ffi::method_setImplementation(m, imp);
            }
            orig
        }
    }

    pub(super) fn install() {
        INSTALL.call_once(|| {
            let Some(wk) = AnyClass::get(c"WKWebView") else {
                log::warn!("webguard: no WKWebView class");
                return;
            };
            // SAFETY: the replacements have the methods' exact signatures
            // and call the saved originals.
            unsafe {
                let cls = wk as *const AnyClass;
                let init: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, Rect, *mut AnyObject) -> *mut AnyObject =
                    init_hook;
                if let Some(o) = replace(cls, "initWithFrame:configuration:", std::mem::transmute::<_, Imp>(init), c"@@:{CGRect={CGPoint=dd}{CGSize=dd}}@") {
                    ORIG_INIT.store(o as usize, Ordering::SeqCst);
                }
                let nav: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) = set_nav_hook;
                if let Some(o) = replace(cls, "setNavigationDelegate:", std::mem::transmute::<_, Imp>(nav), c"v@:@") {
                    ORIG_SET_NAV.store(o as usize, Ordering::SeqCst);
                }
                let ui: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) = set_ui_hook;
                if let Some(o) = replace(cls, "setUIDelegate:", std::mem::transmute::<_, Imp>(ui), c"v@:@") {
                    ORIG_SET_UI.store(o as usize, Ordering::SeqCst);
                }
            }
        });
    }

    // --- Hooks ------------------------------------------------------------------

    unsafe extern "C-unwind" fn init_hook(this: *mut AnyObject, sel: Sel, frame: Rect, config: *mut AnyObject) -> *mut AnyObject {
        if let Some(config) = unsafe { config.as_ref() } {
            prepare(config);
        }
        let o = ORIG_INIT.load(Ordering::SeqCst);
        // SAFETY: the saved original of this very method.
        let orig: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, Rect, *mut AnyObject) -> *mut AnyObject =
            unsafe { std::mem::transmute(o) };
        unsafe { orig(this, sel, frame, config) }
    }

    unsafe extern "C-unwind" fn set_nav_hook(this: *mut AnyObject, sel: Sel, delegate: *mut AnyObject) {
        if !delegate.is_null() {
            hook_delegate(delegate, &[DECIDE, COMMIT]);
        }
        let o = ORIG_SET_NAV.load(Ordering::SeqCst);
        // SAFETY: the saved original.
        let orig: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) = unsafe { std::mem::transmute(o) };
        unsafe { orig(this, sel, delegate) }
    }

    unsafe extern "C-unwind" fn set_ui_hook(this: *mut AnyObject, sel: Sel, delegate: *mut AnyObject) {
        if !delegate.is_null() {
            hook_delegate(delegate, &[CAPTURE]);
        }
        let o = ORIG_SET_UI.load(Ordering::SeqCst);
        // SAFETY: the saved original.
        let orig: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) = unsafe { std::mem::transmute(o) };
        unsafe { orig(this, sel, delegate) }
    }

    fn hook_delegate(delegate: *mut AnyObject, which: &[&'static str]) {
        // SAFETY: a live object's class.
        let cls = unsafe { ffi::object_getClass(delegate) };
        if cls.is_null() {
            return;
        }
        let key = cls as usize ^ which.len();
        if !STATE.with(|s| s.borrow_mut().hooked.insert(key)) {
            return;
        }
        for &name in which {
            // SAFETY: each replacement matches the delegate method's
            // signature (WKNavigationDelegate / WKUIDelegate).
            let (imp, types): (Imp, &CStr) = unsafe {
                match name {
                    DECIDE => {
                        let f: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut AnyObject) =
                            decide_hook;
                        (std::mem::transmute::<_, Imp>(f), c"v@:@@@?")
                    }
                    COMMIT => {
                        let f: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject) = commit_hook;
                        (std::mem::transmute::<_, Imp>(f), c"v@:@@")
                    }
                    _ => {
                        let f: unsafe extern "C-unwind" fn(
                            *mut AnyObject,
                            Sel,
                            *mut AnyObject,
                            *mut AnyObject,
                            *mut AnyObject,
                            isize,
                            *mut AnyObject,
                        ) = capture_hook;
                        (std::mem::transmute::<_, Imp>(f), c"v@:@@@q@?")
                    }
                }
            };
            // SAFETY: see above.
            if let Some(orig) = unsafe { replace(cls, name, imp, types) } {
                STATE.with(|s| s.borrow_mut().originals.insert((cls as usize, name), orig));
            }
        }
    }

    /// The original IMP of `name` for `this`'s class (or the hooked
    /// superclass it inherits from).
    fn original(this: *mut AnyObject, name: &'static str) -> Option<Imp> {
        // SAFETY: class walk of a live object.
        let mut cls = unsafe { ffi::object_getClass(this) };
        STATE.with(|s| {
            let s = s.borrow();
            while !cls.is_null() {
                if let Some(i) = s.originals.get(&(cls as usize, name)) {
                    return Some(*i);
                }
                cls = unsafe { ffi::class_getSuperclass(cls) };
            }
            None
        })
    }

    fn string(o: Option<Obj>) -> Option<String> {
        o.map(|o| {
            // SAFETY: an NSString.
            let s: &NSString = unsafe { &*(Retained::as_ptr(&o) as *const NSString) };
            s.to_string()
        })
    }

    unsafe extern "C-unwind" fn decide_hook(
        this: *mut AnyObject,
        sel: Sel,
        web: *mut AnyObject,
        action: *mut AnyObject,
        handler: *mut AnyObject,
    ) {
        let allow = unsafe { decide(web, action) };
        if allow {
            if let Some(o) = original(this, DECIDE) {
                // SAFETY: the saved original.
                let f: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut AnyObject) =
                    unsafe { std::mem::transmute(o) };
                unsafe { f(this, sel, web, action, handler) };
                return;
            }
        }
        // SAFETY: WebKit's decision handler block, (WKNavigationActionPolicy).
        let block = unsafe { &*(handler as *const Block<dyn Fn(isize)>) };
        block.call((if allow { 1 } else { 0 },));
    }

    unsafe extern "C-unwind" fn commit_hook(this: *mut AnyObject, sel: Sel, web: *mut AnyObject, nav: *mut AnyObject) {
        STATE.with(|s| s.borrow_mut().pending.remove(&(web as usize)));
        if let Some(o) = original(this, COMMIT) {
            // SAFETY: the saved original.
            let f: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject) = unsafe { std::mem::transmute(o) };
            unsafe { f(this, sel, web, nav) };
        }
    }

    unsafe extern "C-unwind" fn capture_hook(
        this: *mut AnyObject,
        sel: Sel,
        web: *mut AnyObject,
        origin: *mut AnyObject,
        frame: *mut AnyObject,
        kind: isize,
        handler: *mut AnyObject,
    ) {
        let on = STATE.with(|s| s.borrow().on);
        if !on {
            if let Some(o) = original(this, CAPTURE) {
                // SAFETY: the saved original.
                let f: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut AnyObject, isize, *mut AnyObject) =
                    unsafe { std::mem::transmute(o) };
                unsafe { f(this, sel, web, origin, frame, kind, handler) };
                return;
            }
        }
        STATE.with(|s| s.borrow_mut().capture_denied += 1);
        // SAFETY: WebKit's decision handler block, (WKPermissionDecision);
        // Deny = 2.
        let block = unsafe { &*(handler as *const Block<dyn Fn(isize)>) };
        block.call((2,));
    }

    /// Reads the navigation action and applies [`verdict`].
    unsafe fn decide(web: *mut AnyObject, action: *mut AnyObject) -> bool {
        if !STATE.with(|s| s.borrow().on) {
            return true;
        }
        let Some(action) = (unsafe { action.as_ref() }) else { return true };
        // SAFETY: WKNavigationAction / WKFrameInfo / NSURLRequest / NSURL /
        // WKWebView messages on live objects, main thread.
        let (url, main, current) = unsafe {
            let req: Option<Obj> = msg_send![action, request];
            let url: Option<Obj> = match &req {
                Some(r) => msg_send![&**r, URL],
                None => None,
            };
            let url = string(match &url {
                Some(u) => msg_send![&**u, absoluteString],
                None => None,
            });
            let frame: Option<Obj> = msg_send![action, targetFrame];
            let main = match &frame {
                Some(f) => {
                    let b: Bool = msg_send![&**f, isMainFrame];
                    b.as_bool()
                }
                None => true,
            };
            let current = match web.as_ref() {
                Some(w) => {
                    let u: Option<Obj> = msg_send![w, URL];
                    string(match &u {
                        Some(u) => msg_send![&**u, absoluteString],
                        None => None,
                    })
                }
                None => None,
            };
            (url, main, current)
        };
        let Some(url) = url else { return true };
        let key = web as usize;
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            let pending = s.pending.get(&key).is_some_and(|t| t.elapsed() < Duration::from_secs(15));
            match verdict(&url, main, current.as_deref(), pending, &s.embeds) {
                Verdict::Allow => true,
                Verdict::Start => {
                    s.pending.insert(key, Instant::now());
                    true
                }
                Verdict::Deny => {
                    let host = url::Url::parse(&url)
                        .ok()
                        .map(|u| u.host_str().map(str::to_owned).unwrap_or_else(|| format!("{}:", u.scheme())))
                        .unwrap_or_default();
                    if url.starts_with("http") {
                        s.nav_denied += 1;
                    } else {
                        s.scheme_denied += 1;
                    }
                    *s.denied_hosts.entry(host.clone()).or_default() += 1;
                    log::info!("webguard: refused {} navigation to {host}", if main { "main-frame" } else { "frame" });
                    false
                }
            }
        })
    }

    // --- Per web view ------------------------------------------------------------

    fn prepare(config: &AnyObject) {
        // SAFETY: WKWebViewConfiguration's userContentController.
        let ctrl: Option<Obj> = unsafe { msg_send![config, userContentController] };
        let Some(ctrl) = ctrl else { return };
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            s.controllers.retain(|w| w.load().is_some());
            if !s.controllers.iter().any(|w| w.load().is_some_and(|c| Retained::as_ptr(&c) == Retained::as_ptr(&ctrl))) {
                s.controllers.push(Weak::from_retained(&ctrl));
            }
            apply(&s, &ctrl);
        });
    }

    fn has_script(ctrl: &AnyObject, script: &AnyObject) -> bool {
        // SAFETY: NSArray of WKUserScript.
        unsafe {
            let list: Option<Obj> = msg_send![ctrl, userScripts];
            let Some(list) = list else { return false };
            let n: usize = msg_send![&*list, count];
            (0..n).any(|i| {
                let o: *mut AnyObject = msg_send![&*list, objectAtIndex: i];
                std::ptr::eq(o, script)
            })
        }
    }

    fn is_resolver(s: &State, ctrl: &AnyObject) -> bool {
        s.res_ctrls.iter().any(|w| w.load().is_some_and(|c| std::ptr::eq(Retained::as_ptr(&c), ctrl)))
    }

    /// On `ctrl`: the ad rules exactly when on; the script always (it also
    /// carries the media sniffer the resolver needs; its ad parts stand down
    /// when the app says "off"); the resolver list on the resolver's views.
    fn apply(s: &State, ctrl: &AnyObject) {
        // SAFETY: WKUserContentController messages, main thread.
        unsafe {
            if let Some(rules) = &s.ad.list {
                let _: () = msg_send![ctrl, removeContentRuleList: &**rules];
                if s.on {
                    let _: () = msg_send![ctrl, addContentRuleList: &**rules];
                }
            }
            if let Some(rules) = &s.res.list {
                let _: () = msg_send![ctrl, removeContentRuleList: &**rules];
                if is_resolver(s, ctrl) {
                    let _: () = msg_send![ctrl, addContentRuleList: &**rules];
                }
            }
            if let Some(script) = &s.script {
                if !has_script(ctrl, script) {
                    let _: () = msg_send![ctrl, addUserScript: &**script];
                }
            }
        }
    }

    /// Removes `script` from `ctrl`, keeping every other user script.
    unsafe fn drop_script(ctrl: &AnyObject, script: &AnyObject) {
        unsafe {
            let list: Option<Obj> = msg_send![ctrl, userScripts];
            let Some(list) = list else { return };
            let n: usize = msg_send![&*list, count];
            let keep: Vec<Obj> = (0..n)
                .filter_map(|i| {
                    let o: Option<Obj> = msg_send![&*list, objectAtIndex: i];
                    o
                })
                .filter(|o| !std::ptr::eq(Retained::as_ptr(o), script))
                .collect();
            let _: () = msg_send![ctrl, removeAllUserScripts];
            for o in keep {
                let _: () = msg_send![ctrl, addUserScript: &*o];
            }
        }
    }

    fn each_controller(f: impl Fn(&State, &AnyObject)) {
        STATE.with(|s| {
            let s = s.borrow();
            for w in &s.controllers {
                if let Some(c) = w.load() {
                    f(&s, &c);
                }
            }
        });
    }

    // --- Configuration from the app ----------------------------------------------

    pub(super) fn handle(d: &Value) -> Value {
        if d.get("stats").and_then(Value::as_bool) == Some(true) {
            return STATE.with(|s| {
                let s = s.borrow();
                json!({
                    "on": s.on,
                    "rules": s.ad.state,
                    "resolverRules": s.res.state,
                    "resolverViews": s.res_ctrls.iter().filter(|w| w.load().is_some()).count(),
                    "navigationsDenied": s.nav_denied,
                    "schemesDenied": s.scheme_denied,
                    "captureDenied": s.capture_denied,
                    "deniedHosts": s.denied_hosts,
                    "views": s.controllers.iter().filter(|w| w.load().is_some()).count(),
                })
            });
        }
        let on = d.get("on").and_then(Value::as_bool).unwrap_or(true);
        let old_script = STATE.with(|s| {
            let mut s = s.borrow_mut();
            s.on = on;
            if let Some(e) = d.get("embeds").and_then(Value::as_array) {
                s.embeds = e.iter().filter_map(Value::as_str).map(str::to_ascii_lowercase).collect();
            }
            let src = d.get("script").and_then(Value::as_str).unwrap_or("");
            if !src.is_empty() && src != s.script_src {
                s.script_src = src.to_owned();
                let old = s.script.take();
                // SAFETY: WKUserScript's initializer (injection time 0 =
                // document start, all frames).
                s.script = unsafe {
                    let cls = AnyClass::get(c"WKUserScript");
                    cls.and_then(|cls| {
                        let a: objc2::rc::Allocated<AnyObject> = msg_send![cls, alloc];
                        let o: Option<Obj> = msg_send![a, initWithSource: &*NSString::from_str(src), injectionTime: 0isize, forMainFrameOnly: Bool::NO];
                        o
                    })
                };
                old
            } else {
                None
            }
        });
        if let Some(old) = old_script {
            // SAFETY: see drop_script.
            each_controller(|_, c| unsafe { drop_script(c, &old) });
        }
        let mut marked = 0;
        if let Some(title) = d.get("markResolver").and_then(Value::as_str) {
            marked = mark_resolver(title);
        }
        each_controller(apply);
        if let Some(json) = d.get("rules").and_then(Value::as_str) {
            load_rules(json.to_owned(), false);
        }
        if let Some(json) = d.get("resolverRules").and_then(Value::as_str) {
            load_rules(json.to_owned(), true);
        }
        let (state, rstate) = STATE.with(|s| {
            let s = s.borrow();
            (s.ad.state.clone(), s.res.state.clone())
        });
        json!({ "ok": true, "rules": state, "resolverRules": rstate, "marked": marked })
    }

    fn fnv(s: &str) -> String {
        let mut h: u64 = 0xcbf29ce484222325;
        for b in s.bytes() {
            h = (h ^ b as u64).wrapping_mul(0x100000001b3);
        }
        format!("{h:x}")
    }

    fn slot(s: &mut State, res: bool) -> &mut Rules {
        if res { &mut s.res } else { &mut s.ad }
    }

    fn load_rules(json: String, res: bool) {
        let id = format!("rustflix-{}-{}", if res { "resolver" } else { "adblock" }, fnv(&json));
        let same = STATE.with(|s| {
            let mut s = s.borrow_mut();
            let r = slot(&mut s, res);
            if r.id == id {
                return true;
            }
            r.id = id.clone();
            r.state = "compiling".into();
            false
        });
        if same {
            return;
        }
        let Some(cls) = AnyClass::get(c"WKContentRuleListStore") else { return };
        // SAFETY: WKContentRuleListStore's API; the completion handlers run
        // on the main thread.
        unsafe {
            let store: Option<Obj> = msg_send![cls, defaultStore];
            let Some(store) = store else { return };
            let ns_id = NSString::from_str(&id);
            let store2 = store.clone();
            let found = RcBlock::new(move |list: *mut AnyObject, _err: *mut AnyObject| {
                if let Some(list) = Retained::retain(list) {
                    ready(&id, list, "cached", res);
                    return;
                }
                let id2 = id.clone();
                let done = RcBlock::new(move |list: *mut AnyObject, err: *mut AnyObject| {
                    match Retained::retain(list) {
                        Some(list) => ready(&id2, list, "compiled", res),
                        None => {
                            let why = Retained::retain(err)
                                .map(|e| {
                                    let d: Option<Obj> = msg_send![&*e, localizedDescription];
                                    string(d).unwrap_or_default()
                                })
                                .unwrap_or_default();
                            log::warn!("webguard: content rules failed: {why}");
                            STATE.with(|s| slot(&mut s.borrow_mut(), res).state = format!("error: {why}"));
                        }
                    }
                });
                let _: () = msg_send![
                    &*store2,
                    compileContentRuleListForIdentifier: &*NSString::from_str(&id),
                    encodedContentRuleList: &*NSString::from_str(&json),
                    completionHandler: &*done
                ];
            });
            let _: () = msg_send![&*store, lookUpContentRuleListForIdentifier: &*ns_id, completionHandler: &*found];
        }
    }

    fn ready(id: &str, list: Obj, how: &str, res: bool) {
        let old = STATE.with(|s| {
            let mut s = s.borrow_mut();
            let r = slot(&mut s, res);
            if r.id != id {
                return None;
            }
            r.state = format!("ready ({how})");
            Some(r.list.replace(list))
        });
        let Some(old) = old else { return };
        log::info!("webguard: content rules ready ({how})");
        each_controller(|s, c| {
            if let Some(old) = &old {
                // SAFETY: WKUserContentController, main thread.
                let _: () = unsafe { msg_send![c, removeContentRuleList: &**old] };
            }
            apply(s, c);
        });
    }

    // --- The resolver's web view and cookies -------------------------------------

    fn array(list: Option<&AnyObject>) -> Vec<Obj> {
        let Some(list) = list else { return Vec::new() };
        // SAFETY: NSArray's count / objectAtIndex: within its bounds.
        unsafe {
            let n: usize = msg_send![list, count];
            (0..n)
                .filter_map(|i| {
                    let o: Option<Obj> = msg_send![list, objectAtIndex: i];
                    o
                })
                .collect()
        }
    }

    fn walk(view: &AnyObject, out: &mut Vec<Obj>) {
        // SAFETY: NSView's subviews, main thread.
        let subs: Option<Obj> = unsafe { msg_send![view, subviews] };
        for sub in array(subs.as_deref()) {
            walk(&sub, out);
            out.push(sub);
        }
    }

    /// Marks the controller of every WKWebView whose page title is `title`
    /// (the resolver sets it on its idle about:blank page) as the
    /// resolver's: it gets the resolver rule list. How many it marked.
    fn mark_resolver(title: &str) -> usize {
        let Some(wk) = AnyClass::get(c"WKWebView") else { return 0 };
        // SAFETY: NSApplication / NSWindow / NSView / WKWebView messages on
        // the main thread; isKindOfClass: before any WKWebView message.
        let views: Vec<Obj> = unsafe {
            let app: Option<Obj> = msg_send![objc2::class!(NSApplication), sharedApplication];
            let Some(app) = app else { return 0 };
            let windows: Option<Obj> = msg_send![&*app, windows];
            let mut all = Vec::new();
            for w in array(windows.as_deref()) {
                let content: Option<Obj> = msg_send![&*w, contentView];
                if let Some(c) = content {
                    walk(&c, &mut all);
                }
            }
            all.into_iter()
                .filter(|v| {
                    let b: Bool = msg_send![&**v, isKindOfClass: wk];
                    b.as_bool()
                })
                .collect()
        };
        let mut n = 0;
        for v in views {
            // SAFETY: WKWebView's title / configuration, main thread.
            let (t, ctrl) = unsafe {
                let t: Option<Obj> = msg_send![&*v, title];
                let cfg: Option<Obj> = msg_send![&*v, configuration];
                let ctrl: Option<Obj> = match &cfg {
                    Some(c) => msg_send![&**c, userContentController],
                    None => None,
                };
                (string(t).unwrap_or_default(), ctrl)
            };
            if t != title {
                continue;
            }
            let Some(ctrl) = ctrl else { continue };
            STATE.with(|s| {
                let mut s = s.borrow_mut();
                s.res_ctrls.retain(|w| w.load().is_some());
                if !is_resolver(&s, &ctrl) {
                    s.res_ctrls.push(Weak::from_retained(&ctrl));
                }
            });
            n += 1;
        }
        n
    }

    /// `sys.webCookies {url}`: the `Cookie` header WebKit would send to `url`
    /// (HttpOnly cookies included; JS cannot read those), from the default
    /// website data store the app's web views use.
    pub(super) fn cookies(url: String, call: nsh_engine::HostCall) {
        let Ok(u) = url::Url::parse(&url) else {
            call.resolve(json!({ "ok": false, "error": "bad url" }));
            return;
        };
        let host = u.host_str().unwrap_or("").to_ascii_lowercase();
        let path = u.path().to_owned();
        let secure = u.scheme() == "https";
        let Some(cls) = AnyClass::get(c"WKWebsiteDataStore") else {
            call.resolve(json!({ "ok": false, "error": "no WebKit" }));
            return;
        };
        let call = RefCell::new(Some(call));
        // SAFETY: WKWebsiteDataStore / WKHTTPCookieStore / NSHTTPCookie API;
        // the completion runs on the main thread, once.
        unsafe {
            let store: Option<Obj> = msg_send![cls, defaultDataStore];
            let jar: Option<Obj> = match &store {
                Some(s) => msg_send![&**s, httpCookieStore],
                None => None,
            };
            let Some(jar) = jar else {
                if let Some(c) = call.borrow_mut().take() {
                    c.resolve(json!({ "ok": false, "error": "no cookie store" }));
                }
                return;
            };
            let done = RcBlock::new(move |list: *mut AnyObject| {
                let mut parts = Vec::new();
                let mut http_only = 0;
                for c in array(list.as_ref()) {
                    let domain = string(msg_send![&*c, domain]).unwrap_or_default().to_ascii_lowercase();
                    let cpath = string(msg_send![&*c, path]).unwrap_or_else(|| "/".into());
                    let csecure: Bool = msg_send![&*c, isSecure];
                    let d = domain.trim_start_matches('.');
                    let host_ok = host == d || host.ends_with(&format!(".{d}"));
                    if !host_ok || !path.starts_with(&cpath) || (csecure.as_bool() && !secure) {
                        continue;
                    }
                    let name = string(msg_send![&*c, name]).unwrap_or_default();
                    let value = string(msg_send![&*c, value]).unwrap_or_default();
                    let ho: Bool = msg_send![&*c, isHTTPOnly];
                    if ho.as_bool() {
                        http_only += 1;
                    }
                    parts.push(format!("{name}={value}"));
                }
                if let Some(c) = call.borrow_mut().take() {
                    c.resolve(json!({ "ok": true, "cookie": parts.join("; "), "count": parts.len(), "httpOnly": http_only }));
                }
            });
            let _: () = msg_send![&*jar, getAllCookies: &*done];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn embeds() -> HashSet<String> {
        ["vidfast.vc", "vsembed.su", "vidnest.fun"].iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"WEBVTT\n"), "V0VCVlRUCg==");
    }

    #[test]
    fn web_fetch_refuses_non_http() {
        let r = web_fetch(&serde_json::json!({ "url": "file:///etc/hosts" }));
        assert_eq!(r["ok"], false);
        let r = web_fetch(&serde_json::json!({ "url": "nonsense" }));
        assert_eq!(r["ok"], false);
    }

    #[test]
    fn sites() {
        assert_eq!(site("a.b.vidfast.vc"), "vidfast.vc");
        assert_eq!(site("x.example.co.uk"), "example.co.uk");
        assert_eq!(site("localhost"), "localhost");
    }

    #[test]
    fn main_frame_navigations() {
        let e = embeds();
        let page = Some("https://vidfast.vc/movie/1");
        // The app's own loads and the embed hosts.
        assert_eq!(verdict("https://vidfast.vc/movie/1", true, Some("about:blank"), false, &e), Verdict::Start);
        assert_eq!(verdict("https://vidnest.fun/anime/1/1/sub", true, page, false, &e), Verdict::Start);
        assert_eq!(verdict("https://a.example.com/", true, None, false, &e), Verdict::Start);
        // Same site, and redirects of an allowed navigation.
        assert_eq!(verdict("https://cdn.vidfast.vc/x", true, page, false, &e), Verdict::Start);
        assert_eq!(verdict("https://mirror.example/", true, page, true, &e), Verdict::Allow);
        // A page taking the view elsewhere.
        assert_eq!(verdict("https://ad.example/landing", true, page, false, &e), Verdict::Deny);
        // Non-web schemes anywhere; frames otherwise free.
        assert_eq!(verdict("itms-appss://apps.apple.com/app/1", false, page, false, &e), Verdict::Deny);
        assert_eq!(verdict("https://ad.example/frame", false, page, false, &e), Verdict::Allow);
        assert_eq!(verdict("about:blank", true, page, false, &e), Verdict::Allow);
        // Downloads play from the app's localhost server in the same view.
        assert_eq!(verdict("http://127.0.0.1:52011/play/3", true, page, false, &e), Verdict::Start);
        // And nothing is refused while the app's own local page shows.
        assert_eq!(verdict("https://anything.example/", true, Some("http://127.0.0.1:52011/t/3/player.html"), false, &e), Verdict::Start);
    }
}
