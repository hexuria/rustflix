import AVFoundation
import AVKit
import Foundation
import NativeShell
import Network
import UIKit
import WebKit

// Offline downloads for rustflix on iOS — the same role vid-dl plays on
// desktop, but in-process (iOS cannot spawn helpers):
//
//  - every transfer runs on a *background* URLSession (one per Wi-Fi-only
//    setting, stable identifiers), so downloads continue while the app is
//    suspended or the phone is locked, and the system relaunches the app
//    to hand over finished work (`handleEventsForBackgroundURLSession`);
//  - progressive files (mp4/webm/…) are one download task, resumed with
//    resume data after interruptions;
//  - HLS (.m3u8) is planned in the foreground (HlsDownloader.swift: the
//    playlist tree is read once and persisted as `<dir>/.manifest.json`),
//    then every segment/key/init map is its own background download task.
//    Files on disk are the truth, so a relaunch only fetches what is
//    missing. AVAssetDownloadURLSession is not used: it cannot attach the
//    Referer/UA/cookie headers these CDNs require (no public API) and its
//    .movpkg output only plays in AVKit, not the app's own web player.
//
// Finished downloads play through the localhost media server below and
// the regular NSH player UI — no network needed.
//
// The NSH app reaches this through `nsh/host` (`host.call("dl.*")`),
// progress arrives as `dl.event` host events. Records persist as JSON so
// the Downloads screen survives relaunches.

enum DlPaths {
    static var support: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
    }
    static var root: URL { support.appendingPathComponent("rustflix-dl", isDirectory: true) }
    static func dir(_ id: Int) -> URL { root.appendingPathComponent("\(id)", isDirectory: true) }
    static func manifest(_ id: Int) -> URL { dir(id).appendingPathComponent(".manifest.json") }
    static func resume(_ id: Int) -> URL { dir(id).appendingPathComponent(".resume") }
    static func incoming(_ id: Int, gen: Int) -> URL { dir(id).appendingPathComponent(".incoming-\(gen)") }
    static let playerPage = ".rustflix-player.html"

    /// Background writes must work while the phone is locked (after the
    /// first unlock since boot).
    static func protect(_ url: URL) {
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
    }

    static func size(_ url: URL) -> Int64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value ?? 0
    }

    static func treeSize(_ url: URL) -> Int64 {
        guard let e = FileManager.default.enumerator(
            at: url, includingPropertiesForKeys: [.totalFileAllocatedSizeKey, .fileSizeKey])
        else { return 0 }
        var total: Int64 = 0
        for case let f as URL in e {
            let v = try? f.resourceValues(forKeys: [.totalFileAllocatedSizeKey, .fileSizeKey])
            total += Int64(v?.totalFileAllocatedSize ?? v?.fileSize ?? 0)
        }
        return total
    }

    static func freeBytes() -> Int64 {
        let v = try? support.resourceValues(forKeys: [
            .volumeAvailableCapacityForImportantUsageKey, .volumeAvailableCapacityKey,
        ])
        if let i = v?.volumeAvailableCapacityForImportantUsage { return i }
        return Int64(v?.volumeAvailableCapacity ?? 0)
    }
}

struct DlRecord: Codable {
    var id: Int
    var name: String
    var status: String // running | done | error
    var progress: Double?
    var message: String
    var kind: String // "file" | "hls"
    var url: String
    /// Request headers; kept only while the record is not done.
    var headers: [String: String]?
    var fileName: String?
    var localURL: String?
    var key: String?
    var type: String?
    var mediaId: Int?
    var season: Int?
    var episode: Int?
    var title: String?
    var createdAt: TimeInterval
    // Added with the background engine (all optional so old records decode).
    /// Why a record is `error`: expired | failed | cancelled | space | drm | network.
    var reason: String?
    /// Bumped on every (re)start; tasks tagged with an older gen are stale.
    var gen: Int?
    var bytes: Int64?
    var totalBytes: Int64?
    var segDone: Int?
    var segTotal: Int?
    /// "wifi" | "network" while transfers wait for connectivity.
    var waiting: String?

    func json() -> [String: Any] {
        var d: [String: Any] = [
            "id": id, "name": name, "status": status,
            "progress": progress ?? NSNull(), "message": message,
            "kind": kind, "key": key ?? NSNull(), "type": type ?? NSNull(),
            "mediaId": mediaId ?? NSNull(), "season": season ?? NSNull(),
            "episode": episode ?? NSNull(), "title": title ?? NSNull(),
            "createdAt": createdAt * 1000,
            "reason": reason ?? NSNull(),
            "bytes": bytes.map { Int($0) as Any } ?? NSNull(),
            "totalBytes": totalBytes.map { Int($0) as Any } ?? NSNull(),
            "done": segDone ?? NSNull(), "total": segTotal ?? NSNull(),
            "waiting": waiting ?? NSNull(),
        ]
        if let fileName { d["file"] = fileName }
        return d
    }
}

// MARK: - Local media server (progressive files)

/// Tiny HTTP/1.1 server on 127.0.0.1 serving the download root with Range
/// support — the NSH webview capability only grants http(s) hosts, so
/// file:// playback is refused; this is the same trick the desktop build
/// uses with its python helper.
final class LocalMediaServer: @unchecked Sendable {
    static let shared = LocalMediaServer()

    private let queue = DispatchQueue(label: "rustflix.media-server")
    private var listener: NWListener?
    private(set) var port: UInt16 = 0
    var root: URL { DlPaths.root }

    private init() {
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    /// Starts listening if needed and returns once the port is known.
    func ensureRunning() async -> UInt16 {
        let started: UInt16 = await withCheckedContinuation { cont in
            queue.async {
                if self.listener == nil {
                    let params = NWParameters.tcp
                    params.requiredInterfaceType = .loopback
                    guard let l = try? NWListener(using: params, on: .any) else {
                        return cont.resume(returning: 0)
                    }
                    l.stateUpdateHandler = { state in
                        if case .ready = state { self.port = l.port?.rawValue ?? 0 }
                    }
                    l.newConnectionHandler = { [weak self] conn in self?.serve(conn) }
                    l.start(queue: self.queue)
                    self.listener = l
                }
                cont.resume(returning: 1)
            }
        }
        guard started > 0 else { return 0 }
        // The port arrives via the state handler on `queue`; poll from
        // here (never block `queue` itself or the handler can't run).
        for _ in 0..<100 where port == 0 {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return port
    }

    private func serve(_ conn: NWConnection) {
        conn.start(queue: queue)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, _ in
            guard let self, let data, let head = String(data: data, encoding: .utf8) else {
                conn.cancel(); return
            }
            self.respond(conn, head: head)
        }
    }

    private func respond(_ conn: NWConnection, head: String) {
        let requestLine = head.components(separatedBy: "\r\n").first ?? ""
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2, parts[0] == "GET" else {
            send(conn, status: "405 Method Not Allowed", body: Data("method".utf8))
            return
        }
        // Strip the query (player pages carry ?f=…) before splitting.
        let rawPath = (String(parts[1]).removingPercentEncoding ?? "")
            .split(separator: "?").first.map(String.init) ?? ""
        // Only /<id>/<file> under the download root; reject traversal.
        let comps = rawPath.split(separator: "/").map(String.init)
        guard comps.count == 2,
              !comps[0].isEmpty, comps[0].allSatisfy(\.isNumber),
              !comps[1].isEmpty, !comps[1].contains(".."),
              // Internal files (manifest with signed URLs, resume data,
              // partial downloads) are never served; the player page is.
              !comps[1].hasPrefix(".") || comps[1] == DlPaths.playerPage
        else {
            send(conn, status: "404 Not Found", body: Data("not found".utf8))
            return
        }
        let fileURL = root.appendingPathComponent(comps[0]).appendingPathComponent(comps[1])
        guard FileManager.default.fileExists(atPath: fileURL.path),
              let fh = try? FileHandle(forReadingFrom: fileURL)
        else {
            send(conn, status: "404 Not Found", body: Data("not found".utf8))
            return
        }
        let attrs = (try? FileManager.default.attributesOfItem(atPath: fileURL.path)) ?? [:]
        let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0

        var status = "200 OK"
        var length = size
        var contentRange = ""
        // Single-range "bytes=a-b" / "bytes=a-" / "bytes=-n".
        if let line = head.components(separatedBy: "\r\n").first(where: {
            $0.lowercased().hasPrefix("range:")
        }), let eq = line.range(of: "bytes=") {
            let spec = String(line[eq.upperBound...])
                .trimmingCharacters(in: .whitespaces)
            let ab = spec.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
            if ab.count == 2 {
                var a: Int64 = 0, b = size - 1
                if !ab[0].isEmpty { a = Int64(ab[0]) ?? 0 }
                else if !ab[1].isEmpty { a = max(0, size - (Int64(ab[1]) ?? 0)) }
                if !ab[1].isEmpty, !ab[0].isEmpty {
                    b = min(Int64(ab[1]) ?? (size - 1), size - 1)
                }
                if size > 0 && a < size && a <= b {
                    status = "206 Partial Content"
                    length = b - a + 1
                    contentRange = "bytes \(a)-\(b)/\(size)"
                    try? fh.seek(toOffset: UInt64(a))
                }
            }
        }

        var headOut = "HTTP/1.1 \(status)\r\n"
            + "Content-Type: \(mimeType(comps[1]))\r\n"
            + "Accept-Ranges: bytes\r\n"
            + "Content-Length: \(length)\r\n"
            + "Connection: close\r\n"
        if !contentRange.isEmpty { headOut += "Content-Range: \(contentRange)\r\n" }
        headOut += "\r\n"
        conn.send(content: Data(headOut.utf8), completion: .contentProcessed { _ in
            self.stream(fh, conn: conn, remaining: length)
        })
    }

    private func stream(_ fh: FileHandle, conn: NWConnection, remaining: Int64) {
        guard remaining > 0 else { try? fh.close(); conn.cancel(); return }
        let chunk = min(65536, Int(remaining))
        guard let data = try? fh.read(upToCount: chunk), !data.isEmpty else {
            try? fh.close(); conn.cancel(); return
        }
        conn.send(content: data, completion: .contentProcessed { [weak self] _ in
            self?.stream(fh, conn: conn, remaining: remaining - Int64(data.count))
        })
    }

    private func send(_ conn: NWConnection, status: String, body: Data) {
        let head = "HTTP/1.1 \(status)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        conn.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in conn.cancel() })
    }

    private func mimeType(_ name: String) -> String {
        switch (name as NSString).pathExtension.lowercased() {
        case "mp4", "m4v": return "video/mp4"
        case "mkv": return "video/x-matroska"
        case "webm": return "video/webm"
        case "mov": return "video/quicktime"
        case "ts", "m2ts": return "video/mp2t"
        case "m4s": return "video/iso.segment"
        case "aac": return "audio/aac"
        case "m3u8": return "application/vnd.apple.mpegurl"
        case "html", "htm": return "text/html"
        default: return "application/octet-stream"
        }
    }
}

// MARK: - Download manager

/// Identifies a task across both background sessions (task identifiers
/// are only unique per session).
struct DlTaskKey: Hashable {
    let sid: String
    let tid: Int
    var str: String { "\(sid)#\(tid)" }
}

/// What the delegate did with a finished transfer before handing over to
/// the main actor (the temp file is gone once the callback returns).
enum DlOutcome {
    case saved(ext: String?, bytes: Int64)
    case http(Int)
    case badBody
    case gone
    case io(String)
}

@MainActor
final class DownloadManager: NSObject {
    static let shared = DownloadManager()

    static let minFreeToStart: Int64 = 500 * 1024 * 1024
    static let minFreeWhileRunning: Int64 = 200 * 1024 * 1024
    /// Live tasks across both sessions. Enough for a whole episode in one
    /// go, so a locked phone finishes it without waking the app.
    static let maxInflight = 1000
    static let sessionWifi = "com.hexuria.rustflix.dl.wifi"
    static let sessionAny = "com.hexuria.rustflix.dl.any"
    private static let wifiKey = "rustflix.dl.wifiOnly"
    private static let nextIdKey = "rustflix.dl.nextId"

    private struct Tracked {
        let rid: Int
        let res: Int? // HLS resource index; nil for a progressive file
        let task: URLSessionTask
    }

    private let storeURL = DlPaths.support.appendingPathComponent("rustflix-dl-records.json")
    private var records: [Int: DlRecord] = [:]
    private var nextId = 1
    private(set) var wifiOnly = true
    private var sessions: [String: URLSession] = [:]
    private let sessionDelegate = DlSessionDelegate()
    private var tracked: [DlTaskKey: Tracked] = [:]
    private var inflight: [Int: Set<Int>] = [:]
    private var manifests: [Int: HlsManifest] = [:]
    private var dirtyManifests: Set<Int> = []
    private var expiry: [Int: DlExpiryTracker] = [:]
    private var attempts: [Int: [Int: Int]] = [:]
    private var retryAt: [Int: [Int: Date]] = [:]
    private var outcomes: [DlTaskKey: DlOutcome] = [:]
    private var walks: [Int: UUID] = [:]
    private var waitingWalk: Set<Int> = []
    private var lastEmit: [Int: TimeInterval] = [:]
    private var emitScheduled: Set<Int> = []
    private var saveScheduled = false
    private var lastSpaceCheck: TimeInterval = 0
    private var bgCompletions: [String: () -> Void] = [:]
    private var eventsFinished: Set<String> = []
    private let pathMonitor = NWPathMonitor()
    private var netSatisfied = true
    private var netWifi = true
    private var reconciled = false
    /// After launch, transfers that finished while the app was not running
    /// are delivered by the delegate only after the session is recreated.
    /// New tasks wait until that burst is over (session reports it drained,
    /// or 3 s without delegate activity) so nothing is fetched twice.
    private var holding = true
    private var lastDelegateActivity: TimeInterval = Date().timeIntervalSince1970
    /// Loaders for in-flight native playback of remote assets; kept alive
    /// for the player's lifetime.
    private var playbackLoaders: [HLSResourceLoader] = []
    private weak var hostView: NshAppView?

    private var currentSession: URLSession? {
        sessions[wifiOnly ? Self.sessionWifi : Self.sessionAny]
    }
    private var transferAllowed: Bool { netSatisfied && (!wifiOnly || netWifi) }

    private override init() {
        super.init()
        let d = UserDefaults.standard
        wifiOnly = d.object(forKey: Self.wifiKey) as? Bool ?? true
        nextId = max(1, d.integer(forKey: Self.nextIdKey))
        prepareRoot()
        loadRecords()
        // Sessions must exist from launch so the system can deliver events
        // for transfers that finished while the app was not running.
        for (sid, cellular) in [(Self.sessionWifi, false), (Self.sessionAny, true)] {
            let c = URLSessionConfiguration.background(withIdentifier: sid)
            c.sessionSendsLaunchEvents = true
            c.isDiscretionary = false
            c.allowsCellularAccess = cellular
            c.httpMaximumConnectionsPerHost = 4
            c.timeoutIntervalForRequest = 60
            c.httpCookieStorage = .shared
            c.httpShouldSetCookies = true
            c.httpCookieAcceptPolicy = .always
            sessions[sid] = URLSession(configuration: c, delegate: sessionDelegate, delegateQueue: sessionDelegate.queue)
        }
        pathMonitor.pathUpdateHandler = { path in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { DownloadManager.shared.pathChanged(path) }
            }
        }
        pathMonitor.start(queue: DispatchQueue(label: "rustflix.dl.path"))
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { DownloadManager.shared.flushState() }
        }
        nc.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { DownloadManager.shared.flushState() }
        }
        reconcile()
    }

    func attach(hostView: NshAppView) {
        self.hostView = hostView
        Task { await syncWebViewCookies() }
    }

    /// Stream CDNs authorize requests with cookies the embed page picked up
    /// in WKWebView's own cookie store — URLSession only sees
    /// HTTPCookieStorage, so mirror the web view's cookies over before
    /// every download (they rotate while the app runs).
    private func syncWebViewCookies() async {
        HTTPCookieStorage.shared.cookieAcceptPolicy = .always
        let cookies: [HTTPCookie] = await withCheckedContinuation { cont in
            WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cont.resume(returning: $0) }
        }
        for c in cookies { HTTPCookieStorage.shared.setCookie(c) }
    }

    // MARK: persistence

    private func prepareRoot() {
        let fm = FileManager.default
        try? fm.createDirectory(at: DlPaths.root, withIntermediateDirectories: true, attributes: [
            .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication,
        ])
        DlPaths.protect(DlPaths.root)
        // Downloads are re-creatable: keep them out of iCloud backups.
        var rv = URLResourceValues()
        rv.isExcludedFromBackup = true
        var root = DlPaths.root
        try? root.setResourceValues(rv)
    }

    private func saveRecords() {
        let list = records.values.sorted { $0.createdAt < $1.createdAt }
        guard let data = try? JSONEncoder().encode(list) else { return }
        try? data.write(to: storeURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var rv = URLResourceValues()
        rv.isExcludedFromBackup = true
        var u = storeURL
        try? u.setResourceValues(rv)
    }

    private func saveNextId() {
        UserDefaults.standard.set(nextId, forKey: Self.nextIdKey)
    }

    private func loadRecords() {
        guard let data = try? Data(contentsOf: storeURL),
              let list = try? JSONDecoder().decode([DlRecord].self, from: data)
        else { return }
        var changed = false
        for var r in list where r.id > 0 {
            if r.status == "done" && r.headers != nil { r.headers = nil; changed = true }
            records[r.id] = r
            nextId = max(nextId, r.id + 1)
        }
        saveNextId()
        if changed { saveRecords() }
    }

    private func writeManifest(_ rid: Int) {
        dirtyManifests.remove(rid)
        guard let m = manifests[rid], let data = try? JSONEncoder().encode(m) else { return }
        guard FileManager.default.fileExists(atPath: DlPaths.dir(rid).path) else { return }
        try? data.write(to: DlPaths.manifest(rid), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func readManifest(_ rid: Int) -> HlsManifest? {
        guard let data = try? Data(contentsOf: DlPaths.manifest(rid)),
              let m = try? JSONDecoder().decode(HlsManifest.self, from: data),
              !m.resources.isEmpty
        else { return nil }
        return m
    }

    private func dirNames(_ rid: Int) -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: DlPaths.dir(rid).path)) ?? []
    }

    func flushState() {
        for rid in dirtyManifests { writeManifest(rid) }
        saveRecords()
    }

    private func saveSoon() {
        guard !saveScheduled else { return }
        saveScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            MainActor.assumeIsolated {
                let m = DownloadManager.shared
                m.saveScheduled = false
                m.flushState()
            }
        }
    }

    // MARK: events

    private func emit(_ r: DlRecord) {
        lastEmit[r.id] = Date().timeIntervalSince1970
        hostView?.send("dl.event", r.json())
    }

    /// Status changes: persisted and emitted immediately.
    private func patch(_ id: Int, _ f: (inout DlRecord) -> Void) {
        guard var r = records[id] else { return }
        f(&r)
        records[id] = r
        saveRecords()
        emit(r)
    }

    /// Progress ticks: at most one event per second per record (with a
    /// trailing event so the last value always lands), saved lazily.
    private func patchProgress(_ id: Int, _ f: (inout DlRecord) -> Void) {
        guard var r = records[id] else { return }
        f(&r)
        records[id] = r
        saveSoon()
        let now = Date().timeIntervalSince1970
        let since = now - (lastEmit[id] ?? 0)
        if since >= 1 {
            emit(r)
        } else if !emitScheduled.contains(id) {
            emitScheduled.insert(id)
            DispatchQueue.main.asyncAfter(deadline: .now() + (1 - since)) {
                MainActor.assumeIsolated {
                    let m = DownloadManager.shared
                    m.emitScheduled.remove(id)
                    if let r = m.records[id] { m.emit(r) }
                }
            }
        }
        checkSpaceIfDue()
    }

    private func liveMessage(_ r: DlRecord) -> String {
        switch r.waiting {
        case "wifi": return "waiting for Wi-Fi"
        case "network": return "waiting for network"
        default: break
        }
        if r.kind == "hls", let t = r.segTotal, t > 0 { return "\(r.segDone ?? 0)/\(t)" }
        if let p = r.progress { return "\(Int(p))%" }
        return "downloading"
    }

    // MARK: handlers (called from RustflixApp via host.call)

    func list() -> [[String: Any]] {
        records.values.sorted { $0.createdAt > $1.createdAt }.map { $0.json() }
    }

    /// Reserves an id for a row the JS side creates itself (failed or
    /// queued rows) so it never collides with a native record.
    func reserveId() -> [String: Any] {
        let id = nextId
        nextId += 1
        saveNextId()
        return ["id": id]
    }

    func options(_ data: [String: Any]) -> [String: Any] {
        if let w = data["wifiOnly"] as? Bool, w != wifiOnly {
            wifiOnly = w
            UserDefaults.standard.set(w, forKey: Self.wifiKey)
            // Move running transfers onto the session with the new
            // cellular policy (resume data keeps file progress; saved
            // segments are kept).
            for r in records.values where r.status == "running" {
                if r.kind == "hls" {
                    cancelTasks(r.id, resume: false)
                    pump(r.id)
                } else if hasTracked(r.id) {
                    cancelTasks(r.id, resume: true)
                    scheduleFileRestart(r.id, after: 1)
                }
            }
            updateWaiting()
            startWaitingWalks()
        }
        return ["wifiOnly": wifiOnly]
    }

    func space() async -> [String: Any] {
        let used: Int64 = await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                cont.resume(returning: DlPaths.treeSize(DlPaths.root))
            }
        }
        return ["used": Int(used), "free": Int(DlPaths.freeBytes()), "minFree": Int(Self.minFreeToStart)]
    }

    private func spaceError() -> [String: Any]? {
        let free = DlPaths.freeBytes()
        guard free < Self.minFreeToStart else { return nil }
        let mb = max(0, free / (1024 * 1024))
        return ["ok": false, "reason": "space", "free": Int(free),
                "error": "Not enough free space (\(mb) MB left, 500 MB needed). Remove some downloads or free up storage."]
    }

    private static func parseHeaders(_ v: Any?) -> [String: String]? {
        guard let h = v as? [String: Any] else { return nil }
        let reserved: Set<String> = ["range", "host", "content-length", "connection", "accept-encoding", "transfer-encoding"]
        var out: [String: String] = [:]
        for (k, raw) in h {
            let val: String
            if let s = raw as? String { val = s } else if let n = raw as? NSNumber { val = n.stringValue } else { continue }
            guard !k.isEmpty, k.count < 256, val.count < 8192,
                  !k.contains(where: { $0 == "\r" || $0 == "\n" || $0 == ":" || $0 == " " }),
                  !val.contains(where: { $0 == "\r" || $0 == "\n" }),
                  !reserved.contains(k.lowercased())
            else { continue }
            out[k] = val
        }
        return out
    }

    func start(_ data: [String: Any]) async -> [String: Any] {
        let reqId = DlNames.id(data["id"])
        var newURL: String?
        if let s = (data["url"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
            guard let u = URL(string: s), let scheme = u.scheme?.lowercased(),
                  scheme == "http" || scheme == "https", u.host != nil
            else { return ["ok": false, "error": "bad url", "reason": "failed"] }
            newURL = s
        }
        let headers = Self.parseHeaders(data["headers"])
        let meta = data["meta"] as? [String: Any] ?? [:]
        let name = (data["name"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(200)) }
        let kindArg = (data["kind"] as? String).flatMap { $0 == "hls" || $0 == "file" ? $0 : nil }

        if let reqId, let existing = records[reqId] {
            return await resume(existing, url: newURL, headers: headers, kind: kindArg, name: name, meta: meta)
        }
        guard let urlStr = newURL else { return ["ok": false, "error": "bad url", "reason": "failed"] }
        if let err = spaceError() { return err }
        await syncWebViewCookies()
        let id: Int
        if let reqId, records[reqId] == nil {
            id = reqId
            nextId = max(nextId, reqId + 1)
        } else {
            id = nextId
            nextId += 1
        }
        saveNextId()
        let dir = DlPaths.dir(id)
        try? FileManager.default.removeItem(at: dir) // stale leftovers without a record
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        DlPaths.protect(dir)
        let kind = kindArg ?? (urlStr.lowercased().contains(".m3u8") ? "hls" : "file")
        var r = DlRecord(
            id: id, name: name ?? "video", status: "running", progress: nil,
            message: "starting…", kind: kind, url: urlStr, headers: headers ?? [:],
            fileName: nil, localURL: nil,
            key: meta["key"] as? String, type: meta["type"] as? String,
            mediaId: DlNames.id(meta["mediaId"]), season: DlNames.id(meta["season"]),
            episode: DlNames.id(meta["episode"]), title: meta["title"] as? String,
            createdAt: Date().timeIntervalSince1970)
        r.gen = 0
        records[id] = r
        saveRecords()
        emit(r)
        if kind == "hls" { beginWalk(id) } else { startFile(id, resume: false) }
        updateWaiting()
        return ["ok": true, "id": id]
    }

    /// `dl.start` with an existing id: continue that record from disk,
    /// optionally with a fresh (re-signed) URL and headers.
    private func resume(_ r0: DlRecord, url: String?, headers: [String: String]?, kind: String?,
                        name: String?, meta: [String: Any]) async -> [String: Any] {
        let id = r0.id
        if r0.status == "done" { return ["ok": true, "id": id, "status": "done"] }
        let urlChanged = url != nil && url != r0.url
        let busy = hasTracked(id) || walks[id] != nil || waitingWalk.contains(id)
        let headersChanged = headers != nil && headers != r0.headers
        if r0.status == "running" && (busy || holding) && !urlChanged && !headersChanged {
            return ["ok": true, "id": id, "resumed": false]
        }
        if let err = spaceError() { return err }
        await syncWebViewCookies()
        guard let cur = records[id] else { return ["ok": false, "error": "removed", "reason": "failed"] }
        let newKind = urlChanged ? (kind ?? ((url ?? "").lowercased().contains(".m3u8") ? "hls" : "file")) : cur.kind
        cancelTasks(id, resume: cur.kind == "file" && !urlChanged)
        walks[id] = nil
        waitingWalk.remove(id)
        if dirtyManifests.contains(id) { writeManifest(id) }
        manifests[id] = nil
        clearRetryState(id)
        let dir = DlPaths.dir(id)
        if newKind != cur.kind {
            try? FileManager.default.removeItem(at: dir)
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        DlPaths.protect(dir)
        patch(id) { r in
            r.status = "running"; r.reason = nil; r.message = "resuming…"; r.waiting = nil
            if urlChanged, let url { r.url = url }
            r.kind = newKind
            if let headers { r.headers = headers } else if r.headers == nil { r.headers = [:] }
            if let name { r.name = name }
            if let k = meta["key"] as? String { r.key = k }
            r.gen = (r.gen ?? 0) + 1
        }
        if newKind == "hls" {
            if urlChanged || !FileManager.default.fileExists(atPath: DlPaths.manifest(id).path) {
                beginWalk(id)
            } else if loadHlsState(id) {
                hlsProgress(id)
                pump(id)
            } else {
                beginWalk(id)
            }
        } else {
            if urlChanged { try? FileManager.default.removeItem(at: DlPaths.resume(id)) }
            // Resume data from the cancel above is written asynchronously.
            scheduleFileRestart(id, after: urlChanged ? 0 : 1)
        }
        updateWaiting()
        return ["ok": true, "id": id, "resumed": true]
    }

    func cancel(_ data: [String: Any]) {
        guard let id = DlNames.id(data["id"]), let r = records[id], r.status != "done" else { return }
        stop(id, keepResume: r.kind == "file")
        patch(id) { r in r.status = "error"; r.message = "cancelled"; r.reason = "cancelled"; r.waiting = nil }
        pumpAll()
    }

    func remove(_ data: [String: Any]) {
        guard let id = DlNames.id(data["id"]), let r = records[id] else { return }
        stop(id, keepResume: false)
        dirtyManifests.remove(id)
        try? FileManager.default.removeItem(at: DlPaths.dir(id))
        if let local = r.localURL { try? FileManager.default.removeItem(atPath: local) }
        records.removeValue(forKey: id)
        lastEmit[id] = nil
        saveRecords()
        pumpAll()
    }

    func playUrl(_ data: [String: Any]) async -> [String: Any] {
        guard let id = DlNames.id(data["id"]), let r = records[id], r.status == "done" else {
            return ["ok": false]
        }
        // HLS downloads that finished have a rewritten local playlist —
        // they play through the media server like files. Only legacy
        // native-asset records (no fileName) need AVPlayerViewController.
        if r.kind == "hls" && r.fileName == nil { return ["ok": true, "native": true] }
        let port = await LocalMediaServer.shared.ensureRunning()
        guard port > 0, let file = r.fileName else { return ["ok": false] }
        let enc = file.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? file
        // `url`: the generated player page (the web player's fallback);
        // `src`: the media itself, for the app's own player (`rustflix.video`).
        return ["ok": true, "url": "http://127.0.0.1:\(port)/\(id)/\(DlPaths.playerPage)?f=\(enc)",
                "src": "http://127.0.0.1:\(port)/\(id)/\(enc)"]
    }

    func play(_ data: [String: Any]) {
        guard let id = DlNames.id(data["id"]), let r = records[id], r.status == "done" else { return }
        let assetURL: URL?
        if let local = r.localURL, !local.isEmpty {
            assetURL = URL(fileURLWithPath: local)
        } else {
            assetURL = URL(string: r.url)
        }
        guard let assetURL else { return }
        let asset: AVURLAsset
        if assetURL.isFileURL {
            asset = AVURLAsset(url: assetURL)
        } else {
            // Remote fallback (download incomplete): same header problem as
            // the downloader — go through the resource loader.
            guard var comps = URLComponents(url: assetURL, resolvingAgainstBaseURL: false) else { return }
            comps.scheme = "rustflix-dl"
            guard let custom = comps.url else { return }
            let a = AVURLAsset(url: custom)
            let loader = HLSResourceLoader(headers: r.headers ?? [:])
            a.resourceLoader.setDelegate(loader, queue: DispatchQueue(label: "rustflix.hls-loader"))
            playbackLoaders.append(loader)
            asset = a
        }
        let item = AVPlayerItem(asset: asset)
        let player = AVPlayer(playerItem: item)
        let vc = AVPlayerViewController()
        vc.player = player
        vc.modalPresentationStyle = .fullScreen
        topViewController()?.present(vc, animated: true) { player.play() }
    }

    func reveal(_ data: [String: Any]) {
        guard let id = DlNames.id(data["id"]), let r = records[id] else { return }
        var urls: [URL] = []
        if r.kind == "file", let file = r.fileName {
            urls.append(DlPaths.dir(id).appendingPathComponent(file))
        }
        if let local = r.localURL, !local.isEmpty {
            urls.append(URL(fileURLWithPath: local))
        }
        guard !urls.isEmpty, let top = topViewController() else { return }
        let ac = UIActivityViewController(activityItems: urls, applicationActivities: nil)
        top.present(ac, animated: true)
    }

    private func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first
        var vc = window?.rootViewController
        while let presented = vc?.presentedViewController { vc = presented }
        return vc
    }

    // MARK: task bookkeeping

    private func hasTracked(_ rid: Int) -> Bool {
        tracked.values.contains { $0.rid == rid }
    }

    private func track(_ task: URLSessionTask, session: URLSession, rid: Int, res: Int?) {
        let key = DlTaskKey(sid: session.configuration.identifier ?? "", tid: task.taskIdentifier)
        tracked[key] = Tracked(rid: rid, res: res, task: task)
        if let res { inflight[rid, default: []].insert(res) }
    }

    /// Cancels every live task of a record. Untracking first means their
    /// cancellation callbacks are ignored as stale.
    private func cancelTasks(_ rid: Int, resume: Bool) {
        for (k, t) in tracked where t.rid == rid {
            tracked[k] = nil
            if resume, t.res == nil, let dt = t.task as? URLSessionDownloadTask {
                dt.cancel(byProducingResumeData: { data in
                    if let data { try? data.write(to: DlPaths.resume(rid), options: .atomic) }
                })
            } else {
                t.task.cancel()
            }
        }
        inflight[rid] = nil
    }

    private func clearRetryState(_ rid: Int) {
        attempts[rid] = nil
        retryAt[rid] = nil
        expiry[rid] = nil
    }

    /// Stops all work for a record (keeps files on disk for a later resume).
    private func stop(_ rid: Int, keepResume: Bool) {
        cancelTasks(rid, resume: keepResume)
        walks[rid] = nil
        waitingWalk.remove(rid)
        if dirtyManifests.contains(rid) { writeManifest(rid) }
        manifests[rid] = nil
        clearRetryState(rid)
    }

    private func fail(_ rid: Int, reason: String, message: String) {
        guard let r = records[rid] else { return }
        stop(rid, keepResume: r.kind == "file")
        patch(rid) { r in
            r.status = "error"; r.reason = reason; r.message = message; r.waiting = nil
        }
        pumpAll()
    }

    private func applyHeaders(_ req: inout URLRequest, _ headers: [String: String], url: URL) {
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        if req.value(forHTTPHeaderField: "Cookie") == nil,
           let cookies = HTTPCookieStorage.shared.cookies(for: url), !cookies.isEmpty {
            for (k, v) in HTTPCookie.requestHeaderFields(with: cookies) { req.setValue(v, forHTTPHeaderField: k) }
        }
    }

    /// Records a failed attempt; returns false when the record was stopped
    /// (expired link or retries exhausted).
    private func noteFailure(_ rid: Int, idx: Int, url: String, _ f: DlFailure, detail: String) -> Bool {
        var a = attempts[rid]?[idx] ?? 0
        // Offline failures don't burn the budget — the session waits for
        // connectivity and we retry once the path is back.
        if !(f == .network && !netSatisfied) { a += 1 }
        attempts[rid, default: [:]][idx] = a
        if case .auth(let code) = f {
            var ex = expiry[rid] ?? DlExpiryTracker()
            let expired = ex.authFailure(idx, status: code, url: url, now: Date())
            expiry[rid] = ex
            if expired {
                fail(rid, reason: "expired", message: "link expired — open the episode again to continue")
                return false
            }
        }
        if a >= DlRetryPolicy.limit(f) {
            fail(rid, reason: "failed", message: detail)
            return false
        }
        retryAt[rid, default: [:]][idx] = Date().addingTimeInterval(DlRetryPolicy.backoff(max(1, a), f))
        return true
    }

    private static func describe(_ outcome: DlOutcome?, _ error: Error?) -> (status: Int?, code: Int?, bad: Bool, text: String) {
        switch outcome {
        case .http(let s)?: return (s, nil, false, "HTTP \(s)")
        case .badBody?: return (nil, nil, true, "error page instead of media")
        case .io(let m)?: return (nil, nil, false, "could not save: \(m)")
        default: break
        }
        if let e = error as NSError? {
            return (nil, e.domain == NSURLErrorDomain ? e.code : nil, false, e.localizedDescription)
        }
        return (nil, nil, false, "download failed")
    }

    // MARK: delegate entry points (main actor)

    fileprivate func didStage(_ key: DlTaskKey, _ outcome: DlOutcome?) {
        lastDelegateActivity = Date().timeIntervalSince1970
        if let outcome { outcomes[key] = outcome }
    }

    fileprivate func didWrite(_ key: DlTaskKey, written: Int64, expected: Int64) {
        guard let t = tracked[key], t.res == nil, let r = records[t.rid], r.status == "running" else { return }
        patchProgress(t.rid) { r in
            r.bytes = written
            r.totalBytes = expected > 0 ? expected : nil
            r.progress = expected > 0 ? min(99, (Double(written) / Double(expected) * 1000).rounded() / 10) : nil
            r.message = self.liveMessage(r)
        }
    }

    fileprivate func didComplete(_ key: DlTaskKey, tag: DlTaskTag?, error: Error?, resumeData: Data?) {
        lastDelegateActivity = Date().timeIntervalSince1970
        let t = tracked.removeValue(forKey: key)
        if let t, let res = t.res { inflight[t.rid]?.remove(res) }
        let outcome = outcomes.removeValue(forKey: key)
        guard let tag else { return }
        switch tag.kind {
        case .file:
            fileCompleted(tag, tracked: t != nil, outcome: outcome, error: error, resumeData: resumeData)
        case .hls(let idx, let file):
            hlsCompleted(tag, idx: idx, file: file, tracked: t != nil, outcome: outcome, error: error)
        }
    }

    fileprivate func finishEvents(_ sid: String) {
        eventsFinished.insert(sid)
        completeBackgroundIfReady(sid)
    }

    func storeBackgroundCompletion(_ sid: String, _ handler: @escaping () -> Void) {
        bgCompletions[sid] = handler
        completeBackgroundIfReady(sid)
    }

    /// Once the session has drained its events (and launch reconciliation
    /// ran), queue follow-up work, persist, and let the system suspend us.
    private func completeBackgroundIfReady(_ sid: String) {
        guard reconciled, eventsFinished.contains(sid) else { return }
        if holding { releaseHold() }
        guard let h = bgCompletions.removeValue(forKey: sid) else { return }
        eventsFinished.remove(sid)
        pumpAll()
        flushState()
        h()
    }

    // MARK: launch reconciliation

    private func reconcile() {
        let group = DispatchGroup()
        var all: [(DlTaskKey, URLSessionTask)] = []
        for (sid, s) in sessions {
            group.enter()
            s.getAllTasks { tasks in
                DispatchQueue.main.async {
                    all += tasks.map { (DlTaskKey(sid: sid, tid: $0.taskIdentifier), $0) }
                    group.leave()
                }
            }
        }
        group.notify(queue: .main) {
            MainActor.assumeIsolated { DownloadManager.shared.applyReconcile(all) }
        }
    }

    private func applyReconcile(_ all: [(DlTaskKey, URLSessionTask)]) {
        let fm = FileManager.default
        let input = records.values.map {
            DlReconcileRecord(id: $0.id, status: $0.status, kind: $0.kind, gen: $0.gen ?? 0,
                              hasManifest: fm.fileExists(atPath: DlPaths.manifest($0.id).path))
        }
        var byKey: [String: (DlTaskKey, URLSessionTask)] = [:]
        for (k, t) in all where t.state == .running || t.state == .suspended { byKey[k.str] = (k, t) }
        let plan = DlReconcile.plan(records: input, tasks: byKey.map { ($0.key, $0.value.1.taskDescription) })
        for a in plan {
            switch a {
            case .cancelTask(let k):
                byKey[k]?.1.cancel()
            case .adopt(let k, let rid, let res):
                guard let (key, task) = byKey[k] else { continue }
                tracked[key] = Tracked(rid: rid, res: res, task: task)
                if let res { inflight[rid, default: []].insert(res) }
                if task.state == .suspended { task.resume() }
            case .resumeHls(let rid):
                if loadHlsState(rid) {
                    hlsProgress(rid)
                    pump(rid)
                } else {
                    beginWalk(rid)
                }
            case .rewalkHls(let rid):
                beginWalk(rid)
            case .restartFile:
                // Started by releaseHold(): a force-quit cancellation (with
                // resume data) may still be on its way through the delegate.
                break
            }
        }
        reconciled = true
        updateWaiting()
        lastDelegateActivity = Date().timeIntervalSince1970
        if eventsFinished.isEmpty { scheduleHoldCheck() }
        for sid in eventsFinished { completeBackgroundIfReady(sid) }
    }

    private func scheduleHoldCheck() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            MainActor.assumeIsolated {
                let m = DownloadManager.shared
                guard m.holding else { return }
                if Date().timeIntervalSince1970 - m.lastDelegateActivity >= 3 { m.releaseHold() } else { m.scheduleHoldCheck() }
            }
        }
    }

    private func releaseHold() {
        guard holding else { return }
        holding = false
        for r in records.values where r.status == "running" && r.kind == "file" && !hasTracked(r.id) {
            startFile(r.id, resume: true)
        }
        pumpAll()
    }

    // MARK: connectivity

    private func pathChanged(_ path: NWPath) {
        netSatisfied = path.status == .satisfied
        netWifi = path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet)
            || (netSatisfied && !path.usesInterfaceType(.cellular))
        updateWaiting()
        if transferAllowed {
            startWaitingWalks()
            pumpAll()
        }
    }

    private func updateWaiting() {
        let w: String? = !netSatisfied ? "network" : (wifiOnly && !netWifi ? "wifi" : nil)
        for r in records.values where r.status == "running" && r.waiting != w {
            patch(r.id) { r in r.waiting = w; r.message = self.liveMessage(r) }
        }
    }

    private func startWaitingWalks() {
        guard transferAllowed else { return }
        for rid in waitingWalk.sorted() { beginWalk(rid) }
    }

    private func checkSpaceIfDue() {
        let now = Date().timeIntervalSince1970
        guard now - lastSpaceCheck > 10 else { return }
        lastSpaceCheck = now
        guard DlPaths.freeBytes() < Self.minFreeWhileRunning else { return }
        for r in records.values where r.status == "running" {
            fail(r.id, reason: "space", message: "storage almost full — free up space, then retry")
        }
    }

    // MARK: progressive downloads

    private func scheduleFileRestart(_ rid: Int, after delay: TimeInterval) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            MainActor.assumeIsolated { DownloadManager.shared.startFile(rid, resume: true) }
        }
    }

    private func startFile(_ rid: Int, resume: Bool) {
        guard !holding, let r = records[rid], r.status == "running", r.kind == "file", !hasTracked(rid),
              let session = currentSession
        else { return }
        var task: URLSessionDownloadTask?
        let resumeURL = DlPaths.resume(rid)
        if resume, let data = try? Data(contentsOf: resumeURL), !data.isEmpty {
            task = session.downloadTask(withResumeData: data)
        }
        try? FileManager.default.removeItem(at: resumeURL)
        if task == nil {
            guard let u = URL(string: r.url) else {
                fail(rid, reason: "failed", message: "bad url"); return
            }
            var req = URLRequest(url: u)
            applyHeaders(&req, r.headers ?? [:], url: u)
            task = session.downloadTask(with: req)
        }
        guard let task else { return }
        task.taskDescription = DlTaskTag(rid: rid, gen: r.gen ?? 0, kind: .file).encoded
        if let at = retryAt[rid]?[-1], at > Date() { task.earliestBeginDate = at }
        track(task, session: session, rid: rid, res: nil)
        task.resume()
    }

    private func fileCompleted(_ tag: DlTaskTag, tracked wasTracked: Bool, outcome: DlOutcome?,
                               error: Error?, resumeData: Data?) {
        let rid = tag.rid
        let incoming = DlPaths.incoming(rid, gen: tag.gen)
        guard let r = records[rid] else { try? FileManager.default.removeItem(at: incoming); return }
        let current = (r.gen ?? 0) == tag.gen
        if case .saved(let ext, _)? = outcome {
            if current && r.status == "running" {
                finishFile(rid, ext: ext ?? "mp4", incoming: incoming)
            } else {
                try? FileManager.default.removeItem(at: incoming)
            }
            return
        }
        guard current else { return }
        if let resumeData { try? resumeData.write(to: DlPaths.resume(rid), options: .atomic) }
        guard wasTracked else {
            // Cancelled by the system (e.g. user force-quit) or by us:
            // reconciliation / the canceller restarts it if still wanted.
            if reconciled && r.status == "running" && !hasTracked(rid) { scheduleFileRestart(rid, after: 1) }
            return
        }
        guard r.status == "running" else { return }
        let d = Self.describe(outcome, error)
        let f = DlRetryPolicy.classify(status: d.status, urlErrorCode: d.code, badBody: d.bad)
        if noteFailure(rid, idx: -1, url: r.url, f, detail: d.text) {
            scheduleFileRestart(rid, after: 0)
        }
    }

    private func finishFile(_ rid: Int, ext: String, incoming: URL) {
        guard let r = records[rid] else { return }
        let dir = DlPaths.dir(rid)
        // The media server splits on "?" and percent-decodes: keep names plain.
        var safe = String(r.name.map { "/:?#%\\\"".contains($0) || $0.isNewline ? "-" : $0 })
        while safe.hasPrefix(".") { safe.removeFirst() }
        if safe.isEmpty { safe = "video" }
        let dest = dir.appendingPathComponent("\(String(safe.prefix(120))).\(ext)")
        let fm = FileManager.default
        try? fm.removeItem(at: dest)
        do {
            try fm.moveItem(at: incoming, to: dest)
        } catch {
            fail(rid, reason: "failed", message: "could not save the file")
            return
        }
        DlPaths.protect(dest)
        writePlayerPage(dir: dir, file: dest.lastPathComponent)
        try? fm.removeItem(at: DlPaths.resume(rid))
        let bytes = DlPaths.size(dest)
        clearRetryState(rid)
        patch(rid) { r in
            r.status = "done"; r.progress = 100; r.message = "finished"; r.reason = nil
            r.fileName = dest.lastPathComponent
            r.headers = nil; r.waiting = nil
            r.bytes = bytes; r.totalBytes = bytes
        }
        pumpAll()
    }

    private func writePlayerPage(dir: URL, file: String) {
        let src = file.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? file
        let html = "<!doctype html><meta charset=utf-8>" +
            "<style>html,body{margin:0;height:100%;background:#000}video{width:100%;height:100%;object-fit:contain}</style>" +
            "<video src=\"\(src)\" playsinline webkit-playsinline preload=\"metadata\"></video>" +
            "<script>var v=document.querySelector('video');v.play().catch(function(){});</script>"
        let url = dir.appendingPathComponent(DlPaths.playerPage)
        try? Data(html.utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    // MARK: HLS downloads

    /// Loads the persisted manifest and marks whatever is already on disk.
    private func loadHlsState(_ rid: Int) -> Bool {
        if manifests[rid] != nil { return true }
        guard var m = readManifest(rid) else { return false }
        let dir = DlPaths.dir(rid)
        m.markFromDisk(existing: Set(dirNames(rid)), size: { DlPaths.size(dir.appendingPathComponent($0)) })
        manifests[rid] = m
        dirtyManifests.insert(rid)
        return true
    }

    /// Reads (or re-reads, with a fresh URL) the playlist tree in the
    /// foreground session, maps it onto what is already saved, then hands
    /// the resources to the background session.
    private func beginWalk(_ rid: Int) {
        guard let r = records[rid], r.status == "running", r.kind == "hls" else { return }
        if !transferAllowed {
            waitingWalk.insert(rid)
            updateWaiting()
            return
        }
        waitingWalk.remove(rid)
        let token = UUID()
        walks[rid] = token
        let urlStr = r.url
        var headers = r.headers ?? [:]
        if let u = URL(string: urlStr), headers.keys.first(where: { $0.lowercased() == "cookie" }) == nil,
           let cookies = HTTPCookieStorage.shared.cookies(for: u), !cookies.isEmpty {
            for (k, v) in HTTPCookie.requestHeaderFields(with: cookies) { headers[k] = v }
        }
        let allowCell = !wifiOnly
        patch(rid) { r in r.message = r.waiting == nil ? "reading playlist…" : self.liveMessage(r) }
        // Give the walk time to finish if the user leaves the app now.
        var bg = UIBackgroundTaskIdentifier.invalid
        bg = UIApplication.shared.beginBackgroundTask(withName: "rustflix.dl.playlist") {
            UIApplication.shared.endBackgroundTask(bg)
            bg = .invalid
        }
        Task { @MainActor in
            defer { if bg != .invalid { UIApplication.shared.endBackgroundTask(bg) } }
            let fetcher = HlsPlaylistFetcher(headers: headers, allowsCellular: allowCell)
            defer { fetcher.invalidate() }
            do {
                var m = try await HlsPlanner(fetch: { try await fetcher.fetch($0) }).plan(url: urlStr)
                guard walks[rid] == token, let cur = records[rid], cur.status == "running" else { return }
                walks[rid] = nil
                let old = manifests[rid] ?? readManifest(rid)
                let names = dirNames(rid)
                let dir = DlPaths.dir(rid)
                m.adopt(old, startName: DlNames.nextIndex(in: names))
                m.markFromDisk(existing: Set(names), size: { DlPaths.size(dir.appendingPathComponent($0)) })
                cancelTasks(rid, resume: false)
                clearRetryState(rid)
                manifests[rid] = m
                writeManifest(rid)
                hlsProgress(rid)
                pump(rid)
            } catch {
                guard walks[rid] == token else { return }
                walks[rid] = nil
                if error is CancellationError { return }
                let ns = error as NSError
                if ns.domain == NSURLErrorDomain,
                   DlRetryPolicy.classify(status: nil, urlErrorCode: ns.code, badBody: false) == .network,
                   !transferAllowed {
                    waitingWalk.insert(rid) // lost the network mid-walk: wait
                    updateWaiting()
                    return
                }
                let hls = error as? HlsError
                let reason = hls?.reason ?? "failed"
                let msg = reason == "expired"
                    ? "link expired — open the episode again to continue"
                    : (hls?.errorDescription ?? error.localizedDescription)
                fail(rid, reason: reason, message: msg)
            }
        }
    }

    private func pumpAll() {
        for r in records.values.sorted(by: { $0.id < $1.id }) where r.status == "running" && r.kind == "hls" {
            pump(r.id)
        }
    }

    /// Creates background tasks for every resource still missing (up to
    /// the global in-flight cap); finalizes once everything is on disk.
    private func pump(_ rid: Int) {
        guard !holding, let r = records[rid], r.status == "running", walks[rid] == nil,
              let m = manifests[rid], let session = currentSession
        else { return }
        if m.isComplete { finalizeHls(rid); return }
        var budget = Self.maxInflight - tracked.count
        guard budget > 0 else { return }
        let fly = inflight[rid] ?? []
        let now = Date()
        let headers = r.headers ?? [:]
        let gen = r.gen ?? 0
        for i in m.resources.indices where !m.resources[i].done && !fly.contains(i) {
            if budget <= 0 { break }
            guard let u = URL(string: m.resources[i].url) else {
                fail(rid, reason: "failed", message: "bad segment url"); return
            }
            var req = URLRequest(url: u)
            applyHeaders(&req, headers, url: u)
            let task = session.downloadTask(with: req)
            task.taskDescription = DlTaskTag(rid: rid, gen: gen, kind: .hls(index: i, file: m.resources[i].file)).encoded
            if let at = retryAt[rid]?[i], at > now { task.earliestBeginDate = at }
            track(task, session: session, rid: rid, res: i)
            budget -= 1
            task.resume()
        }
    }

    private func hlsProgress(_ rid: Int) {
        guard let m = manifests[rid] else { return }
        let done = m.doneCount, total = m.resources.count
        patchProgress(rid) { r in
            r.segDone = done; r.segTotal = total; r.bytes = m.doneBytes
            r.progress = total > 0 ? min(99, (Double(done) / Double(total) * 1000).rounded() / 10) : nil
            r.message = self.liveMessage(r)
        }
    }

    private func hlsCompleted(_ tag: DlTaskTag, idx: Int, file: String, tracked wasTracked: Bool,
                              outcome: DlOutcome?, error: Error?) {
        let rid = tag.rid
        guard let r = records[rid], var m = manifests[rid] else { return }
        if case .saved(let ext, let bytes)? = outcome {
            // Names are never reassigned to other content, so a saved file
            // counts even if it came from an older generation.
            let i = (idx < m.resources.count && m.resources[idx].file == file)
                ? idx : m.resources.firstIndex(where: { $0.file == file })
            guard let i else { return }
            if !m.resources[i].done {
                m.resources[i].done = true
                m.resources[i].ext = ext
                m.resources[i].bytes = bytes
                manifests[rid] = m
                dirtyManifests.insert(rid)
                saveSoon()
            }
            if var ex = expiry[rid] { ex.success(i); expiry[rid] = ex }
            attempts[rid]?[i] = nil
            hlsProgress(rid)
            pump(rid)
            return
        }
        guard wasTracked, (r.gen ?? 0) == tag.gen, r.status == "running",
              idx < m.resources.count, m.resources[idx].file == file
        else { return }
        if case .gone? = outcome { return }
        let d = Self.describe(outcome, error)
        let f = DlRetryPolicy.classify(status: d.status, urlErrorCode: d.code, badBody: d.bad)
        if noteFailure(rid, idx: idx, url: m.resources[idx].url, f, detail: "segment \(idx + 1) failed: \(d.text)") {
            pump(rid)
        }
    }

    private func finalizeHls(_ rid: Int) {
        guard let m = manifests[rid] else { return }
        let dir = DlPaths.dir(rid)
        for (pi, p) in m.playlists.enumerated() {
            let url = dir.appendingPathComponent(p.local)
            do {
                try Data(m.render(pi).utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            } catch {
                fail(rid, reason: "failed", message: "could not write the playlist")
                return
            }
        }
        writePlayerPage(dir: dir, file: m.entry)
        // Drop leftovers (unmapped segments from older reads, manifest with
        // its signed URLs, resume data).
        let keep = m.referencedFiles.union([DlPaths.playerPage])
        for n in dirNames(rid) where !keep.contains(n) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(n))
        }
        manifests[rid] = nil
        dirtyManifests.remove(rid)
        inflight[rid] = nil
        clearRetryState(rid)
        let bytes = DlPaths.treeSize(dir)
        let total = m.resources.count
        patch(rid) { r in
            r.status = "done"; r.progress = 100; r.message = "finished"; r.reason = nil
            r.fileName = m.entry
            r.headers = nil; r.waiting = nil
            r.bytes = bytes; r.segDone = total; r.segTotal = total
        }
        pumpAll()
    }
}

// MARK: - Background session delegate
// Callbacks arrive on one serial queue. Finished files are moved into the
// download folder right here (the temp file is deleted when the callback
// returns); everything else hops to the main actor in order.

final class DlSessionDelegate: NSObject, URLSessionDownloadDelegate {
    let queue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.name = "rustflix.dl.delegate"
        return q
    }()
    /// Per-task last progress forward (only touched on `queue`).
    private var lastTick: [DlTaskKey: TimeInterval] = [:]

    private func key(_ s: URLSession, _ t: URLSessionTask) -> DlTaskKey {
        DlTaskKey(sid: s.configuration.identifier ?? "", tid: t.taskIdentifier)
    }

    private func main(_ f: @escaping @MainActor () -> Void) {
        DispatchQueue.main.async { MainActor.assumeIsolated { f() } }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        let k = key(session, downloadTask)
        let now = Date().timeIntervalSince1970
        guard now - (lastTick[k] ?? 0) >= 0.5 else { return }
        lastTick[k] = now
        main { DownloadManager.shared.didWrite(k, written: totalBytesWritten, expected: totalBytesExpectedToWrite) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        let k = key(session, downloadTask)
        let tag = DlTaskTag(downloadTask.taskDescription)
        let outcome = tag.map { Self.stage($0, location: location, response: downloadTask.response) }
        main { DownloadManager.shared.didStage(k, outcome) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let k = key(session, task)
        lastTick[k] = nil
        let tag = DlTaskTag(task.taskDescription)
        let resume = (error as NSError?)?.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
        main { DownloadManager.shared.didComplete(k, tag: tag, error: error, resumeData: resume) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let sid = session.configuration.identifier ?? ""
        main { DownloadManager.shared.finishEvents(sid) }
    }

    /// Validates and moves a finished transfer into the record's folder.
    static func stage(_ tag: DlTaskTag, location: URL, response: URLResponse?) -> DlOutcome {
        let fm = FileManager.default
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { return .http(code) }
        let dir = DlPaths.dir(tag.rid)
        guard fm.fileExists(atPath: dir.path) else { return .gone } // removed meanwhile
        let size = DlPaths.size(location)
        switch tag.kind {
        case .file:
            let dest = DlPaths.incoming(tag.rid, gen: tag.gen)
            try? fm.removeItem(at: dest)
            do { try fm.moveItem(at: location, to: dest) } catch { return .io(error.localizedDescription) }
            DlPaths.protect(dest)
            let ext = DlSniff.fileExt(suggested: response?.suggestedFilename, mime: response?.mimeType,
                                      urlPath: response?.url?.path ?? "")
            return .saved(ext: ext, bytes: size)
        case .hls(_, let file):
            guard size > 0 else { return .badBody }
            var head = Data()
            if let fh = try? FileHandle(forReadingFrom: location) {
                head = (try? fh.read(upToCount: 512)) ?? Data()
                try? fh.close()
            }
            if DlSniff.looksLikeErrorPage(head, size: size) { return .badBody }
            let ext = DlSniff.ext(head)
            let dest = dir.appendingPathComponent(ext.map { "\(file).\($0)" } ?? file)
            try? fm.removeItem(at: dest)
            do { try fm.moveItem(at: location, to: dest) } catch { return .io(error.localizedDescription) }
            DlPaths.protect(dest)
            return .saved(ext: ext, bytes: size)
        }
    }
}

// MARK: - HLS resource loader

/// Forwards every request AVFoundation makes for a `rustflix-dl://` asset
/// to the real https URL through URLSession, attaching the headers the
/// stream CDN requires (Referer + User-Agent). AVFoundation's own requests
/// (Range etc.) are preserved.
final class HLSResourceLoader: NSObject, AVAssetResourceLoaderDelegate {
    private let headers: [String: String]
    private let session: URLSession

    init(headers: [String: String]) {
        self.headers = headers
        self.session = URLSession(configuration: .default)
        super.init()
    }

    func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest
    ) -> Bool {
        guard var comps = URLComponents(url: loadingRequest.request.url!, resolvingAgainstBaseURL: false) else {
            return false
        }
        comps.scheme = "https"
        guard let real = comps.url else { return false }

        var req = URLRequest(url: real)
        // AVFoundation's own headers first (Range, Accept…), then ours for
        // anything it didn't set.
        if let h = loadingRequest.request.allHTTPHeaderFields {
            for (k, v) in h { req.setValue(v, forHTTPHeaderField: k) }
        }
        for (k, v) in headers where req.value(forHTTPHeaderField: k) == nil {
            req.setValue(v, forHTTPHeaderField: k)
        }

        let task = session.dataTask(with: req) { data, response, error in
            if let error {
                loadingRequest.finishLoading(with: error)
                return
            }
            guard let http = response as? HTTPURLResponse, let data else {
                loadingRequest.finishLoading(with: NSError(domain: "rustflix.dl", code: -1))
                return
            }
            let ci = loadingRequest.contentInformationRequest
            ci?.isByteRangeAccessSupported = true
            ci?.contentLength = Int64(data.count)
            ci?.contentType = http.value(forHTTPHeaderField: "Content-Type")
                ?? loadingRequest.request.value(forHTTPHeaderField: "Accept")
            loadingRequest.response = http
            if let dataReq = loadingRequest.dataRequest {
                var payload = data
                // A 200 means the server ignored our forwarded Range —
                // slice out the requested window ourselves.
                let off = Int(dataReq.requestedOffset)
                if http.statusCode == 200 && off > 0 && off < data.count {
                    let end = min(off + Int(dataReq.requestedLength), data.count)
                    payload = data.subdata(in: off..<end)
                }
                dataReq.respond(with: payload)
            }
            loadingRequest.finishLoading()
        }
        task.resume()
        return true
    }
}
