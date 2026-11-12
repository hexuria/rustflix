import Foundation

// Minimal HLS (m3u8) downloader: fetches the playlist tree, downloads
// every segment/key/init/media-playlist into a flat directory and writes
// rewritten playlists whose URIs point at the local files. The result
// plays through the app's localhost media server like any other file —
// no AVAssetDownloadURLSession needed (it refuses custom schemes and
// drops the Referer/UA headers these CDNs require).
//
// Handles: master playlists, variant/media/iframe sub-playlists,
// EXT-X-KEY (AES-128 keys are just files — AVPlayer decrypts locally),
// EXT-X-MAP init segments and EXT-X-BYTERANGE passthrough. SAMPLE-AES /
// FairPlay is rejected.

/// One remote resource to fetch into `dir/<file>`.
struct HlsResource {
    var url: String
    var file: String
}

final class HlsDownloader {
    private let headers: [String: String]
    private let dir: URL
    private let session = URLSession(configuration: .default)
    /// absolute URL → local filename (segments, keys, maps).
    private var names: [String: String] = [:]
    private var nextName = 0
    /// (remoteURL, localName, final rewritten lines) per playlist.
    private var playlistJobs: [(remote: String, local: String, lines: [String])] = []
    private var resources: [HlsResource] = []
    private var resourceSet: Set<String> = []
    /// Local filename → sniffed container extension (segments are stored
    /// extensionless; demuxers need .ts/.m4s/.aac to pick a parser).
    private var exts: [String: String] = [:]
    var cancelled = false

    init(headers: [String: String], dir: URL) {
        self.headers = headers
        self.dir = dir
    }

    /// Downloads the whole tree; returns the local playlist filename.
    func run(url: String, progress: @escaping (Double, String) -> Void) async throws -> String {
        let text = try await fetchPlaylist(url)
        try await walk(text, remote: url)
        // Phase 2: download every resource, four at a time, in rounds —
        // these CDNs have bad phases where every request 5xxs for a
        // while, so failures get retried in later rounds rather than
        // killing the whole download.
        var pending = resources
        for round in 0..<5 {
            if cancelled { throw CancellationError() }
            var failed: [HlsResource] = []
            var idx = 0
            while idx < pending.count {
                if cancelled { throw CancellationError() }
                let end = min(idx + 4, pending.count)
                let batch = Array(pending[idx..<end])
                let results = await withTaskGroup(of: (HlsResource, String?, Error?).self) { group in
                    for res in batch {
                        group.addTask {
                            do { return (res, try await self.fetchResource(res), nil) }
                            catch { return (res, nil, error) }
                        }
                    }
                    var out: [(HlsResource, String?, Error?)] = []
                    for await r in group { out.append(r) }
                    return out
                }
                for (res, ext, error) in results {
                    if let error {
                        if error is CancellationError { throw error }
                        failed.append(res)
                    } else if let ext {
                        exts[res.file] = ext
                    }
                }
                idx = end
                let done = resources.count - failed.count - (pending.count - idx)
                progress(
                    Double(max(0, done)) / Double(max(1, resources.count)),
                    round > 0 ? "retrying \(failed.count)…" : "\(done)/\(resources.count)")
            }
            pending = failed
            if pending.isEmpty { break }
            if round < 4 {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
        if !pending.isEmpty {
            throw fail("\(pending.count) segments failed after retries")
        }
        // Phase 3: write the rewritten playlists, appending the sniffed
        // extension to every segment/init URI.
        for job in playlistJobs {
            let out = job.lines.map { finalize($0) }.joined(separator: "\n")
            try out.write(
                to: dir.appendingPathComponent(job.local), atomically: true, encoding: .utf8)
        }
        // The entry playlist is the first job.
        return playlistJobs.first?.local ?? "p0.m3u8"
    }

    // MARK: - phase 1: playlist walk

    private func fetchPlaylist(_ url: String) async throws -> String {
        // Playlists are few and cheap — give them a much bigger retry
        // budget than segments so a bad CDN phase can't kill the walk.
        let (data, _) = try await fetch(url, attempts: 30)
        guard let text = String(data: data, encoding: .utf8) else {
            throw fail("playlist is not text: \(url)")
        }
        return text
    }

    /// Parses one playlist into `lines` (already rewritten to local names),
    /// queues it for phase 3 and collects every resource to download.
    /// Recurses into sub-playlists.
    private func walk(_ text: String, remote: String) async throws {
        if cancelled { throw CancellationError() }
        let local = "p\(playlistJobs.count).m3u8"
        let myIdx = playlistJobs.count
        playlistJobs.append((remote, local, []))
        var lines = text.components(separatedBy: "\n")

        let isMaster = text.contains("#EXT-X-STREAM-INF")
            || text.contains("#EXT-X-I-FRAME-STREAM-INF")
            || text.contains("#EXT-X-MEDIA:")
        // Master playlists offer several video renditions — downloading
        // all of them would multiply the size several times over. Keep
        // exactly one variant (best bandwidth under the cap) plus every
        // EXT-X-MEDIA rendition (audio/subtitle tracks are small).
        var keepUris: Set<String> = []
        if isMaster {
            var bestBw = -1
            var bestUri: String?
            var lowestBw = Int.max
            var lowestUri: String?
            var i = 0
            while i < lines.count {
                let t = lines[i].trimmingCharacters(in: .whitespaces)
                if t.hasPrefix("#EXT-X-STREAM-INF:") {
                    // The variant URI is the next non-empty, non-tag line.
                    var j = i + 1
                    while j < lines.count {
                        let u = lines[j].trimmingCharacters(in: .whitespaces)
                        if u.isEmpty { j += 1; continue }
                        if !u.hasPrefix("#") {
                            let bw = Int(attr(t, "BANDWIDTH") ?? "0") ?? 0
                            if bw <= 15_000_000 && bw > bestBw { bestBw = bw; bestUri = u }
                            if bw < lowestBw { lowestBw = bw; lowestUri = u }
                        }
                        break
                    }
                }
                i += 1
            }
            let chosen = bestUri ?? lowestUri
            if let chosen { keepUris.insert(resolve(chosen, base: remote)) }
            // EXT-X-MEDIA renditions (audio/subtitles) are kept; I-frame
            // playlists are trickplay-only and dropped to save space.
            for line in lines {
                let t = line.trimmingCharacters(in: .whitespaces)
                if t.hasPrefix("#EXT-X-MEDIA:") {
                    if let uri = attr(t, "URI") {
                        keepUris.insert(resolve(uri, base: remote))
                    }
                }
            }
        }
        var pendingVariant = false

        for i in lines.indices {
            let raw = lines[i]
            let t = raw.trimmingCharacters(in: .whitespaces)
            guard !t.isEmpty else { continue }

            if t.hasPrefix("#EXT-X-KEY:") {
                if t.contains("METHOD=SAMPLE-AES") || t.contains("METHOD=FDK-AES") {
                    throw fail("DRM-protected stream can't be downloaded")
                }
                if let uri = attr(t, "URI") {
                    let abs = resolve(uri, base: remote)
                    let f = fileName(for: abs)
                    lines[i] = raw.replacingOccurrences(of: "URI=\"\(uri)\"", with: "URI=\"\(f)\"")
                }
                continue
            }
            if t.hasPrefix("#EXT-X-MAP:") {
                if let uri = attr(t, "URI") {
                    let abs = resolve(uri, base: remote)
                    let f = fileName(for: abs)
                    lines[i] = raw.replacingOccurrences(of: "URI=\"\(uri)\"", with: "URI=\"\(f)\"")
                }
                continue
            }
            if t.hasPrefix("#EXT-X-I-FRAME-STREAM-INF:") {
                lines[i] = "" // trickplay playlist: not downloaded offline
                continue
            }
            if t.hasPrefix("#EXT-X-MEDIA:") {
                if let uri = attr(t, "URI") {
                    let abs = resolve(uri, base: remote)
                    if keepUris.contains(abs) {
                        let sub = try await subPlaylist(abs)
                        lines[i] = raw.replacingOccurrences(of: "URI=\"\(uri)\"", with: "URI=\"\(sub)\"")
                    }
                    // Non-selected renditions keep their remote URI; the
                    // local server 404s them, which AVPlayer tolerates.
                }
                continue
            }
            if t.hasPrefix("#") {
                if t.hasPrefix("#EXT-X-STREAM-INF") || t.hasPrefix("#EXT-X-I-FRAME-STREAM-INF") {
                    pendingVariant = true
                }
                continue
            }
            // Bare URI line: variant playlist (master) or segment (media).
            let abs = resolve(t, base: remote)
            if isMaster || pendingVariant {
                if keepUris.contains(abs) {
                    let sub = try await subPlaylist(abs)
                    lines[i] = sub
                }
                // Non-selected variants keep the remote URI → local 404.
                pendingVariant = false
            } else {
                lines[i] = fileName(for: abs)
            }
        }
        playlistJobs[myIdx].lines = lines
    }

    /// Downloads (recursively) one sub-playlist and returns its local name.
    private func subPlaylist(_ abs: String) async throws -> String {
        let text = try await fetchPlaylist(abs)
        let before = playlistJobs.count
        try await walk(text, remote: abs)
        return playlistJobs[before].local
    }

    /// Registers `abs` as a downloadable resource and returns its local
    /// filename (deduped — keys/maps repeat across playlists).
    private func fileName(for abs: String) -> String {
        if let f = names[abs] { return f }
        let f = "f\(nextName)"
        nextName += 1
        names[abs] = f
        if resourceSet.insert(abs).inserted {
            resources.append(HlsResource(url: abs, file: f))
        }
        return f
    }

    // MARK: - phase 2: resource fetch

    private func fetchResource(_ res: HlsResource) async throws -> String? {
        let (data, _) = try await fetch(res.url, attempts: 6)
        let ext = sniffExt(data)
        let name = ext.map { "\(res.file).\($0)" } ?? res.file
        try data.write(to: dir.appendingPathComponent(name), options: .atomic)
        return ext
    }

    /// Container sniff: MPEG-TS sync byte, ADTS AAC sync, otherwise fMP4.
    private func sniffExt(_ data: Data) -> String? {
        guard data.count > 8 else { return nil }
        let b = [UInt8](data.prefix(12))
        if b[0] == 0x47 { return "ts" }
        if b[0] == 0xFF && (b[1] & 0xF0) == 0xF0 { return "aac" }
        let tag = String(bytes: b[4..<8], encoding: .ascii)
        if tag == "ftyp" || tag == "styp" || tag == "moof" || tag == "moov" { return "m4s" }
        return nil
    }

    /// Rewrites one playlist line: bare segment URIs and URI="…" attrs get
    /// the sniffed extension appended.
    private func finalize(_ line: String) -> String {
        let t = line.trimmingCharacters(in: .whitespaces)
        if let ext = exts[t] { return "\(t).\(ext)" }
        guard line.contains("URI=\"") else { return line }
        // URI="f12" → URI="f12.ts" (names are unique, replace is safe).
        for (name, ext) in exts {
            let needle = "URI=\"\(name)\""
            if line.contains(needle) {
                return line.replacingOccurrences(of: needle, with: "URI=\"\(name).\(ext)\"")
            }
        }
        return line
    }

    private func fetch(_ url: String, attempts: Int = 16) async throws -> (Data, URLResponse) {
        guard let u = URL(string: url) else { throw fail("bad url \(url)") }
        var req = URLRequest(url: u)
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        // These CDNs throw transient 5xx/403s and sometimes answer 200
        // with an HTML error page — retry with backoff and keep going
        // until the bytes look like real media.
        var lastError: Error = fail("no attempts")
        for attempt in 0..<attempts {
            if cancelled { throw CancellationError() }
            do {
                let (data, resp) = try await session.data(for: req)
                if cancelled { throw CancellationError() }
                if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                    let code = http.statusCode
                    // 4xx (except 429) won't heal on retry.
                    if (400..<500).contains(code) && code != 429 {
                        throw fail("HTTP \(code) for \(url)")
                    }
                    lastError = fail("HTTP \(code) for \(url)")
                } else if looksLikeErrorPage(data) {
                    lastError = fail("error page instead of media for \(url)")
                } else {
                    return (data, resp)
                }
            } catch let e as NSError where e.domain == "rustflix.hls" {
                throw e // our own fatal HTTP error
            } catch {
                lastError = error
            }
            // 0.4s, 0.8s, 1.6s … capped at ~6s, with jitter.
            let base = min(0.4 * pow(2.0, Double(min(attempt, 4))), 6.0)
            let jitter = Double.random(in: 0...0.3)
            try? await Task.sleep(nanoseconds: UInt64((base + jitter) * 1_000_000_000))
        }
        throw lastError
    }

    /// Some edges answer 200 with a small HTML error page instead of the
    /// segment — treat that as a failed fetch, not media.
    private func looksLikeErrorPage(_ data: Data) -> Bool {
        guard data.count < 4096 else { return false }
        let head = String(data: data.prefix(256), encoding: .utf8)?.lowercased() ?? ""
        return head.contains("<html") || head.contains("<!doctype") || head.contains("<head")
    }

    // MARK: - helpers

    /// `KEY="value"` attribute (quoted or bare token up to a comma).
    private func attr(_ line: String, _ key: String) -> String? {
        guard let r = line.range(of: "\(key)=") else { return nil }
        var s = String(line[r.upperBound...])
        if s.hasPrefix("\"") {
            guard let end = s.dropFirst().firstIndex(of: "\"") else { return nil }
            return String(s.dropFirst()[..<end])
        }
        if let comma = s.firstIndex(of: ",") { s = String(s[..<comma]) }
        return s.trimmingCharacters(in: .whitespaces)
    }

    /// Resolves a playlist URI (relative or absolute) against its playlist.
    private func resolve(_ uri: String, base: String) -> String {
        if uri.hasPrefix("http://") || uri.hasPrefix("https://") { return uri }
        guard let b = URL(string: base) else { return uri }
        // Split query off the relative reference first.
        var pathPart = uri
        var query = ""
        if let qi = uri.firstIndex(of: "?") {
            pathPart = String(uri[..<qi])
            query = String(uri[uri.index(after: qi)...])
        }
        var comps = URLComponents()
        comps.scheme = b.scheme
        comps.host = b.host
        comps.port = b.port
        if pathPart.hasPrefix("/") {
            comps.path = pathPart
        } else {
            var dir = b.path
            if let slash = dir.lastIndex(of: "/") { dir = String(dir[...slash]) }
            comps.path = dir + pathPart
        }
        comps.query = query.isEmpty ? nil : query
        return comps.url?.absoluteString ?? uri
    }

    private func fail(_ msg: String) -> NSError {
        NSError(domain: "rustflix.hls", code: 1, userInfo: [NSLocalizedDescriptionKey: msg])
    }
}
