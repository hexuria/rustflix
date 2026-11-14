// `rustflix.video` on iOS: the app's own player — an AVPlayer in an
// AVPlayerLayer-backed UIView, registered with NSH as a native component
// (`NshAppView.register(component:)`), driven by app/lib/nativevideo.tsx.
// Props, commands and events are those of contract.md §1:
//
// - props `src` (a proxy URL from StreamProxy.swift, a local download URL
//   or a file path; the same value again is a no-op, null stops), `startAt`
//   (applied once per src, when it is ready), `paused`, `muted`, `volume`,
//   `rate` (pitch-corrected), `fit` (contain / cover → videoGravity),
//   `maxResolution` (preferredMaximumResolution), `frame` (desktop only:
//   ignored), and iOS's `nowPlaying {title, subtitle?, artwork?}`;
// - commands `seek {time}`, `selectAudio {id}`, `selectSubtitle {id|null}`,
//   `enterPip`, `exitPip`;
// - events `ready {handle}`, `load`, `frame`, `tracks`, `progress`,
//   `buffer`, `seeked`, `rate`, `pip`, `end`, `error`. Stalls and failures
//   come from KVO (item status, timeControlStatus, isPlaybackLikelyToKeepUp)
//   and the stalled / failed-to-play-to-end / error-log notifications —
//   what NSH's own Video misses.
//
// iOS specifics: the shared audio session is `.playback` / `.moviePlayback`
// while a player has an item (UIBackgroundModes audio keeps it playing in
// the background; the layer is detached from the player there unless
// Picture in Picture runs, so the sound goes on). Interruptions and a
// removed route (headphones unplugged) pause and say so in `rate {by}`;
// lock screen / Control Center commands (play, pause, ±10 s, scrubbing) act
// on the player that played last and are reported the same way. Picture in
// Picture uses AVPictureInPictureController on the player layer, starting
// on its own when the app leaves while playing. AirPlay video is off
// (`allowsExternalPlayback = false`): an Apple TV cannot reach the proxy on
// 127.0.0.1 (screen mirroring still works).
//
// The view takes no touches: NSH views drawn after the component (its later
// siblings) sit above it and get them (UIKit hit testing in nsh-platform-ios
// native_view.rs). Unmounting releases the component (NSH's destroy
// callback): deinit pauses, drops the item and removes every observer.

import AVFoundation
import AVKit
import MediaPlayer
import NativeShell
import UIKit
import WebKit

final class PlayerLayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

private final class WeakVideo {
    weak var video: NativeVideoComponent?
    init(_ v: NativeVideoComponent) { video = v }
}

@MainActor
final class NativeVideoComponent: NSObject, NshComponent, AVPictureInPictureControllerDelegate {
    // MARK: Registry (`sys.nativeVideo`, `sys.nativePlayers`)

    private static var nextHandle = 1
    private static var players: [Int: WeakVideo] = [:]

    static func find(_ handle: Int) -> NativeVideoComponent? { players[handle]?.video }

    /// `{live, playing}`: components alive, and playing now.
    static func census() -> [String: Any] {
        let all = players.values.compactMap(\.video)
        return ["ok": true, "live": all.count, "playing": all.filter { $0.player.timeControlStatus == .playing }.count]
    }

    // MARK: State

    private let ctx: NshComponentContext
    let handle: Int
    private let playerView = PlayerLayerView()
    var view: UIView { playerView }
    let player = AVPlayer()
    private var item: AVPlayerItem?

    private var src: String?
    private var startAt = 0.0
    private var paused = false
    private var muted = false
    private var volume: Float = 1
    private var rate: Float = 1
    private var maxResolution: CGSize = .zero
    private var nowPlaying: [String: Any] = [:]

    /// Per src.
    private var gen = 0
    private var started = Date()
    private var loaded = false
    private var framed = false
    private var failed = false
    private var ended = false
    private var stalled = false
    private var startSought = false
    private var pendingSeek: Double?
    private var lastRate: Float = -1
    private var lastProgress = Date.distantPast
    private var lastErrorLog: (String, Date)?
    private var audioIds: [String] = []
    private var subtitleIds: [String] = []
    /// Why the player paused itself (`rate {by}`), until the next report.
    private var pausedBy: String?
    private var interrupted = false

    private var itemObservers: [NSKeyValueObservation] = []
    private var itemTokens: [NSObjectProtocol] = []
    private var observers: [NSKeyValueObservation] = []
    private var tokens: [NSObjectProtocol] = []
    private var timeObserver: Any?
    private var pip: AVPictureInPictureController?
    private var pipObservers: [NSKeyValueObservation] = []
    private var lastPip: (Bool, Bool)?
    private var pipStarting = false
    private var detached = false
    private var lastLog = Date.distantPast
    private var torn = false
    private var fullscreen = false

    init(_ ctx: NshComponentContext) {
        self.ctx = ctx
        handle = Self.nextHandle
        Self.nextHandle += 1
        super.init()
        Self.players[handle] = WeakVideo(self)
        playerView.backgroundColor = .black
        playerView.isUserInteractionEnabled = false
        playerView.playerLayer.videoGravity = .resizeAspect
        playerView.playerLayer.player = player
        player.allowsExternalPlayback = false
        player.automaticallyWaitsToMinimizeStalling = true
        player.preventsDisplaySleepDuringVideoPlayback = true
        ctx.emit("ready", ["handle": handle, "fullscreen": true])
        observePlayer()
        setUpPip()
        NSLog("rustflix/video: player %d made", handle)
    }

    deinit {
        MainActor.assumeIsolated { teardown() }
    }

    /// Stops for good: no sound, no observer, no callback.
    private func teardown() {
        guard !torn else { return }
        torn = true
        Self.players[handle] = nil
        releaseItem()
        if let t = timeObserver { player.removeTimeObserver(t) }
        timeObserver = nil
        observers.forEach { $0.invalidate() }
        observers = []
        pipObservers.forEach { $0.invalidate() }
        pipObservers = []
        tokens.forEach { NotificationCenter.default.removeObserver($0) }
        tokens = []
        pip?.delegate = nil
        if pip?.isPictureInPictureActive == true { pip?.stopPictureInPicture() }
        pip = nil
        playerView.playerLayer.player = nil
        NowPlaying.shared.release(self)
        NativeAudioSession.update()
        if fullscreen { setFullscreen(false) }
        NSLog("rustflix/video: player %d gone", handle)
    }

    // MARK: NshComponent

    func setProp(_ name: String, _ value: Any?) {
        guard !torn else { return }
        switch name {
        case "src": setSrc(value as? String)
        case "startAt": startAt = Self.number(value).map { max(0, $0) } ?? 0
        case "paused": setPaused((value as? Bool) ?? false)
        case "muted":
            muted = (value as? Bool) ?? false
            player.isMuted = muted
        case "volume":
            volume = Float(min(1, max(0, Self.number(value) ?? 1)))
            player.volume = volume
        case "rate": setRate(Self.number(value) ?? 1)
        case "fit":
            playerView.playerLayer.videoGravity = (value as? String) == "cover" ? .resizeAspectFill : .resizeAspect
        case "maxResolution":
            if let d = value as? [String: Any], let w = Self.number(d["width"]), let h = Self.number(d["height"]), w > 0, h > 0 {
                maxResolution = CGSize(width: w, height: h)
            } else {
                maxResolution = .zero
            }
            item?.preferredMaximumResolution = maxResolution
        case "nowPlaying":
            nowPlaying = (value as? [String: Any]) ?? [:]
            NowPlaying.shared.refresh(self, info: true)
        default: break // `frame` and anything else: not for phones.
        }
    }

    func command(_ name: String, _ args: Any?) {
        guard !torn else { return }
        let a = (args as? [String: Any]) ?? [:]
        switch name {
        case "seek": if let t = Self.number(a["time"]) { seek(t) }
        case "selectAudio": selectAudio(a["id"] as? String)
        case "selectSubtitle": selectSubtitle(a["id"] as? String)
        case "enterPip": setPip(true)
        case "exitPip": setPip(false)
        case "enterFullscreen": setFullscreen(true)
        case "exitFullscreen": setFullscreen(false)
        default: break
        }
    }

    /// `sys.nativeVideo {handle, …}`: the props and commands at once.
    func control(_ d: [String: Any]) {
        for k in ["muted", "volume", "rate", "fit", "maxResolution", "startAt", "nowPlaying", "paused"] where d[k] != nil {
            setProp(k, d[k] is NSNull ? nil : d[k])
        }
        if d.keys.contains("src") { setSrc(d["src"] as? String) }
        if let t = Self.number(d["seek"]) { seek(t) }
        if d.keys.contains("selectAudio") { selectAudio(d["selectAudio"] as? String) }
        if d.keys.contains("selectSubtitle") { selectSubtitle(d["selectSubtitle"] as? String) }
        if let p = d["pip"] as? Bool { setPip(p) }
        if let f = d["fullscreen"] as? Bool { setFullscreen(f) }
    }

    private func emit(_ name: String, _ data: [String: Any]) {
        guard !torn else { return }
        ctx.emit(name, data)
    }

    // MARK: Source

    private func setSrc(_ value: String?) {
        let url = value.flatMap { $0.isEmpty ? nil : $0 }
        guard url != src else { return }
        releaseItem()
        src = url
        guard let url else {
            NativeAudioSession.update()
            NowPlaying.shared.release(self)
            return
        }
        let u: URL? = url.hasPrefix("/") ? URL(fileURLWithPath: url) : URL(string: url)
        guard let u, u.isFileURL || ["http", "https"].contains(u.scheme?.lowercased() ?? "") else {
            failed = true
            emit("error", ["message": "not a playable URL: \(url.prefix(120))", "code": "source", "fatal": true])
            return
        }
        gen += 1
        started = Date()
        let asset = AVURLAsset(url: u)
        let item = AVPlayerItem(asset: asset)
        item.audioTimePitchAlgorithm = .spectral
        item.preferredMaximumResolution = maxResolution
        self.item = item
        observeItem(item)
        player.isMuted = muted
        player.volume = volume
        player.replaceCurrentItem(with: item)
        NativeAudioSession.update(playing: true)
        NSLog("rustflix/video: player %d src %@", handle, String(url.prefix(160)))
        // Props of one update come together: start once `startAt` is known.
        let g = gen
        DispatchQueue.main.async { [weak self] in
            guard let self, self.gen == g else { return }
            self.applyRate()
        }
    }

    /// Stops and releases the current item (observers first: no callback
    /// of an old item reaches the new one).
    private func releaseItem() {
        gen += 1
        itemObservers.forEach { $0.invalidate() }
        itemObservers = []
        itemTokens.forEach { NotificationCenter.default.removeObserver($0) }
        itemTokens = []
        if item != nil {
            player.pause()
            player.replaceCurrentItem(with: nil)
        }
        item = nil
        loaded = false
        framed = false
        failed = false
        ended = false
        stalled = false
        startSought = false
        pendingSeek = nil
        lastRate = -1
        audioIds = []
        subtitleIds = []
    }

    private func setPaused(_ p: Bool) {
        paused = p
        if !p { interrupted = false }
        applyRate()
        emitProgress(force: true)
    }

    private func setRate(_ r: Double) {
        rate = Float(r.isFinite && r > 0 ? min(4, max(0.25, r)) : 1)
        if #available(iOS 16.0, *) { player.defaultRate = rate }
        applyRate()
    }

    /// Plays at `rate` unless paused (or the start position is pending).
    private func applyRate() {
        guard item != nil, !torn else { return }
        let waitingForStart = startAt > 0 && !startSought
        if paused || waitingForStart || failed {
            player.pause()
        } else {
            if ended { return }
            player.rate = rate
        }
        NativeAudioSession.update()
    }

    // MARK: Observation

    private func observePlayer() {
        observers.append(player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.statusChanged() }
        })
        observers.append(player.observe(\.rate, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.statusChanged() }
        })
        observers.append(playerView.playerLayer.observe(\.isReadyForDisplay, options: [.new]) { [weak self] layer, _ in
            let ready = layer.isReadyForDisplay
            DispatchQueue.main.async { if ready { self?.firstFrame() } }
        })
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 4), queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        let nc = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        tokens.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] n in
            let info = n.userInfo ?? [:]
            MainActor.assumeIsolated { self?.interruption(info) }
        })
        tokens.append(nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { [weak self] n in
            let reason = (n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue
            DispatchQueue.main.async { self?.routeChanged(reason) }
        })
        tokens.append(nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.enteredBackground() }
        })
        tokens.append(nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.enteringForeground() }
        })
    }

    private func observeItem(_ item: AVPlayerItem) {
        let g = gen
        let on: (@escaping @MainActor (NativeVideoComponent) -> Void) -> Void = { [weak self] f in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, self.gen == g, !self.torn else { return }
                    f(self)
                }
            }
        }
        itemObservers.append(item.observe(\.status, options: [.new]) { _, _ in on { $0.itemStatusChanged() } })
        itemObservers.append(item.observe(\.isPlaybackLikelyToKeepUp, options: [.new]) { _, _ in on { $0.statusChanged() } })
        itemObservers.append(item.observe(\.isPlaybackBufferEmpty, options: [.new]) { _, _ in on { $0.statusChanged() } })
        let nc = NotificationCenter.default
        itemTokens.append(nc.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { _ in
            on { $0.playedToEnd() }
        })
        itemTokens.append(nc.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { n in
            let err = n.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? NSError
            on { $0.fatal(err, prefix: "failed to play to the end") }
        })
        itemTokens.append(nc.addObserver(forName: .AVPlayerItemPlaybackStalled, object: item, queue: .main) { _ in
            on { v in
                if !v.stalled && !v.paused {
                    v.stalled = true
                    v.emit("buffer", ["stalled": true, "reason": "stalled"])
                    v.emitProgress(force: true)
                }
            }
        })
        itemTokens.append(nc.addObserver(forName: .AVPlayerItemNewErrorLogEntry, object: item, queue: .main) { _ in
            on { $0.errorLogged() }
        })
        if #available(iOS 15.0, *) {
            itemTokens.append(nc.addObserver(forName: AVPlayerItem.mediaSelectionDidChangeNotification, object: item, queue: .main) { _ in
                on { v in if v.loaded { v.emitTracks() } }
            })
        }
    }

    private func itemStatusChanged() {
        guard let item else { return }
        switch item.status {
        case .failed: fatal(item.error as NSError?, prefix: nil)
        case .readyToPlay: ready(item)
        default: break
        }
    }

    private func ready(_ item: AVPlayerItem) {
        guard !loaded else { return }
        loaded = true
        let g = gen
        let key = "availableMediaCharacteristicsWithMediaSelectionOptions"
        item.asset.loadValuesAsynchronously(forKeys: [key]) { [weak self] in
            DispatchQueue.main.async {
                guard let self, self.gen == g, let item = self.item else { return }
                let (audio, subs) = self.trackLists(item)
                let size = item.presentationSize
                self.emit("load", [
                    "duration": Self.seconds(item.duration) ?? NSNull(),
                    "width": Double(size.width), "height": Double(size.height),
                    "audioTracks": audio, "subtitleTracks": subs,
                    "ms": self.ms(),
                ])
                NSLog("rustflix/video: player %d loaded in %d ms (%.0fx%.0f, %d audio, %d subtitle tracks)",
                      self.handle, self.ms(), size.width, size.height, audio.count, subs.count)
                self.reportPip(force: true)
                NowPlaying.shared.refresh(self, info: true)
            }
        }
        // The start position, once: then play.
        let target = pendingSeek ?? (startAt > 0 ? startAt : nil)
        pendingSeek = nil
        if let target, target > 0 {
            let t0 = Date()
            player.seek(to: CMTime(seconds: target, preferredTimescale: 600),
                        toleranceBefore: CMTime(value: 1, timescale: 2), toleranceAfter: CMTime(value: 1, timescale: 2)) { [weak self] finished in
                DispatchQueue.main.async {
                    guard let self, self.gen == g else { return }
                    self.startSought = true
                    self.emit("seeked", ["target": target, "time": Self.seconds(self.player.currentTime()) ?? NSNull(),
                                         "finished": finished, "ms": Int(Date().timeIntervalSince(t0) * 1000)])
                    self.applyRate()
                }
            }
        } else {
            startSought = true
            applyRate()
        }
    }

    private func firstFrame() {
        guard !framed, let item, gen > 0 else { return }
        framed = true
        let size = item.presentationSize
        emit("frame", ["ms": ms(), "width": Double(size.width), "height": Double(size.height)])
        NSLog("rustflix/video: player %d first frame after %d ms (%.0fx%.0f)", handle, ms(), size.width, size.height)
        #if DEBUG
        let fsAfter = UserDefaults.standard.double(forKey: "rustflixDebugFullscreenAfter")
        if fsAfter > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + fsAfter) { [weak self] in self?.setFullscreen(true) }
            DispatchQueue.main.asyncAfter(deadline: .now() + fsAfter + 6) { [weak self] in self?.setFullscreen(false) }
        }
        let after = UserDefaults.standard.double(forKey: "rustflixDebugPipAfter")
        if after > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + after) { [weak self] in
                NSLog("rustflix/video: debug: starting picture in picture")
                self?.setPip(true)
            }
        }
        #endif
    }

    private func tick() {
        guard let item, !torn else { return }
        if !framed, player.timeControlStatus == .playing, item.presentationSize != .zero,
           (Self.seconds(player.currentTime()) ?? 0) > 0.2 {
            // The layer is not in a window (hidden): the clock moved with a
            // picture, so it was decoded.
            firstFrame()
        }
        if player.timeControlStatus == .playing { emitProgress(force: false) }
        if Date().timeIntervalSince(lastLog) >= 5, player.timeControlStatus == .playing {
            lastLog = Date()
            NSLog("rustflix/video: player %d at %.1f s rate %.2f%@%@", handle, Self.seconds(player.currentTime()) ?? -1,
                  player.rate, UIApplication.shared.applicationState == .background ? " (background)" : "",
                  pip?.isPictureInPictureActive == true ? " (pip)" : "")
        }
        NowPlaying.shared.refresh(self, info: false)
    }

    /// timeControlStatus / rate / buffer changes → `buffer`, `rate`.
    private func statusChanged() {
        guard item != nil, !torn else { return }
        let tcs = player.timeControlStatus
        let waiting = tcs == .waitingToPlayAtSpecifiedRate && !paused
        if waiting != stalled {
            stalled = waiting
            emit("buffer", ["stalled": waiting, "reason": waiting ? (player.reasonForWaitingToPlay?.rawValue ?? NSNull()) : NSNull()])
            emitProgress(force: true)
        }
        let eff: Float = tcs == .playing ? player.rate : 0
        if eff != lastRate {
            lastRate = eff
            var d: [String: Any] = ["rate": Double(eff), "paused": paused]
            if let by = pausedBy {
                d["by"] = by
                pausedBy = nil
            }
            emit("rate", d)
            NSLog("rustflix/video: player %d rate %.2f%@", handle, eff, paused ? " (paused)" : "")
            NowPlaying.shared.refresh(self, info: false)
        }
        if tcs == .playing { NowPlaying.shared.claim(self) }
        NativeAudioSession.update()
    }

    private func playedToEnd() {
        guard !ended else { return }
        ended = true
        emitProgress(force: true)
        emit("end", [:])
    }

    private func errorLogged() {
        guard let ev = item?.errorLog()?.events.last else { return }
        // Only HTTP failures and network errors reach the app (CoreMedia
        // also logs benign notices, e.g. -12318 "segment exceeds specified
        // bandwidth"); AVPlayer retries these itself.
        let http = ev.errorStatusCode >= 400 && ev.errorStatusCode < 600 && ev.errorDomain != NSURLErrorDomain
        guard http || ev.errorDomain == NSURLErrorDomain else {
            NSLog("rustflix/video: player %d notice: %@ (%@ %d)", handle, ev.errorComment ?? "-", ev.errorDomain, ev.errorStatusCode)
            return
        }
        let code = ev.errorStatusCode >= 100 && ev.errorStatusCode < 600 && ev.errorDomain != NSURLErrorDomain
            ? "http\(ev.errorStatusCode)" : (ev.errorDomain == NSURLErrorDomain ? "network" : "\(ev.errorDomain):\(ev.errorStatusCode)")
        if let (c, at) = lastErrorLog, c == code, Date().timeIntervalSince(at) < 5 { return }
        lastErrorLog = (code, Date())
        let message = "\(ev.errorComment ?? "playback error") (\(ev.errorDomain) \(ev.errorStatusCode))"
        NSLog("rustflix/video: player %d error log: %@ %@", handle, code, message)
        emit("error", ["message": message, "code": code, "fatal": false])
    }

    private func fatal(_ err: NSError?, prefix: String?) {
        guard !failed else { return }
        failed = true
        let text = Self.describe(err)
        let message = prefix.map { "\($0): \(text)" } ?? text
        NSLog("rustflix/video: player %d failed: %@", handle, message)
        emit("error", ["message": message, "code": Self.code(err), "fatal": true])
        player.pause()
        NativeAudioSession.update()
    }

    // MARK: Progress

    private func emitProgress(force: Bool) {
        guard let item, loaded || framed else { return }
        let now = Date()
        if !force && now.timeIntervalSince(lastProgress) < 0.2 { return }
        lastProgress = now
        let t = Self.seconds(player.currentTime())
        var around: Double?
        var furthest: Double?
        for v in item.loadedTimeRanges {
            let r = v.timeRangeValue
            guard let a = Self.seconds(r.start), let d = Self.seconds(r.duration) else { continue }
            let end = a + d
            if let t, a <= t + 0.5, t <= end { around = end }
            furthest = max(furthest ?? end, end)
        }
        emit("progress", ["currentTime": t ?? NSNull(), "buffered": (around ?? furthest) ?? NSNull(), "playable": furthest ?? NSNull()])
    }

    // MARK: Seeking

    func seek(_ secs: Double) {
        guard item != nil, secs.isFinite else { return }
        let target = max(0, secs)
        if !loaded {
            pendingSeek = target
            return
        }
        let g = gen
        let t0 = Date()
        ended = false
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600),
                    toleranceBefore: CMTime(value: 1, timescale: 2), toleranceAfter: CMTime(value: 1, timescale: 2)) { [weak self] finished in
            DispatchQueue.main.async {
                guard let self, self.gen == g else { return }
                self.emit("seeked", ["target": target, "time": Self.seconds(self.player.currentTime()) ?? NSNull(),
                                     "finished": finished, "ms": Int(Date().timeIntervalSince(t0) * 1000)])
                self.emitProgress(force: true)
                NowPlaying.shared.refresh(self, info: false)
            }
        }
    }

    // MARK: Tracks

    private func groups(_ item: AVPlayerItem) -> (AVMediaSelectionGroup?, AVMediaSelectionGroup?) {
        let asset = item.asset
        guard asset.statusOfValue(forKey: "availableMediaCharacteristicsWithMediaSelectionOptions", error: nil) == .loaded else {
            return (nil, nil)
        }
        return (asset.mediaSelectionGroup(forMediaCharacteristic: .audible),
                asset.mediaSelectionGroup(forMediaCharacteristic: .legible))
    }

    private func trackLists(_ item: AVPlayerItem) -> ([[String: Any]], [[String: Any]]) {
        let (audio, legible) = groups(item)
        let selection = item.currentMediaSelection
        func list(_ g: AVMediaSelectionGroup?, _ prefix: String) -> [[String: Any]] {
            guard let g else { return [] }
            return g.options.enumerated().map { i, o in
                var label = o.displayName
                if o.hasMediaCharacteristic(.containsOnlyForcedSubtitles) { label += " (forced)" }
                if o.hasMediaCharacteristic(.describesMusicAndSoundForAccessibility) { label += " (SDH)" }
                let lang = o.extendedLanguageTag ?? o.locale?.identifier
                return [
                    "id": "\(prefix)\(i)", "label": label, "lang": lang ?? NSNull(),
                    "default": g.defaultOption == o,
                    "selected": selection.selectedMediaOption(in: g) == o,
                ]
            }
        }
        let a = list(audio, "a")
        let s = list(legible, "s")
        audioIds = a.compactMap { $0["id"] as? String }
        subtitleIds = s.compactMap { $0["id"] as? String }
        return (a, s)
    }

    private func emitTracks() {
        guard let item else { return }
        let (a, s) = trackLists(item)
        emit("tracks", ["audioTracks": a, "subtitleTracks": s])
    }

    private func option(_ id: String?, _ prefix: Character, _ g: AVMediaSelectionGroup?) -> AVMediaSelectionOption? {
        guard let id, id.first == prefix, let i = Int(id.dropFirst()), let g, i >= 0, i < g.options.count else { return nil }
        return g.options[i]
    }

    private func selectAudio(_ id: String?) {
        guard let item, loaded else { return }
        let (audio, _) = groups(item)
        guard let audio, let o = option(id, "a", audio) else {
            emit("error", ["message": "no audio track \(id ?? "null")", "code": "track", "fatal": false])
            return
        }
        item.select(o, in: audio)
        emitTracks()
    }

    private func selectSubtitle(_ id: String?) {
        guard let item, loaded else { return }
        let (_, legible) = groups(item)
        guard let legible else {
            if id != nil { emit("error", ["message": "no subtitle tracks", "code": "track", "fatal": false]) }
            return
        }
        if id == nil {
            item.select(nil, in: legible)
        } else if let o = option(id, "s", legible) {
            item.select(o, in: legible)
        } else {
            emit("error", ["message": "no subtitle track \(id ?? "")", "code": "track", "fatal": false])
            return
        }
        emitTracks()
    }

    // MARK: Picture in Picture

    private func setUpPip() {
        guard AVPictureInPictureController.isPictureInPictureSupported(),
              let pip = AVPictureInPictureController(playerLayer: playerView.playerLayer)
        else { return }
        pip.delegate = self
        if #available(iOS 14.2, *) { pip.canStartPictureInPictureAutomaticallyFromInline = true }
        self.pip = pip
        pipObservers.append(pip.observe(\.isPictureInPicturePossible, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.reportPip(force: false) }
        })
        pipObservers.append(pip.observe(\.isPictureInPictureActive, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.reportPip(force: false) }
        })
    }

    private func reportPip(force: Bool) {
        guard !torn else { return }
        let now = (pip?.isPictureInPictureActive ?? false, pip?.isPictureInPicturePossible ?? false)
        if !force, let l = lastPip, l == now { return }
        lastPip = now
        emit("pip", ["active": now.0, "possible": now.1])
        NSLog("rustflix/video: player %d pip active=%d possible=%d", handle, now.0 ? 1 : 0, now.1 ? 1 : 0)
    }

    private func setPip(_ on: Bool) {
        guard let pip, pip.isPictureInPicturePossible || (!on && pip.isPictureInPictureActive) else {
            emit("pip", ["active": false, "possible": false])
            return
        }
        if on, !pip.isPictureInPictureActive {
            if detached { reattach() }
            pip.startPictureInPicture()
        } else if !on, pip.isPictureInPictureActive {
            pip.stopPictureInPicture()
        }
    }

    nonisolated func pictureInPictureControllerWillStartPictureInPicture(_ c: AVPictureInPictureController) {
        MainActor.assumeIsolated { pipStarting = true }
    }

    nonisolated func pictureInPictureControllerDidStartPictureInPicture(_ c: AVPictureInPictureController) {
        MainActor.assumeIsolated {
            pipStarting = false
            reportPip(force: false)
        }
    }

    nonisolated func pictureInPictureController(_ c: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
        let text = Self.describe(error as NSError)
        MainActor.assumeIsolated {
            pipStarting = false
            emit("error", ["message": "picture in picture: \(text)", "code": "pip", "fatal": false])
            reportPip(force: true)
        }
    }

    nonisolated func pictureInPictureControllerDidStopPictureInPicture(_ c: AVPictureInPictureController) {
        MainActor.assumeIsolated {
            reportPip(force: false)
            // Back in the background without PiP: sound only.
            if UIApplication.shared.applicationState == .background { detach() }
        }
    }

    nonisolated func pictureInPictureController(
        _ c: AVPictureInPictureController,
        restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
    ) {
        // The player view never left the app's screen.
        completionHandler(true)
    }

    // MARK: Full screen

    /// Contract request R2: the app's player dialog already fills the
    /// screen, so full screen is landscape (and back to portrait) — the
    /// app's own controls and captions stay, unlike AVPlayerViewController.
    private func setFullscreen(_ on: Bool) {
        fullscreen = on
        let scene = playerView.window?.windowScene
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        guard let scene else { return }
        let mask: UIInterfaceOrientationMask = on ? .landscape : .portrait
        if #available(iOS 16.0, *) {
            for w in scene.windows { w.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations() }
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { [weak self] error in
                let text = error.localizedDescription
                DispatchQueue.main.async {
                    self?.emit("error", ["message": "full screen: \(text)", "code": "fullscreen", "fatal": false])
                }
            }
        } else {
            let o: UIInterfaceOrientation = on ? .landscapeRight : .portrait
            UIDevice.current.setValue(o.rawValue, forKey: "orientation")
            UIViewController.attemptRotationToDeviceOrientation()
        }
        NSLog("rustflix/video: player %d full screen %@", handle, on ? "on (landscape)" : "off (portrait)")
    }

    // MARK: Background, interruptions, routes

    private func enteredBackground() {
        // No PiP to take over: sound only at once (iOS pauses a player that
        // still feeds a layer in the background).
        if pip?.isPictureInPicturePossible != true {
            detach()
            return
        }
        // Automatic PiP may still be starting; give it a moment.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self, !self.torn, UIApplication.shared.applicationState == .background else { return }
            if self.pip?.isPictureInPictureActive == true || self.pipStarting { return }
            self.detach()
        }
    }

    private func enteringForeground() {
        reattach()
    }

    private func detach() {
        guard !detached, item != nil else { return }
        detached = true
        playerView.playerLayer.player = nil
        NSLog("rustflix/video: player %d in the background: sound only", handle)
        // iOS may have paused it with the layer still attached: go on.
        if !paused && !failed && !ended {
            DispatchQueue.main.async { [weak self] in self?.applyRate() }
        }
    }

    private func reattach() {
        guard detached else { return }
        detached = false
        playerView.playerLayer.player = player
    }

    private func interruption(_ info: [AnyHashable: Any]) {
        guard item != nil else { return }
        let type = (info[AVAudioSessionInterruptionTypeKey] as? NSNumber).flatMap { AVAudioSession.InterruptionType(rawValue: $0.uintValue) }
        switch type {
        case .began:
            NSLog("rustflix/video: player %d audio interruption began", handle)
            if !paused { interrupted = true }
            pausedBy = "interruption"
            statusChanged()
        case .ended:
            let opts = (info[AVAudioSessionInterruptionOptionKey] as? NSNumber).map { AVAudioSession.InterruptionOptions(rawValue: $0.uintValue) }
            NSLog("rustflix/video: player %d audio interruption ended (resume: %d)", handle, opts?.contains(.shouldResume) == true ? 1 : 0)
            if interrupted, !paused, opts?.contains(.shouldResume) == true {
                interrupted = false
                NativeAudioSession.update(playing: true)
                applyRate()
            } else if interrupted {
                // Not to resume: paused, and the app is told.
                interrupted = false
                paused = true
                pausedBy = "interruption"
                lastRate = -1
                applyRate()
                statusChanged()
            }
        default: break
        }
    }

    private func routeChanged(_ reason: UInt?) {
        guard item != nil, !paused, reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
        NSLog("rustflix/video: player %d audio route gone (headphones out): pausing", handle)
        pause(by: "route")
    }

    // MARK: Remote commands (NowPlaying)

    func pause(by: String) {
        paused = true
        pausedBy = by
        lastRate = -1
        applyRate()
        statusChanged()
        emitProgress(force: true)
    }

    func play(by: String) {
        paused = false
        pausedBy = by
        lastRate = -1
        interrupted = false
        NativeAudioSession.update(playing: true)
        applyRate()
        statusChanged()
    }

    var isPausedNow: Bool { paused }
    var currentSeconds: Double? { Self.seconds(player.currentTime()) }
    var durationSeconds: Double? { item.flatMap { Self.seconds($0.duration) } }
    var effectiveRate: Float { player.timeControlStatus == .playing ? player.rate : 0 }
    var nowPlayingInfo: [String: Any] { nowPlaying }
    var hasItem: Bool { item != nil && !failed }
    var isPlaying: Bool { item != nil && player.timeControlStatus != .paused }

    // MARK: Helpers

    private func ms() -> Int { Int(Date().timeIntervalSince(started) * 1000) }

    nonisolated static func seconds(_ t: CMTime) -> Double? {
        guard t.isValid, t.isNumeric, !t.isIndefinite else { return nil }
        let s = t.seconds
        return s.isFinite ? s : nil
    }

    nonisolated static func number(_ v: Any?) -> Double? {
        switch v {
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return nil }
            return n.doubleValue.isFinite ? n.doubleValue : nil
        case let d as Double: return d.isFinite ? d : nil
        case let i as Int: return Double(i)
        default: return nil
        }
    }

    nonisolated static func describe(_ err: NSError?) -> String {
        guard let err else { return "unknown error" }
        var s = "\(err.localizedDescription) (\(err.domain) \(err.code))"
        if let u = err.userInfo[NSUnderlyingErrorKey] as? NSError {
            s += "; underlying: \(u.localizedDescription) (\(u.domain) \(u.code))"
        }
        return s
    }

    /// The contract's error codes: network, http<status>, decode, format,
    /// source, else "<domain>:<code>".
    nonisolated static func code(_ err: NSError?) -> String {
        guard let err else { return "internal" }
        var chain: [NSError] = [err]
        while let u = chain.last?.userInfo[NSUnderlyingErrorKey] as? NSError, chain.count < 4 { chain.append(u) }
        for e in chain {
            let text = "\(e.localizedDescription) \(e.userInfo[NSLocalizedFailureReasonErrorKey] ?? "")"
            if let r = text.range(of: #"HTTP (\d{3})"#, options: .regularExpression) {
                return "http" + text[r].dropFirst(5)
            }
        }
        for e in chain {
            if e.domain == NSURLErrorDomain {
                return [NSURLErrorUnsupportedURL, NSURLErrorBadURL, NSURLErrorFileDoesNotExist].contains(e.code) ? "source" : "network"
            }
            if e.domain == AVFoundationErrorDomain {
                switch e.code {
                case AVError.decodeFailed.rawValue, AVError.decoderNotFound.rawValue, AVError.decoderTemporarilyUnavailable.rawValue:
                    return "decode"
                case AVError.fileFormatNotRecognized.rawValue, AVError.failedToParse.rawValue, AVError.formatUnsupported.rawValue:
                    return "format"
                case AVError.contentIsUnavailable.rawValue, AVError.noLongerPlayable.rawValue, AVError.serverIncorrectlyConfigured.rawValue:
                    return "source"
                default: continue
                }
            }
            if e.domain == "CoreMediaErrorDomain" && (e.code == -12938 || e.code == -12660) { return "network" }
        }
        return "\(err.domain):\(err.code)"
    }
}

// MARK: - The audio session

@MainActor
enum NativeAudioSession {
    private static var active = false

    /// `.playback` / `.moviePlayback` while a player has an item to play;
    /// let go (others may resume) once none has.
    static func update(playing: Bool = false) {
        let census = NativeVideoComponent.census()
        let want = playing || ((census["live"] as? Int ?? 0) > 0 && anyWantsSound())
        let s = AVAudioSession.sharedInstance()
        if want && !active {
            do {
                try s.setCategory(.playback, mode: .moviePlayback, options: [])
                try s.setActive(true)
                active = true
            } catch {
                NSLog("rustflix/video: audio session: %@", "\(error)")
            }
        } else if !want && active {
            active = false
            // After the stop settles (a src swap is not a stop).
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                guard !active, !anyWantsSound() else { return }
                try? s.setActive(false, options: .notifyOthersOnDeactivation)
            }
        }
    }

    private static func anyWantsSound() -> Bool {
        NativeVideoComponent.liveVideos().contains { $0.hasItem && !$0.isPausedNow }
    }
}

extension NativeVideoComponent {
    static func liveVideos() -> [NativeVideoComponent] {
        players.values.compactMap(\.video)
    }
}

// MARK: - Now Playing and remote commands

@MainActor
final class NowPlaying {
    static let shared = NowPlaying()

    private weak var owner: NativeVideoComponent?
    private var commands = false
    private var artworkURL: String?
    private var artwork: MPMediaItemArtwork?
    private var lastPush = Date.distantPast

    /// `v` played: it gets the lock screen and remote commands.
    func claim(_ v: NativeVideoComponent) {
        if owner !== v {
            owner = v
            setUpCommands()
            refresh(v, info: true)
        }
    }

    func release(_ v: NativeVideoComponent) {
        guard owner === v || owner == nil else { return }
        owner = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        let c = MPRemoteCommandCenter.shared()
        for cmd in [c.playCommand, c.pauseCommand, c.togglePlayPauseCommand, c.skipForwardCommand,
                    c.skipBackwardCommand, c.changePlaybackPositionCommand] {
            cmd.isEnabled = false
        }
    }

    func refresh(_ v: NativeVideoComponent, info: Bool) {
        guard owner === v else { return }
        if !info && Date().timeIntervalSince(lastPush) < 1 { return }
        lastPush = Date()
        let np = v.nowPlayingInfo
        var d: [String: Any] = [
            MPMediaItemPropertyTitle: (np["title"] as? String) ?? "rustflix",
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.video.rawValue,
            MPNowPlayingInfoPropertyPlaybackRate: Double(v.effectiveRate),
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
        ]
        if let sub = np["subtitle"] as? String { d[MPMediaItemPropertyArtist] = sub }
        if let t = v.currentSeconds { d[MPNowPlayingInfoPropertyElapsedPlaybackTime] = t }
        if let dur = v.durationSeconds {
            d[MPMediaItemPropertyPlaybackDuration] = dur
            d[MPNowPlayingInfoPropertyIsLiveStream] = false
        } else {
            d[MPNowPlayingInfoPropertyIsLiveStream] = true
        }
        if let art = np["artwork"] as? String, art != artworkURL {
            artworkURL = art
            artwork = nil
            loadArtwork(art)
        }
        if let artwork { d[MPMediaItemPropertyArtwork] = artwork }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = d
    }

    private func loadArtwork(_ s: String) {
        guard let u = URL(string: s), ["http", "https"].contains(u.scheme?.lowercased() ?? "") else { return }
        URLSession.shared.dataTask(with: u) { data, _, _ in
            guard let data, let img = UIImage(data: data) else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard self.artworkURL == s else { return }
                    self.artwork = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
                    if let o = self.owner { self.refresh(o, info: true) }
                }
            }
        }.resume()
    }

    private func setUpCommands() {
        let c = MPRemoteCommandCenter.shared()
        for cmd in [c.playCommand, c.pauseCommand, c.togglePlayPauseCommand, c.skipForwardCommand,
                    c.skipBackwardCommand, c.changePlaybackPositionCommand] {
            cmd.isEnabled = true
        }
        c.nextTrackCommand.isEnabled = false
        c.previousTrackCommand.isEnabled = false
        guard !commands else { return }
        commands = true
        c.skipForwardCommand.preferredIntervals = [10]
        c.skipBackwardCommand.preferredIntervals = [10]
        func on(_ cmd: MPRemoteCommand, _ f: @escaping @MainActor (NativeVideoComponent, MPRemoteCommandEvent) -> Void) {
            cmd.addTarget { [weak self] e in
                MainActor.assumeIsolated {
                    guard let o = self?.owner else { return .noActionableNowPlayingItem }
                    f(o, e)
                    return .success
                }
            }
        }
        on(c.playCommand) { v, _ in v.play(by: "remote") }
        on(c.pauseCommand) { v, _ in v.pause(by: "remote") }
        on(c.togglePlayPauseCommand) { v, _ in v.isPausedNow ? v.play(by: "remote") : v.pause(by: "remote") }
        on(c.skipForwardCommand) { v, _ in v.seek((v.currentSeconds ?? 0) + 10) }
        on(c.skipBackwardCommand) { v, _ in v.seek(max(0, (v.currentSeconds ?? 0) - 10)) }
        on(c.changePlaybackPositionCommand) { v, e in
            if let e = e as? MPChangePlaybackPositionCommandEvent { v.seek(e.positionTime) }
        }
    }
}

// MARK: - Registration

@MainActor
enum NativeVideoHost {
    /// Registers `rustflix.video`, `sys.nativeVideo`, `sys.nativePlayers`,
    /// `sys.webViews`, and the stream proxy's `dl.stream.*` on `appView`.
    static func register(_ appView: NshAppView) {
        appView.register(component: "rustflix.video") { ctx in NativeVideoComponent(ctx) }
        appView.handle("sys.nativeVideo") { data in
            let d = (data as? [String: Any]) ?? [:]
            guard let h = NativeVideoComponent.number(d["handle"]), let v = NativeVideoComponent.find(Int(h)) else {
                return ["ok": false]
            }
            v.control(d)
            return ["ok": true]
        }
        appView.handle("sys.nativePlayers") { _ in NativeVideoComponent.census() }
        // Contract request R1: the app's player exists here ("auto" turns it
        // on); `local`: it plays a finished download's /<id>/<file> URL.
        appView.handle("sys.nativeVideoInfo") { _ in
            ["ok": true, "available": true, "version": 1,
             "pip": AVPictureInPictureController.isPictureInPictureSupported(),
             "fullscreen": true, "local": true]
        }
        appView.handle("sys.webViews") { _ in webViews() }

        let proxy = StreamProxy.shared
        weak let view = appView
        proxy.sink = { event in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { view?.send("dl.stream.event", event) }
            }
        }
        for op in ["dl.stream.open", "dl.stream.update", "dl.stream.close", "dl.stream.stats", "dl.stream.debug"] {
            appView.handle(op) { data in
                let d = (data as? [String: Any]) ?? [:]
                if op == "dl.stream.open" || op == "dl.stream.update" { await syncCookies() }
                return await proxy.call(op, d)
            }
        }
        appView.handle("dl.stream.selftest") { _ in
            let (failures, checks) = StreamRewriteCheck.run()
            return ["ok": failures.isEmpty, "result": failures.isEmpty ? "PASS" : "FAIL", "checks": checks, "failures": failures]
        }
    }

    /// The web views' cookies (the resolver's page picked them up) for the
    /// proxy's URLSession, which reads HTTPCookieStorage.
    private static func syncCookies() async {
        let cookies: [HTTPCookie] = await withCheckedContinuation { cont in
            WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cont.resume(returning: $0) }
        }
        for c in cookies { HTTPCookieStorage.shared.setCookie(c) }
    }

    /// Every WKWebView in the app's windows: URL, size, hidden (itself or an
    /// ancestor), alpha, its window's visibility (no page may show while
    /// the native player plays).
    static func webViews() -> [String: Any] {
        var out: [[String: Any]] = []
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        func walk(_ v: UIView, hidden: Bool, alpha: CGFloat, window: UIWindow) {
            let h = hidden || v.isHidden
            let a = alpha * v.alpha
            if let w = v as? WKWebView {
                let frame = w.convert(w.bounds, to: window)
                let onScreen = frame.intersects(window.bounds)
                out.append([
                    "url": w.url?.absoluteString ?? NSNull(), "loading": w.isLoading, "hidden": h,
                    "alpha": Double(a), "width": Double(frame.width), "height": Double(frame.height),
                    "x": Double(frame.minX), "y": Double(frame.minY), "onScreen": onScreen,
                    "windowVisible": !window.isHidden,
                ])
            }
            for s in v.subviews { walk(s, hidden: h, alpha: a, window: window) }
        }
        for w in windows { walk(w, hidden: false, alpha: 1, window: w) }
        return ["ok": true, "count": out.count, "views": out]
    }
}

