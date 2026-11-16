//! Windows: reaching the WebView2 web views NSH builds through wry
//! (`sys.webGuard`, `sys.webCookies`, `sys.webViews`, `sys.webBackground`;
//! the macOS side is `crate::webguard`'s `mac` module, Linux's
//! `crate::webkitgtk`, the TSX side `app/lib/adblock.ts`).
//!
//! wry has no configuration hook and NSH keeps each `wry::WebView` to
//! itself, and wry's `WRY_WEBVIEW` window stores no pointer to its
//! controller. So, like the macOS guard (which hooks WebKit's own entry
//! points), WebView2's own entry point is hooked once, at startup, before
//! any web view exists:
//!
//! - A throwaway environment (its own temporary profile) is made, and the
//!   slot of `ICoreWebView2Environment10::CreateCoreWebView2ControllerWithOptions`
//!   (and of the base `CreateCoreWebView2Controller`) in its vtable is
//!   replaced. COM vtables are a fixed ABI and the environment class's
//!   vtable is shared by every environment of the WebView2 runtime loaded in
//!   this process, so wry's later calls land here.
//! - The replacement wraps the completion handler wry passes: when a
//!   controller is made, [`adopt`] sets it up — the guard script at
//!   document creation (every frame), a network filter for every frame's
//!   requests, no pop-up windows, the main-frame navigation rule
//!   (`crate::webguard::verdict`, as on macOS), no camera/microphone — and
//!   only then hands it to wry, before its first navigation.
//!
//! Everything WebView2 runs on the main thread (its STA): the hook, the
//! event handlers, the state. Host calls arrive on the engine thread and
//! are queued for a message-only window of ours ([`on_main`]).

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    ffi::c_void,
    sync::{
        Mutex,
        atomic::{AtomicIsize, AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use webview2_com::{
    AddScriptToExecuteOnDocumentCreatedCompletedHandler, ContentLoadingEventHandler,
    CreateCoreWebView2ControllerCompletedHandler, CreateCoreWebView2EnvironmentCompletedHandler,
    GetCookiesCompletedHandler, Microsoft::Web::WebView2::Win32::*,
    NavigationStartingEventHandler, NewWindowRequestedEventHandler, PermissionRequestedEventHandler,
    WebResourceRequestedEventHandler, take_pwstr,
};
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    Graphics::Gdi::{CreateRectRgn, SetWindowRgn},
    System::{
        Com::{COINIT_APARTMENTTHREADED, CoInitializeEx},
        LibraryLoader::GetModuleHandleW,
        Memory::{PAGE_PROTECTION_FLAGS, PAGE_READWRITE, VirtualProtect},
    },
    UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, HWND_MESSAGE, PostMessageW, RegisterClassW, SWP_NOACTIVATE,
        SWP_NOZORDER, SWP_SHOWWINDOW, SetWindowPos, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP, WNDCLASSW,
    },
};
use windows_core61::{HRESULT, HSTRING, Interface, PWSTR};

use crate::webguard::{Verdict, site, verdict};

/// The size the hidden resolver page is laid out at (a real viewport: embed
/// players size-check their elements), shown through a 1×1 window region.
const RESOLVER_VIEWPORT: (i32, i32) = (1600, 900);

// --- Main-thread queue ----------------------------------------------------------

const WM_RUN: u32 = WM_APP + 0x52;
static QUEUE: Mutex<Vec<Box<dyn FnOnce() + Send>>> = Mutex::new(Vec::new());
static WINDOW: AtomicIsize = AtomicIsize::new(0);

/// Runs `f` on the main thread, from the message loop (or a nested pump).
fn on_main(f: impl FnOnce() + Send + 'static) {
    QUEUE.lock().unwrap().push(Box::new(f));
    let hwnd = WINDOW.load(Ordering::SeqCst);
    if hwnd != 0 {
        // SAFETY: our own message-only window, alive for the process.
        let _ = unsafe { PostMessageW(Some(HWND(hwnd as *mut c_void)), WM_RUN, WPARAM(0), LPARAM(0)) };
    }
}

unsafe extern "system" fn queue_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_RUN {
        let jobs = std::mem::take(&mut *QUEUE.lock().unwrap());
        for job in jobs {
            // A panic must not cross into the window procedure's caller.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
        }
        return LRESULT(0);
    }
    // SAFETY: the default procedure for our own window.
    unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
}

fn make_queue_window() {
    let name = windows_core::w!("RustflixWebViewQueue");
    // SAFETY: a class with a static name and procedure; a message-only
    // window owned by this (the main) thread.
    unsafe {
        let instance = GetModuleHandleW(None).unwrap_or_default();
        let class = WNDCLASSW { lpfnWndProc: Some(queue_proc), hInstance: instance.into(), lpszClassName: name, ..Default::default() };
        RegisterClassW(&class);
        if let Ok(hwnd) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            name,
            name,
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance.into()),
            None,
        ) {
            WINDOW.store(hwnd.0 as isize, Ordering::SeqCst);
        }
    }
}

// --- Content rules (WebKit content-blocker JSON, as macOS compiles them) ---------

struct Rule {
    types: Option<Vec<String>>,
    third_party: Option<bool>,
    block: bool,
}

/// A compiled rule list: every `url-filter` in one `RegexSet`, evaluated in
/// order (the last matching rule decides; `ignore-previous-rules` lets
/// through what earlier rules blocked).
struct Rules {
    set: regex::RegexSet,
    rules: Vec<Rule>,
}

impl Rules {
    fn compile(json: &str) -> Option<Rules> {
        let list: Vec<Value> = serde_json::from_str(json).ok()?;
        let mut patterns = Vec::new();
        let mut rules = Vec::new();
        for r in &list {
            let Some(filter) = r.pointer("/trigger/url-filter").and_then(Value::as_str) else { continue };
            let pattern = format!("(?i){filter}");
            // WebKit's regex subset is valid Rust regex; skip what is not.
            if regex::Regex::new(&pattern).is_err() {
                log::warn!("webview: skipped content rule {filter:?}");
                continue;
            }
            let types = r.pointer("/trigger/resource-type").and_then(Value::as_array).map(|a| {
                a.iter().filter_map(Value::as_str).map(str::to_owned).collect()
            });
            let third_party = r.pointer("/trigger/load-type").and_then(Value::as_array).and_then(|a| {
                let has = |s: &str| a.iter().any(|v| v.as_str() == Some(s));
                match (has("first-party"), has("third-party")) {
                    (true, false) => Some(false),
                    (false, true) => Some(true),
                    _ => None,
                }
            });
            let block = r.pointer("/action/type").and_then(Value::as_str) == Some("block");
            patterns.push(pattern);
            rules.push(Rule { types, third_party, block });
        }
        let set = regex::RegexSet::new(&patterns).ok()?;
        Some(Rules { set, rules })
    }

    /// Whether the list blocks `url` of resource type `kind` (`third`: the
    /// request goes to another site than the page's).
    fn blocks(&self, url: &str, kind: &str, third: bool) -> bool {
        let mut blocked = false;
        for i in self.set.matches(url).iter() {
            let r = &self.rules[i];
            if r.types.as_ref().is_some_and(|t| !t.iter().any(|x| x == kind)) {
                continue;
            }
            if r.third_party.is_some_and(|t| t != third) {
                continue;
            }
            blocked = r.block;
        }
        blocked
    }
}

/// WebView2's resource context as WebKit's `resource-type`.
fn resource_type(ctx: COREWEBVIEW2_WEB_RESOURCE_CONTEXT) -> &'static str {
    match ctx {
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => "document",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "style-sheet",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_TEXT_TRACK => "media",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_EVENT_SOURCE => "raw",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH => "fetch",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "websocket",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING => "ping",
        _ => "other",
    }
}

fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url).ok()?.host_str().map(str::to_ascii_lowercase)
}

// --- State (main thread) -------------------------------------------------------------

struct View {
    controller: ICoreWebView2Controller,
    webview: ICoreWebView2,
    resolver: bool,
    /// The id of the guard script this view got, and the script's hash.
    script: Option<(String, u64)>,
    /// A main-frame navigation the guard let start, until its content loads
    /// (its redirects may leave the site).
    pending: Option<Instant>,
}

#[derive(Default)]
struct Guard {
    on: bool,
    script: String,
    ad: Option<Rules>,
    res: Option<Rules>,
    embeds: HashSet<String>,
    views: HashMap<usize, View>,
}

thread_local! {
    static GUARD: RefCell<Guard> = RefCell::new(Guard { on: true, ..Default::default() });
}

static BLOCKED: AtomicU64 = AtomicU64::new(0);
static NAV_DENIED: AtomicU64 = AtomicU64::new(0);
static POPUPS: AtomicU64 = AtomicU64::new(0);

fn key(w: &ICoreWebView2) -> usize {
    w.as_raw() as usize
}

fn fnv(s: &str) -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Drops views whose controller was closed (wry closes it when its web view
/// goes); their calls fail from then on.
fn prune(g: &mut Guard) {
    g.views.retain(|_, v| {
        let mut hwnd = windows_61::Win32::Foundation::HWND::default();
        // SAFETY: a live COM reference; a closed controller answers an error.
        unsafe { v.controller.ParentWindow(&mut hwnd) }.is_ok()
    });
}

// --- The hook ------------------------------------------------------------------------

type CreateWithOptions = unsafe extern "system" fn(*mut c_void, windows_61::Win32::Foundation::HWND, *mut c_void, *mut c_void) -> HRESULT;
type Create = unsafe extern "system" fn(*mut c_void, windows_61::Win32::Foundation::HWND, *mut c_void) -> HRESULT;

static ORIGINAL_WITH_OPTIONS: AtomicUsize = AtomicUsize::new(0);
static ORIGINAL_CREATE: AtomicUsize = AtomicUsize::new(0);

/// Wraps wry's completion handler: the new controller is set up first.
fn wrap(env: *mut c_void, handler: *mut c_void) -> Option<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler> {
    // SAFETY: COM pointers WebView2 passes to the slot; borrowed, then
    // AddRef'd by `cloned`. The slot belongs to an environment interface.
    let (env, inner) = unsafe {
        (
            ICoreWebView2Environment::from_raw_borrowed(&env)?.clone(),
            ICoreWebView2CreateCoreWebView2ControllerCompletedHandler::from_raw_borrowed(&handler)?.clone(),
        )
    };
    Some(CreateCoreWebView2ControllerCompletedHandler::create(Box::new(move |result, controller| {
        if result.is_ok()
            && let Some(c) = &controller
        {
            let c = c.clone();
            let env = env.clone();
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| adopt(&c, &env))).is_err() {
                log::error!("webview: setting up a new web view panicked");
            }
        }
        let code = result.map(|()| HRESULT(0)).unwrap_or_else(|e| e.code());
        // SAFETY: wry's own handler, called once as WebView2 would.
        unsafe { inner.Invoke(code, controller.as_ref()) }
    })))
}

unsafe extern "system" fn create_with_options(
    this: *mut c_void,
    hwnd: windows_61::Win32::Foundation::HWND,
    options: *mut c_void,
    handler: *mut c_void,
) -> HRESULT {
    // SAFETY: the slot's original implementation, saved before patching.
    let original: CreateWithOptions = unsafe { std::mem::transmute(ORIGINAL_WITH_OPTIONS.load(Ordering::SeqCst)) };
    match std::panic::catch_unwind(|| wrap(this, handler)).ok().flatten() {
        // SAFETY: same arguments, our handler in place of wry's (WebView2
        // AddRefs it for as long as it needs it).
        Some(h) => unsafe { original(this, hwnd, options, h.as_raw()) },
        None => unsafe { original(this, hwnd, options, handler) },
    }
}

unsafe extern "system" fn create(this: *mut c_void, hwnd: windows_61::Win32::Foundation::HWND, handler: *mut c_void) -> HRESULT {
    // SAFETY: as above.
    let original: Create = unsafe { std::mem::transmute(ORIGINAL_CREATE.load(Ordering::SeqCst)) };
    match std::panic::catch_unwind(|| wrap(this, handler)).ok().flatten() {
        Some(h) => unsafe { original(this, hwnd, h.as_raw()) },
        None => unsafe { original(this, hwnd, handler) },
    }
}

/// Replaces vtable entry `index` of `object` with `with`; returns the
/// entry it held (none when it already holds `with`).
///
/// SAFETY: `object` is a live COM interface pointer whose vtable has more
/// than `index` entries.
unsafe fn patch(object: *mut c_void, index: usize, with: usize) -> Option<usize> {
    unsafe {
        let vtbl = *(object as *const *mut usize);
        let slot = vtbl.add(index);
        if *slot == with {
            return None;
        }
        let mut old = PAGE_PROTECTION_FLAGS(0);
        VirtualProtect(slot as *const c_void, size_of::<usize>(), PAGE_READWRITE, &mut old).ok()?;
        let previous = std::ptr::replace(slot, with);
        let mut ignored = PAGE_PROTECTION_FLAGS(0);
        let _ = VirtualProtect(slot as *const c_void, size_of::<usize>(), old, &mut ignored);
        Some(previous)
    }
}

/// Hooks WebView2's controller creation (see the module header). Runs once,
/// on the main thread, before GPUI and before any web view; failures only
/// leave web views unguarded (logged).
pub(crate) fn install() {
    let started = Instant::now();
    // SAFETY: the main thread's apartment: STA, as WebView2 and GPUI
    // (OleInitialize) want it. Never uninitialised: it lives as long as the
    // process.
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    make_queue_window();
    let folder = std::env::temp_dir().join("rustflix-webview2-probe");
    let (tx, rx) = std::sync::mpsc::channel();
    let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |result, env| {
        let _ = tx.send(result.and(env.ok_or_else(|| windows_core61::Error::from(HRESULT(0x80004003u32 as i32)))));
        Ok(())
    }));
    // SAFETY: WebView2's loader with a folder of ours and no options; the
    // answer comes through the pumped completion handler.
    let made = unsafe {
        CreateCoreWebView2EnvironmentWithOptions(
            windows_core61::PCWSTR::null(),
            &HSTRING::from(folder.as_os_str()),
            None,
            &handler,
        )
    };
    if let Err(e) = made {
        log::warn!("webview: no WebView2 environment to hook ({e}); web views stay unguarded");
        return;
    }
    let env = match webview2_com::wait_with_pump(rx) {
        Ok(Ok(env)) => env,
        other => {
            log::warn!("webview: WebView2 environment failed ({other:?}); web views stay unguarded");
            return;
        }
    };
    // SAFETY: live environment interfaces; the indexes come from the
    // interfaces' own vtable layouts.
    unsafe {
        let base = std::mem::offset_of!(ICoreWebView2Environment_Vtbl, CreateCoreWebView2Controller) / size_of::<usize>();
        if let Some(prev) = patch(env.as_raw(), base, create as Create as usize) {
            ORIGINAL_CREATE.store(prev, Ordering::SeqCst);
        }
        if let Ok(env10) = env.cast::<ICoreWebView2Environment10>() {
            let index = std::mem::offset_of!(ICoreWebView2Environment10_Vtbl, CreateCoreWebView2ControllerWithOptions)
                / size_of::<usize>();
            if let Some(prev) = patch(env10.as_raw(), index, create_with_options as CreateWithOptions as usize) {
                ORIGINAL_WITH_OPTIONS.store(prev, Ordering::SeqCst);
            }
        }
    }
    log::info!(
        "webview: WebView2 controller creation hooked in {} ms (with options: {}, base: {})",
        started.elapsed().as_millis(),
        ORIGINAL_WITH_OPTIONS.load(Ordering::SeqCst) != 0,
        ORIGINAL_CREATE.load(Ordering::SeqCst) != 0,
    );
}

// --- A new web view ----------------------------------------------------------------

/// Sets up a controller wry has just been given (main thread, before wry
/// sees it and before its first navigation).
fn adopt(controller: &ICoreWebView2Controller, env: &ICoreWebView2Environment) {
    // SAFETY: WebView2 calls on the main thread with live objects.
    let Ok(webview) = (unsafe { controller.CoreWebView2() }) else { return };
    let k = key(&webview);
    GUARD.with_borrow_mut(|g| {
        prune(g);
        g.views.insert(k, View { controller: controller.clone(), webview: webview.clone(), resolver: false, script: None, pending: None });
    });
    let mut token = 0i64;
    // SAFETY: as above; handlers hold no reference to the web view (no cycle).
    unsafe {
        // Every request of every frame.
        let filtered = match webview.cast::<ICoreWebView2_22>() {
            Ok(w22) => w22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                windows_core61::w!("*"),
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
            ),
            Err(_) => webview.AddWebResourceRequestedFilter(windows_core61::w!("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL),
        };
        if let Err(e) = filtered {
            log::warn!("webview: no request filter: {e}");
        }
        let env = env.clone();
        let _ = webview.add_WebResourceRequested(
            &WebResourceRequestedEventHandler::create(Box::new(move |sender, args| {
                let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
                let request = args.Request()?;
                let mut uri = PWSTR::null();
                request.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                let mut ctx = COREWEBVIEW2_WEB_RESOURCE_CONTEXT::default();
                args.ResourceContext(&mut ctx)?;
                let mut page = PWSTR::null();
                let page = sender.Source(&mut page).map(|()| take_pwstr(page)).unwrap_or_default();
                let third = match (host_of(&uri), host_of(&page)) {
                    (Some(a), Some(b)) => site(&a) != site(&b),
                    _ => false,
                };
                let kind = resource_type(ctx);
                let blocked = GUARD.with_borrow(|g| {
                    if !g.on {
                        return false;
                    }
                    let resolver = g.views.get(&key(&sender)).is_some_and(|v| v.resolver);
                    g.ad.as_ref().is_some_and(|r| r.blocks(&uri, kind, third))
                        || (resolver && g.res.as_ref().is_some_and(|r| r.blocks(&uri, kind, third)))
                });
                if blocked {
                    BLOCKED.fetch_add(1, Ordering::Relaxed);
                    log::debug!("webview: blocked {kind} {}", host_of(&uri).unwrap_or_default());
                    let response = env.CreateWebResourceResponse(None, 403, windows_core61::w!("Blocked"), windows_core61::w!(""))?;
                    args.SetResponse(&response)?;
                }
                Ok(())
            })),
            &mut token,
        );
        // No pop-up windows (macOS: wry's UI delegate makes none).
        let _ = webview.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args
                    && GUARD.with_borrow(|g| g.on)
                {
                    POPUPS.fetch_add(1, Ordering::Relaxed);
                    let mut uri = PWSTR::null();
                    let _ = args.Uri(&mut uri);
                    log::info!("webview: pop-up to {} refused", host_of(&take_pwstr(uri)).unwrap_or_default());
                    args.SetHandled(true)?;
                }
                Ok(())
            })),
            &mut token,
        );
        // The main frame's navigations (`verdict`, as on macOS).
        let _ = webview.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(|sender, args| {
                let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                let mut current = PWSTR::null();
                let current = sender.Source(&mut current).map(|()| take_pwstr(current)).ok();
                let k = key(&sender);
                let allow = GUARD.with_borrow_mut(|g| {
                    if !g.on {
                        return true;
                    }
                    let pending = g.views.get(&k).and_then(|v| v.pending).is_some_and(|t| t.elapsed() < Duration::from_secs(15));
                    match verdict(&uri, true, current.as_deref(), pending, &g.embeds) {
                        Verdict::Allow => true,
                        Verdict::Start => {
                            if let Some(v) = g.views.get_mut(&k) {
                                v.pending = Some(Instant::now());
                            }
                            true
                        }
                        Verdict::Deny => false,
                    }
                });
                if !allow {
                    NAV_DENIED.fetch_add(1, Ordering::Relaxed);
                    log::info!("webview: main-frame navigation to {} refused", host_of(&uri).unwrap_or_default());
                    args.SetCancel(true)?;
                }
                if allow && GUARD.with_borrow(|g| g.views.get(&k).is_some_and(|v| v.resolver)) {
                    give_viewport(&k);
                }
                Ok(())
            })),
            &mut token,
        );
        // Its content arrived: its redirects are over.
        let _ = webview.add_ContentLoading(
            &ContentLoadingEventHandler::create(Box::new(|sender, _| {
                if let Some(sender) = sender {
                    let k = key(&sender);
                    GUARD.with_borrow_mut(|g| {
                        if let Some(v) = g.views.get_mut(&k) {
                            v.pending = None;
                        }
                    });
                }
                Ok(())
            })),
            &mut token,
        );
        // No frame may open a non-web scheme.
        let _ = webview.add_FrameNavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                let deny = GUARD.with_borrow(|g| g.on && matches!(verdict(&uri, false, None, false, &g.embeds), Verdict::Deny));
                if deny {
                    NAV_DENIED.fetch_add(1, Ordering::Relaxed);
                    args.SetCancel(true)?;
                }
                Ok(())
            })),
            &mut token,
        );
        // No camera or microphone while the guard is on.
        let _ = webview.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if GUARD.with_borrow(|g| g.on)
                    && matches!(kind, COREWEBVIEW2_PERMISSION_KIND_CAMERA | COREWEBVIEW2_PERMISSION_KIND_MICROPHONE)
                {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                }
                Ok(())
            })),
            &mut token,
        );
    }
    give_script(k);
}

/// Gives view `k` the current guard script (at document creation, every
/// frame) unless it has this exact one; the previous one is removed.
fn give_script(k: usize) {
    let (webview, src, old) = GUARD.with_borrow(|g| {
        let v = g.views.get(&k);
        (v.map(|v| v.webview.clone()), g.script.clone(), v.and_then(|v| v.script.clone()))
    });
    let Some(webview) = webview else { return };
    if src.is_empty() {
        return;
    }
    let hash = fnv(&src);
    if old.as_ref().is_some_and(|(_, h)| *h == hash) {
        return;
    }
    // SAFETY: main thread, live web view.
    unsafe {
        if let Some((id, _)) = &old {
            let _ = webview.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(id.as_str()));
        }
        let added = webview.AddScriptToExecuteOnDocumentCreated(
            &HSTRING::from(src.as_str()),
            &AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |result, id| {
                if result.is_ok() {
                    GUARD.with_borrow_mut(|g| {
                        if let Some(v) = g.views.get_mut(&k) {
                            v.script = Some((id, hash));
                        }
                    });
                }
                Ok(())
            })),
        );
        if let Err(e) = added {
            log::warn!("webview: guard script not added: {e}");
        }
    }
}

/// The resolver's hidden view: laid out at a real size, shown through a
/// 1×1 window region (NSH never places a view with no geometry, so it
/// would keep its 200×200 creation size and stay hidden).
fn give_viewport(k: &usize) {
    let Some(controller) = GUARD.with_borrow(|g| g.views.get(k).map(|v| v.controller.clone())) else { return };
    let (w, h) = RESOLVER_VIEWPORT;
    // SAFETY: main thread; the container is wry's child window of ours.
    unsafe {
        let mut parent = windows_61::Win32::Foundation::HWND::default();
        if controller.ParentWindow(&mut parent).is_err() || parent.0.is_null() {
            return;
        }
        let container = HWND(parent.0);
        let rgn = CreateRectRgn(0, 0, 1, 1);
        // The window owns the region from here on.
        SetWindowRgn(container, Some(rgn), false);
        let _ = SetWindowPos(container, None, 0, 0, w, h, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        let _ = controller.SetBounds(windows_61::Win32::Foundation::RECT { left: 0, top: 0, right: w, bottom: h });
        let _ = controller.SetIsVisible(true);
    }
}

// --- Host calls ----------------------------------------------------------------------

fn guard(d: &Value) -> Value {
    if d.get("stats").and_then(Value::as_bool) == Some(true) {
        return GUARD.with_borrow_mut(|g| {
            prune(g);
            json!({
                "ok": true,
                "views": g.views.len(),
                "scripted": g.views.values().filter(|v| v.script.is_some()).count(),
                "filters": usize::from(g.ad.is_some()) + usize::from(g.res.is_some()),
                "resolverViews": g.views.values().filter(|v| v.resolver).count(),
                "blocked": BLOCKED.load(Ordering::Relaxed),
                "navDenied": NAV_DENIED.load(Ordering::Relaxed),
                "popups": POPUPS.load(Ordering::Relaxed),
                "hooked": ORIGINAL_WITH_OPTIONS.load(Ordering::Relaxed) != 0 || ORIGINAL_CREATE.load(Ordering::Relaxed) != 0,
            })
        });
    }
    let ad = d.get("rules").and_then(Value::as_str).map(Rules::compile);
    let res = d.get("resolverRules").and_then(Value::as_str).map(Rules::compile);
    let marked = GUARD.with_borrow_mut(|g| {
        prune(g);
        // macOS: `on` defaults to true on every call.
        g.on = d.get("on").and_then(Value::as_bool).unwrap_or(true);
        if let Some(src) = d.get("script").and_then(Value::as_str)
            && !src.is_empty()
        {
            g.script = src.to_owned();
        }
        if let Some(r) = ad {
            g.ad = r;
        }
        if let Some(r) = res {
            g.res = r;
        }
        if let Some(e) = d.get("embeds").and_then(Value::as_array) {
            g.embeds = e.iter().filter_map(Value::as_str).map(str::to_ascii_lowercase).collect();
        }
        let mut marked = Vec::new();
        if let Some(title) = d.get("markResolver").and_then(Value::as_str) {
            for (k, v) in g.views.iter_mut() {
                let mut t = PWSTR::null();
                // SAFETY: main thread, live web view.
                let t = unsafe { v.webview.DocumentTitle(&mut t) }.map(|()| take_pwstr(t)).unwrap_or_default();
                if t == title {
                    v.resolver = true;
                    marked.push(*k);
                }
            }
        }
        marked
    });
    for k in &marked {
        give_viewport(k);
    }
    let keys: Vec<usize> = GUARD.with_borrow(|g| g.views.keys().copied().collect());
    for k in keys {
        give_script(k);
    }
    GUARD.with_borrow(|g| {
        log::info!(
            "webview: webGuard on={} script={} bytes views={} filters={} embeds={} marked={}",
            g.on,
            g.script.len(),
            g.views.len(),
            usize::from(g.ad.is_some()) + usize::from(g.res.is_some()),
            g.embeds.len(),
            marked.len()
        );
    });
    json!({ "ok": true, "marked": marked.len() })
}

/// `sys.webGuard` (any thread).
pub(crate) fn handle_guard(data: Value, call: nsh_engine::HostCall) {
    on_main(move || call.resolve(guard(&data)));
}

/// `sys.webCookies {url}` (any thread): the `Cookie` header WebView2 would
/// send to `url` (HttpOnly included), from the profile the web views share.
pub(crate) fn handle_cookies(url: String, call: nsh_engine::HostCall) {
    on_main(move || {
        let webview = GUARD.with_borrow_mut(|g| {
            prune(g);
            g.views.values().next().map(|v| v.webview.clone())
        });
        let Some(webview) = webview else {
            call.resolve(json!({ "ok": false, "error": "no web view" }));
            return;
        };
        // SAFETY: main thread, live web view; the handler resolves the call.
        let asked = unsafe {
            webview.cast::<ICoreWebView2_2>().and_then(|w| w.CookieManager()).and_then(|m| {
                let call = std::cell::Cell::new(Some(call));
                let handler = GetCookiesCompletedHandler::create(Box::new(move |result, list| {
                    let Some(call) = call.take() else { return Ok(()) };
                    let out = match (result, list) {
                        (Ok(()), Some(list)) => {
                            let mut n = 0u32;
                            let _ = list.Count(&mut n);
                            let (mut parts, mut http_only) = (Vec::new(), 0);
                            for i in 0..n {
                                let Ok(c) = list.GetValueAtIndex(i) else { continue };
                                let (mut name, mut value) = (PWSTR::null(), PWSTR::null());
                                let _ = c.Name(&mut name);
                                let _ = c.Value(&mut value);
                                let mut ho = windows_core61::BOOL::default();
                                let _ = c.IsHttpOnly(&mut ho);
                                if ho.as_bool() {
                                    http_only += 1;
                                }
                                parts.push(format!("{}={}", take_pwstr(name), take_pwstr(value)));
                            }
                            json!({ "ok": true, "cookie": parts.join("; "), "count": parts.len(), "httpOnly": http_only })
                        }
                        (Err(e), _) => json!({ "ok": false, "error": e.to_string() }),
                        _ => json!({ "ok": false, "error": "no cookies" }),
                    };
                    call.resolve(out);
                    Ok(())
                }));
                m.GetCookies(&HSTRING::from(url.as_str()), &handler)
            })
        };
        if let Err(e) = asked {
            log::warn!("webview: cookies not read: {e}");
        }
    });
}

/// `sys.webViews` (any thread): every web view's URL, title, size and
/// visibility (diagnostics; the native player check that no page shows).
pub(crate) fn handle_views(call: nsh_engine::HostCall) {
    on_main(move || {
        let views: Vec<Value> = GUARD.with_borrow_mut(|g| {
            prune(g);
            g.views
                .values()
                .map(|v| {
                    // SAFETY: main thread, live objects.
                    unsafe {
                        let (mut url, mut title) = (PWSTR::null(), PWSTR::null());
                        let url = v.webview.Source(&mut url).map(|()| take_pwstr(url)).ok();
                        let title = v.webview.DocumentTitle(&mut title).map(|()| take_pwstr(title)).ok();
                        let mut r = windows_61::Win32::Foundation::RECT::default();
                        let _ = v.controller.Bounds(&mut r);
                        let mut vis = windows_core61::BOOL::default();
                        let _ = v.controller.IsVisible(&mut vis);
                        json!({
                            "url": url, "title": title,
                            "w": r.right - r.left, "h": r.bottom - r.top,
                            "visible": vis.as_bool() && !v.resolver,
                            "resolver": v.resolver,
                        })
                    }
                })
                .collect()
        });
        call.resolve(json!({ "ok": true, "count": views.len(), "views": views }));
    });
}

/// `sys.webBackground {color}` (any thread): every web view's background
/// until its page paints (`#rrggbb`; anything else is black).
pub(crate) fn handle_background(data: Value, call: nsh_engine::HostCall) {
    let c = data.get("color").and_then(Value::as_str).unwrap_or("black").trim().trim_start_matches('#').to_owned();
    let v = if c.len() == 6 { u32::from_str_radix(&c, 16).unwrap_or(0) } else { 0 };
    let color = COREWEBVIEW2_COLOR { A: 255, R: (v >> 16) as u8, G: (v >> 8) as u8, B: v as u8 };
    on_main(move || {
        let n = GUARD.with_borrow_mut(|g| {
            prune(g);
            let mut n = 0;
            for v in g.views.values() {
                // SAFETY: main thread, live controller.
                if let Ok(c2) = v.controller.cast::<ICoreWebView2Controller2>()
                    && unsafe { c2.SetDefaultBackgroundColor(color) }.is_ok()
                {
                    n += 1;
                }
            }
            n
        });
        call.resolve(json!({ "ok": true, "count": n }));
    });
}
