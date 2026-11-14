// Playlist rewriting for the streaming proxy (StreamProxy.swift): every URI
// of an upstream playlist becomes a local name in the session's folder,
// recorded in the session's table. A port of src/stream/playlist.rs — same
// names, slots and rules (the golden check, StreamRewriteCheck.swift, runs
// the Rust tests' fixtures against it):
//
// - master: variants (`EXT-X-STREAM-INF` + the URI line), renditions
//   (`EXT-X-MEDIA:…URI=`), I-frame lists, `EXT-X-SESSION-KEY`;
// - media: segments, `EXT-X-KEY` (AES-128 identity keys; anything else is
//   DRM), `EXT-X-MAP` (byte ranges kept: the player sends them as Range);
// - relative, absolute, protocol-relative and query-only URIs (resolved
//   against the playlist's final URL), CRLF line ends;
// - low-latency parts, preload hints, rendition reports, server control
//   and session data with a URI are dropped.
//
// Pure Foundation: no UIKit, no NativeShell (the command-line check in
// ios/RewriterCheck compiles this file on its own).

import Foundation

enum StreamRole: String {
    case playlist, segment, key, map, file

    /// The first letter of its local names.
    var letter: Character {
        switch self {
        case .playlist: return "p"
        case .segment: return "r"
        case .key: return "k"
        case .map: return "m"
        case .file: return "f"
        }
    }
}

enum StreamRewriteError: Error, Equatable {
    /// SAMPLE-AES / FairPlay / Widevine keys.
    case drm
    /// Not a playlist (an error page, binary data).
    case notPlaylist
}

/// What an entry is, independent of its URL (src/stream/playlist.rs `Desc`).
enum StreamDesc: Equatable, CustomStringConvertible {
    /// The session's entry (playlist or file).
    case entry
    case variant(bw: UInt64, w: Int, h: Int, codecs: String, ord: Int)
    case iframe(bw: UInt64, w: Int, h: Int, ord: Int)
    case rendition(kind: String, lang: String, name: String, ord: Int)
    /// `start`: the sum of the EXTINF durations before it.
    case segment(seq: UInt64, start: Double, dur: Double)
    case key(path: String, ord: Int)
    case map(path: String, range: String, ord: Int)

    static let tEps = 0.1

    var description: String {
        switch self {
        case .entry: return "Entry"
        case let .variant(bw, w, h, _, ord): return "Variant(\(w)x\(h) \(bw) #\(ord))"
        case let .iframe(bw, w, h, ord): return "IFrame(\(w)x\(h) \(bw) #\(ord))"
        case let .rendition(kind, lang, name, ord): return "Rendition(\(kind) \(lang) \(name) #\(ord))"
        case let .segment(seq, start, dur): return "Segment(#\(seq) \(start)+\(dur))"
        case let .key(_, ord): return "Key(#\(ord))"
        case let .map(_, range, ord): return "Map(\(range) #\(ord))"
        }
    }

    /// The same thing (`self` read before, `new` now).
    func same(_ new: StreamDesc) -> Bool {
        switch (self, new) {
        case (.entry, .entry): return true
        case let (.variant(bw, w, h, c, _), .variant(b2, w2, h2, c2, _)):
            return bw == b2 && w == w2 && h == h2 && (c == c2 || c.isEmpty || c2.isEmpty)
        case let (.iframe(bw, w, h, _), .iframe(b2, w2, h2, _)): return bw == b2 && w == w2 && h == h2
        case let (.rendition(k, l, n, _), .rendition(k2, l2, n2, _)): return k == k2 && l == l2 && n == n2
        case let (.segment(seq, start, dur), .segment(s2, t2, d2)):
            if dur > 0 && d2 > 0 { return abs(start - t2) < Self.tEps && abs(dur - d2) < Self.tEps }
            return seq == s2
        case let (.key(p, _), .key(p2, _)): return p == p2
        case let (.map(p, r, _), .map(p2, r2, _)): return p == p2 && r == r2
        default: return false
        }
    }

    /// How close `new` is to `self` when not `same` (lower is closer); nil
    /// when it cannot stand for it.
    func near(_ new: StreamDesc) -> UInt64? {
        func diff(_ a: UInt64, _ b: UInt64) -> UInt64 { a > b ? a - b : b - a }
        switch (self, new) {
        case let (.variant(bw, w, h, _, _), .variant(b2, w2, h2, _, _)):
            guard w == w2 && h == h2 && (h > 0 || diff(bw, b2).multipliedReportingOverflow(by: 4).partialValue < max(bw, 1))
            else { return nil }
            return diff(bw, b2)
        case let (.iframe(_, w, h, _), .iframe(_, w2, h2, _)):
            return w == w2 && h == h2 ? 0 : nil
        case let (.rendition(k, l, _, o), .rendition(k2, l2, _, o2)) where k == k2:
            if l == l2 && !l.isEmpty { return 1 }
            if l.isEmpty && l2.isEmpty { return 10 + UInt64(abs(o - o2)) }
            return nil
        case let (.segment(_, start, dur), .segment(_, t2, d2)) where abs(start - t2) < 0.5 && abs(dur - d2) < 0.5:
            return UInt64(abs(start - t2) * 1000)
        case let (.key(_, o), .key(_, o2)) where o == o2: return 0
        case let (.map(_, _, o), .map(_, _, o2)) where o == o2: return 0
        default: return nil
        }
    }
}

/// Where the rewriter records the URIs it replaces.
protocol StreamTable: AnyObject {
    /// A rewrite of playlist `parent` starts.
    func begin(parent: Int)
    /// The local name for `desc` in playlist `parent`, now pointing at
    /// `url` (an entry it already gave, matched by `desc`, else a new one:
    /// a name never changes).
    func register(parent: Int, desc: StreamDesc, url: String, role: StreamRole) -> String
}

extension StreamTable {
    func begin(parent: Int) {}
}

/// The proxy's table of a session (src/stream/mod.rs `State` as a Table):
/// entries matched by what they are, so a fresh link from another CDN —
/// another variant order, bandwidths, rendition groups, names, media-
/// sequence base — keeps every name the player was given.
final class StreamEntries: StreamTable {
    struct Entry {
        var url: String
        /// Its local name, fixed when it was first listed.
        let name: String
        let role: StreamRole
        let parent: Int
        /// What it is as the player knows it (kept across fresh links:
        /// remapping looks for the same time / quality).
        let desc: StreamDesc
        /// What it is in the link it was last read in (re-reads match this).
        var seen: StreamDesc
        /// The link generation it was last read in.
        var gen: Int
    }

    /// The link generation: `dl.stream.update` moves it on.
    var gen = 0
    private(set) var entries: [Entry]
    private var kids: [String: [Int]] = [:]
    private var claimed = Set<Int>()
    private var pos: [StreamRole: Int] = [:]
    private(set) var remapped = 0
    private(set) var remaps: [String] = []

    init(url: String, role: StreamRole) {
        entries = [Entry(url: url, name: StreamPlaylist.localName(0, role, url), role: role, parent: 0, desc: .entry, seen: .entry, gen: 0)]
    }

    private static func key(_ parent: Int, _ role: StreamRole) -> String { "\(parent)|\(role.rawValue)" }

    /// The entry playlist moves to a fresh link.
    func setEntryURL(_ url: String) {
        entries[0].url = url
        entries[0].gen = gen
    }

    /// Every entry of the previous generation stands for this one (the same
    /// link again).
    func carryOver() {
        for i in entries.indices where entries[i].gen == gen - 1 { entries[i].gen = gen }
    }

    func begin(parent: Int) {
        claimed.removeAll()
        pos.removeAll()
    }

    func register(parent: Int, desc: StreamDesc, url: String, role: StreamRole) -> String {
        let p = pos[role, default: 0]
        pos[role] = p + 1
        let kids = self.kids[Self.key(parent, role)] ?? []
        let free = { (i: Int) in !self.claimed.contains(i) }
        // The same thing: at its old position first (the usual re-read),
        // else anywhere; else close enough among entries the current link
        // has not placed yet.
        var found: Int?
        if p < kids.count, free(kids[p]), entries[kids[p]].seen.same(desc) { found = kids[p] }
        if found == nil { found = kids.first { free($0) && entries[$0].seen.same(desc) } }
        if found == nil {
            var best: (UInt64, Int)?
            for i in kids where free(i) && entries[i].gen != gen {
                guard let d = entries[i].seen.near(desc) else { continue }
                if best == nil || d < best!.0 { best = (d, i) }
            }
            found = best?.1
        }
        if let id = found {
            claimed.insert(id)
            entries[id].url = url
            entries[id].gen = gen
            entries[id].seen = desc
            return entries[id].name
        }
        let id = entries.count
        let name = StreamPlaylist.localName(id, role, url)
        entries.append(Entry(url: url, name: name, role: role, parent: parent, desc: desc, seen: desc, gen: gen))
        self.kids[Self.key(parent, role), default: []].append(id)
        claimed.insert(id)
        return name
    }

    /// Points stale entry `id` at the fresh entry nearest to it among its
    /// siblings: the segment covering its start time, the nearest lower
    /// variant, the rendition of its type and language. False when none.
    func remap(_ id: Int) -> Bool {
        let e = entries[id]
        let fresh = (kids[Self.key(e.parent, e.role)] ?? []).filter { entries[$0].gen == gen }
        var pick: Int?
        switch e.desc {
        case let .segment(_, start, _):
            let at = start + 0.05
            pick = fresh.first { i in
                if case let .segment(_, s2, d2) = entries[i].desc { return s2 <= at && at < s2 + max(d2, 0.001) }
                return false
            } ?? fresh.compactMap { i -> (UInt64, Int)? in
                if case let .segment(_, s2, _) = entries[i].desc { return (UInt64(abs(s2 - start) * 1000), i) }
                return nil
            }.min { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1 < $1.1 }?.1
        case let .variant(bw, _, _, _, _):
            let vs = fresh.compactMap { i -> (UInt64, Int)? in
                if case let .variant(b, _, _, _, _) = entries[i].desc { return (b, i) }
                return nil
            }
            let lower = vs.filter { $0.0 <= bw }.max { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1 < $1.1 }
            pick = (lower ?? vs.min { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1 < $1.1 })?.1
        case let .rendition(kind, lang, _, _):
            func kindOf(_ i: Int) -> (String, String)? {
                if case let .rendition(k, l, _, _) = entries[i].desc { return (k, l) }
                return nil
            }
            pick = fresh.first { kindOf($0).map { $0.0 == kind && $0.1 == lang } ?? false }
                ?? fresh.first { kindOf($0)?.0 == kind }
        case let .iframe(bw, _, _, _):
            pick = fresh.compactMap { i -> (UInt64, Int)? in
                if case let .iframe(b, _, _, _) = entries[i].desc { return (b > bw ? b - bw : bw - b, i) }
                return nil
            }.min { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1 < $1.1 }?.1
        case let .key(_, ord), let .map(_, _, ord):
            pick = fresh.first { i in
                switch entries[i].desc {
                case let .key(_, o), let .map(_, _, o): return o == ord
                default: return false
                }
            } ?? fresh.first
        case .entry:
            pick = nil
        }
        guard let src = pick else { return false }
        // An alias: it keeps its own identity (`seen`), so re-reads never
        // take it for the entry it borrows from.
        if remaps.count < 8 { remaps.append("\(entries[id].seen) -> \(entries[src].seen)") }
        entries[id].url = entries[src].url
        entries[id].gen = gen
        remapped += 1
        return true
    }
}

enum StreamPlaylist {
    static let mediaExts: Set<String> = [
        "ts", "m4s", "mp4", "m4v", "m4a", "aac", "mp3", "ac3", "ec3", "vtt", "webvtt", "cmfv", "cmfa",
    ]
    static let fileExts: Set<String> = ["mp4", "m4v", "mov", "webm", "mkv"]

    /// A lowercase extension of `url`'s path (1–5 alphanumerics), if any.
    static func pathExt(_ url: String) -> String? {
        let path = URLComponents(string: url)?.percentEncodedPath ?? url
        guard let last = path.split(separator: "/", omittingEmptySubsequences: false).last,
              let dot = last.lastIndex(of: ".")
        else { return nil }
        let ext = last[last.index(after: dot)...]
        guard !ext.isEmpty, ext.count <= 5, ext.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) })
        else { return nil }
        return ext.lowercased()
    }

    /// The local name of entry `id`: `index.m3u8` for the entry playlist,
    /// `p<id>.m3u8`, `r<id>.<ext>`, `k<id>.key`, `m<id>.<ext>`, `f<id>.<ext>`.
    /// Segment extensions come from the upstream path when it is a media
    /// one (CDNs that disguise segments as images get `ts`).
    static func localName(_ id: Int, _ role: StreamRole, _ url: String) -> String {
        let media = pathExt(url).flatMap { mediaExts.contains($0) ? $0 : nil }
        switch role {
        case .playlist: return id == 0 ? "index.m3u8" : "p\(id).m3u8"
        case .key: return "k\(id).key"
        case .segment: return "r\(id).\(media ?? "ts")"
        case .map: return "m\(id).\(media ?? "mp4")"
        case .file: return "f\(id).\(pathExt(url).flatMap { fileExts.contains($0) ? $0 : nil } ?? "mp4")"
        }
    }

    /// A local name back to (id, role letter): `index.m3u8` is (0, "p").
    static func parseName(_ name: String) -> (Int, Character)? {
        if name == "index.m3u8" { return (0, "p") }
        guard let letter = name.first, "prkmf".contains(letter) else { return nil }
        let rest = name.dropFirst()
        guard let dot = rest.firstIndex(of: ".") else { return nil }
        let digits = rest[..<dot]
        let ext = rest[rest.index(after: dot)...]
        guard !digits.isEmpty, digits.count <= 9, digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        guard !ext.isEmpty, ext.count <= 6, ext.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) })
        else { return nil }
        guard let id = Int(digits) else { return nil }
        return (id, letter)
    }

    /// True when `text` is an HLS playlist (`#EXTM3U` first, BOM and blank
    /// space allowed before it).
    static func isPlaylist(_ text: String) -> Bool {
        var s = Substring(text)
        while let c = s.first, c == "\u{feff}" { s = s.dropFirst() }
        return s.drop(while: { $0.isWhitespace }).hasPrefix("#EXTM3U")
    }

    /// `KEY="value"` attribute (quoted, or a bare token up to a comma), at
    /// an attribute boundary.
    static func attr(_ line: String, _ key: String) -> String? {
        let pat = "\(key)="
        var from = line.startIndex
        while let r = line.range(of: pat, range: from..<line.endIndex) {
            let ok = r.lowerBound == line.startIndex || [",", ":"].contains(line[line.index(before: r.lowerBound)])
            if !ok {
                from = r.upperBound
                continue
            }
            let s = line[r.upperBound...]
            if s.hasPrefix("\"") {
                let q = s.dropFirst()
                guard let end = q.firstIndex(of: "\"") else { return nil }
                return String(q[..<end])
            }
            let end = s.firstIndex(of: ",") ?? s.endIndex
            return s[..<end].trimmingCharacters(in: .whitespaces)
        }
        return nil
    }

    /// A playlist URI (relative or absolute) against its playlist's URL.
    static func resolve(_ uri: String, base: String) -> String {
        let lower = uri.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") { return uri }
        guard let b = URL(string: base) else { return uri }
        if let u = URL(string: uri, relativeTo: b) { return u.absoluteString }
        if let enc = uri.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
           let u = URL(string: enc, relativeTo: b) {
            return u.absoluteString
        }
        return uri
    }

    /// The path of `url` (the key of keys and maps).
    static func pathKey(_ url: String) -> String {
        URLComponents(string: url)?.percentEncodedPath ?? url
    }

    /// The downloader's rule: any key method other than NONE / AES-128 with
    /// identity keys is DRM.
    static func isDrmKey(_ t: String) -> Bool {
        let method = (attr(t, "METHOD") ?? "").uppercased()
        if method == "NONE" { return false }
        if method != "AES-128" { return true }
        if let f = attr(t, "KEYFORMAT") { return f != "identity" }
        return false
    }

    /// `line` with its `URI` value `uri` replaced by `local` (quoted).
    static func replaceURI(_ line: String, _ uri: String, _ local: String) -> String {
        let quoted = "URI=\"\(uri)\""
        if let r = line.range(of: quoted) {
            return line.replacingCharacters(in: r, with: "URI=\"\(local)\"")
        }
        if let r = line.range(of: "URI=\(uri)") {
            return line.replacingCharacters(in: r, with: "URI=\"\(local)\"")
        }
        return line
    }

    private static func sig(_ t: String, _ keys: [String]) -> String {
        keys.map { attr(t, $0) ?? "" }.joined(separator: ",")
    }

    private static func resolution(_ t: String) -> (Int, Int) {
        guard let r = attr(t, "RESOLUTION"), let x = r.firstIndex(where: { $0 == "x" || $0 == "X" }),
              let w = Int(r[..<x].trimmingCharacters(in: .whitespaces)),
              let h = Int(r[r.index(after: x)...].trimmingCharacters(in: .whitespaces))
        else { return (0, 0) }
        return (w, h)
    }

    private static func bandwidth(_ t: String) -> UInt64 { attr(t, "BANDWIDTH").flatMap { UInt64($0) } ?? 0 }

    /// Playlist `text` (entry `me` of the table, fetched from `base`, its
    /// final URL) with every URI replaced by a local name.
    static func rewrite(_ text: String, base: String, me: Int, table: StreamTable) throws -> String {
        guard isPlaylist(text) else { throw StreamRewriteError.notPlaylist }
        // NSString splitting: "\r\n" is one Character to Swift's split.
        let lines = text.components(separatedBy: "\n")
        // DRM first: nothing is registered for a playlist that cannot play.
        for raw in lines {
            let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if (t.hasPrefix("#EXT-X-KEY:") || t.hasPrefix("#EXT-X-SESSION-KEY:")) && isDrmKey(t) { throw StreamRewriteError.drm }
        }
        table.begin(parent: me)
        let isMaster = text.contains("#EXT-X-STREAM-INF") || text.contains("#EXT-X-I-FRAME-STREAM-INF")
            || text.contains("#EXT-X-MEDIA:")
        var seq: UInt64 = 0
        var segments: UInt64 = 0
        var clock = 0.0
        var extinf: Double?
        var (variants, iframes, renditions, keys, maps) = (0, 0, 0, 0, 0)
        var pending: StreamDesc?
        var out: [String] = []

        func tagged(_ t: String, _ desc: StreamDesc, _ role: StreamRole) -> String {
            guard let uri = attr(t, "URI"), !uri.isEmpty else { return t }
            let name = table.register(parent: me, desc: desc, url: resolve(uri, base: base), role: role)
            return replaceURI(t, uri, name)
        }

        for raw in lines {
            var line = Substring(raw)
            if line.hasSuffix("\r") { line = line.dropLast() }
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { continue }
            if t.hasPrefix("#EXT-X-MEDIA-SEQUENCE:") {
                seq = UInt64(t.dropFirst("#EXT-X-MEDIA-SEQUENCE:".count).trimmingCharacters(in: .whitespaces)) ?? 0
                out.append(t)
                continue
            }
            if t.hasPrefix("#EXTINF:") {
                let v = t.dropFirst("#EXTINF:".count).split(separator: ",", omittingEmptySubsequences: false).first ?? ""
                extinf = Double(v.trimmingCharacters(in: .whitespaces)).flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
                out.append(t)
                continue
            }
            if t.hasPrefix("#EXT-X-KEY:") || t.hasPrefix("#EXT-X-SESSION-KEY:") {
                let path = attr(t, "URI").map { pathKey(resolve($0, base: base)) } ?? ""
                if attr(t, "URI") != nil { keys += 1 }
                out.append(tagged(t, .key(path: path, ord: max(0, keys - 1)), .key))
                continue
            }
            if t.hasPrefix("#EXT-X-MAP:") {
                let path = attr(t, "URI").map { pathKey(resolve($0, base: base)) } ?? ""
                let desc = StreamDesc.map(path: path, range: attr(t, "BYTERANGE") ?? "", ord: maps)
                maps += 1
                out.append(tagged(t, desc, .map))
                continue
            }
            if t.hasPrefix("#EXT-X-MEDIA:") {
                let desc = StreamDesc.rendition(kind: attr(t, "TYPE") ?? "", lang: (attr(t, "LANGUAGE") ?? "").lowercased(),
                                                name: attr(t, "NAME") ?? "", ord: renditions)
                renditions += 1
                out.append(tagged(t, desc, .playlist))
                continue
            }
            if t.hasPrefix("#EXT-X-I-FRAME-STREAM-INF:") {
                let (w, h) = resolution(t)
                let desc = StreamDesc.iframe(bw: bandwidth(t), w: w, h: h, ord: iframes)
                iframes += 1
                out.append(tagged(t, desc, .playlist))
                continue
            }
            if t.hasPrefix("#EXT-X-STREAM-INF:") {
                let (w, h) = resolution(t)
                pending = .variant(bw: bandwidth(t), w: w, h: h, codecs: attr(t, "CODECS") ?? "", ord: variants)
                variants += 1
                out.append(t)
                continue
            }
            if t.hasPrefix("#EXT-X-PART:") || t.hasPrefix("#EXT-X-PART-INF:") || t.hasPrefix("#EXT-X-PRELOAD-HINT:")
                || t.hasPrefix("#EXT-X-RENDITION-REPORT:") || t.hasPrefix("#EXT-X-SERVER-CONTROL:")
                || (t.hasPrefix("#EXT-X-SESSION-DATA:") && attr(t, "URI") != nil) {
                continue
            }
            if t.hasPrefix("#") {
                out.append(t)
                continue
            }
            // A bare URI: a variant (master) or a segment.
            let abs = resolve(t, base: base)
            if isMaster || pending != nil {
                let desc = pending ?? {
                    variants += 1
                    return .variant(bw: 0, w: 0, h: 0, codecs: "", ord: variants - 1)
                }()
                pending = nil
                out.append(table.register(parent: me, desc: desc, url: abs, role: .playlist))
            } else {
                let dur = extinf ?? 0
                extinf = nil
                let desc = StreamDesc.segment(seq: seq + segments, start: clock, dur: dur)
                clock += dur
                segments += 1
                out.append(table.register(parent: me, desc: desc, url: abs, role: .segment))
            }
        }
        return out.joined(separator: "\n") + "\n"
    }
}
