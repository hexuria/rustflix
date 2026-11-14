// The streaming proxy (`dl.stream.*`, capability "dl.*") on iOS: a stream
// the hidden web view resolved (URL + the page's headers) played by the
// app's own player (NativeVideo.swift) through a local HTTP server that adds
// those headers to every upstream request. The Swift twin of src/stream
// (same ops, local URLs, events and stats; contract.md §2):
//
// - `dl.stream.open {url, kind?, headers?, cookies?, key?}` → `{ok, sid, url}`
//   with `url` = `http://127.0.0.1:<port>/<token>/s/<sid>/index.m3u8` (HLS)
//   or `…/f0.<ext>` (a progressive file);
// - `dl.stream.update {sid, url, headers?, cookies?}`: a fresh link, the
//   local URLs stay; `dl.stream.close {sid}`; `dl.stream.stats {sid}`;
//   `dl.stream.debug {sid, status?, count?}` (the next `count` upstream
//   answers are `status` without asking upstream);
// - events `dl.stream.event {sid, type}`: `expiring`, `expired`, `updated`,
//   `error {reason, message, fatal}`, `stats`.
//
// Not an open proxy: a random port on the loopback interface only, a
// per-launch path token, and a session serves only the ids its own
// playlists listed (StreamPlaylist.swift). No request carries a URL.
//
// Media flows with back-pressure: a URLSession data task per request,
// suspended while more than 1 MB is queued on the player's connection and
// resumed below 256 KB — no whole-segment buffering. Range is forwarded;
// a 200 to a range request is skipped/capped into the 206 asked for;
// chunked when the length is unknown. Segments behind a fake image header
// (PNG/JPEG/GIF/BMP before MPEG-TS) are served from the first TS packet.
//
// A refused request (401/403/410) is held up to 20 s for `dl.stream.update`
// and then retried against the fresh link: local names stay stable — the
// entries are matched by what they are (StreamDesc: variant resolution /
// bandwidth / codecs, rendition type / language / name, segment start and
// duration), a name with no exact counterpart is served from the nearest
// one (the segment covering the same time, the nearest lower variant, the
// same-language rendition), and only when nothing can stand for it does the
// session report `error relink` (src/stream's rules).
//
// Everything runs on one serial queue (`q`): the listener, the
// connections, URLSession's delegate callbacks, the session tables.

import Foundation
import Network

final class StreamProxy: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let shared = StreamProxy()

    /// How long a refused request waits for a fresh link.
    static let hold: TimeInterval = 20
    static let maxSessions = 8
    static let playlistLimit = 16 * 1024 * 1024
    /// Back-pressure marks (bytes queued on the player's connection).
    static let highWater = 1024 * 1024
    static let lowWater = 256 * 1024
    /// `expiring` this long before a link's parsed expiry.
    static let expiringLead: TimeInterval = 90
    static let idleReap: TimeInterval = 30 * 60

    let q = DispatchQueue(label: "rustflix.stream")
    let token: String
    private var listener: NWListener?
    private var port: UInt16 = 0
    private var sessions: [String: Session] = [:]
    private var transfers: [Int: Transfer] = [:]
    private var reaper: DispatchSourceTimer?
    /// Where events go (`dl.stream.event`); called on `q`.
    var sink: (([String: Any]) -> Void)?

    private lazy var http: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 30
        c.httpCookieStorage = .shared
        c.httpShouldSetCookies = true
        c.httpCookieAcceptPolicy = .always
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        c.httpMaximumConnectionsPerHost = 6
        let ops = OperationQueue()
        ops.underlyingQueue = q
        ops.maxConcurrentOperationCount = 1
        return URLSession(configuration: c, delegate: self, delegateQueue: ops)
    }()

    private override init() {
        token = Self.randomHex(16)
        super.init()
    }

    static func randomHex(_ bytes: Int) -> String {
        var g = SystemRandomNumberGenerator()
        return (0..<bytes).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &g)) }.joined()
    }

    // MARK: - Types

    struct Stats {
        var requests = 0, upstream = 0, withHeaders = 0, bytes: Int64 = 0
        var statuses: [String: Int] = [:]
        var playlists = 0, segments = 0, ranges = 0, rangesEmulated = 0
        var expired = 0, updates = 0, holds = 0, holdMsMax = 0, recovered = 0
        var errors = 0, strippedHeaders = 0

        func json(headerNames: [String], table: Int) -> [String: Any] {
            [
                "requests": requests, "upstream": upstream, "withHeaders": withHeaders,
                "headerNames": headerNames, "bytes": bytes, "statuses": statuses,
                "playlists": playlists, "segments": segments, "ranges": ranges,
                "rangesEmulated": rangesEmulated, "expired": expired, "updates": updates,
                "holds": holds, "holdMsMax": holdMsMax, "recovered": recovered,
                "errors": errors, "table": table,
                "strippedHeaders": strippedHeaders,
            ]
        }
    }

    final class Session {
        let sid: String
        let key: String?
        let kind: String
        let created = Date()
        var refs = 1
        var headers: [String: String]
        /// The entries (names → upstream URLs), matched by what they are.
        let t: StreamEntries
        /// Parent playlist → the generation it was last rewritten in.
        var rewritten: [Int: Int] = [:]
        var closed: String?
        var expiredFor: Int?
        var expiringFor: Int?
        var relinkFor: Int?
        var force: (status: Int, count: Int)?
        var stats = Stats()
        var lastStats = Date.distantPast
        var lastActivity = Date()
        /// Requests held for a fresh link: called with true (it came) or false.
        var waiters: [UUID: (Bool) -> Void] = [:]
        /// Playlist refreshes in flight (parent id → callbacks).
        var refreshing: [Int: [(Result<Void, Fail>) -> Void]] = [:]

        init(sid: String, key: String?, kind: String, url: String, headers: [String: String]) {
            self.sid = sid
            self.key = key
            self.kind = kind
            self.headers = headers
            t = StreamEntries(url: url, role: kind == "hls" ? .playlist : .file)
        }

        var headerNames: [String] { headers.keys.sorted() }
        var gen: Int { t.gen }
        var entries: [StreamEntries.Entry] { t.entries }

        func statsJSON() -> [String: Any] {
            var j = stats.json(headerNames: headerNames, table: t.entries.count)
            j["remapped"] = t.remapped
            j["remaps"] = t.remaps
            return j
        }
    }

    enum Fail: Error {
        /// Answer this status (an upstream one, or a 404 / 502 of our own).
        case status(Int)
        /// The player hung up.
        case gone
    }

    struct Request {
        var method: String
        var path: String
        var range: String?
        var close: Bool
    }

    /// One player connection (HTTP/1.1, keep-alive, one request at a time).
    final class Conn {
        let nw: NWConnection
        var buffer = Data()
        var busy = false
        var gone = false
        /// Bytes handed to the connection and not yet sent.
        var unsent = 0
        var onDrain: (() -> Void)?
        var transfer: Int?
        init(_ nw: NWConnection) { self.nw = nw }
    }

    /// A media request in flight: its upstream task and how its body goes out.
    final class Transfer {
        let session: Session
        let id: Int
        let conn: Conn
        let req: Request
        let held: Bool
        let attempt: Int
        let seen: Int
        var task: URLSessionDataTask?
        var started = false
        var suspended = false
        var chunked = false
        var skip: Int64 = 0
        var left: Int64?
        var sent: Int64 = 0
        var head = ""
        var headWritten = false
        /// Sniffing a segment's first bytes for a fake image header.
        var sniff = false
        var sniffed = Data()
        var length: Int64?

        init(session: Session, id: Int, conn: Conn, req: Request, held: Bool, attempt: Int, seen: Int) {
            self.session = session; self.id = id; self.conn = conn; self.req = req
            self.held = held; self.attempt = attempt; self.seen = seen
        }
    }

    // MARK: - Listener

    /// Starts the server if needed (on `q`); the port, 0 when it cannot.
    private func ensureListening() -> UInt16 {
        if let l = listener, port != 0, l.state == .ready { return port }
        listener?.cancel()
        listener = nil
        port = 0
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        params.allowLocalEndpointReuse = true
        guard let l = try? NWListener(using: params, on: .any) else { return 0 }
        let ready = DispatchSemaphore(value: 0)
        l.stateUpdateHandler = { [weak self, weak l] state in
            switch state {
            case .ready:
                self?.port = l?.port?.rawValue ?? 0
                ready.signal()
            case .failed:
                ready.signal()
            default: break
            }
        }
        l.newConnectionHandler = { [weak self] nw in
            guard let self else { return }
            self.q.async { self.accept(nw) }
        }
        // The state handler runs on another queue so `q` can wait for it.
        let lq = DispatchQueue(label: "rustflix.stream.listener")
        l.start(queue: lq)
        listener = l
        _ = ready.wait(timeout: .now() + 3)
        if reaper == nil {
            let t = DispatchSource.makeTimerSource(queue: q)
            t.schedule(deadline: .now() + 60, repeating: 60)
            t.setEventHandler { [weak self] in self?.reap() }
            t.resume()
            reaper = t
        }
        return port
    }

    private func accept(_ nw: NWConnection) {
        // Loopback only (the listener requires it); belt and braces.
        if case .hostPort(let host, _) = nw.endpoint {
            let h = "\(host)"
            if !(h.hasPrefix("127.") || h == "::1" || h.hasPrefix("::ffff:127.")) {
                nw.cancel()
                return
            }
        }
        let c = Conn(nw)
        nw.stateUpdateHandler = { [weak self, weak c] state in
            guard let self, let c else { return }
            switch state {
            case .failed, .cancelled: self.q.async { self.hangUp(c) }
            default: break
            }
        }
        nw.start(queue: q)
        receive(c)
    }

    private func receive(_ c: Conn) {
        c.nw.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self else { return }
            if let data, !data.isEmpty { c.buffer.append(data) }
            if complete || error != nil {
                self.hangUp(c)
                return
            }
            if c.buffer.count > 64 * 1024 && c.buffer.range(of: Data("\r\n\r\n".utf8)) == nil {
                self.hangUp(c)
                return
            }
            self.next(c)
            self.receive(c)
        }
    }

    private func hangUp(_ c: Conn) {
        guard !c.gone else { return }
        c.gone = true
        if let t = c.transfer, let tr = transfers.removeValue(forKey: t) {
            tr.task?.cancel()
        }
        c.transfer = nil
        c.nw.cancel()
    }

    /// Takes the next request off the connection's buffer when idle.
    private func next(_ c: Conn) {
        guard !c.busy, !c.gone, let end = c.buffer.range(of: Data("\r\n\r\n".utf8)) else { return }
        let headData = c.buffer.subdata(in: c.buffer.startIndex..<end.lowerBound)
        c.buffer.removeSubrange(c.buffer.startIndex..<end.upperBound)
        guard let head = String(data: headData, encoding: .utf8) ?? String(data: headData, encoding: .isoLatin1) else {
            hangUp(c)
            return
        }
        let lines = head.components(separatedBy: "\r\n")
        let parts = (lines.first ?? "").split(separator: " ").map(String.init)
        var req = Request(method: parts.first ?? "", path: parts.count > 1 ? parts[1] : "", range: nil,
                          close: parts.count > 2 && parts[2] == "HTTP/1.0")
        for l in lines.dropFirst() {
            guard let colon = l.firstIndex(of: ":") else { continue }
            let k = l[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let v = l[l.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if k == "range" { req.range = v } else if k == "connection" { req.close = v.lowercased() == "close" }
        }
        c.busy = true
        if req.method != "GET" && req.method != "HEAD" {
            simple(c, 405, close: true)
            return
        }
        respond(c, req)
    }

    /// The request on `c` is answered: next one, or close.
    private func finished(_ c: Conn, _ req: Request) {
        c.transfer = nil
        if req.close {
            whenDrained(c) { [weak self] in self?.hangUp(c) }
            return
        }
        c.busy = false
        next(c)
    }

    private func write(_ c: Conn, _ data: Data, then: (() -> Void)? = nil) {
        guard !c.gone else { return }
        c.unsent += data.count
        c.nw.send(content: data, completion: .contentProcessed { [weak self, weak c] error in
            guard let self, let c else { return }
            c.unsent -= data.count
            if error != nil {
                self.hangUp(c)
                return
            }
            then?()
            if c.unsent <= Self.lowWater, let d = c.onDrain {
                c.onDrain = nil
                d()
            }
        })
    }

    private func whenDrained(_ c: Conn, _ f: @escaping () -> Void) {
        if c.unsent == 0 { f() } else { c.onDrain = f }
    }

    private func simple(_ c: Conn, _ code: Int, close: Bool) {
        let text: String
        switch code {
        case 403: text = "Forbidden"
        case 404: text = "Not Found"
        case 405: text = "Method Not Allowed"
        case 410: text = "Gone"
        case 416: text = "Range Not Satisfiable"
        case 502: text = "Bad Gateway"
        case 503: text = "Service Unavailable"
        default: text = "Error"
        }
        let head = "HTTP/1.1 \(code) \(text)\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\(close ? "Connection: close\r\n" : "")\r\n"
        write(c, Data(head.utf8))
        finished(c, Request(method: "GET", path: "", range: nil, close: close))
    }

    private func fail(_ c: Conn, _ req: Request, _ f: Fail, _ s: Session?) {
        switch f {
        case .gone: hangUp(c)
        case .status(let code):
            if code != 404 { s?.stats.errors += 1 }
            simple(c, code, close: req.close)
        }
    }

    // MARK: - Routing

    /// `/<token>/s/<sid>/<name>`, the query ignored.
    private func route(_ path: String) -> (Session, Int, Character)? {
        let p = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let p2 = p.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        guard p2.hasPrefix("/") else { return nil }
        let parts = p2.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 4, parts[0] == token, parts[1] == "s" else { return nil }
        guard let (id, letter) = StreamPlaylist.parseName(parts[3]), let s = sessions[parts[2]],
              id < s.entries.count
        else { return nil }
        let e = s.entries[id]
        // Exactly the name the session gave it.
        guard e.role.letter == letter, e.name == parts[3] else { return nil }
        return (s, id, letter)
    }

    private func respond(_ c: Conn, _ req: Request) {
        guard let (s, id, letter) = route(req.path) else {
            fail(c, req, .status(404), nil)
            return
        }
        if s.closed != nil {
            fail(c, req, .status(410), s)
            return
        }
        s.stats.requests += 1
        s.lastActivity = Date()
        if letter == "p" {
            servePlaylist(s, id, c, req, held: false)
        } else {
            if req.range != nil { s.stats.ranges += 1 }
            serveMedia(s, id, c, req, held: false, attempt: 1)
        }
        maybeStats(s)
    }

    // MARK: - Upstream

    private func makeRequest(_ s: Session, _ url: String, extra: [String: String]) -> URLRequest? {
        guard let u = URL(string: url) else { return nil }
        var r = URLRequest(url: u)
        r.timeoutInterval = 30
        for (k, v) in s.headers { r.setValue(v, forHTTPHeaderField: k) }
        for (k, v) in extra { r.setValue(v, forHTTPHeaderField: k) }
        return r
    }

    /// Bookkeeping of one upstream request; a forced status when the debug
    /// op asked for one.
    private func countUpstream(_ s: Session, _ url: String) -> Int? {
        s.stats.upstream += 1
        if let f = s.force {
            s.force = f.count > 1 ? (f.status, f.count - 1) : nil
            s.stats.statuses["forced\(f.status)", default: 0] += 1
            return f.status
        }
        s.stats.withHeaders += 1
        if s.expiringFor != s.gen, let at = Self.expiresAt(url), at - Date().timeIntervalSince1970 < Self.expiringLead {
            s.expiringFor = s.gen
            let inSec = max(0, Int(at - Date().timeIntervalSince1970))
            emit(s, "expiring", ["expiresAt": Int(at), "inSec": inSec])
        }
        return nil
    }

    private enum Fetched {
        case text(String, String)
        case status(Int)
    }

    private func fetchPlaylist(_ s: Session, _ url: String, attempt: Int = 1, _ done: @escaping (Result<Fetched, Fail>) -> Void) {
        if let forced = countUpstream(s, url) {
            done(.success(.status(forced)))
            return
        }
        guard let req = makeRequest(s, url, extra: [:]) else {
            done(.failure(.status(502)))
            return
        }
        let task = http.dataTask(with: req) { [weak self] data, resp, error in
            // URLSession calls completion handlers on its delegate queue (`q`).
            guard let self else { return }
            guard error == nil, let http = resp as? HTTPURLResponse else {
                s.stats.statuses["network", default: 0] += 1
                if attempt < 3 {
                    self.q.asyncAfter(deadline: .now() + 0.3) { self.fetchPlaylist(s, url, attempt: attempt + 1, done) }
                } else {
                    done(.failure(.status(502)))
                }
                return
            }
            let code = http.statusCode
            s.stats.statuses["\(code)", default: 0] += 1
            if (code >= 500 || code == 429) && attempt < 3 {
                self.q.asyncAfter(deadline: .now() + 0.5) { self.fetchPlaylist(s, url, attempt: attempt + 1, done) }
                return
            }
            guard (200..<300).contains(code) else {
                done(.success(.status(code)))
                return
            }
            let body = data ?? Data()
            guard body.count <= Self.playlistLimit else {
                done(.failure(.status(502)))
                return
            }
            let text = String(data: body, encoding: .utf8) ?? String(decoding: body, as: UTF8.self)
            let base = http.url?.absoluteString ?? url
            done(.success(.text(text, base)))
        }
        task.resume()
    }

    /// Entry `id`'s URL for the current link, reading its parent playlist
    /// again after a fresh link (one refresh per parent at a time).
    private func freshURL(_ s: Session, _ id: Int, depth: Int = 0, _ done: @escaping (Result<(String, Int, StreamRole), Fail>) -> Void) {
        guard id < s.entries.count else {
            done(.failure(.status(404)))
            return
        }
        let e = s.entries[id]
        if e.gen == s.gen || id == 0 {
            done(.success((e.url, s.gen, e.role)))
            return
        }
        guard depth <= 6 else {
            done(.failure(.status(502)))
            return
        }
        refresh(s, e.parent, depth: depth + 1) { [weak self] r in
            guard let self else { return }
            switch r {
            case .failure(let f): done(.failure(f))
            case .success:
                // Listed again, else served from the nearest counterpart (the
                // segment covering the same time, the nearest lower variant).
                if s.entries[id].gen == s.gen || s.t.remap(id) {
                    let e = s.entries[id]
                    done(.success((e.url, s.gen, e.role)))
                    return
                }
                // Nothing in the fresh link can stand for it.
                if s.relinkFor != s.gen {
                    s.relinkFor = s.gen
                    self.emit(s, "error", [
                        "reason": "relink", "fatal": false,
                        "message": "the fresh link does not have what the player is playing: rebuild the item at the current time",
                    ])
                }
                done(.failure(.status(404)))
            }
        }
    }

    /// Reads playlist `parent` with the current link and rewrites it (which
    /// moves the entries it lists to their fresh URLs).
    private func refresh(_ s: Session, _ parent: Int, depth: Int, _ done: @escaping (Result<Void, Fail>) -> Void) {
        if s.rewritten[parent] == s.gen {
            done(.success(()))
            return
        }
        if s.refreshing[parent] != nil {
            s.refreshing[parent]?.append(done)
            return
        }
        s.refreshing[parent] = [done]
        let finish: (Result<Void, Fail>) -> Void = { r in
            let all = s.refreshing.removeValue(forKey: parent) ?? []
            for f in all { f(r) }
        }
        freshURL(s, parent, depth: depth) { [weak self] r in
            guard let self else { return }
            switch r {
            case .failure(let f): finish(.failure(f))
            case .success(let (purl, pgen, _)):
                self.fetchPlaylist(s, purl) { r in
                    switch r {
                    case .failure(let f): finish(.failure(f))
                    case .success(.status(let code)): finish(.failure(.status(code)))
                    case .success(.text(let text, let base)):
                        guard s.gen == pgen else {
                            finish(.failure(.status(503)))
                            return
                        }
                        do {
                            _ = try self.rewrite(s, text, base: base, me: parent)
                            finish(.success(()))
                        } catch {
                            finish(.failure(.status(502)))
                        }
                    }
                }
            }
        }
    }

    private func rewrite(_ s: Session, _ text: String, base: String, me: Int) throws -> String {
        let out = try StreamPlaylist.rewrite(text, base: base, me: me, table: s.t)
        s.rewritten[me] = s.gen
        return out
    }

    // MARK: - Holding for a fresh link

    /// Holds a refused request (link generation `seen`): emits `expired`
    /// once per generation, waits for `update` up to the hold. `done(true)`
    /// when a fresh link came.
    private func hold(_ s: Session, seen: Int, code: Int, _ done: @escaping (Bool) -> Void) {
        let start = Date()
        s.stats.holds += 1
        if s.expiredFor != seen {
            s.expiredFor = seen
            s.stats.expired += 1
            NSLog("rustflix/stream: session %@ upstream answered %d: holding for a fresh link", s.sid, code)
            emit(s, "expired", ["status": code])
        }
        if s.closed != nil {
            done(false)
            return
        }
        if s.gen != seen {
            done(true)
            return
        }
        let key = UUID()
        let finish: (Bool) -> Void = { [weak self] fresh in
            let ms = Int(Date().timeIntervalSince(start) * 1000)
            s.stats.holdMsMax = max(s.stats.holdMsMax, ms)
            if !fresh && s.closed == nil {
                self?.emit(s, "error", [
                    "reason": "expired", "fatal": false,
                    "message": "upstream answered \(code) and no fresh link came within \(Int(Self.hold)) s",
                ])
            }
            done(fresh)
        }
        s.waiters[key] = finish
        q.asyncAfter(deadline: .now() + Self.hold) {
            if let f = s.waiters.removeValue(forKey: key) { f(false) }
        }
    }

    // MARK: - Playlists

    private func servePlaylist(_ s: Session, _ id: Int, _ c: Conn, _ req: Request, held: Bool) {
        freshURL(s, id) { [weak self] r in
            guard let self, !c.gone else { return }
            switch r {
            case .failure(let f): self.fail(c, req, f, s)
            case .success(let (url, seen, _)):
                self.fetchPlaylist(s, url) { r in
                    guard !c.gone else { return }
                    switch r {
                    case .failure(let f): self.fail(c, req, f, s)
                    case .success(.status(let code)) where DlRetryPolicy.isAuthStatus(code):
                        self.hold(s, seen: seen, code: code) { fresh in
                            if fresh { self.servePlaylist(s, id, c, req, held: true) } else { self.fail(c, req, .status(code), s) }
                        }
                    case .success(.status(let code)): self.fail(c, req, .status(code), s)
                    case .success(.text(let text, let base)):
                        s.stats.playlists += 1
                        if held { s.stats.recovered += 1 }
                        let body: String
                        do {
                            body = try self.rewrite(s, text, base: base, me: id)
                        } catch StreamRewriteError.drm {
                            self.closeSession(s, "drm")
                            self.emit(s, "error", ["reason": "drm", "message": "DRM-protected stream", "fatal": true])
                            self.fail(c, req, .status(403), s)
                            return
                        } catch {
                            self.emit(s, "error", ["reason": "upstream", "message": "upstream playlist is not a playlist", "fatal": false])
                            self.fail(c, req, .status(502), s)
                            return
                        }
                        let data = Data(body.utf8)
                        let head = "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: \(data.count)\r\n"
                            + "Cache-Control: no-store\r\n\(req.close ? "Connection: close\r\n" : "")\r\n"
                        self.write(c, Data(head.utf8))
                        if req.method != "HEAD" {
                            self.write(c, data)
                            s.stats.bytes += Int64(data.count)
                        }
                        self.finished(c, req)
                    }
                }
            }
        }
    }

    // MARK: - Media

    private func serveMedia(_ s: Session, _ id: Int, _ c: Conn, _ req: Request, held: Bool, attempt: Int) {
        freshURL(s, id) { [weak self] r in
            guard let self, !c.gone else { return }
            switch r {
            case .failure(let f): self.fail(c, req, f, s)
            case .success(let (url, seen, _)):
                if let forced = self.countUpstream(s, url) {
                    self.mediaRefused(s, id, c, req, code: forced, seen: seen, attempt: attempt)
                    return
                }
                var extra = ["Accept-Encoding": "identity"]
                if let range = req.range { extra["Range"] = range }
                guard let ureq = self.makeRequest(s, url, extra: extra) else {
                    self.fail(c, req, .status(502), s)
                    return
                }
                let task = self.http.dataTask(with: ureq)
                let tr = Transfer(session: s, id: id, conn: c, req: req, held: held, attempt: attempt, seen: seen)
                tr.task = task
                self.transfers[task.taskIdentifier] = tr
                c.transfer = task.taskIdentifier
                task.resume()
            }
        }
    }

    private func mediaRefused(_ s: Session, _ id: Int, _ c: Conn, _ req: Request, code: Int, seen: Int, attempt: Int) {
        if DlRetryPolicy.isAuthStatus(code) {
            hold(s, seen: seen, code: code) { [weak self] fresh in
                guard let self, !c.gone else { return }
                if fresh { self.serveMedia(s, id, c, req, held: true, attempt: attempt) } else { self.fail(c, req, .status(code), s) }
            }
        } else if (code >= 500 || code == 429) && attempt < 3 {
            q.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self, !c.gone else { return }
                self.serveMedia(s, id, c, req, held: false, attempt: attempt + 1)
            }
        } else {
            fail(c, req, .status(code), s)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let tr = transfers[dataTask.taskIdentifier], !tr.conn.gone else {
            completionHandler(.cancel)
            return
        }
        let s = tr.session
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        s.stats.statuses["\(code)", default: 0] += 1
        guard (200..<300).contains(code) else {
            completionHandler(.cancel)
            transfers[dataTask.taskIdentifier] = nil
            tr.conn.transfer = nil
            mediaRefused(s, tr.id, tr.conn, tr.req, code: code, seen: tr.seen, attempt: tr.attempt)
            return
        }
        let http = response as? HTTPURLResponse
        let len: Int64? = response.expectedContentLength >= 0 ? response.expectedContentLength : nil
        let role = s.entries[tr.id].role
        let ctype = Self.contentType(s.entries[tr.id].name)
        let connHdr = tr.req.close ? "Connection: close\r\n" : ""
        var status = "200 OK"
        var rangeHdr = ""
        switch (code, tr.req.range) {
        case (206, _):
            if let cr = http?.value(forHTTPHeaderField: "Content-Range"), !cr.contains("\r"), !cr.contains("\n") {
                rangeHdr = "Content-Range: \(cr)\r\n"
            }
            status = "206 Partial Content"
            tr.left = len
        case (_, let range?):
            if let total = len {
                switch Self.parseRange(range, size: total) {
                case .some(.some(let (a, b))):
                    s.stats.rangesEmulated += 1
                    status = "206 Partial Content"
                    rangeHdr = "Content-Range: bytes \(a)-\(b)/\(total)\r\n"
                    tr.skip = a
                    tr.left = b - a + 1
                case .some(.none):
                    tr.left = total
                case .none:
                    completionHandler(.cancel)
                    transfers[dataTask.taskIdentifier] = nil
                    write(tr.conn, Data("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */\(total)\r\nContent-Length: 0\r\n\(connHdr)\r\n".utf8))
                    finished(tr.conn, tr.req)
                    return
                }
            } else if range.replacingOccurrences(of: " ", with: "") == "bytes=0-" {
                tr.left = nil
            } else {
                completionHandler(.cancel)
                transfers[dataTask.taskIdentifier] = nil
                tr.conn.transfer = nil
                fail(tr.conn, tr.req, .status(502), s)
                return
            }
        default:
            tr.left = len
        }
        if role == .segment { s.stats.segments += 1 }
        if tr.held { s.stats.recovered += 1 }
        tr.length = tr.left
        tr.sniff = role == .segment && tr.req.range == nil && code == 200
        tr.chunked = tr.left == nil
        tr.head = "HTTP/1.1 \(status)\r\nContent-Type: \(ctype)\r\nAccept-Ranges: bytes\r\n%LENGTH%\(rangeHdr)Cache-Control: no-store\r\n\(connHdr)\r\n"
        if tr.req.method == "HEAD" {
            tr.sniff = false
            writeHead(tr)
            completionHandler(.cancel)
            transfers[dataTask.taskIdentifier] = nil
            finished(tr.conn, tr.req)
            return
        }
        if !tr.sniff { writeHead(tr) }
        completionHandler(.allow)
    }

    private func writeHead(_ tr: Transfer) {
        guard !tr.headWritten else { return }
        tr.headWritten = true
        let length = tr.left.map { "Content-Length: \($0)\r\n" } ?? "Transfer-Encoding: chunked\r\n"
        write(tr.conn, Data(tr.head.replacingOccurrences(of: "%LENGTH%", with: length).utf8))
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let tr = transfers[dataTask.taskIdentifier] else { return }
        var chunk = data
        if tr.skip > 0 {
            let n = Int(min(Int64(chunk.count), tr.skip))
            chunk.removeFirst(n)
            tr.skip -= Int64(n)
            if chunk.isEmpty { return }
        }
        if tr.sniff {
            tr.sniffed.append(chunk)
            guard let cut = Self.fakeHeaderCut(tr.sniffed, final: false) else { return }
            tr.sniff = false
            chunk = tr.sniffed
            tr.sniffed = Data()
            if cut > 0 {
                chunk.removeFirst(cut)
                tr.session.stats.strippedHeaders += 1
                if let l = tr.left { tr.left = max(0, l - Int64(cut)) }
            }
            writeHead(tr)
        }
        send(tr, chunk)
    }

    private func send(_ tr: Transfer, _ data: Data) {
        var chunk = data
        if let l = tr.left {
            if l <= 0 { return }
            if Int64(chunk.count) > l { chunk = chunk.prefix(Int(l)) }
            tr.left = l - Int64(chunk.count)
        }
        guard !chunk.isEmpty else { return }
        tr.sent += Int64(chunk.count)
        tr.session.stats.bytes += Int64(chunk.count)
        if tr.chunked {
            var framed = Data(String(chunk.count, radix: 16).utf8)
            framed.append(Data("\r\n".utf8))
            framed.append(chunk)
            framed.append(Data("\r\n".utf8))
            write(tr.conn, framed)
        } else {
            write(tr.conn, chunk)
        }
        // Back-pressure: the upstream read waits for the player.
        if tr.conn.unsent > Self.highWater, !tr.suspended, let task = tr.task {
            tr.suspended = true
            task.suspend()
            tr.conn.onDrain = { [weak tr] in
                guard let tr, tr.suspended else { return }
                tr.suspended = false
                tr.task?.resume()
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let tr = transfers.removeValue(forKey: task.taskIdentifier) else { return }
        let c = tr.conn
        guard !c.gone else { return }
        if tr.sniff {
            // Short body: decide on what came.
            tr.sniff = false
            var body = tr.sniffed
            let cut = Self.fakeHeaderCut(body, final: true) ?? 0
            if cut > 0 {
                body.removeFirst(cut)
                tr.session.stats.strippedHeaders += 1
                if let l = tr.left { tr.left = max(0, l - Int64(cut)) }
            }
            if error == nil, tr.left == nil || tr.left == Int64(body.count) {
                if !tr.chunked { tr.left = Int64(body.count) }
                writeHead(tr)
                send(tr, body)
            } else if !tr.headWritten {
                c.transfer = nil
                if tr.attempt < 3 {
                    serveMedia(tr.session, tr.id, c, tr.req, held: tr.held, attempt: tr.attempt + 1)
                } else {
                    fail(c, tr.req, .status(502), tr.session)
                }
                return
            }
        }
        if let error {
            let cancelled = (error as NSError).code == NSURLErrorCancelled
            if !tr.headWritten && !cancelled {
                tr.session.stats.statuses["network", default: 0] += 1
                c.transfer = nil
                if tr.attempt < 3 {
                    q.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                        guard let self, !c.gone else { return }
                        self.serveMedia(tr.session, tr.id, c, tr.req, held: tr.held, attempt: tr.attempt + 1)
                    }
                } else {
                    fail(c, tr.req, .status(502), tr.session)
                }
                return
            }
            // Upstream broke mid-body: the promised length cannot be kept.
            hangUp(c)
            return
        }
        if tr.chunked {
            write(c, Data("0\r\n\r\n".utf8))
        } else if let l = tr.left, l > 0 {
            hangUp(c)
            return
        }
        maybeStats(tr.session)
        finished(c, tr.req)
    }

    /// Where the media starts in a segment's first bytes (src/stream
    /// `disguise_offset`): 0 for plain media; after a fake image header
    /// (PNG/JPEG/GIF/BMP), the first offset with 5 MPEG-TS sync bytes 188
    /// apart or an fMP4 box; nil when more bytes are needed (`final`: no
    /// more will come).
    static func fakeHeaderCut(_ d: Data, final: Bool) -> Int? {
        let b = [UInt8](d.prefix(64 * 1024))
        guard b.count >= 8 else { return final ? 0 : nil }
        let image = b.starts(with: [0x89, 0x50, 0x4E, 0x47]) || b.starts(with: [0xFF, 0xD8, 0xFF])
            || b.starts(with: Array("GIF8".utf8)) || b.starts(with: Array("BM".utf8))
        if !image { return 0 }
        // "GIF8" starts with the TS sync byte: real TS keeps its packets.
        if b.count >= 753, (0..<5).allSatisfy({ b[188 * $0] == 0x47 }) { return 0 }
        let boxes: [[UInt8]] = ["ftyp", "styp", "moof", "sidx"].map { Array($0.utf8) }
        for k in 1..<b.count {
            if b[k] == 0x47, k + 188 * 4 < b.count, (1..<5).allSatisfy({ b[k + 188 * $0] == 0x47 }) { return k }
            if k + 8 <= b.count, boxes.contains(Array(b[(k + 4)..<(k + 8)])) {
                let size = Int(b[k]) << 24 | Int(b[k + 1]) << 16 | Int(b[k + 2]) << 8 | Int(b[k + 3])
                if size >= 8 && size < 1 << 26 { return k }
            }
        }
        if b.count >= 64 * 1024 || final { return 0 }
        return nil
    }

    // MARK: - Ops

    private func emit(_ s: Session, _ type: String, _ extra: [String: Any] = [:]) {
        var v: [String: Any] = ["sid": s.sid, "type": type]
        for (k, x) in extra { v[k] = x }
        sink?(v)
    }

    private func maybeStats(_ s: Session, force: Bool = false) {
        guard force || Date().timeIntervalSince(s.lastStats) >= 5 else { return }
        s.lastStats = Date()
        emit(s, "stats", ["stats": s.statsJSON()])
    }

    private func baseURL(_ sid: String) -> String { "http://127.0.0.1:\(port)/\(token)/s/\(sid)/" }

    private static func validURL(_ s: String?) -> String? {
        guard let s = s?.trimmingCharacters(in: .whitespacesAndNewlines), let u = URL(string: s),
              let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https", u.host?.isEmpty == false
        else { return nil }
        return s
    }

    /// The page's headers for the stream; transfer headers and values with
    /// CR/LF dropped; `cookies` wins over a Cookie header.
    static func parseHeaders(_ v: Any?, cookies: Any?) -> [String: String]? {
        var out: [String: String]?
        if let h = v as? [String: Any] {
            let reserved: Set<String> = ["range", "host", "content-length", "connection", "accept-encoding", "transfer-encoding"]
            var o: [String: String] = [:]
            for (k, raw) in h {
                let val: String
                if let s = raw as? String { val = s } else if let n = raw as? NSNumber { val = n.stringValue } else { continue }
                guard !k.isEmpty, k.count < 256, val.count < 16384,
                      !k.contains(where: { $0 == "\r" || $0 == "\n" || $0 == ":" || $0 == " " }),
                      !val.contains(where: { $0 == "\r" || $0 == "\n" }),
                      !reserved.contains(k.lowercased())
                else { continue }
                o[k] = val
            }
            out = o
        }
        if let c = cookies as? String, !c.isEmpty, !c.contains(where: { $0 == "\r" || $0 == "\n" }) {
            var o = out ?? [:]
            for k in o.keys where k.lowercased() == "cookie" { o[k] = nil }
            o["Cookie"] = c
            out = o
        }
        return out
    }

    func call(_ name: String, _ data: [String: Any]) async -> [String: Any] {
        await withCheckedContinuation { cont in
            q.async { cont.resume(returning: self.handle(name, data)) }
        }
    }

    private func handle(_ name: String, _ d: [String: Any]) -> [String: Any] {
        switch name {
        case "dl.stream.open": return open(d)
        case "dl.stream.update": return update(d)
        case "dl.stream.close": return close(d)
        case "dl.stream.stats": return stats(d)
        case "dl.stream.debug": return debug(d)
        default: return ["ok": false, "error": "unknown op"]
        }
    }

    private func open(_ d: [String: Any]) -> [String: Any] {
        guard let url = Self.validURL(d["url"] as? String) else { return ["ok": false, "error": "bad url"] }
        guard ensureListening() != 0 else { return ["ok": false, "error": "no local proxy"] }
        let key = (d["key"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        if let key, let s = sessions.values.first(where: { $0.key == key && $0.closed == nil }) {
            s.refs += 1
            s.lastActivity = Date()
            return ["ok": true, "sid": s.sid, "url": baseURL(s.sid) + s.entries[0].name]
        }
        let kind: String
        switch d["kind"] as? String {
        case "file": kind = "file"
        case "hls": kind = "hls"
        default: kind = url.lowercased().contains(".m3u8") ? "hls" : "file"
        }
        let headers = Self.parseHeaders(d["headers"], cookies: d["cookies"]) ?? [:]
        let sid = Self.randomHex(8)
        let s = Session(sid: sid, key: key, kind: kind, url: url, headers: headers)
        while sessions.count >= Self.maxSessions, let oldest = sessions.values.min(by: { $0.created < $1.created }) {
            sessions[oldest.sid] = nil
            closeSession(oldest, "replaced")
        }
        sessions[sid] = s
        NSLog("rustflix/stream: session %@ opened (%@)", sid, kind)
        #if DEBUG
        // Tests: `-rustflixDebugForce403After <s>` — the next upstream answer
        // of this session, that long after it opened, is a 403 (an expiry
        // while the player plays from its buffer).
        let after = UserDefaults.standard.double(forKey: "rustflixDebugForce403After")
        if after > 0 {
            q.asyncAfter(deadline: .now() + after) { [weak s] in
                guard let s, s.closed == nil else { return }
                NSLog("rustflix/stream: debug: forcing a 403 on session %@", s.sid)
                s.force = (403, 1)
            }
        }
        #endif
        return ["ok": true, "sid": sid, "url": baseURL(sid) + s.entries[0].name]
    }

    private func update(_ d: [String: Any]) -> [String: Any] {
        guard let sid = d["sid"] as? String, let s = sessions[sid] else { return ["ok": false, "error": "no such session"] }
        guard let url = Self.validURL(d["url"] as? String) else { return ["ok": false, "error": "bad url"] }
        if s.closed != nil { return ["ok": false, "error": "closed"] }
        let same = s.entries[0].url == url
        s.t.gen += 1
        s.t.setEntryURL(url)
        if same {
            // The same link again: every URL it listed still stands — no
            // playlist needs reading again before the held requests retry.
            s.t.carryOver()
            for (k, g) in s.rewritten where g == s.gen - 1 { s.rewritten[k] = s.gen }
        }
        if let h = Self.parseHeaders(d["headers"], cookies: d["cookies"]) { s.headers = h }
        s.stats.updates += 1
        s.lastActivity = Date()
        NSLog("rustflix/stream: session %@ has a fresh link (generation %d)", sid, s.gen)
        emit(s, "updated", ["generation": s.gen])
        let waiting = s.waiters
        s.waiters = [:]
        for f in waiting.values { f(true) }
        return ["ok": true]
    }

    private func close(_ d: [String: Any]) -> [String: Any] {
        guard let sid = d["sid"] as? String, let s = sessions[sid] else { return ["ok": false] }
        s.refs -= 1
        if s.refs <= 0 {
            sessions[sid] = nil
            closeSession(s, "closed")
        }
        return ["ok": true]
    }

    private func stats(_ d: [String: Any]) -> [String: Any] {
        guard let sid = d["sid"] as? String, let s = sessions[sid] else { return ["ok": false] }
        return ["ok": true, "stats": s.statsJSON(),
                "closed": s.closed ?? NSNull(), "generation": s.gen]
    }

    private func debug(_ d: [String: Any]) -> [String: Any] {
        guard let sid = d["sid"] as? String, let s = sessions[sid] else { return ["ok": false] }
        var status = (d["status"] as? NSNumber)?.intValue ?? 403
        if !(400..<600).contains(status) { status = 403 }
        let count = min(100, max(0, (d["count"] as? NSNumber)?.intValue ?? 1))
        s.force = count > 0 ? (status, count) : nil
        return ["ok": true]
    }

    private func closeSession(_ s: Session, _ why: String) {
        if s.closed == nil {
            s.closed = why
            NSLog("rustflix/stream: session %@ ended (%@)", s.sid, why)
        }
        let waiting = s.waiters
        s.waiters = [:]
        for f in waiting.values { f(false) }
        // Closing a session drops its upstream transfers and connections.
        for (k, tr) in transfers where tr.session === s {
            transfers[k] = nil
            tr.task?.cancel()
            hangUp(tr.conn)
        }
    }

    private func reap() {
        let now = Date()
        // No request for 30 min and nobody holding it open (or nothing at
        // all for 6 h: a forgotten open).
        for s in sessions.values {
            let idle = now.timeIntervalSince(s.lastActivity)
            if (idle > Self.idleReap && s.refs <= 0) || idle > 6 * 3600 {
                sessions[s.sid] = nil
                closeSession(s, "idle")
            }
        }
    }

    // MARK: - Helpers

    static func contentType(_ name: String) -> String {
        switch (name as NSString).pathExtension.lowercased() {
        case "m3u8": return "application/vnd.apple.mpegurl"
        case "ts", "m2ts": return "video/mp2t"
        case "mp4", "m4v", "cmfv": return "video/mp4"
        case "m4s": return "video/iso.segment"
        case "m4a", "cmfa": return "audio/mp4"
        case "aac": return "audio/aac"
        case "mp3": return "audio/mpeg"
        case "ac3": return "audio/ac3"
        case "ec3": return "audio/eac3"
        case "vtt", "webvtt": return "text/vtt"
        case "mkv": return "video/x-matroska"
        case "webm": return "video/webm"
        case "mov": return "video/quicktime"
        default: return "application/octet-stream"
        }
    }

    /// `bytes=a-b` / `a-` / `-n` against `size`: nil = not satisfiable,
    /// .some(nil) = not a single range (the whole body).
    static func parseRange(_ v: String, size: Int64) -> (Int64, Int64)?? {
        let t = v.trimmingCharacters(in: .whitespaces)
        guard t.hasPrefix("bytes=") else { return .some(nil) }
        let spec = String(t.dropFirst(6))
        if spec.contains(",") { return .some(nil) }
        let ab = spec.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        guard ab.count == 2 else { return .some(nil) }
        var a: Int64, b: Int64
        if ab[0].isEmpty {
            guard let n = Int64(ab[1]), n > 0, size > 0 else { return nil }
            a = max(0, size - n)
            b = size - 1
        } else {
            guard let start = Int64(ab[0]) else { return nil }
            a = start
            if ab[1].isEmpty { b = size - 1 } else {
                guard let e = Int64(ab[1]) else { return nil }
                b = min(e, size - 1)
            }
        }
        if size == 0 || a >= size || a > b { return nil }
        return .some((a, b))
    }

    /// The earliest expiry timestamp in `url` (unix seconds): Expires=,
    /// exp=, e=, … in seconds or milliseconds, at a separator (the rule of
    /// DlRetryPolicy.urlExpired / src/dl/policy.rs).
    static func expiresAt(_ url: String) -> TimeInterval? {
        let pattern = #"(?i)(?:^|[?&/~;,=])(?:expires?|exp|expiry|e|validto|valid_to|deadline)=(\d{10}|\d{13})(?=$|[&/~;,#])"#
        guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
        let ns = url as NSString
        var best: TimeInterval?
        for m in re.matches(in: url, range: NSRange(location: 0, length: ns.length)) where m.numberOfRanges > 1 {
            guard let v = Double(ns.substring(with: m.range(at: 1))) else { continue }
            let secs = v > 1e12 ? v / 1000 : v
            best = min(best ?? secs, secs)
        }
        return best
    }
}
