//! AppKit fixes the GPUI/NSH stack does not make itself (`sys.*`,
//! `app/lib/system.ts`; gated by capabilities.host "sys.*").
//!
//! - `sys.focusContent`: makes GPUI's own view (`GPUIView`) the window's
//!   first responder again. GPUI never takes it back once a WKWebView had
//!   it: the view does not accept first responder on a click (no
//!   `acceptsFirstResponder` override, gpui-fast-macos window.rs) and
//!   GPUI's `window.focus` is bookkeeping only, so after a web view held
//!   the keyboard (and was hidden or removed) plain keys reach no text
//!   field. Only the first responder inside our own window changes: the
//!   window is never ordered front, the app never activated.
//! - `sys.webBackground`: every WKWebView in the window draws no white
//!   background (KVC `drawsBackground` = NO, `underPageBackgroundColor`
//!   black on macOS 12+, its layer black). lb-wry 0.53.3 applies a web
//!   view's background colour on iOS only, so a macOS web view is white
//!   until its page paints.
//! - `sys.webViews`: every WKWebView in the app's windows — its URL, size,
//!   whether it or an ancestor is hidden, its alpha, its window's
//!   visibility (the native player spike checks that no page shows).
//! - `sys.appInfo`: `{ version, build }` for Settings → About (every
//!   desktop).
//! - `sys.pickFolder`: an `NSOpenPanel` for one folder, as a sheet on the
//!   app's window (or a free-standing panel without one). Both return at
//!   once and answer from AppKit's completion handler: no nested modal
//!   loop inside a main-queue block, which would stall GPUI's own
//!   main-queue work while the panel is up.
//!
//! Host handlers run on the engine thread (nsh-engine host_channel.rs:
//! "Handlers run on the engine thread and must not block it"), so every
//! call hops to the main thread with `DispatchQueue::main().exec_async`
//! (GPUI's main thread drains the main queue) and answers from there.
//!
//! Raw `msg_send!` through `objc2` only (no objc2-app-kit), with the
//! Foundation types already in the build. Every message that may not
//! exist is guarded by `respondsToSelector:` or `isKindOfClass:`, so no
//! Objective-C exception (an abort through Rust) can be raised.

use nsh_engine::HostChannel;

pub(crate) fn register(host: &HostChannel) {
    // Settings → About: the app's version (Cargo's) and build number
    // (app/nsh.json `build`, the one the packages carry).
    host.handle("sys.appInfo", |call| call.resolve(app_info()));
    #[cfg(target_os = "macos")]
    {
        host.handle("sys.focusContent", |call| {
            mac::on_main(move || {
                let ok = mac::focus_content();
                call.resolve(serde_json::json!({ "ok": ok }));
            });
        });
        host.handle("sys.webBackground", |call| {
            mac::on_main(move || {
                let count = mac::web_background();
                call.resolve(serde_json::json!({ "ok": true, "count": count }));
            });
        });
        host.handle("sys.webViews", |call| {
            mac::on_main(move || {
                let views = mac::web_views();
                call.resolve(serde_json::json!({ "ok": true, "count": views.len(), "views": views }));
            });
        });
        host.handle("sys.pickFolder", |call| {
            let start = call
                .data()
                .get("start")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            mac::on_main(move || mac::pick_folder(call, start));
        });
    }
    #[cfg(not(target_os = "macos"))]
    for name in ["sys.focusContent", "sys.webBackground", "sys.webViews", "sys.pickFolder"] {
        host.handle(name, |call| call.resolve(serde_json::json!({ "ok": false })));
    }
}

/// `{ version, build }` for `sys.appInfo`.
fn app_info() -> serde_json::Value {
    let build = serde_json::from_str::<serde_json::Value>(include_str!("../app/nsh.json"))
        .ok()
        .and_then(|v| v.get("build").cloned())
        .map(|b| match b {
            serde_json::Value::String(s) => s,
            other => other.to_string(),
        })
        .unwrap_or_default();
    serde_json::json!({ "version": env!("CARGO_PKG_VERSION"), "build": build })
}

#[cfg(test)]
mod tests {
    #[test]
    fn app_info_has_version_and_build() {
        let v = super::app_info();
        assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
        assert!(!v["build"].as_str().unwrap_or("").is_empty());
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;

    use block2::RcBlock;
    use nsh_engine::HostCall;
    use objc2::encode::{Encoding, RefEncode};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{MainThreadMarker, class, msg_send, sel};
    use objc2_foundation::{NSString, NSURL};

    /// Runs `work` on the main thread (AppKit's), from any thread.
    pub(super) fn on_main(work: impl FnOnce() + Send + 'static) {
        dispatch2::DispatchQueue::main().exec_async(work);
    }

    /// `CGColorRef`'s pointee, encoded as AppKit declares it.
    #[repr(C)]
    struct CGColor {
        _private: [u8; 0],
    }
    // SAFETY: `^{CGColor=}`, the encoding of `CGColorRef`.
    unsafe impl RefEncode for CGColor {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("CGColor", &[]));
    }

    type Obj = Retained<AnyObject>;

    fn responds(obj: &AnyObject, sel: objc2::runtime::Sel) -> bool {
        // SAFETY: NSObject's respondsToSelector: on a live object.
        let r: Bool = unsafe { msg_send![obj, respondsToSelector: sel] };
        r.as_bool()
    }

    fn is_kind(obj: &AnyObject, cls: &AnyClass) -> bool {
        // SAFETY: NSObject's isKindOfClass: on a live object.
        let r: Bool = unsafe { msg_send![obj, isKindOfClass: cls] };
        r.as_bool()
    }

    /// `[NSApp keyWindow]`, else `mainWindow`, else the first visible window.
    fn app_window() -> Option<Obj> {
        // SAFETY: NSApplication's own messages, on the main thread.
        unsafe {
            let app: Option<Obj> = msg_send![class!(NSApplication), sharedApplication];
            let app = app?;
            let key: Option<Obj> = msg_send![&*app, keyWindow];
            if key.is_some() {
                return key;
            }
            let main: Option<Obj> = msg_send![&*app, mainWindow];
            if main.is_some() {
                return main;
            }
            let windows: Option<Obj> = msg_send![&*app, windows];
            for w in array(windows.as_deref()) {
                let visible: Bool = msg_send![&*w, isVisible];
                if visible.as_bool() {
                    return Some(w);
                }
            }
            None
        }
    }

    /// The objects of an NSArray (empty for none).
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

    /// `view` and every view under it, depth first.
    fn walk(view: &AnyObject, out: &mut Vec<Obj>) {
        // SAFETY: NSView's subviews, on the main thread.
        let subs: Option<Obj> = unsafe { msg_send![view, subviews] };
        for sub in array(subs.as_deref()) {
            walk(&sub, out);
            out.push(sub);
        }
    }

    /// Every view of `window`'s content view (the content view included).
    fn views_of(window: &AnyObject) -> Vec<Obj> {
        // SAFETY: NSWindow's contentView, on the main thread.
        let content: Option<Obj> = unsafe { msg_send![window, contentView] };
        let Some(content) = content else { return Vec::new() };
        let mut out = Vec::new();
        walk(&content, &mut out);
        out.push(content);
        out
    }

    /// The window's GPUIView becomes its first responder. False when there
    /// is no window or no GPUIView in it.
    pub(super) fn focus_content() -> bool {
        if MainThreadMarker::new().is_none() {
            return false;
        }
        let Some(gpui) = AnyClass::get(c"GPUIView") else { return false };
        let Some(window) = app_window() else { return false };
        let Some(view) = views_of(&window).into_iter().find(|v| is_kind(v, gpui)) else {
            return false;
        };
        // SAFETY: NSWindow's firstResponder / makeFirstResponder: with a
        // view of this window, on the main thread. Neither orders the
        // window front nor activates the app.
        unsafe {
            let current: Option<Obj> = msg_send![&*window, firstResponder];
            if current.as_deref().is_some_and(|c| std::ptr::eq(c, &*view)) {
                return true;
            }
            let ok: Bool = msg_send![&*window, makeFirstResponder: &*view];
            ok.as_bool()
        }
    }

    /// Every WKWebView of the app's window draws black, not white, where
    /// its page has not painted. How many it found.
    pub(super) fn web_background() -> usize {
        if MainThreadMarker::new().is_none() {
            return 0;
        }
        let Some(wk) = AnyClass::get(c"WKWebView") else { return 0 };
        // Every window (the hidden resolver view lives in the main one, but
        // a sheet can be key).
        // SAFETY: NSApplication's windows, on the main thread.
        let windows: Option<Obj> = unsafe {
            let app: Option<Obj> = msg_send![class!(NSApplication), sharedApplication];
            match app {
                Some(app) => msg_send![&*app, windows],
                None => None,
            }
        };
        let mut count = 0;
        for window in array(windows.as_deref()) {
            for view in views_of(&window) {
                if is_kind(&view, wk) {
                    paint_black(&view);
                    count += 1;
                }
            }
        }
        count
    }

    /// `NSRect` (`CGRect`), as AppKit returns it.
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }
    // SAFETY: `{CGRect={CGPoint=dd}{CGSize=dd}}` on 64-bit platforms.
    unsafe impl objc2::encode::Encode for Rect {
        const ENCODING: Encoding = Encoding::Struct(
            "CGRect",
            &[
                Encoding::Struct("CGPoint", &[Encoding::Double, Encoding::Double]),
                Encoding::Struct("CGSize", &[Encoding::Double, Encoding::Double]),
            ],
        );
    }

    /// Every WKWebView of the app's windows: `{url, loading, hidden, alpha,
    /// width, height, windowVisible}` (`hidden`: it or an ancestor).
    pub(super) fn web_views() -> Vec<serde_json::Value> {
        if MainThreadMarker::new().is_none() {
            return Vec::new();
        }
        let Some(wk) = AnyClass::get(c"WKWebView") else { return Vec::new() };
        // SAFETY: NSApplication's windows, on the main thread.
        let windows: Option<Obj> = unsafe {
            let app: Option<Obj> = msg_send![class!(NSApplication), sharedApplication];
            match app {
                Some(app) => msg_send![&*app, windows],
                None => None,
            }
        };
        let mut out = Vec::new();
        for window in array(windows.as_deref()) {
            // SAFETY: NSWindow's isVisible, on the main thread.
            let shown: Bool = unsafe { msg_send![&*window, isVisible] };
            for view in views_of(&window).into_iter().filter(|v| is_kind(v, wk)) {
                // SAFETY: NSView / WKWebView properties, each checked with
                // respondsToSelector: first, on the main thread.
                unsafe {
                    let url = if responds(&view, sel!(URL)) {
                        let u: Option<Retained<NSURL>> = msg_send![&*view, URL];
                        u.and_then(|u| u.absoluteString()).map(|s| s.to_string())
                    } else {
                        None
                    };
                    let loading = responds(&view, sel!(isLoading)) && {
                        let b: Bool = msg_send![&*view, isLoading];
                        b.as_bool()
                    };
                    let hidden: Bool = msg_send![&*view, isHiddenOrHasHiddenAncestor];
                    let alpha: f64 = msg_send![&*view, alphaValue];
                    let frame: Rect = msg_send![&*view, frame];
                    out.push(serde_json::json!({
                        "url": url,
                        "loading": loading,
                        "hidden": hidden.as_bool(),
                        "alpha": alpha,
                        "width": frame.w,
                        "height": frame.h,
                        "windowVisible": shown.as_bool(),
                    }));
                }
            }
        }
        out
    }

    fn paint_black(view: &AnyObject) {
        // SAFETY: messages checked with respondsToSelector: first (KVC's
        // `drawsBackground` resolves to WebKit's `_setDrawsBackground:` /
        // `setDrawsBackground:`; without either, setValue:forKey: would
        // raise), on the main thread.
        unsafe {
            if responds(view, sel!(_setDrawsBackground:)) || responds(view, sel!(setDrawsBackground:)) {
                let no: Option<Obj> = msg_send![class!(NSNumber), numberWithBool: Bool::NO];
                if let Some(no) = no {
                    let key = NSString::from_str("drawsBackground");
                    let _: () = msg_send![view, setValue: &*no, forKey: &*key];
                }
            }
            let black: Option<Obj> = msg_send![class!(NSColor), blackColor];
            let Some(black) = black else { return };
            if responds(view, sel!(setUnderPageBackgroundColor:)) {
                let _: () = msg_send![view, setUnderPageBackgroundColor: &*black];
            }
            let layer: Option<Obj> = msg_send![view, layer];
            if let Some(layer) = layer {
                let cg: *const CGColor = msg_send![&*black, CGColor];
                if !cg.is_null() {
                    let _: () = msg_send![&*layer, setBackgroundColor: cg];
                }
            }
        }
    }

    /// Shows the folder panel; answers `{ok, path}` or `{ok: false,
    /// cancelled: true}` once it closes.
    pub(super) fn pick_folder(call: HostCall, start: Option<String>) {
        if MainThreadMarker::new().is_none() {
            call.resolve(serde_json::json!({ "ok": false, "error": "not on the main thread" }));
            return;
        }
        // SAFETY: NSOpenPanel's own messages, on the main thread. The
        // completion block is copied by AppKit and called once, on the main
        // thread; the panel is kept alive by the block until then.
        unsafe {
            let panel: Option<Obj> = msg_send![class!(NSOpenPanel), openPanel];
            let Some(panel) = panel else {
                call.resolve(serde_json::json!({ "ok": false, "error": "no panel" }));
                return;
            };
            let _: () = msg_send![&*panel, setCanChooseDirectories: Bool::YES];
            let _: () = msg_send![&*panel, setCanChooseFiles: Bool::NO];
            let _: () = msg_send![&*panel, setCanCreateDirectories: Bool::YES];
            let _: () = msg_send![&*panel, setAllowsMultipleSelection: Bool::NO];
            let _: () = msg_send![&*panel, setResolvesAliases: Bool::YES];
            let prompt = NSString::from_str("Choose");
            let _: () = msg_send![&*panel, setPrompt: &*prompt];
            if let Some(dir) = start.filter(|s| std::path::Path::new(s).is_dir()) {
                let url = NSURL::fileURLWithPath(&NSString::from_str(&dir));
                let _: () = msg_send![&*panel, setDirectoryURL: &*url];
            }

            let call = RefCell::new(Some(call));
            let keep = RefCell::new(Some(panel.clone()));
            let done = RcBlock::new(move |response: isize| {
                // NSModalResponseOK is 1.
                let path = keep.borrow_mut().take().and_then(|p| {
                    if response != 1 {
                        return None;
                    }
                    let url: Option<Retained<NSURL>> = msg_send![&*p, URL];
                    let path: Option<Retained<NSString>> = match url {
                        Some(u) => msg_send![&*u, path],
                        None => None,
                    };
                    path.map(|s| s.to_string())
                });
                if let Some(call) = call.borrow_mut().take() {
                    call.resolve(match path {
                        Some(path) => serde_json::json!({ "ok": true, "path": path }),
                        None => serde_json::json!({ "ok": false, "cancelled": true }),
                    });
                }
            });
            match app_window() {
                Some(window) => {
                    let _: () = msg_send![
                        &*panel,
                        beginSheetModalForWindow: &*window,
                        completionHandler: &*done
                    ];
                }
                None => {
                    let _: () = msg_send![&*panel, beginWithCompletionHandler: &*done];
                }
            }
        }
    }
}
