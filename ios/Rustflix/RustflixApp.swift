import SwiftUI
import NativeShell

@main
struct RustflixApp: App {
    var body: some Scene {
        WindowGroup {
            NshHostView()
                .ignoresSafeArea()
        }
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
    }

    private func loadApp() {
        guard let url = Bundle.main.url(
            forResource: "bundle", withExtension: "nshc", subdirectory: "nsh"
        ) else {
            appView.onError?("nsh/bundle.nshc missing from the app bundle")
            return
        }
        do {
            try appView.loadBundle(at: url)
        } catch {
            appView.onError?("loadBundle failed: \(error)")
        }
    }
}
