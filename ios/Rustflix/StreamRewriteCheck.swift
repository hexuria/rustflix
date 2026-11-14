// The golden check of the Swift playlist rewriter (StreamPlaylist.swift):
// the fixtures and assertions of src/stream/tests.rs (rewrites_a_master_
// playlist, rewrites_media_playlists, slots_keep_local_names_across_a_
// fresh_link, drm_and_non_playlists_are_refused, local_names), copied
// verbatim, plus the fallback mapping of a fresh link with another ladder.
//
// Runs two ways: `ios/RewriterCheck/run.sh` (swiftc on the Mac, prints
// PASS/FAIL, exit status) and in the app as `dl.stream.selftest`.
//
// Pure Foundation.

import Foundation

enum StreamRewriteCheck {
    /// The Rust tests' `Fake` table: rows of (parent, slot, url, role),
    /// ids from 1.
    final class Fake: StreamTable {
        var rows: [(parent: Int, desc: StreamDesc, url: String, role: StreamRole)] = []

        func register(parent: Int, desc: StreamDesc, url: String, role: StreamRole) -> String {
            if let i = rows.firstIndex(where: { $0.parent == parent && $0.role == role && $0.desc.same(desc) }) {
                let name = StreamPlaylist.localName(i + 1, role, rows[i].url)
                rows[i].url = url
                return name
            }
            let name = StreamPlaylist.localName(rows.count + 1, role, url)
            rows.append((parent, desc, url, role))
            return name
        }

        func url(_ id: Int) -> String { rows[id - 1].url }
        func role(_ id: Int) -> StreamRole { rows[id - 1].role }
    }

    static let master = "#EXTM3U\r\n"
        + "#EXT-X-VERSION:6\r\n"
        + "#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"https://keys.example.com/k0?t=1\"\r\n"
        + "#EXT-X-SESSION-DATA:DATA-ID=\"com.x.title\",VALUE=\"Movie\"\r\n"
        + "#EXT-X-SESSION-DATA:DATA-ID=\"com.x.more\",URI=\"https://evil.example.com/data.json\"\r\n"
        + "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"English\",LANGUAGE=\"en\",DEFAULT=YES,URI=\"audio/en.m3u8\"\r\n"
        + "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"Deutsch\",LANGUAGE=\"de\",URI=\"https://cdn2.example.com/audio/de.m3u8?sig=a\"\r\n"
        + "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"English\",LANGUAGE=\"en\",URI=\"subs/en.m3u8\"\r\n"
        + "#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID=\"cc\",NAME=\"CC1\",INSTREAM-ID=\"CC1\"\r\n"
        + "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS=\"avc1.4d401e,mp4a.40.2\",AUDIO=\"aud\",SUBTITLES=\"subs\"\r\n"
        + "low/index.m3u8?token=abc\r\n"
        + "\r\n"
        + "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO=\"aud\"\r\n"
        + "https://cdn2.example.com/hi/index.m3u8\r\n"
        + "#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x360,URI=\"iframes.m3u8\"\r\n"

    static let media = "#EXTM3U\r\n"
        + "#EXT-X-VERSION:7\r\n"
        + "#EXT-X-TARGETDURATION:6\r\n"
        + "#EXT-X-MEDIA-SEQUENCE:100\r\n"
        + "#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.0\r\n"
        + "#EXT-X-PART-INF:PART-TARGET=0.5\r\n"
        + "#EXT-X-KEY:METHOD=AES-128,URI=\"/keys/k1?sig=1\",IV=0x01\r\n"
        + "#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"700@0\"\r\n"
        + "#EXTINF:6,\r\n"
        + "seg0.m4s?sig=1\r\n"
        + "#EXTINF:6,\r\n"
        + "../hi/seg1.m4s?sig=1\r\n"
        + "#EXTINF:6,\r\n"
        + "?part=3\r\n"
        + "#EXT-X-KEY:METHOD=NONE\r\n"
        + "#EXTINF:6,\r\n"
        + "#EXT-X-BYTERANGE:1000@700\r\n"
        + "https://other.example.com/all.mp4\r\n"
        + "#EXTINF:6,\r\n"
        + "#EXT-X-BYTERANGE:1000\r\n"
        + "//edge.example.com/all.mp4\r\n"
        + "#EXT-X-PART:DURATION=0.5,URI=\"part.m4s\"\r\n"
        + "#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"hint.m4s\"\r\n"
        + "#EXT-X-RENDITION-REPORT:URI=\"../lo/index.m3u8\",LAST-MSN=104\r\n"
        + "#EXTINF:6,\r\n"
        + "disguised.png\r\n"
        + "#EXT-X-ENDLIST\r\n"

    /// Runs every check; the failures (empty = PASS) and how many ran.
    static func run() -> (failures: [String], checks: Int) {
        var failures: [String] = []
        var checks = 0
        func check(_ ok: Bool, _ what: String, _ ctx: @autoclosure () -> String = "") {
            checks += 1
            if !ok { failures.append(ctx().isEmpty ? what : "\(what) — \(ctx().prefix(400))") }
        }
        func rewrite(_ text: String, _ base: String, _ me: Int, _ t: StreamTable) -> Result<String, StreamRewriteError> {
            do { return .success(try StreamPlaylist.rewrite(text, base: base, me: me, table: t)) } catch let e as StreamRewriteError {
                return .failure(e)
            } catch { return .failure(.notPlaylist) }
        }

        // rewrites_a_master_playlist
        do {
            let t = Fake()
            guard case .success(let out) = rewrite(master, "https://cdn.example.com/v/master.m3u8?sig=1", 0, t) else {
                check(false, "master: rewrite failed"); return (failures, checks)
            }
            check(!out.contains("http") && !out.contains("audio/") && !out.contains("\r"), "master: nothing upstream left", out)
            check(out.contains("#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"k1.key\""), "master: session key", out)
            check(out.contains("DATA-ID=\"com.x.title\""), "master: session data without URI kept")
            check(!out.contains("com.x.more"), "master: session data with URI dropped")
            check(out.contains("NAME=\"English\",LANGUAGE=\"en\",DEFAULT=YES,URI=\"p2.m3u8\""), "master: audio en", out)
            check(out.contains("NAME=\"Deutsch\",LANGUAGE=\"de\",URI=\"p3.m3u8\""), "master: audio de", out)
            check(out.contains("TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"English\",LANGUAGE=\"en\",URI=\"p4.m3u8\""), "master: subs", out)
            check(out.contains("INSTREAM-ID=\"CC1\""), "master: CC rendition kept")
            check(out.contains("SUBTITLES=\"subs\"\np5.m3u8\n"), "master: variant 1", out)
            check(out.contains("AUDIO=\"aud\"\np6.m3u8\n"), "master: variant 2", out)
            check(out.contains("#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x360,URI=\"p7.m3u8\""), "master: i-frames", out)
            if t.rows.count == 7 {
                check(t.url(1) == "https://keys.example.com/k0?t=1", "master: url 1", t.url(1))
                check(t.url(2) == "https://cdn.example.com/v/audio/en.m3u8", "master: url 2", t.url(2))
                check(t.url(3) == "https://cdn2.example.com/audio/de.m3u8?sig=a", "master: url 3", t.url(3))
                check(t.url(5) == "https://cdn.example.com/v/low/index.m3u8?token=abc", "master: url 5", t.url(5))
                check(t.url(6) == "https://cdn2.example.com/hi/index.m3u8", "master: url 6", t.url(6))
                check(t.url(7) == "https://cdn.example.com/v/iframes.m3u8", "master: url 7", t.url(7))
                check(t.role(1) == .key, "master: role 1")
                check((2...7).allSatisfy { t.role($0) == .playlist }, "master: roles 2…7")
            } else {
                check(false, "master: 7 rows", "\(t.rows.count)")
            }
        }

        // rewrites_media_playlists
        do {
            let t = Fake()
            let base = "https://cdn2.example.com/hi/index.m3u8?sig=1"
            guard case .success(let out) = rewrite(media, base, 6, t) else {
                check(false, "media: rewrite failed"); return (failures, checks)
            }
            check(!out.contains("http") && !out.contains("sig=") && !out.contains("\r"), "media: nothing upstream left", out)
            check(out.contains("#EXT-X-MEDIA-SEQUENCE:100\n"), "media: sequence kept")
            check(out.contains("#EXT-X-KEY:METHOD=AES-128,URI=\"k1.key\",IV=0x01\n"), "media: key", out)
            check(out.contains("#EXT-X-MAP:URI=\"m2.mp4\",BYTERANGE=\"700@0\"\n"), "media: map", out)
            check(out.contains("#EXTINF:6,\nr3.m4s\n#EXTINF:6,\nr4.m4s\n#EXTINF:6,\nr5.ts\n#EXT-X-KEY:METHOD=NONE\n"), "media: segments", out)
            check(out.contains("#EXT-X-BYTERANGE:1000@700\nr6.mp4\n#EXTINF:6,\n#EXT-X-BYTERANGE:1000\nr7.mp4\n"), "media: byte ranges", out)
            check(out.contains("\nr8.ts\n#EXT-X-ENDLIST\n"), "media: disguised segment named ts", out)
            for gone in ["PART", "PRELOAD", "RENDITION-REPORT", "SERVER-CONTROL"] {
                check(!out.contains(gone), "media: \(gone) dropped", out)
            }
            if t.rows.count == 8 {
                check(t.url(1) == "https://cdn2.example.com/keys/k1?sig=1", "media: url 1", t.url(1))
                check(t.url(2) == "https://cdn2.example.com/hi/init.mp4", "media: url 2", t.url(2))
                check(t.url(3) == "https://cdn2.example.com/hi/seg0.m4s?sig=1", "media: url 3", t.url(3))
                check(t.url(4) == "https://cdn2.example.com/hi/seg1.m4s?sig=1", "media: url 4", t.url(4))
                check(t.url(5) == "https://cdn2.example.com/hi/index.m3u8?part=3", "media: url 5", t.url(5))
                check(t.url(6) == "https://other.example.com/all.mp4", "media: url 6", t.url(6))
                check(t.url(7) == "https://edge.example.com/all.mp4", "media: url 7", t.url(7))
                let segs = t.rows.compactMap { r -> String? in
                    if case let .segment(seq, start, _) = r.desc { return "\(seq)@\(start)" }
                    return nil
                }
                check(segs == ["100@0.0", "101@6.0", "102@12.0", "103@18.0", "104@24.0", "105@30.0"], "media: segment descs", "\(segs)")
                check(t.rows.allSatisfy { $0.parent == 6 }, "media: parent")
            } else {
                check(false, "media: 8 rows", "\(t.rows.count)")
            }
        }

        // slots_keep_local_names_across_a_fresh_link
        do {
            let t = Fake()
            let a = try? StreamPlaylist.rewrite(media, base: "https://cdn2.example.com/hi/index.m3u8?sig=1", me: 6, table: t)
            let n = t.rows.count
            let fresh = media.replacingOccurrences(of: "sig=1", with: "sig=2")
            let b = try? StreamPlaylist.rewrite(fresh, base: "https://cdn3.example.com/hi/index.m3u8?sig=2", me: 6, table: t)
            check(a != nil && a == b, "fresh link: the same local playlist")
            check(t.rows.count == n, "fresh link: no new entries")
            check(t.rows.count >= 3 && t.url(3) == "https://cdn3.example.com/hi/seg0.m4s?sig=2", "fresh link: url moved")
            let m = Fake()
            let x = try? StreamPlaylist.rewrite(master, base: "https://cdn.example.com/v/master.m3u8?sig=1", me: 0, table: m)
            let y = try? StreamPlaylist.rewrite(
                master.replacingOccurrences(of: "token=abc", with: "token=def"),
                base: "https://cdn.example.com/v/master.m3u8?sig=2", me: 0, table: m)
            check(x != nil && x == y, "fresh link: the same master")
            check(m.rows.count >= 5 && m.url(5) == "https://cdn.example.com/v/low/index.m3u8?token=def", "fresh link: variant moved")
        }

        // drm_and_non_playlists_are_refused
        for key in [
            "#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://x\",KEYFORMAT=\"com.apple.streamingkeydelivery\"",
            "#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI=\"data:x\"",
            "#EXT-X-KEY:METHOD=AES-128,URI=\"k\",KEYFORMAT=\"com.apple.streamingkeydelivery\"",
            "#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI=\"skd://x\"",
        ] {
            let text = "#EXTM3U\n\(key)\n#EXTINF:4,\na.ts\n"
            check(rewrite(text, "http://h/p.m3u8", 0, Fake()) == .failure(.drm), "drm: \(key)")
        }
        let ok = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k.bin\",KEYFORMAT=\"identity\"\n#EXTINF:4,\na.ts\n"
        if case .success = rewrite(ok, "http://h/p.m3u8", 0, Fake()) { check(true, "") } else { check(false, "identity key accepted") }
        for bad in ["<html>403</html>", "", "\u{1}\u{2}binary"] {
            check(rewrite(bad, "http://h/p.m3u8", 0, Fake()) == .failure(.notPlaylist), "not a playlist: \(bad.debugDescription)")
        }
        check(StreamPlaylist.isPlaylist("\u{feff}\n #EXTM3U\n"), "BOM + blank before #EXTM3U")

        // local_names
        check(StreamPlaylist.localName(0, .playlist, "x") == "index.m3u8", "name: index")
        check(StreamPlaylist.localName(3, .segment, "https://h/a/b.TS?x=1") == "r3.ts", "name: r3.ts")
        check(StreamPlaylist.localName(3, .segment, "https://h/a/b.jpg") == "r3.ts", "name: disguised")
        check(StreamPlaylist.localName(4, .map, "https://h/init") == "m4.mp4", "name: map")
        check(StreamPlaylist.localName(0, .file, "https://h/v.m4v?e=1") == "f0.m4v", "name: f0.m4v")
        check(StreamPlaylist.localName(0, .file, "https://h/v") == "f0.mp4", "name: f0.mp4")
        for (name, want) in [("index.m3u8", (0, "p")), ("p12.m3u8", (12, "p")), ("r7.ts", (7, "r")), ("k1.key", (1, "k"))] {
            let got = StreamPlaylist.parseName(name)
            check(got?.0 == want.0 && got.map { String($0.1) } == want.1, "parse: \(name)")
        }
        for bad in ["x1.ts", "r.ts", "r1", "r1.", "r-1.ts", "r1.t/s", "r1.ts%2F..", "p1234567890.m3u8", "index.m3u8x"] {
            check(StreamPlaylist.parseName(bad) == nil, "parse rejects: \(bad)")
        }

        // a_fresh_link_with_another_structure_keeps_every_name (src/stream
        // tests): copy A → copy B through the proxy's own table, the
        // proxy's refresh walk emulated.
        relink(check)
        return (failures, checks)
    }

    /// Copy A: 1080p + 720p + 360p, audio en/de, 4 s segments from sequence 0.
    static func copyA() -> [String: String] {
        var o: [String: String] = [:]
        o["https://a.example/a/master.m3u8"] = "#EXTM3U\n"
            + "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"English\",LANGUAGE=\"en\",DEFAULT=YES,URI=\"en.m3u8?sig=1\"\n"
            + "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"Deutsch\",LANGUAGE=\"de\",URI=\"de.m3u8?sig=1\"\n"
            + "#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS=\"avc1.640028,mp4a.40.2\",AUDIO=\"aud\"\nfhd.m3u8?sig=1\n"
            + "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS=\"avc1.64001f,mp4a.40.2\",AUDIO=\"aud\"\nhd.m3u8?sig=1\n"
            + "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS=\"avc1.64001e,mp4a.40.2\",AUDIO=\"aud\"\nsd.m3u8?sig=1\n"
        for v in ["fhd", "hd", "sd", "en", "de"] {
            var text = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n"
            for i in 0..<6 { text += "#EXTINF:4.000,\n\(v)-\(i).ts?sig=1\n" }
            o["https://a.example/a/\(v).m3u8?sig=1"] = text + "#EXT-X-ENDLIST\n"
        }
        return o
    }

    /// Copy B: other host, other order and bandwidths, no codecs, no 1080p,
    /// no German, sequence from 7, other names; 720p cut in 6 s segments.
    static func copyB() -> [String: String] {
        var o: [String: String] = [:]
        o["https://b.example/cdn2/b/master.m3u8"] = "#EXTM3U\n"
            + "#EXT-X-STREAM-INF:BANDWIDTH=850000,RESOLUTION=640x360,AUDIO=\"a1\"\nv0/index.m3u8?tok=2\n"
            + "#EXT-X-STREAM-INF:BANDWIDTH=2100000,RESOLUTION=1280x720,AUDIO=\"a1\"\nv1/index.m3u8?tok=2\n"
            + "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a1\",NAME=\"English\",LANGUAGE=\"en\",DEFAULT=YES,URI=\"aud/en/index.m3u8?tok=2\"\n"
        for (dir, step) in [("v0", 4), ("v1", 6), ("aud/en", 4)] {
            var text = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:7\n"
            var t = 0, i = 0
            while t < 24 { text += "#EXTINF:\(step).0,\nchunk-\(i).ts?tok=2\n"; t += step; i += 1 }
            o["https://b.example/cdn2/b/\(dir)/index.m3u8?tok=2"] = text + "#EXT-X-ENDLIST\n"
        }
        return o
    }

    /// What a B segment URL holds: "<variant>/t=<start>".
    static func bContent(_ url: String) -> String? {
        let map = ["v0": ("sd", 4), "v1": ("hd", 6), "aud/en": ("en", 4)]
        for (dir, (v, step)) in map {
            let pre = "https://b.example/cdn2/b/\(dir)/chunk-"
            if url.hasPrefix(pre), let i = Int(url.dropFirst(pre.count).prefix { $0.isNumber }) { return "\(v)/t=\(i * step)" }
        }
        return nil
    }

    static func relink(_ check: (Bool, String, @autoclosure () -> String) -> Void) {
        func names(_ text: String) -> [String] {
            text.components(separatedBy: "\n").compactMap { l in
                if let u = StreamPlaylist.attr(l, "URI") { return u }
                return l.isEmpty || l.hasPrefix("#") ? nil : l
            }
        }
        let t = StreamEntries(url: "https://a.example/a/master.m3u8", role: .playlist)
        var origin = copyA()
        let ids: (String) -> Int = { name in StreamPlaylist.parseName(name)?.0 ?? -1 }
        /// The proxy's refresh walk: entry `id`'s current URL, re-reading its
        /// parents with the current link, remapping when nothing matches.
        func current(_ id: Int, _ depth: Int = 0) -> String? {
            let e = t.entries[id]
            if e.gen == t.gen || id == 0 { return e.url }
            guard depth < 6, let purl = current(e.parent, depth + 1), let text = origin[purl] else { return nil }
            _ = try? StreamPlaylist.rewrite(text, base: purl, me: e.parent, table: t)
            if t.entries[id].gen == t.gen || t.remap(id) { return t.entries[id].url }
            return nil
        }
        func read(_ id: Int) -> String? {
            guard let url = current(id), let text = origin[url] else { return nil }
            return try? StreamPlaylist.rewrite(text, base: url, me: id, table: t)
        }
        guard let master = read(0) else { check(false, "relink: master A", ""); return }
        var lists: [(String, [String])] = []
        for pl in names(master) {
            guard let text = read(ids(pl)) else { check(false, "relink: playlist \(pl)", ""); return }
            lists.append((pl, names(text)))
        }
        check(lists.count == 5, "relink: en, de, fhd, hd, sd", "\(lists.map(\.0))")
        guard lists.count == 5 else { return }
        // The fresh link: copy B.
        origin = copyB()
        t.gen += 1
        t.setEntryURL("https://b.example/cdn2/b/master.m3u8")
        for ((pl, segs), v) in zip(lists, ["en", "de", "fhd", "hd", "sd"]) {
            for (i, seg) in segs.enumerated() {
                let got = current(ids(seg)).flatMap(bContent)
                let s = i * 4
                let want: String
                switch v {
                case "sd", "en": want = "\(v)/t=\(s)"
                case "hd", "fhd": want = "hd/t=\(s / 6 * 6)"
                default: want = "en/t=\(s)"
                }
                check(got == want, "relink: \(pl) (\(v)) #\(i) \(seg)", "\(got ?? "nil") want \(want)")
            }
        }
        // Re-reading the fresh master lists the names the player already has
        // for what has a counterpart (360p, 720p, English) and nothing new.
        guard let again = read(0) else { check(false, "relink: master B", ""); return }
        let now = names(again)
        check(now == [lists[4].0, lists[3].0, lists[0].0], "relink: sd, hd, en keep their names", "\(now)")
        check(read(ids(lists[4].0)).map(names) == lists[4].1, "relink: 360p same cut, same names", "")
        check(read(ids(lists[0].0)).map(names) == lists[0].1, "relink: English same cut, same names", "")
        check(read(0) == again, "relink: a third read changes nothing", "")
        check(t.remapped > 0, "relink: remapped", "\(t.remapped)")
        // nothing_to_stand_for_a_name_asks_for_a_relink
        let r = StreamEntries(url: "https://h/r/a.m3u8", role: .playlist)
        _ = try? StreamPlaylist.rewrite("#EXTM3U\n#EXTINF:4,\ns0.ts?sig=1\n#EXT-X-ENDLIST\n", base: "https://h/r/a.m3u8", me: 0, table: r)
        r.gen += 1
        r.setEntryURL("https://h/r/b.m3u8")
        _ = try? StreamPlaylist.rewrite("#EXTM3U\n#EXT-X-ENDLIST\n", base: "https://h/r/b.m3u8", me: 0, table: r)
        check(r.entries[1].gen != r.gen && !r.remap(1), "relink: nothing stands for a vanished segment", "")
    }
}
