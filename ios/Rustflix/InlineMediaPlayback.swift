// Inline <video> playback for every WKWebView in the app.
//
// On iPhone a WKWebViewConfiguration defaults to
// allowsInlineMediaPlayback = false, so any <video> that starts playing is
// taken into the native fullscreen player, and NSH has no way to change
// that: it builds its web views from a plain `[WKWebViewConfiguration new]`
// (nsh-platform-ios web.rs) and NativeShell.xcframework exposes no
// configuration hook. The player draws its own controls over the video and
// only goes native fullscreen from its fullscreen button
// (video.webkitEnterFullscreen(), unaffected by this), so we swizzle
// -[WKWebView initWithFrame:configuration:] and set the flags on the
// configuration before calling through (WebKit copies it at init).
//
// mediaTypesRequiringUserActionForPlayback defaults to .all on iOS; it is
// cleared so the app can start playback itself after the user pressed Play
// on the title page.

import ObjectiveC
import WebKit

enum InlineMediaPlayback {
    private static var installed = false

    /// Installs the hook once; call before NSH creates any web view.
    static func install() {
        guard !installed else { return }
        installed = true
        let cls: AnyClass = WKWebView.self
        guard
            let original = class_getInstanceMethod(
                cls, #selector(WKWebView.init(frame:configuration:))),
            let replacement = class_getInstanceMethod(
                cls, #selector(WKWebView.init(rustflixFrame:configuration:)))
        else { return }
        method_exchangeImplementations(original, replacement)
    }
}

extension WKWebView {
    /// After the exchange this body runs for `initWithFrame:configuration:`,
    /// and `self.init(rustflixFrame:…)` reaches WebKit's original. It is an
    /// init-family selector so the ObjC ownership conventions match, and
    /// `dynamic` so the delegation goes through objc_msgSend.
    @objc dynamic convenience init(rustflixFrame frame: CGRect, configuration: WKWebViewConfiguration) {
        configuration.allowsInlineMediaPlayback = true
        configuration.allowsPictureInPictureMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        self.init(rustflixFrame: frame, configuration: configuration)
    }
}
