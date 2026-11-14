import NativeShell
import QuartzCore
import UIKit

/// The FPS monitor, the performance recorder and the spike capture on
/// iPhone (`perf.*`, `app/lib/perf.ts`; gated by capabilities.host "perf.*").
///
/// The NativeShell framework has no on-screen monitor on iOS (its
/// `nsh::fps` readings are log lines only, and the app's TSX — compiled by
/// nsh 0.4.0 — cannot reach `setFpsEnabled`), so this is the app's own:
///
/// - **Frames**: a display link of its own at the screen's full rate
///   (120 Hz on ProMotion with `CADisableMinimumFrameDurationOnPhone` in
///   Info.plist) closes a frame at every refresh. Two run-loop observers
///   time the main thread's work: from each wake-up (`afterWaiting`, first)
///   to each sleep (`beforeWaiting`, last — after Core Animation's commit).
///   A frame's cost is the main-thread time since the previous refresh:
///   applying NSH's batches, UIKit layout, scrolling, animations, the CA
///   commit. A refresh with under 0.25 ms of work is idle, not a frame.
///   A refresh that comes more than 1.5 periods after the last one means
///   the main thread was busy when it was due: refreshes were missed.
/// - **Red**: a frame whose cost is over one refresh (8.3 ms at 120 Hz):
///   bars are green within half a refresh, amber within one, red over.
/// - **JS**: the JS thread's lag and labelled long tasks, sent once a
///   second by the app (`perf.js`).
/// - **Spikes**: every red frame goes to `perf-spikes.jsonl` with what the
///   app was doing (route, scenario step) and the JS tasks of its second.
///   Main-thread stacks are not sampled in-process here: take them with
///   `sample <pid>` (Simulator) or Instruments' Time Profiler (device) and
///   line them up with the spikes' timestamps (`scratchpad/perf/spikes.py`).
///
/// While the panel shows or the recorder is on, one JSON line per second
/// goes to `Library/Application Support/perf.jsonl` (rolled at 2 MB),
/// written off the main thread. Nothing runs while both are off: no display
/// link, no observers, no timers. The panel is its own window: updating it
/// (twice a second) never touches NSH's views.
///
/// A two-finger triple tap anywhere toggles the panel (through the app, so
/// the Settings switch and the stored state follow); on the panel, a tap
/// folds it to one line and a long press saves the recording.
@MainActor
final class PerfMonitor: NSObject, UIGestureRecognizerDelegate {
    static let shared = PerfMonitor()

    private weak var hostView: NshAppView?
    private var hudOn = false
    private var recordOn = false

    private var link: CADisplayLink?
    private var linkTarget: LinkTarget?
    private var wakeObserver: CFRunLoopObserver?
    private var sleepObserver: CFRunLoopObserver?

    /// Main-thread time since the last refresh (seconds), and when the
    /// current wake-up began.
    private var pending: CFTimeInterval = 0
    private var wakeAt: CFTimeInterval = 0
    private var awake = false
    private var lastTick: CFTimeInterval = 0
    private var period: CFTimeInterval = 1.0 / 60.0

    /// The last 120 frames' cost (ms) and when they were shown, for the panel.
    private var ring: [(at: CFTimeInterval, cost: Double, gap: Double)] = []
    /// This second, for the recorder.
    private var costs: [Double] = []
    private var gaps: [Double] = []
    private var missed = 0
    /// Refreshes this second, and those with no work (idle).
    private var refreshes = 0
    private var idleRefreshes = 0
    /// This second's red frames: (when, cost ms, gap ms).
    private var spikes: [(at: Date, cost: Double, gap: Double)] = []

    private var route = ""
    private var step = ""
    private var js: [String: Any] = [:]
    private var jsLong: [[Any]] = []
    /// The panel's JS row: the last second's readings.
    private var jsLagMax: Double = 0
    private var jsWorst: (ms: Double, label: String) = (0, "")

    private var hud: HudWindow?
    private var hudTimer: Timer?
    private var secondTimer: Timer?
    private var toggles: [ObjectIdentifier: UITapGestureRecognizer] = [:]

    private let writer = PerfWriter()

    private override init() {}

    // MARK: Host

    func attach(hostView: NshAppView) {
        self.hostView = hostView
    }

    /// The two-finger triple tap on `window` (each app window once). It
    /// never delays or cancels a touch: the app's own taps, swipes and the
    /// player's double-tap seek see every touch as before.
    func watchGesture(in window: UIWindow?) {
        guard let window, !(window is HudWindow), toggles[ObjectIdentifier(window)] == nil else { return }
        let tap = UITapGestureRecognizer(target: self, action: #selector(toggleGesture))
        tap.numberOfTouchesRequired = 2
        tap.numberOfTapsRequired = 3
        tap.cancelsTouchesInView = false
        tap.delaysTouchesBegan = false
        tap.delaysTouchesEnded = false
        tap.delegate = self
        window.addGestureRecognizer(tap)
        toggles[ObjectIdentifier(window)] = tap
    }

    nonisolated func gestureRecognizer(
        _ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool { true }

    @objc private func toggleGesture() {
        hostView?.send("perf.toggle", nil)
    }

    // MARK: Host handlers

    func set(_ data: Any?) -> Any? {
        let d = data as? [String: Any] ?? [:]
        let hud = d["hud"] as? Bool ?? false
        let record = d["record"] as? Bool ?? false
        let wasMeasuring = hudOn || recordOn
        hudOn = hud
        recordOn = record
        let measuring = hudOn || recordOn
        if measuring && !wasMeasuring { startMeasuring() }
        if !measuring && wasMeasuring { stopMeasuring() }
        if hudOn { showHud() } else { hideHud() }
        if measuring {
            if secondTimer == nil {
                costs.removeAll()
                gaps.removeAll()
                missed = 0
                let t = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated { self?.closeSecond() }
                }
                RunLoop.main.add(t, forMode: .common)
                secondTimer = t
            }
        } else {
            secondTimer?.invalidate()
            secondTimer = nil
        }
        return ["ok": true, "hud": hudOn, "record": recordOn, "file": writer.path]
    }

    func jsReport(_ data: Any?) {
        guard let d = data as? [String: Any] else { return }
        if let r = d["route"] as? String { route = r }
        if let s = d["step"] as? String { step = s }
        let lag = (d["lagMax"] as? NSNumber)?.doubleValue ?? 0
        jsLagMax = lag
        var worst: (Double, String) = (0, "")
        if let long = d["long"] as? [[Any]] {
            for item in long {
                guard item.count >= 2, let ms = (item[0] as? NSNumber)?.doubleValue else { continue }
                let label = item[1] as? String ?? ""
                if ms > worst.0 { worst = (ms, label) }
                if jsLong.count < 60 { jsLong.append([ms, label]) }
            }
        }
        jsWorst = worst
        js["lagMax"] = max((js["lagMax"] as? Double) ?? 0, lag)
        js["lagSum"] = ((js["lagSum"] as? Double) ?? 0) + ((d["lagSum"] as? NSNumber)?.doubleValue ?? 0)
        js["lagBase"] = (d["lagBase"] as? NSNumber)?.doubleValue ?? 0
    }

    func routeChanged(_ data: Any?) {
        if let r = (data as? [String: Any])?["route"] as? String { route = r }
        if let s = (data as? [String: Any])?["step"] as? String { step = s }
    }

    /// Rotates the files to timestamped names; with `share`, offers them
    /// in the share sheet.
    func save(_ data: Any?) async -> Any? {
        let share = (data as? [String: Any])?["share"] as? Bool ?? false
        let files = await writer.rotate()
        if share, !files.isEmpty {
            presentShare(files)
        }
        return ["ok": true, "dir": writer.dir.path, "files": files.map(\.path)]
    }

    private func presentShare(_ files: [URL]) {
        guard var top = hostView?.window?.rootViewController else { return }
        while let next = top.presentedViewController { top = next }
        let sheet = UIActivityViewController(activityItems: files, applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = top.view
        sheet.popoverPresentationController?.sourceRect = CGRect(
            x: top.view.bounds.midX, y: top.view.bounds.midY, width: 1, height: 1)
        top.present(sheet, animated: true)
    }

    /// Self-test: the main thread busy for exactly `ms` (the next refresh
    /// carries it as one frame).
    func block(_ data: Any?) -> Any? {
        let ms = min(2000, ((data as? [String: Any])?["ms"] as? NSNumber)?.doubleValue ?? 0)
        selftestBlock(ms)
        return ["ok": true]
    }

    @inline(never)
    private func selftestBlock(_ ms: Double) {
        let until = CACurrentMediaTime() + ms / 1000
        var x: UInt64 = 0
        while CACurrentMediaTime() < until { x = x &* 6364136223846793005 &+ 1 }
        if x == 42 { NSLog("") }
    }

    // MARK: Measuring

    private func startMeasuring() {
        let now = CACurrentMediaTime()
        pending = 0
        wakeAt = now
        awake = true
        lastTick = 0
        ring.removeAll()
        let runLoop = CFRunLoopGetMain()
        // First on every wake-up.
        let wake = CFRunLoopObserverCreateWithHandler(
            kCFAllocatorDefault, CFRunLoopActivity.afterWaiting.rawValue, true, Int.min
        ) { [weak self] _, _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                // (The display link closes a frame every refresh, so work
                // never waits longer than one refresh for its frame.)
                self.wakeAt = CACurrentMediaTime()
                self.awake = true
            }
        }
        // Last before sleeping: after Core Animation's commit (order 2000000).
        let sleep = CFRunLoopObserverCreateWithHandler(
            kCFAllocatorDefault, CFRunLoopActivity.beforeWaiting.rawValue, true, Int.max
        ) { [weak self] _, _ in
            MainActor.assumeIsolated {
                guard let self, self.awake else { return }
                self.pending += CACurrentMediaTime() - self.wakeAt
                self.awake = false
            }
        }
        CFRunLoopAddObserver(runLoop, wake, .commonModes)
        CFRunLoopAddObserver(runLoop, sleep, .commonModes)
        wakeObserver = wake
        sleepObserver = sleep

        let target = LinkTarget { [weak self] link in self?.tick(link) }
        // The link's default rate (the screen's, as the system paces it):
        // pinning it to the maximum would hold a ProMotion screen at 120 Hz
        // and change the pacing being measured. The rate it runs at is
        // recorded (`hz`, from each tick's period).
        let link = CADisplayLink(target: target, selector: #selector(LinkTarget.fire(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
        self.linkTarget = target
    }

    private func stopMeasuring() {
        link?.invalidate()
        link = nil
        linkTarget = nil
        let runLoop = CFRunLoopGetMain()
        if let o = wakeObserver { CFRunLoopRemoveObserver(runLoop, o, .commonModes) }
        if let o = sleepObserver { CFRunLoopRemoveObserver(runLoop, o, .commonModes) }
        wakeObserver = nil
        sleepObserver = nil
        ring.removeAll()
        spikes.removeAll()
    }

    private func tick(_ link: CADisplayLink) {
        let now = CACurrentMediaTime()
        let p = link.targetTimestamp - link.timestamp
        if p > 0.002 && p < 0.1 { period = p }
        // The work since the last refresh, this wake-up's so far included
        // (its rest counts toward the next one).
        var cost = pending
        if awake {
            cost += now - wakeAt
            wakeAt = now
        }
        pending = 0
        let ts = link.timestamp
        let gap = lastTick > 0 ? ts - lastTick : period
        lastTick = ts
        // Pauses (backgrounded, the link stopped) are not late refreshes.
        let lateBy = gap < 0.25 ? gap : period
        if lateBy > period * 1.5 {
            missed += Int((lateBy / period).rounded()) - 1
        }
        let costMs = cost * 1000
        refreshes += 1
        // Our own tick is ~0.05 ms: a refresh under 0.25 ms changed nothing.
        // (Core Animation's commit for refresh N runs after its tick, so it
        // is counted in refresh N+1: a one-refresh shift.)
        guard costMs >= 0.25 else {
            idleRefreshes += 1
            return
        }
        let gapMs = lateBy * 1000
        if ring.count >= 120 { ring.removeFirst() }
        ring.append((now, costMs, gapMs))
        costs.append(costMs)
        gaps.append(gapMs)
        if costMs > period * 1000, spikes.count < 200 {
            spikes.append((Date(), costMs, gapMs))
        }
    }

    // MARK: The recorder

    private func closeSecond() {
        let budget = period * 1000
        var sorted = costs.sorted()
        let n = sorted.count
        let avg = n > 0 ? sorted.reduce(0, +) / Double(n) : 0
        let p95 = n > 0 ? sorted[min(n - 1, Int((Double(n) * 0.95).rounded(.up)) - 1)] : 0
        let mx = sorted.last ?? 0
        let over8 = sorted.filter { $0 > 8.333 }.count
        let over16 = sorted.filter { $0 > 16.667 }.count
        let overBudget = sorted.filter { $0 > budget }.count
        var g = gaps.sorted()
        let gp95 = g.isEmpty ? 0 : g[min(g.count - 1, Int((Double(g.count) * 0.95).rounded(.up)) - 1)]
        let gmax = g.last ?? 0
        g.removeAll()
        sorted.removeAll()
        var js = self.js
        js["long"] = jsLong
        let line: [String: Any] = [
            "t": Int(Date().timeIntervalSince1970 * 1000),
            "platform": "ios",
            "route": route,
            "step": step,
            "hz": Int((1 / period).rounded()),
            "frames": n,
            "avg": round2(avg),
            "p95": round2(p95),
            "max": round2(mx),
            "over8": over8,
            "over16": over16,
            "drop": round2(n > 0 ? Double(overBudget) / Double(n) : 0),
            "gapP95": round2(gp95),
            "gapMax": round2(gmax),
            "missed": missed,
            "refreshes": refreshes,
            "idleShare": round2(refreshes > 0 ? Double(idleRefreshes) / Double(refreshes) : 0),
            "thermal": ["nominal", "fair", "serious", "critical"][min(3, ProcessInfo.processInfo.thermalState.rawValue)],
            "spikes": spikes.count,
            "js": js,
        ]
        for s in spikes {
            writer.spike([
                "t": Int(s.at.timeIntervalSince1970 * 1000),
                "platform": "ios",
                "route": route,
                "step": step,
                "hz": Int((1 / period).rounded()),
                "budget": round2(budget),
                "cost": round2(s.cost),
                "gap": round2(s.gap),
                "reason": "main thread \(String(format: "%.1f", s.cost)) ms (no split on iOS: see stacks via sample/Instruments)",
                "js": jsLong,
            ])
        }
        spikes.removeAll()
        costs.removeAll()
        gaps.removeAll()
        missed = 0
        refreshes = 0
        idleRefreshes = 0
        self.js = [:]
        jsLong.removeAll()
        writer.write(line)
    }

    /// Two decimals, written as such (a Double would print 17 digits).
    private func round2(_ v: Double) -> NSDecimalNumber {
        NSDecimalNumber(string: String(format: "%.2f", v.isFinite ? v : 0))
    }

    // MARK: The panel

    private func showHud() {
        if hud == nil {
            guard let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive }) ??
                UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
            else { return }
            let w = HudWindow(windowScene: scene)
            w.panel.onTap = { [weak self] in self?.refreshHud() }
            w.panel.onLongPress = { [weak self] in self?.hostView?.send("perf.saveRequest", nil) }
            w.isHidden = false
            hud = w
        }
        if hudTimer == nil {
            let t = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.refreshHud() }
            }
            RunLoop.main.add(t, forMode: .common)
            hudTimer = t
        }
        refreshHud()
    }

    private func hideHud() {
        hudTimer?.invalidate()
        hudTimer = nil
        hud?.isHidden = true
        hud = nil
    }

    private func refreshHud() {
        guard let hud else { return }
        let now = CACurrentMediaTime()
        let budget = period * 1000
        let recent = ring.filter { now - $0.at <= 1.0 }
        let fps = recent.count
        let costs = ring.map(\.cost)
        let mean = costs.isEmpty ? 0 : costs.reduce(0, +) / Double(costs.count)
        let sorted = costs.sorted()
        let p95 = sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
        let drop = costs.isEmpty ? 0 : Double(costs.filter { $0 > budget }.count) / Double(costs.count)
        let worst = recent.map(\.cost).max() ?? 0
        let gaps = ring.map(\.gap).sorted()
        let gapP95 = gaps.isEmpty ? 0 : gaps[min(gaps.count - 1, Int(Double(gaps.count) * 0.95))]
        let hz = Int((1 / period).rounded())
        let maxFps = mean > 0 ? min(Double(hz), 1000 / mean) : 0
        if hud.panel.collapsed {
            hud.panel.update(lines: [String(format: "%d fps · worst %.1f ms", fps, worst)], bars: [], budget: budget)
            return
        }
        var lines = [
            String(format: "FPS  %3d  max %3.0f  %d Hz", fps, maxFps, hz),
            String(format: "MAIN %5.2f p95 %5.2f ms drop %2.0f%%", mean, p95, drop * 100),
            String(format: "1s   worst %5.2f  gap p95 %5.2f", worst, gapP95),
            String(format: "JS   lag %5.1f ms", jsLagMax),
        ]
        if jsWorst.ms > 0 {
            lines.append(String(format: "     %5.1f %@", jsWorst.ms, String(jsWorst.label.prefix(26))))
        }
        hud.panel.update(lines: lines, bars: costs, budget: budget)
    }
}

/// The display link's target (CADisplayLink retains it, not the monitor).
private final class LinkTarget: NSObject {
    let onFire: (CADisplayLink) -> Void
    init(_ onFire: @escaping (CADisplayLink) -> Void) { self.onFire = onFire }
    @objc func fire(_ link: CADisplayLink) { onFire(link) }
}

/// A window over everything (the player's full-screen dialog too) that
/// takes only the touches on the panel: all others go to the windows below.
final class HudWindow: UIWindow {
    let panel = HudPanel()

    override init(windowScene: UIWindowScene) {
        super.init(windowScene: windowScene)
        windowLevel = .alert + 1
        backgroundColor = .clear
        let vc = UIViewController()
        vc.view.backgroundColor = .clear
        rootViewController = vc
        vc.view.addSubview(panel)
        panel.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            panel.topAnchor.constraint(equalTo: vc.view.safeAreaLayoutGuide.topAnchor, constant: 4),
            panel.trailingAnchor.constraint(equalTo: vc.view.safeAreaLayoutGuide.trailingAnchor, constant: -8),
            panel.widthAnchor.constraint(equalToConstant: 216),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let p = convert(point, to: panel)
        return panel.bounds.contains(p) ? panel : nil
    }
}

/// The readings over the last 120 frames' bars. Opaque-ish fill, plain
/// corner radius (no masks, shadows or blur: nothing offscreen). A tap
/// folds it to one line; a long press saves the recording.
final class HudPanel: UIView {
    private let label = UILabel()
    private let graph = HudGraph()
    private var graphHeight: NSLayoutConstraint!
    private(set) var collapsed = false
    var onTap: (() -> Void)?
    var onLongPress: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(white: 0, alpha: 0.72)
        layer.cornerRadius = 8
        label.numberOfLines = 0
        label.font = .monospacedSystemFont(ofSize: 10, weight: .medium)
        label.textColor = UIColor(red: 0.85, green: 1, blue: 0.85, alpha: 1)
        label.translatesAutoresizingMaskIntoConstraints = false
        graph.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        addSubview(graph)
        graphHeight = graph.heightAnchor.constraint(equalToConstant: 30)
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            graph.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 4),
            graph.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            graph.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            graphHeight,
            graph.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
        ])
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(pressed(_:))))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    @objc private func tapped() {
        collapsed.toggle()
        graph.isHidden = collapsed
        graphHeight.constant = collapsed ? 0 : 30
        onTap?()
    }

    @objc private func pressed(_ g: UILongPressGestureRecognizer) {
        if g.state == .began { onLongPress?() }
    }

    func update(lines: [String], bars: [Double], budget: Double) {
        label.text = lines.joined(separator: "\n")
        guard !collapsed else { return }
        graph.bars = bars
        graph.budget = budget
        graph.setNeedsDisplay()
    }
}

final class HudGraph: UIView {
    var bars: [Double] = []
    var budget: Double = 16.7

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
        isUserInteractionEnabled = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ rect: CGRect) {
        guard let cx = UIGraphicsGetCurrentContext() else { return }
        let h = bounds.height
        let w = bounds.width / 120
        // Full height is two refreshes; the line is one.
        let scale = h / CGFloat(budget * 2)
        let start = 120 - bars.count
        for (i, cost) in bars.enumerated() {
            let bh = min(h, max(1, CGFloat(cost) * scale))
            let color: UIColor =
                cost > budget ? .systemRed : cost > budget / 2 ? .systemOrange : .systemGreen
            cx.setFillColor(color.cgColor)
            cx.fill(CGRect(x: CGFloat(start + i) * w, y: h - bh, width: max(1, w - 0.5), height: bh))
        }
        cx.setFillColor(UIColor(white: 1, alpha: 0.5).cgColor)
        cx.fill(CGRect(x: 0, y: h - CGFloat(budget) * scale, width: bounds.width, height: 0.5))
    }
}

/// Appends the recorder's lines to `perf.jsonl` / `perf-spikes.jsonl` on a
/// queue of its own.
private final class PerfWriter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "rustflix.perf.writer", qos: .utility)
    let dir: URL
    private let url: URL
    private let spikesURL: URL
    private static let rollBytes: UInt64 = 2 * 1024 * 1024

    var path: String { url.path }

    init() {
        dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        url = dir.appendingPathComponent("perf.jsonl")
        spikesURL = dir.appendingPathComponent("perf-spikes.jsonl")
    }

    func write(_ line: [String: Any]) { append(line, to: url, rolled: "perf.1.jsonl") }

    func spike(_ line: [String: Any]) { append(line, to: spikesURL, rolled: "perf-spikes.1.jsonl") }

    private func append(_ line: [String: Any], to url: URL, rolled: String) {
        guard JSONSerialization.isValidJSONObject(line),
              var data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys])
        else { return }
        data.append(0x0A)
        queue.async {
            let fm = FileManager.default
            try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? UInt64,
               size > PerfWriter.rollBytes {
                let old = url.deletingLastPathComponent().appendingPathComponent(rolled)
                try? fm.removeItem(at: old)
                try? fm.moveItem(at: url, to: old)
            }
            if let handle = try? FileHandle(forWritingTo: url) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            } else {
                try? data.write(to: url)
            }
        }
    }

    /// Renames both files to `perf-<unix seconds>.jsonl` names.
    func rotate() async -> [URL] {
        await withCheckedContinuation { done in
            queue.async {
                let stamp = Int(Date().timeIntervalSince1970)
                var out: [URL] = []
                for (from, name) in [(self.url, "perf-\(stamp).jsonl"), (self.spikesURL, "perf-spikes-\(stamp).jsonl")] {
                    let to = self.dir.appendingPathComponent(name)
                    if FileManager.default.fileExists(atPath: from.path),
                       (try? FileManager.default.moveItem(at: from, to: to)) != nil {
                        out.append(to)
                    }
                }
                done.resume(returning: out)
            }
        }
    }
}
