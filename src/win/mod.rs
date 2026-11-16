//! Windows shell glue (`cfg(target_os = "windows")` only).
//!
//! - [`before_gpui`]: process settings GPUI reads when it starts.
//! - [`shell`]: free space, the Recycle Bin and Explorer (`fs.*`, `dl.*`).

pub(crate) mod shell;

/// Called first thing in `main`, before any thread exists and before
/// GPUI's platform is created.
///
/// GPUI's Windows renderer draws through DirectComposition by default,
/// with its composition target created topmost
/// (`IDCompositionDevice::CreateTargetForHwnd(hwnd, true)`,
/// gpui-fast-windows `directx_renderer.rs`). A topmost target is
/// composed above the window's child windows, and every web view NSH
/// builds through wry is a child window (WebView2's `WRY_WEBVIEW` →
/// `Chrome_WidgetWin_*`). So each web view sits under GPUI's opaque
/// picture: the source page of the web-page player and every web view the
/// app shows stay black, although WebView2 renders them.
///
/// `GPUI_DISABLE_DIRECT_COMPOSITION` (read once by `WindowsPlatform::new`)
/// makes GPUI present through a swap chain on the window instead, which
/// child windows draw above, as a WKWebView sits above GPUI's layer on
/// macOS. A value the user set is kept.
pub(crate) fn before_gpui() {
    const KEY: &str = "GPUI_DISABLE_DIRECT_COMPOSITION";
    if std::env::var_os(KEY).is_none() {
        // SAFETY: no other thread exists yet (this runs before logging,
        // the engine and GPUI start), so nothing reads the environment
        // concurrently.
        unsafe { std::env::set_var(KEY, "true") };
    }
}
