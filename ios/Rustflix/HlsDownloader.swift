import Foundation

// Download-engine logic that does not touch UIKit/AVFoundation, so it can
// be compiled and tested on macOS (see the report for the test harness):
//
//  - HlsPlanner: walks an HLS playlist tree (master → one variant + every
//    EXT-X-MEDIA rendition) and produces an HlsManifest: every resource
//    (segment / key / init map) to fetch, plus the playlists rewritten with
//    placeholders that are later replaced by local file names.
//  - HlsManifest: persisted per download (`<dir>/.manifest.json`) so a
//    download resumes from what is on disk, and `adopt(_:)` maps the
//    segments of a re-read playlist (fresh signed URL) onto the ones
//    already saved.
//  - DlTaskTag / DlRetryPolicy / DlExpiryTracker / DlReconcile: the
//    bookkeeping the background URLSession needs across relaunches.
//
// The transfers themselves run in DownloadManager (Downloads.swift) on a
// background URLSession, one download task per resource.

// MARK: - Errors

enum HlsError: LocalizedError {
    case http(Int, String)
    case drm
    case notText(String)
    case badURL(String)
    case empty

    var errorDescription: String? {
        switch self {
        case .http(let code, _): return "HTTP \(code) for the playlist"
        case .drm: return "DRM-protected stream can't be downloaded"
        case .notText: return "playlist is not text"
        case .badURL: return "bad playlist url"
        case .empty: return "playlist has no segments"
        }
    }

    /// Record `reason` code for this failure.
    var reason: String {
        switch self {
        case .http(let code, _): return DlRetryPolicy.isAuthStatus(code) ? "expired" : "failed"
        case .drm: return "drm"
        default: return "failed"
        }
    }
}

// MARK: - Manifest

struct HlsResourceEntry: Codable, Equatable {
    /// Absolute remote URL (signed; replaced when the playlist is re-read).
    var url: String
    /// Local base name ("f12"); the sniffed extension is appended on disk.
    var file: String
    var ext: String?
    var done: Bool
    var bytes: Int64
    /// Index of the playlist that first referenced this resource.
    var playlist: Int
    /// Kind + ordinal inside that playlist: "s17" segment, "k0" key, "m0" map.
    var slot: String

    var localName: String { ext.map { "\(file).\($0)" } ?? file }
}

struct HlsPlaylistEntry: Codable, Equatable {
    var remote: String
    var local: String
    /// Rewritten lines; resources appear as `HlsManifest.token(idx)`.
    var lines: [String]
    /// Identity used to pair playlists across re-reads: the variant /
    /// rendition attributes plus the segment count.
    var signature: String
}

struct HlsManifest: Codable, Equatable {
    var version = 1
    var playlists: [HlsPlaylistEntry] = []
    var resources: [HlsResourceEntry] = []
    var nextName = 0

    var entry: String { playlists.first?.local ?? "p0.m3u8" }
    var doneCount: Int { resources.reduce(0) { $0 + ($1.done ? 1 : 0) } }
    var doneBytes: Int64 { resources.reduce(0) { $0 + ($1.done ? $1.bytes : 0) } }
    var isComplete: Bool { !resources.isEmpty && resources.allSatisfy(\.done) }

    static func token(_ idx: Int) -> String { "\u{1}R\(idx)\u{1}" }

    /// Gives every resource a local name. Resources that match one of
    /// `old` (same playlist signature, then unique URL path, else the same
    /// kind+ordinal) keep its name and done state, so already-saved
    /// segments are not fetched again. New names never reuse a name from
    /// `old` or from files already on disk (`startName`).
    mutating func adopt(_ old: HlsManifest?, startName: Int) {
        var next = max(startName, old?.nextName ?? 0, nextName)
        // Pair playlists by signature (prefer the same index).
        var partner: [Int: Int] = [:]
        if let old {
            var used = Set<Int>()
            for (pi, p) in playlists.enumerated() {
                if pi < old.playlists.count, old.playlists[pi].signature == p.signature, !used.contains(pi) {
                    partner[pi] = pi; used.insert(pi); continue
                }
                if let qi = old.playlists.indices.first(where: {
                    !used.contains($0) && old.playlists[$0].signature == p.signature
                }) {
                    partner[pi] = qi; used.insert(qi)
                }
            }
        }
        // Per old playlist: path → [old idx], slot → old idx.
        var oldPaths: [Int: [String: [Int]]] = [:]
        var oldSlots: [Int: [String: Int]] = [:]
        if let old {
            for (j, r) in old.resources.enumerated() {
                oldPaths[r.playlist, default: [:]][Self.pathKey(r.url), default: []].append(j)
                oldSlots[r.playlist, default: [:]][r.slot] = j
            }
        }
        var newPaths: [Int: [String: Int]] = [:]
        for r in resources {
            newPaths[r.playlist, default: [:]][Self.pathKey(r.url), default: 0] += 1
        }
        var taken = Set<Int>()
        for i in resources.indices {
            var match: Int?
            if let old, let q = partner[resources[i].playlist] {
                let p = Self.pathKey(resources[i].url)
                if newPaths[resources[i].playlist]?[p] == 1,
                   let js = oldPaths[q]?[p], js.count == 1, old.resources[js[0]].slot.first == resources[i].slot.first {
                    match = js[0]
                } else if let j = oldSlots[q]?[resources[i].slot] {
                    match = j
                }
                if let j = match, taken.contains(j) { match = nil }
            }
            if let old, let j = match {
                taken.insert(j)
                let o = old.resources[j]
                resources[i].file = o.file
                resources[i].ext = o.ext
                resources[i].done = o.done
                resources[i].bytes = o.bytes
            } else {
                resources[i].file = "f\(next)"
                resources[i].ext = nil
                resources[i].done = false
                resources[i].bytes = 0
                next += 1
            }
        }
        nextName = next
    }

    /// Files on disk are the truth: a resource whose file exists was saved
    /// (files are only moved into their final name once validated), even
    /// if the manifest was not written after it landed.
    mutating func markFromDisk(existing names: Set<String>, size: (String) -> Int64) {
        for i in resources.indices where !resources[i].done {
            let f = resources[i].file
            for ext in ["ts", "m4s", "aac", nil] as [String?] {
                let n = ext.map { "\(f).\($0)" } ?? f
                if names.contains(n) {
                    resources[i].ext = ext
                    resources[i].done = true
                    resources[i].bytes = size(n)
                    break
                }
            }
        }
    }

    /// Final text of playlist `pi`, placeholders replaced by local names.
    func render(_ pi: Int) -> String {
        guard pi < playlists.count else { return "" }
        return playlists[pi].lines.map { line -> String in
            guard line.contains("\u{1}R") else { return line }
            var out = ""
            var rest = Substring(line)
            while let a = rest.range(of: "\u{1}R") {
                out += rest[..<a.lowerBound]
                let after = rest[a.upperBound...]
                guard let b = after.firstIndex(of: "\u{1}"),
                      let idx = Int(after[..<b]), idx >= 0, idx < resources.count
                else { out += after; rest = ""; break }
                out += resources[idx].localName
                rest = after[after.index(after: b)...]
            }
            return out + rest
        }.joined(separator: "\n")
    }

    /// Every local file a finished download needs.
    var referencedFiles: Set<String> {
        Set(resources.map(\.localName)).union(playlists.map(\.local))
    }

    /// URL path without host/query — signed URLs change their query (and
    /// sometimes the edge host) between reads.
    static func pathKey(_ url: String) -> String {
        if let c = URLComponents(string: url) { return c.percentEncodedPath }
        return url
    }
}

// MARK: - Planner

final class HlsPlanner {
    typealias Fetch = (String) async throws -> String
    private let fetch: Fetch
    private var playlists: [HlsPlaylistEntry] = []
    private var resources: [HlsResourceEntry] = []
    private var byURL: [String: Int] = [:]
    private var counters: [Int: [Character: Int]] = [:]
    /// Highest variant bandwidth kept (bits/s).
    static let bandwidthCap = 15_000_000

    init(fetch: @escaping Fetch) { self.fetch = fetch }

    func plan(url: String) async throws -> HlsManifest {
        let text = try await fetch(url)
        _ = try await walk(text, remote: url, role: "root")
        guard !resources.isEmpty else { throw HlsError.empty }
        var m = HlsManifest()
        m.playlists = playlists
        m.resources = resources
        return m
    }

    private func register(_ abs: String, playlist: Int, kind: Character) -> Int {
        if let i = byURL[abs] { return i }
        let ord = counters[playlist, default: [:]][kind, default: 0]
        counters[playlist, default: [:]][kind] = ord + 1
        resources.append(HlsResourceEntry(
            url: abs, file: "", ext: nil, done: false, bytes: 0,
            playlist: playlist, slot: "\(kind)\(ord)"))
        byURL[abs] = resources.count - 1
        return resources.count - 1
    }

    private func walk(_ text: String, remote: String, role: String) async throws -> Int {
        let myIdx = playlists.count
        playlists.append(HlsPlaylistEntry(remote: remote, local: "p\(myIdx).m3u8", lines: [], signature: ""))
        var lines = text.components(separatedBy: "\n").map {
            $0.hasSuffix("\r") ? String($0.dropLast()) : $0
        }
        let isMaster = text.contains("#EXT-X-STREAM-INF")
            || text.contains("#EXT-X-I-FRAME-STREAM-INF")
            || text.contains("#EXT-X-MEDIA:")
        // Master playlists offer several renditions — keep exactly one
        // variant (best bandwidth under the cap) plus every EXT-X-MEDIA
        // rendition (audio/subtitle tracks are small).
        var keepUris: Set<String> = []
        if isMaster {
            var bestBw = -1, lowestBw = Int.max
            var bestUri: String?, lowestUri: String?
            var i = 0
            while i < lines.count {
                let t = lines[i].trimmingCharacters(in: .whitespacesAndNewlines)
                if t.hasPrefix("#EXT-X-STREAM-INF:") {
                    var j = i + 1
                    while j < lines.count {
                        let u = lines[j].trimmingCharacters(in: .whitespacesAndNewlines)
                        if u.isEmpty { j += 1; continue }
                        if !u.hasPrefix("#") {
                            let bw = Int(Self.attr(t, "BANDWIDTH") ?? "0") ?? 0
                            if bw <= Self.bandwidthCap && bw > bestBw { bestBw = bw; bestUri = u }
                            if bw < lowestBw { lowestBw = bw; lowestUri = u }
                        }
                        break
                    }
                }
                i += 1
            }
            if let chosen = bestUri ?? lowestUri { keepUris.insert(Self.resolve(chosen, base: remote)) }
            for line in lines {
                let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if t.hasPrefix("#EXT-X-MEDIA:"), let uri = Self.attr(t, "URI") {
                    keepUris.insert(Self.resolve(uri, base: remote))
                }
            }
        }
        var pendingInf: Int?
        var pendingAttrs = ""
        var segLines = 0

        for i in lines.indices {
            let raw = lines[i]
            let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { continue }

            if t.hasPrefix("#EXT-X-KEY:") || t.hasPrefix("#EXT-X-SESSION-KEY:") {
                if t.contains("METHOD=SAMPLE-AES") || t.contains("METHOD=FDK-AES")
                    || t.contains("KEYFORMAT=\"com.apple.streamingkeydelivery\"") {
                    throw HlsError.drm
                }
                if t.hasPrefix("#EXT-X-SESSION-KEY:") { lines[i] = ""; continue }
                if let uri = Self.attr(t, "URI") {
                    let idx = register(Self.resolve(uri, base: remote), playlist: myIdx, kind: "k")
                    lines[i] = raw.replacingOccurrences(of: "URI=\"\(uri)\"", with: "URI=\"\(HlsManifest.token(idx))\"")
                }
                continue
            }
            if t.hasPrefix("#EXT-X-MAP:") {
                if let uri = Self.attr(t, "URI") {
                    let idx = register(Self.resolve(uri, base: remote), playlist: myIdx, kind: "m")
                    lines[i] = raw.replacingOccurrences(of: "URI=\"\(uri)\"", with: "URI=\"\(HlsManifest.token(idx))\"")
                }
                continue
            }
            if t.hasPrefix("#EXT-X-I-FRAME-STREAM-INF:") || t.hasPrefix("#EXT-X-SESSION-DATA:") {
                lines[i] = "" // trickplay / session data: not needed offline
                continue
            }
            if t.hasPrefix("#EXT-X-MEDIA:") {
                if let uri = Self.attr(t, "URI") {
                    let abs = Self.resolve(uri, base: remote)
                    if keepUris.contains(abs) {
                        let sig = ["TYPE", "GROUP-ID", "NAME", "LANGUAGE"]
                            .map { Self.attr(t, $0) ?? "" }.joined(separator: ",")
                        let sub = try await subPlaylist(abs, role: "media:\(sig)")
                        lines[i] = raw.replacingOccurrences(of: "URI=\"\(uri)\"", with: "URI=\"\(sub)\"")
                    } else {
                        lines[i] = ""
                    }
                }
                continue
            }
            if t.hasPrefix("#") {
                if t.hasPrefix("#EXT-X-STREAM-INF") {
                    pendingInf = i
                    pendingAttrs = ["BANDWIDTH", "RESOLUTION", "CODECS"]
                        .map { Self.attr(t, $0) ?? "" }.joined(separator: ",")
                }
                continue
            }
            // Bare URI line: variant playlist (master) or segment (media).
            let abs = Self.resolve(t, base: remote)
            if isMaster || pendingInf != nil {
                if keepUris.contains(abs) {
                    lines[i] = try await subPlaylist(abs, role: "variant:\(pendingAttrs)")
                } else {
                    // Drop unselected variants entirely so the offline
                    // player never tries to switch to a remote rendition.
                    lines[i] = ""
                    if let p = pendingInf { lines[p] = "" }
                }
                pendingInf = nil
            } else {
                let idx = register(abs, playlist: myIdx, kind: "s")
                lines[i] = HlsManifest.token(idx)
                segLines += 1
            }
        }
        playlists[myIdx].lines = lines
        playlists[myIdx].signature = "\(role)|n=\(segLines)"
        return myIdx
    }

    private func subPlaylist(_ abs: String, role: String) async throws -> String {
        let text = try await fetch(abs)
        let idx = try await walk(text, remote: abs, role: role)
        return playlists[idx].local
    }

    /// `KEY="value"` attribute (quoted or bare token up to a comma).
    static func attr(_ line: String, _ key: String) -> String? {
        // Match at an attribute boundary so "URI" doesn't hit "X-URI".
        var searchStart = line.startIndex
        while let r = line.range(of: "\(key)=", range: searchStart..<line.endIndex) {
            let ok = r.lowerBound == line.startIndex
                || [",", ":"].contains(line[line.index(before: r.lowerBound)])
            if !ok { searchStart = r.upperBound; continue }
            var s = String(line[r.upperBound...])
            if s.hasPrefix("\"") {
                guard let end = s.dropFirst().firstIndex(of: "\"") else { return nil }
                return String(s.dropFirst()[..<end])
            }
            if let comma = s.firstIndex(of: ",") { s = String(s[..<comma]) }
            return s.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }

    /// Resolves a playlist URI (relative or absolute) against its playlist.
    static func resolve(_ uri: String, base: String) -> String {
        if uri.hasPrefix("http://") || uri.hasPrefix("https://") { return uri }
        guard let b = URL(string: base) else { return uri }
        // RFC 3986 resolution (handles "../", "//host", queries).
        if let u = URL(string: uri, relativeTo: b) { return u.absoluteString }
        if let enc = uri.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
           let u = URL(string: enc, relativeTo: b) {
            return u.absoluteString
        }
        return uri
    }
}

// MARK: - Playlist fetch (foreground; playlists are few and small)

final class HlsPlaylistFetcher {
    private let headers: [String: String]
    private let session: URLSession
    private let attempts: Int

    init(headers: [String: String], allowsCellular: Bool, attempts: Int = 20) {
        self.headers = headers
        self.attempts = attempts
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 30
        c.allowsCellularAccess = allowsCellular
        c.httpCookieStorage = .shared
        session = URLSession(configuration: c)
    }

    func invalidate() { session.finishTasksAndInvalidate() }

    func fetch(_ url: String) async throws -> String {
        guard let u = URL(string: url) else { throw HlsError.badURL(url) }
        var req = URLRequest(url: u)
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        var lastError: Error = HlsError.badURL(url)
        for attempt in 0..<attempts {
            try Task.checkCancellation()
            do {
                let (data, resp) = try await session.data(for: req)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 200
                if (200..<300).contains(code) {
                    if DlSniff.looksLikeErrorPage(data.prefix(512), size: Int64(data.count)) {
                        lastError = HlsError.notText(url)
                    } else if let text = String(data: data, encoding: .utf8), text.contains("#EXT") {
                        return text
                    } else {
                        throw HlsError.notText(url)
                    }
                } else if (400..<500).contains(code) && code != 429 && code != 408 {
                    // 4xx won't heal on retry (401/403/410 → expired link).
                    throw HlsError.http(code, url)
                } else {
                    lastError = HlsError.http(code, url)
                }
            } catch let e as HlsError {
                throw e
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                lastError = error
            }
            let base = min(0.4 * pow(2.0, Double(min(attempt, 4))), 6.0)
            try await Task.sleep(nanoseconds: UInt64((base + Double.random(in: 0...0.3)) * 1_000_000_000))
        }
        throw lastError
    }
}

// MARK: - Sniffing

enum DlSniff {
    /// Container sniff: MPEG-TS sync byte, ADTS AAC sync, otherwise fMP4.
    static func ext(_ data: Data) -> String? {
        guard data.count > 8 else { return nil }
        let b = [UInt8](data.prefix(12))
        if b[0] == 0x47 { return "ts" }
        if b[0] == 0xFF && (b[1] & 0xF0) == 0xF0 { return "aac" }
        let tag = String(bytes: b[4..<8], encoding: .ascii)
        if tag == "ftyp" || tag == "styp" || tag == "moof" || tag == "moov" { return "m4s" }
        return nil
    }

    /// Some edges answer 200 with a small HTML error page instead of media.
    static func looksLikeErrorPage(_ head: Data, size: Int64) -> Bool {
        guard size < 4096 else { return false }
        let s = String(data: head.prefix(256), encoding: .utf8)?.lowercased() ?? ""
        return s.contains("<html") || s.contains("<!doctype") || s.contains("<head")
    }

    /// Extension for a progressive download.
    static func fileExt(suggested: String?, mime: String?, urlPath: String) -> String {
        let known: Set<String> = ["mp4", "m4v", "webm", "mov", "mkv", "ts", "m2ts"]
        for name in [suggested ?? "", urlPath] {
            let e = (name as NSString).pathExtension.lowercased()
            if known.contains(e) { return e }
        }
        switch (mime ?? "").lowercased() {
        case "video/webm": return "webm"
        case "video/quicktime": return "mov"
        case "video/x-matroska": return "mkv"
        case "video/mp2t": return "ts"
        default: return "mp4"
        }
    }
}

// MARK: - Task tags (survive relaunch via URLSessionTask.taskDescription)

enum DlTaskKind: Equatable {
    case file
    case hls(index: Int, file: String)
}

struct DlTaskTag: Equatable {
    var rid: Int
    var gen: Int
    var kind: DlTaskKind

    var encoded: String {
        switch kind {
        case .file: return "rfx1|f|\(rid)|\(gen)"
        case .hls(let i, let f): return "rfx1|h|\(rid)|\(gen)|\(i)|\(f)"
        }
    }

    init(rid: Int, gen: Int, kind: DlTaskKind) {
        self.rid = rid; self.gen = gen; self.kind = kind
    }

    init?(_ s: String?) {
        guard let p = s?.split(separator: "|", omittingEmptySubsequences: false).map(String.init),
              p.count >= 4, p[0] == "rfx1", let rid = Int(p[2]), let gen = Int(p[3]), rid > 0
        else { return nil }
        self.rid = rid; self.gen = gen
        if p[1] == "f" && p.count == 4 {
            kind = .file
        } else if p[1] == "h", p.count == 6, let i = Int(p[4]), i >= 0, DlNames.isSafe(p[5]) {
            kind = .hls(index: i, file: p[5])
        } else {
            return nil
        }
    }
}

enum DlNames {
    /// Local resource names are "f<digits>".
    static func isSafe(_ name: String) -> Bool {
        name.count > 1 && name.count < 16 && name.hasPrefix("f") && name.dropFirst().allSatisfy(\.isASCII)
            && name.dropFirst().allSatisfy(\.isNumber)
    }

    /// First "f<N>" index not used by any file in `names`.
    static func nextIndex(in names: [String]) -> Int {
        var maxN = -1
        for n in names where n.hasPrefix("f") {
            let digits = n.dropFirst().prefix { $0.isASCII && $0.isNumber }
            if let v = Int(digits), !digits.isEmpty { maxN = max(maxN, v) }
        }
        return maxN + 1
    }

    /// Accepts ids from JS (Int / Double / NSNumber / numeric String).
    static func id(_ v: Any?) -> Int? {
        var out: Int?
        switch v {
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return nil }
            let d = n.doubleValue
            if d.isFinite, d == d.rounded(), abs(d) < 1e15 { out = Int(d) }
        case let i as Int: out = i
        case let d as Double: if d.isFinite, d == d.rounded(), abs(d) < 1e15 { out = Int(d) }
        case let s as String: out = Int(s.trimmingCharacters(in: .whitespaces))
        default: out = nil
        }
        guard let o = out, o > 0 else { return nil }
        return o
    }
}

// MARK: - Retry / expiry policy

enum DlFailure: Equatable {
    case auth(Int)      // 401 / 403 / 410
    case client(Int)    // other 4xx (except 408/429)
    case server         // 5xx, 408, 429, HTML error page
    case network        // connectivity
    case other
}

enum DlRetryPolicy {
    static func isAuthStatus(_ code: Int) -> Bool { code == 401 || code == 403 || code == 410 }

    static func classify(status: Int?, urlErrorCode: Int?, badBody: Bool) -> DlFailure {
        if badBody { return .server }
        if let s = status {
            if isAuthStatus(s) { return .auth(s) }
            if s == 408 || s == 429 || s >= 500 { return .server }
            if (400..<500).contains(s) { return .client(s) }
        }
        if let c = urlErrorCode {
            let net: Set<Int> = [
                NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost,
                NSURLErrorTimedOut, NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost,
                NSURLErrorDNSLookupFailed, NSURLErrorInternationalRoamingOff,
                NSURLErrorDataNotAllowed, NSURLErrorCallIsActive, NSURLErrorCancelled,
                NSURLErrorBackgroundSessionWasDisconnected, NSURLErrorSecureConnectionFailed,
                NSURLErrorCannotLoadFromNetwork,
            ]
            return net.contains(c) ? .network : .other
        }
        return .other
    }

    /// Attempts allowed per resource before the download fails.
    static func limit(_ f: DlFailure) -> Int {
        switch f {
        case .network: return 30
        case .server: return 10
        case .auth: return 3
        case .client: return 3
        case .other: return 6
        }
    }

    /// Delay before attempt `attempt` (1-based) of a failed resource.
    static func backoff(_ attempt: Int, _ f: DlFailure) -> TimeInterval {
        let cap: Double = f == .network ? 60 : 20
        return min(cap, 0.5 * pow(2.0, Double(max(0, min(attempt - 1, 8)))))
    }

    /// True when the URL carries an expiry timestamp that has passed
    /// (Expires=, exp=, e=, … in seconds or milliseconds; also the
    /// `exp=…~acl=` form of Akamai tokens).
    static func urlExpired(_ url: String, now: Date) -> Bool {
        let pattern = #"(?i)(?:^|[?&/~;,=])(?:expires?|exp|expiry|e|validto|valid_to|deadline)=(\d{10}|\d{13})(?=$|[&/~;,#])"#
        guard let re = try? NSRegularExpression(pattern: pattern) else { return false }
        let ns = url as NSString
        for m in re.matches(in: url, range: NSRange(location: 0, length: ns.length)) where m.numberOfRanges > 1 {
            guard let v = Double(ns.substring(with: m.range(at: 1))) else { continue }
            let secs = v > 1e12 ? v / 1000 : v
            if secs < now.timeIntervalSince1970 { return true }
        }
        return false
    }
}

/// Decides when auth failures mean "the signed link expired" rather than
/// a transient CDN 403: a 410, an expiry timestamp in the past, the same
/// resource refused 3 times, or 6 distinct resources refused with no
/// success in between.
struct DlExpiryTracker {
    static let distinctThreshold = 6
    static let perResourceThreshold = 3
    private(set) var streak = Set<Int>()
    private(set) var perResource: [Int: Int] = [:]

    mutating func success(_ idx: Int) {
        streak.removeAll()
        perResource[idx] = nil
    }

    /// Returns true when the record should be marked `expired`.
    mutating func authFailure(_ idx: Int, status: Int, url: String, now: Date) -> Bool {
        let n = (perResource[idx] ?? 0) + 1
        perResource[idx] = n
        streak.insert(idx)
        return status == 410
            || DlRetryPolicy.urlExpired(url, now: now)
            || n >= Self.perResourceThreshold
            || streak.count >= Self.distinctThreshold
    }
}

// MARK: - Launch reconciliation

struct DlReconcileRecord {
    var id: Int
    var status: String
    var kind: String
    var gen: Int
    var hasManifest: Bool
}

enum DlReconcileAction: Equatable {
    /// A live task nobody owns any more: cancel it.
    case cancelTask(taskKey: String)
    /// Track this live task for record `rid` (HLS resource or file).
    case adopt(taskKey: String, rid: Int, resource: Int?)
    /// HLS with a manifest: load it, check disk, enqueue what's missing.
    case resumeHls(rid: Int)
    /// HLS with no manifest (died during the playlist walk): re-read.
    case rewalkHls(rid: Int)
    /// Progressive download with no live task: restart (resume data first).
    case restartFile(rid: Int)
}

enum DlReconcile {
    /// `tasks`: (stable task key, taskDescription) of every live task in
    /// the background sessions. Records still `running` always end up
    /// with either a live task or a restart action — never stale.
    static func plan(records: [DlReconcileRecord], tasks: [(key: String, desc: String?)]) -> [DlReconcileAction] {
        var out: [DlReconcileAction] = []
        let byId = Dictionary(records.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var liveFile = Set<Int>()
        for t in tasks {
            guard let tag = DlTaskTag(t.desc), let r = byId[tag.rid],
                  r.status == "running", r.gen == tag.gen
            else { out.append(.cancelTask(taskKey: t.key)); continue }
            switch tag.kind {
            case .file:
                if r.kind == "file", !liveFile.contains(r.id) {
                    liveFile.insert(r.id)
                    out.append(.adopt(taskKey: t.key, rid: r.id, resource: nil))
                } else {
                    out.append(.cancelTask(taskKey: t.key))
                }
            case .hls(let i, _):
                if r.kind == "hls" && r.hasManifest {
                    out.append(.adopt(taskKey: t.key, rid: r.id, resource: i))
                } else {
                    out.append(.cancelTask(taskKey: t.key))
                }
            }
        }
        for r in records.sorted(by: { $0.id < $1.id }) where r.status == "running" {
            if r.kind == "hls" {
                out.append(r.hasManifest ? .resumeHls(rid: r.id) : .rewalkHls(rid: r.id))
            } else if !liveFile.contains(r.id) {
                out.append(.restartFile(rid: r.id))
            }
        }
        return out
    }
}
