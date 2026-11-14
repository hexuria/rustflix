// System controls for the player's swipe gestures: screen brightness
// (left half) and media volume (right half), exposed to JS through
// `nsh/host` as `sys.*` (see app/lib/system.ts).

import AVFoundation
import GameController
import MediaPlayer
import NativeShell
import UIKit

@MainActor
final class SystemControls {
    static let shared = SystemControls()

    private weak var hostView: UIView?
    /// Brightness in effect before the first `setBrightness` since the last
    /// restore; nil when nothing needs restoring.
    private var savedBrightness: CGFloat?
    /// The level the player asked for, re-applied when the app returns to
    /// the foreground while a saved level is still pending restore.
    private var playerBrightness: CGFloat?

    // iOS has no public API to set the system volume. The well-known
    // workaround is an MPVolumeView kept in the view hierarchy (so the
    // system routes volume through it and does not show its own HUD) but
    // effectively invisible, and driving its internal UISlider.
    private var volumeView: MPVolumeView?

    private init() {
        // Only alter the system brightness while the app is in front: hand
        // the saved level back when leaving, re-apply the player's on return.
        let nc = NotificationCenter.default
        nc.addObserver(
            forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
        ) { _ in
            Task { @MainActor in SystemControls.shared.appWillResignActive() }
        }
        nc.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { _ in
            Task { @MainActor in SystemControls.shared.appDidBecomeActive() }
        }
    }

    func attach(hostView: UIView) {
        self.hostView = hostView
    }

    // MARK: Brightness

    func getBrightness() -> [String: Any] {
        ["value": Double(UIScreen.main.brightness)]
    }

    func setBrightness(_ data: Any?) -> [String: Any] {
        guard let v = Self.value(data) else { return getBrightness() }
        if savedBrightness == nil { savedBrightness = UIScreen.main.brightness }
        playerBrightness = CGFloat(v)
        UIScreen.main.brightness = CGFloat(v)
        return ["value": v]
    }

    func restoreBrightness() -> [String: Any] {
        if let saved = savedBrightness {
            UIScreen.main.brightness = saved
            savedBrightness = nil
        }
        playerBrightness = nil
        return getBrightness()
    }

    private func appWillResignActive() {
        if let saved = savedBrightness { UIScreen.main.brightness = saved }
    }

    private func appDidBecomeActive() {
        guard savedBrightness != nil, let level = playerBrightness else { return }
        // The user may have changed brightness while away; restore to that.
        savedBrightness = UIScreen.main.brightness
        UIScreen.main.brightness = level
    }

    // MARK: Volume

    func getVolume() -> [String: Any] {
        if let slider = volumeSlider() { return ["value": Double(slider.value)] }
        return ["value": Double(AVAudioSession.sharedInstance().outputVolume)]
    }

    func setVolume(_ data: Any?) async -> [String: Any] {
        guard let v = Self.value(data) else { return getVolume() }
        var slider = volumeSlider()
        if slider == nil {
            // A freshly added MPVolumeView builds its slider lazily; give it
            // one run-loop turn before looking again.
            try? await Task.sleep(nanoseconds: 50_000_000)
            slider = volumeSlider()
        }
        guard let slider else { return getVolume() }
        slider.setValue(Float(v), animated: false)
        slider.sendActions(for: .valueChanged)
        return ["value": v]
    }

    /// The hidden MPVolumeView's slider, creating the view on first use.
    private func volumeSlider() -> UISlider? {
        if volumeView == nil {
            guard let host = hostView else { return nil }
            // Tiny, nearly transparent and off-screen: alpha 0 or isHidden
            // would make iOS fall back to showing the system volume HUD.
            let v = MPVolumeView(frame: CGRect(x: -2000, y: -2000, width: 1, height: 1))
            v.alpha = 0.0001
            v.isUserInteractionEnabled = false
            host.addSubview(v)
            v.layoutIfNeeded()
            volumeView = v
        }
        return volumeView.flatMap(Self.findSlider)
    }

    /// Depth-first search: the slider's depth inside MPVolumeView is not API.
    private static func findSlider(in view: UIView) -> UISlider? {
        for sub in view.subviews {
            if let slider = sub as? UISlider { return slider }
            if let slider = findSlider(in: sub) { return slider }
        }
        return nil
    }

    // MARK: App info (Settings → About, Gestures)

    /// `sys.appInfo`: the marketing version and the build number.
    func appInfo() -> [String: Any] {
        let info = Bundle.main.infoDictionary ?? [:]
        return [
            "version": info["CFBundleShortVersionString"] as? String ?? "",
            "build": info["CFBundleVersion"] as? String ?? "",
        ]
    }

    /// `sys.hardwareKeyboard`: a hardware keyboard is attached (an iPad's
    /// Keyboard shortcuts category shows then).
    func hardwareKeyboard() -> [String: Any] {
        ["connected": GCKeyboard.coalesced != nil]
    }

    // MARK: Arguments

    /// `{ "value": number }` clamped to 0…1; nil when missing or not a number.
    private static func value(_ data: Any?) -> Double? {
        guard let dict = data as? [String: Any] else { return nil }
        let d: Double
        switch dict["value"] {
        case let n as NSNumber: d = n.doubleValue
        case let n as Double: d = n
        case let n as Int: d = Double(n)
        default: return nil
        }
        guard d.isFinite else { return nil }
        return min(1, max(0, d))
    }
}
