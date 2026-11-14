import SwiftUI
import NativeShell

@main
struct RustflixApp: App {
    @UIApplicationDelegateAdaptor(RustflixAppDelegate.self) private var appDelegate

    init() {
        // Before NSH makes any WKWebView: inline <video> on iPhone.
        InlineMediaPlayback.install()
        // Ad blocking hooks (WebGuard.swift), also before any web view.
        WebGuard.install()
    }

    var body: some Scene {
        WindowGroup {
            NshHostView()
                .ignoresSafeArea()
        }
    }
}

/// Background downloads: the download sessions are created at launch (so
/// transfers that finished while the app was suspended or not running are
/// delivered), and the system's completion handler is called once those
/// events are drained.
final class RustflixAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        _ = DownloadManager.shared
        return true
    }

    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        DownloadManager.shared.storeBackgroundCompletion(identifier, completionHandler)
    }
}

/// Hosts the NSH runtime (`NshAppView`, a UIView) edge to edge.
struct NshHostView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> NshHostController {
        NshHostController()
    }
    func updateUIViewController(_ controller: NshHostController, context: Context) {}
}

final class NshHostController: UIViewController {
    private let appView = NshAppView()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        appView.frame = view.bounds
        appView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        appView.onError = { message in
            NSLog("rustflix/nsh: %@", message)
        }
        view.addSubview(appView)
        loadApp()
        // The FPS monitor's two-finger triple tap, on every app window (the
        // player's full-screen dialog may bring its own).
        NotificationCenter.default.addObserver(
            forName: UIWindow.didBecomeVisibleNotification, object: nil, queue: .main
        ) { note in
            MainActor.assumeIsolated {
                PerfMonitor.shared.watchGesture(in: note.object as? UIWindow)
            }
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        PerfMonitor.shared.watchGesture(in: view.window)
    }

    private func loadApp() {
        guard let url = Bundle.main.url(
            forResource: "bundle", withExtension: "nshc", subdirectory: "nsh"
        ) else {
            appView.onError?("nsh/bundle.nshc missing from the app bundle")
            return
        }
        // Before the bundle runs: the app hands over its ad lists at boot.
        WebGuard.shared.register(appView)
        // The app's own player (`rustflix.video`, a native component: before
        // the bundle mounts anything) and the stream proxy (`dl.stream.*`):
        // NativeVideo.swift, StreamProxy.swift.
        NativeVideoHost.register(appView)
        // The system activity indicator (`rustflix.spinner`).
        NativeSpinnerComponent.register(appView)
        do {
            try appView.loadBundle(at: url)
        } catch {
            appView.onError?("loadBundle failed: \(error)")
        }
        registerDownloadHandlers()
        registerSystemHandlers()
        registerCacheHandlers()
        registerPerfHandlers()
    }

    /// `nsh/host` handlers of the FPS monitor and the perf recorder
    /// (`app/lib/perf.ts`, gated by capabilities.host "perf.*").
    private func registerPerfHandlers() {
        let perf = PerfMonitor.shared
        perf.attach(hostView: appView)
        appView.handle("perf.set") { data in perf.set(data) }
        appView.handle("perf.save") { data in await perf.save(data) }
        appView.handle("perf.block") { data in perf.block(data) }
        appView.handle("perf.js") { data in
            perf.jsReport(data)
            return nil
        }
        appView.handle("perf.route") { data in
            perf.routeChanged(data)
            return nil
        }
    }

    /// `nsh/host` handlers backing Settings → Storage
    /// (`host.call("cache.*")` in JS, gated by capabilities.host "cache.*").
    private func registerCacheHandlers() {
        let cache = CacheControls.shared
        appView.handle("cache.info") { _ in await cache.info() }
        appView.handle("cache.clear") { data in await cache.clear(data) }
    }

    /// `nsh/host` handlers backing the player's brightness/volume swipes
    /// (`host.call("sys.*")` in JS, gated by capabilities.host "sys.*").
    private func registerSystemHandlers() {
        let sys = SystemControls.shared
        sys.attach(hostView: appView)
        appView.handle("sys.getBrightness") { _ in sys.getBrightness() }
        appView.handle("sys.setBrightness") { data in sys.setBrightness(data) }
        appView.handle("sys.restoreBrightness") { _ in sys.restoreBrightness() }
        appView.handle("sys.getVolume") { _ in sys.getVolume() }
        appView.handle("sys.setVolume") { data in await sys.setVolume(data) }
        appView.handle("sys.appInfo") { _ in sys.appInfo() }
        appView.handle("sys.hardwareKeyboard") { _ in sys.hardwareKeyboard() }
    }

    /// `nsh/host` handlers backing the app's offline downloads
    /// (`host.call("dl.*")` in JS, gated by capabilities.host "dl.*").
    private func registerDownloadHandlers() {
        let dl = DownloadManager.shared
        dl.attach(hostView: appView)
        appView.handle("dl.list") { _ in dl.list() }
        appView.handle("dl.start") { data in
            await dl.start((data as? [String: Any]) ?? [:])
        }
        appView.handle("dl.cancel") { data in
            dl.cancel((data as? [String: Any]) ?? [:])
            return nil
        }
        appView.handle("dl.remove") { data in
            dl.remove((data as? [String: Any]) ?? [:])
            return nil
        }
        appView.handle("dl.playUrl") { data in
            await dl.playUrl((data as? [String: Any]) ?? [:])
        }
        appView.handle("dl.play") { data in
            dl.play((data as? [String: Any]) ?? [:])
            return nil
        }
        appView.handle("dl.reveal") { data in
            dl.reveal((data as? [String: Any]) ?? [:])
            return nil
        }
        appView.handle("dl.options") { data in
            dl.options((data as? [String: Any]) ?? [:])
        }
        appView.handle("dl.space") { _ in await dl.space() }
        appView.handle("dl.nextId") { _ in dl.reserveId() }
    }
}
