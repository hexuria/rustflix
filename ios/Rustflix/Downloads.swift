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
//  - progressive files (mp4/webm/…) download with URLSession into
//    Application Support/rustflix-dl/<id>/ and play through the app's
//    localhost media server + the regular NSH player UI;
//  - HLS (.m3u8) downloads fetch the whole playlist tree with URLSession
//    (HlsDownloader.swift — AVAssetDownloadURLSession cannot attach the
//    Referer/UA headers these CDNs require), rewrite it to local files
//    and play through the same localhost media server.
//
// The NSH app reaches this through `nsh/host` (`host.call("dl.*")`),
// progress arrives as `dl.event` host events. Records persist as JSON so
// the Downloads screen survives relaunches.

struct DlRecord: Codable {
    var id: Int
    var name: String
    var status: String // running | done | error
    var progress: Double?
    var message: String
    var kind: String // "file" | "hls"
    var url: String
    var headers: [String: String]
    var fileName: String?
    var localURL: String?
    var key: String?
    var type: String?
    var mediaId: Int?
    var season: Int?
    var episode: Int?
    var title: String?
    var createdAt: TimeInterval

    func json() -> [String: Any] {
        var d: [String: Any] = [
            "id": id, "name": name, "status": status,
            "progress": progress ?? NSNull(), "message": message,
            "kind": kind, "key": key ?? NSNull(), "type": type ?? NSNull(),
            "mediaId": mediaId ?? NSNull(), "season": season ?? NSNull(),
            "episode": episode ?? NSNull(), "title": title ?? NSNull(),
            "createdAt": createdAt * 1000,
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
    var root: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("rustflix-dl", isDirectory: true)
    }

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
        let rawPath = String(parts[1]).removingPercentEncoding ?? ""
        // Only /<id>/<file> under the download root; reject traversal.
        let comps = rawPath.split(separator: "/").map(String.init)
        guard comps.count == 2,
              !comps[0].isEmpty, comps[0].allSatisfy(\.isNumber),
              !comps[1].isEmpty, !comps[1].contains("..")
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

@MainActor
final class DownloadManager: NSObject {
    static let shared = DownloadManager()

    private let storeURL: URL = {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("rustflix-dl-records.json")
    }()
    private var records: [Int: DlRecord] = [:]
    private var nextId = 1
    private var fileSession: URLSession!
    private var fileTasks: [Int: URLSessionDownloadTask] = [:]
    private var fileTaskInfo: [Int: (dir: URL, name: String)] = [:]
    private var hlsDownloads: [Int: HlsDownloader] = [:]
    /// Loaders for in-flight native playback of remote assets; kept alive
    /// for the player's lifetime.
    private var playbackLoaders: [HLSResourceLoader] = []
    private weak var hostView: NshAppView?

    private override init() {
        super.init()
        loadRecords()
        let dc = URLSessionConfiguration.default
        dc.timeoutIntervalForRequest = 60
        fileSession = URLSession(configuration: dc, delegate: self, delegateQueue: nil)
    }

    func attach(hostView: NshAppView) {
        self.hostView = hostView
        Task { await syncWebViewCookies() }
    }

    /// Stream CDNs authorize requests with cookies the embed page picked up
    /// in WKWebView's own cookie store — URLSession/AVURLAsset only see
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

    private func saveRecords() {
        let list = records.values.sorted { $0.createdAt < $1.createdAt }
        if let data = try? JSONEncoder().encode(list) {
            try? data.write(to: storeURL, options: .atomic)
        }
    }

    private func loadRecords() {
        guard let data = try? Data(contentsOf: storeURL),
              let list = try? JSONDecoder().decode([DlRecord].self, from: data)
        else { return }
        var interrupted = false
        for var r in list {
            if r.status == "running" {
                r.status = "error"
                r.message = "interrupted"
                interrupted = true
            }
            records[r.id] = r
            nextId = max(nextId, r.id + 1)
        }
        if interrupted { saveRecords() }
    }

    private func emit(_ r: DlRecord) {
        hostView?.send("dl.event", r.json())
    }

    private func patch(_ id: Int, _ f: (inout DlRecord) -> Void) {
        guard var r = records[id] else { return }
        f(&r)
        records[id] = r
        saveRecords()
        emit(r)
    }

    // MARK: handlers (called from RustflixApp via host.call)

    func list() -> [[String: Any]] {
        records.values.sorted { $0.createdAt > $1.createdAt }.map { $0.json() }
    }

    func start(_ data: [String: Any]) async -> [String: Any] {
        guard let urlStr = data["url"] as? String, let u = URL(string: urlStr) else {
            return ["ok": false, "error": "bad url"]
        }
        let name = (data["name"] as? String) ?? "video"
        let kind = (data["kind"] as? String) ?? (urlStr.contains(".m3u8") ? "hls" : "file")
        var headers: [String: String] = [:]
        if let h = data["headers"] as? [String: Any] {
            for (k, v) in h { headers[k] = "\(v)" }
        }
        let meta = data["meta"] as? [String: Any] ?? [:]
        await syncWebViewCookies()
        let id = nextId; nextId += 1
        let dir = LocalMediaServer.shared.root.appendingPathComponent("\(id)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var r = DlRecord(
            id: id, name: name, status: "running", progress: nil,
            message: "starting…", kind: kind, url: urlStr, headers: headers,
            fileName: nil, localURL: nil,
            key: meta["key"] as? String, type: meta["type"] as? String,
            mediaId: meta["mediaId"] as? Int, season: meta["season"] as? Int,
            episode: meta["episode"] as? Int, title: meta["title"] as? String,
            createdAt: Date().timeIntervalSince1970)
        records[id] = r
        saveRecords()
        emit(r)

        if kind == "hls" {
            startHLS(id: id, url: u, headers: headers, name: name)
        } else {
            startFile(id: id, url: u, headers: headers, name: name, dir: dir)
        }
        return ["ok": true, "id": id]
    }

    func cancel(_ data: [String: Any]) {
        guard let id = data["id"] as? Int else { return }
        patch(id) { r in r.status = "error"; r.message = "cancelled" }
        fileTasks[id]?.cancel()
        fileTasks[id] = nil
        fileTaskInfo[id] = nil
        hlsDownloads[id]?.cancelled = true
        hlsDownloads[id] = nil
    }

    func remove(_ data: [String: Any]) {
        guard let id = data["id"] as? Int, let r = records[id] else { return }
        fileTasks[id]?.cancel()
        fileTasks[id] = nil
        fileTaskInfo[id] = nil
        hlsDownloads[id]?.cancelled = true
        hlsDownloads[id] = nil
        let dir = LocalMediaServer.shared.root.appendingPathComponent("\(id)", isDirectory: true)
        try? FileManager.default.removeItem(at: dir)
        if let local = r.localURL { try? FileManager.default.removeItem(atPath: local) }
        records.removeValue(forKey: id)
        saveRecords()
    }

    func playUrl(_ data: [String: Any]) async -> [String: Any] {
        guard let id = data["id"] as? Int, let r = records[id], r.status == "done" else {
            return ["ok": false]
        }
        // HLS downloads that finished have a rewritten local playlist —
        // they play through the media server like files. Only legacy
        // native-asset records (no fileName) need AVPlayerViewController.
        if r.kind == "hls" && r.fileName == nil { return ["ok": true, "native": true] }
        let port = await LocalMediaServer.shared.ensureRunning()
        guard port > 0, let file = r.fileName else { return ["ok": false] }
        let enc = file.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? file
        return ["ok": true, "url": "http://127.0.0.1:\(port)/\(id)/.rustflix-player.html?f=\(enc)"]
    }

    func play(_ data: [String: Any]) {
        guard let id = data["id"] as? Int, let r = records[id], r.status == "done" else { return }
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
            let loader = HLSResourceLoader(headers: r.headers)
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
        guard let id = data["id"] as? Int, let r = records[id] else { return }
        var urls: [URL] = []
        if r.kind == "file", let file = r.fileName {
            urls.append(LocalMediaServer.shared.root.appendingPathComponent("\(id)/\(file)"))
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

    // MARK: progressive downloads

    private func startFile(id: Int, url: URL, headers: [String: String], name: String, dir: URL) {
        var req = URLRequest(url: url)
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        let task = fileSession.downloadTask(with: req)
        fileTasks[id] = task
        fileTaskInfo[id] = (dir, name)
        task.resume()
    }

    private func finishFile(id: Int, location: URL) {
        guard let info = fileTaskInfo[id] else { return }
        let (dir, name) = info
        let suggested = location.pathExtension.isEmpty ? "mp4" : location.pathExtension
        let safe = name.replacingOccurrences(of: "/", with: "-")
        let dest = dir.appendingPathComponent("\(safe).\(suggested)")
        try? FileManager.default.removeItem(at: dest)
        do {
            try FileManager.default.moveItem(at: location, to: dest)
        } catch {
            try? FileManager.default.copyItem(at: location, to: dest)
            try? FileManager.default.removeItem(at: location)
        }
        writePlayerPage(dir: dir, file: dest.lastPathComponent)
        patch(id) { r in
            r.status = "done"; r.progress = 100; r.message = "finished"
            r.fileName = dest.lastPathComponent
        }
        fileTasks[id] = nil
        fileTaskInfo[id] = nil
    }

    private func writePlayerPage(dir: URL, file: String) {
        let src = file.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? file
        let html = "<!doctype html><meta charset=utf-8>" +
            "<style>html,body{margin:0;height:100%;background:#000}video{width:100%;height:100%;object-fit:contain}</style>" +
            "<video src=\"\(src)\" playsinline webkit-playsinline preload=\"metadata\"></video>" +
            "<script>var v=document.querySelector('video');v.play().catch(function(){});</script>"
        try? html.write(to: dir.appendingPathComponent(".rustflix-player.html"), atomically: true, encoding: .utf8)
    }

    // MARK: HLS downloads

    private func startHLS(id: Int, url: URL, headers: [String: String], name: String) {
        let dir = LocalMediaServer.shared.root.appendingPathComponent("\(id)", isDirectory: true)
        let dl = HlsDownloader(headers: headers, dir: dir)
        hlsDownloads[id] = dl
        Task {
            do {
                let pl = try await dl.run(url: url.absoluteString) { [weak self] pct, msg in
                    Task { @MainActor [weak self] in
                        self?.patch(id) { r in r.progress = pct * 100; r.message = msg }
                    }
                }
                writePlayerPage(dir: dir, file: pl)
                patch(id) { r in
                    r.status = "done"; r.progress = 100; r.message = "finished"
                    r.fileName = pl
                }
                hlsDownloads[id] = nil
            } catch is CancellationError {
                hlsDownloads[id] = nil
            } catch {
                patch(id) { r in
                    if r.status == "running" {
                        r.status = "error"
                        r.message = error.localizedDescription
                    }
                }
                hlsDownloads[id] = nil
            }
        }
    }
}

// MARK: - URLSessionDownloadDelegate (progressive files)
// Delegate callbacks arrive off the main thread; all state lives on the
// main actor, so each hops over before touching it.

extension DownloadManager: @preconcurrency URLSessionDownloadDelegate {
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        Task { @MainActor in
            guard let id = fileTasks.first(where: { $0.value === downloadTask })?.key else { return }
            let pct = totalBytesExpectedToWrite > 0
                ? min(99.0, Double(totalBytesWritten) / Double(totalBytesExpectedToWrite) * 100) : nil
            patch(id) { r in
                r.progress = pct
                r.message = pct != nil ? "\(Int(pct!))%" : "downloading"
            }
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        Task { @MainActor in
            guard let id = fileTasks.first(where: { $0.value === downloadTask })?.key else { return }
            finishFile(id: id, location: location)
        }
    }
}

// One implementation satisfies the task delegate's didCompleteWithError.
extension DownloadManager {
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        Task { @MainActor in
            var ids: [Int] = []
            for (id, t) in fileTasks where t === task { ids.append(id) }
            for id in ids {
                if let error {
                    patch(id) { r in
                        if r.status == "running" {
                            r.status = "error"
                            r.message = error.localizedDescription
                        }
                    }
                }
                fileTasks[id] = nil
                fileTaskInfo[id] = nil
            }
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
