// The app's caches for Settings → Storage, exposed to JS through
// `nsh/host` as `cache.*` (see app/lib/cache.ts):
//
//   cache.info                  -> { images, web, site } in bytes
//   cache.clear { what }        -> { freed } in bytes
//
// images: NSH's image disk cache, <container>/Library/Caches/nsh/<app id>/images
//         (nsh-platform-ios `system_cache`); its contents are deleted, the
//         directory kept. Safe while NSH runs: a missing entry is a miss.
// web:    URLCache.shared plus WebKit's disk/memory/fetch/offline caches
//         (WKWebsiteDataStore.default()); measured as Library/Caches/<bundle id>.
// site:   every kind of WebKit website data (cookies, local storage,
//         IndexedDB, ...); measured as Library/WebKit/<bundle id>.
//
// Sizes come from walking those directories off the main thread; a
// missing directory counts as 0. Bad input frees nothing.

import Foundation
import WebKit

@MainActor
final class CacheControls {
    static let shared = CacheControls()

    /// NSH names an app's directories by its `nsh.json` id, which ships in
    /// the bundle's `nsh/app.json`; the iOS bundle id is the fallback.
    private let appId: String
    private let bundleId: String

    private init() {
        bundleId = Bundle.main.bundleIdentifier ?? "com.hexuria.rustflix"
        var id = bundleId
        if let url = Bundle.main.url(forResource: "app", withExtension: "json", subdirectory: "nsh"),
           let data = try? Data(contentsOf: url),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let nshId = json["id"] as? String,
           Self.isDirName(nshId)
        {
            id = nshId
        }
        appId = id
    }

    private static func isDirName(_ s: String) -> Bool {
        !s.isEmpty && s != "." && s != ".." && !s.contains("/") && !s.contains("\\")
            && !s.contains("\0")
    }

    private var library: URL? {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first
    }

    private var imagesDir: URL? {
        library?.appendingPathComponent("Caches/nsh", isDirectory: true)
            .appendingPathComponent(appId, isDirectory: true)
            .appendingPathComponent("images", isDirectory: true)
    }

    private var webDir: URL? {
        Self.isDirName(bundleId)
            ? library?.appendingPathComponent("Caches", isDirectory: true)
                .appendingPathComponent(bundleId, isDirectory: true)
            : nil
    }

    private var siteDir: URL? {
        Self.isDirName(bundleId)
            ? library?.appendingPathComponent("WebKit", isDirectory: true)
                .appendingPathComponent(bundleId, isDirectory: true)
            : nil
    }

    func info() async -> [String: Any] {
        let dirs = (imagesDir, webDir, siteDir)
        return await Task.detached(priority: .utility) {
            [
                "images": Self.size(of: dirs.0),
                "web": Self.size(of: dirs.1),
                "site": Self.size(of: dirs.2),
            ] as [String: Any]
        }.value
    }

    func clear(_ data: Any?) async -> [String: Any] {
        let what = (data as? [String: Any])?["what"] as? String
        var freed: Int64 = 0
        switch what {
        case "images":
            let dir = imagesDir
            freed = await Task.detached(priority: .utility) { Self.clearContents(of: dir) }.value
        case "web":
            let dir = webDir
            let before = await Self.measure(dir)
            URLCache.shared.removeAllCachedResponses()
            await Self.removeWebsiteData(ofTypes: [
                WKWebsiteDataTypeDiskCache,
                WKWebsiteDataTypeMemoryCache,
                WKWebsiteDataTypeFetchCache,
                WKWebsiteDataTypeOfflineWebApplicationCache,
            ])
            freed = max(0, before - (await Self.measure(dir)))
        case "site":
            let dir = siteDir
            let before = await Self.measure(dir)
            await Self.removeWebsiteData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes())
            freed = max(0, before - (await Self.measure(dir)))
        default:
            freed = 0
        }
        return ["freed": freed]
    }

    // MARK: WebKit

    private static func removeWebsiteData(ofTypes types: Set<String>) async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: .distantPast) {
                done.resume()
            }
        }
        // WebKit's processes finish deleting files after it answers.
        try? await Task.sleep(nanoseconds: 300_000_000)
    }

    // MARK: Directories (off the main thread)

    private static func measure(_ dir: URL?) async -> Int64 {
        await Task.detached(priority: .utility) { size(of: dir) }.value
    }

    /// Bytes of the files under `dir`; 0 when it is missing. Symlinks are
    /// not followed.
    nonisolated private static func size(of dir: URL?) -> Int64 {
        guard let dir else { return 0 }
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey]
        guard let walker = FileManager.default.enumerator(
            at: dir, includingPropertiesForKeys: keys, options: [], errorHandler: { _, _ in true }
        ) else { return 0 }
        var total: Int64 = 0
        for case let url as URL in walker {
            guard let values = try? url.resourceValues(forKeys: Set(keys)),
                  values.isRegularFile == true
            else { continue }
            total += Int64(values.fileSize ?? 0)
        }
        return total
    }

    /// Deletes what `dir` holds, keeping `dir`. Returns the bytes freed.
    nonisolated private static func clearContents(of dir: URL?) -> Int64 {
        guard let dir else { return 0 }
        let before = size(of: dir)
        let fm = FileManager.default
        if let items = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) {
            for item in items {
                try? fm.removeItem(at: item)
            }
        }
        return max(0, before - size(of: dir))
    }
}
