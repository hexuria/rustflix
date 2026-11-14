// Ad blocking in the player's and the resolver's web views (iOS side of
// app/lib/adblock.ts; macOS: src/webguard.rs).
//
// NSH builds its WKWebViews itself (nsh-platform-ios web.rs) with no
// configuration hook, so, like InlineMediaPlayback.swift, this hooks
// WebKit's own entry points:
//
// - `-[WKWebView initWithFrame:configuration:]`: before WebKit copies the
//   configuration, its user content controller gets the compiled content
//   blocker (WKContentRuleList) and the guard script (every frame, at
//   document start). Both are therefore in place before the view's first
//   navigation. A view made before the app handed over the lists (the
//   first second after launch: only the resolver's idle about:blank view)
//   gets them as soon as they are ready; WebKit applies them from its next
//   load on.
// - `-[WKUserContentController removeAllUserScripts]`: NSH clears the user
//   scripts whenever a web view's injected scripts change, then adds its
//   own; the guard is put back first.
// - `-[WKWebView setNavigationDelegate:]`: the delegate's class (NSH's) gets
//   a check in front of `webView:decidePolicyForNavigationAction:…`: the
//   main frame may only go to the embed hosts, the site it shows, or on
//   through the redirects of a navigation it was allowed to start
//   (tracked with `webView:didCommitNavigation:`); no frame may open a
//   non-web scheme (App Store / intent links). Pop-up windows never open
//   (NSH's UI delegate makes none) and JS dialogs never show (no panel
//   delegate methods).
//
// `sys.webGuard` (gated by capabilities.host "sys.*"):
//   {on, rules, script, embeds} → configure; {stats: true} → counters.

import Foundation
import NativeShell
import ObjectiveC
import WebKit

@MainActor
final class WebGuard {
    static let shared = WebGuard()

    private var on = true
    private var rules: WKContentRuleList?
    private var rulesId = ""
    private var rulesState = "none"
    /// The resolver's extra list (images, fonts…) and the controllers of
    /// the hidden resolver web view(s), found by the page title it sets.
    private var resRules: WKContentRuleList?
    private var resRulesId = ""
    private var resRulesState = "none"
    private var resCtrls = NSHashTable<WKUserContentController>.weakObjects()
    private var webViews = NSHashTable<WKWebView>.weakObjects()
    private var script: WKUserScript?
    private var embeds: Set<String> = []
    private var controllers = NSHashTable<WKUserContentController>.weakObjects()
    /// Web views (by identity) whose allowed main-frame navigation has not
    /// committed yet: its redirects pass.
    private var pending: [ObjectIdentifier: Date] = [:]
    private var hooked: Set<ObjectIdentifier> = []
    private var navDenied = 0
    private var navDeniedHosts: [String: Int] = [:]
    private var schemeDenied = 0

    // MARK: Install (before NSH makes any web view)

    nonisolated static func install() {
        MainActor.assumeIsolated { shared.installHooks() }
    }

    private var installed = false
    private func installHooks() {
        guard !installed else { return }
        installed = true
        exchange(WKWebView.self, #selector(WKWebView.init(frame:configuration:)),
                 #selector(WKWebView.init(rfGuardFrame:configuration:)))
        exchange(WKWebView.self, NSSelectorFromString("setNavigationDelegate:"),
                 #selector(WKWebView.rfGuardSetNavigationDelegate(_:)))
        exchange(WKUserContentController.self, #selector(WKUserContentController.removeAllUserScripts),
                 #selector(WKUserContentController.rfGuardRemoveAllUserScripts))
    }

    private func exchange(_ cls: AnyClass, _ a: Selector, _ b: Selector) {
        guard let ma = class_getInstanceMethod(cls, a), let mb = class_getInstanceMethod(cls, b) else {
            NSLog("rustflix/webguard: cannot hook %@", NSStringFromSelector(a))
            return
        }
        method_exchangeImplementations(ma, mb)
    }

    func register(_ appView: NshAppView) {
        appView.handle("sys.webGuard") { [weak self] data in
            guard let self else { return nil }
            return self.handle(data as? [String: Any] ?? [:])
        }
        appView.handle("sys.webCookies") { [weak self] data in
            guard let self else { return nil }
            return await self.cookies((data as? [String: Any])?["url"] as? String ?? "")
        }
        // A GET with the page's headers, for the subtitle files a source's
        // page offers (arbitrary hosts; the app's own fetch only reaches
        // nsh.json's hosts).
        appView.handle("sys.webFetch") { data in
            await WebGuard.webFetch(data as? [String: Any] ?? [:])
        }
    }

    private static let hopHeaders: Set<String> = ["host", "content-length", "connection", "transfer-encoding", "range", "accept-encoding"]

    /// `sys.webFetch {url, headers?, max?}` → `{ok, status, b64, contentType}`
    /// (2xx, at most `max` bytes, default 8 MB, never above 16 MB) or
    /// `{ok:false, status?, error?}`. GET over http(s) only.
    nonisolated static func webFetch(_ d: [String: Any]) async -> [String: Any] {
        guard let s = d["url"] as? String, let url = URL(string: s),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            return ["ok": false, "error": "bad url"]
        }
        var req = URLRequest(url: url, timeoutInterval: 30)
        for (k, v) in (d["headers"] as? [String: Any]) ?? [:] {
            guard let v = v as? String, !k.isEmpty, !k.contains(where: { $0 == "\r" || $0 == "\n" || $0 == ":" }),
                  !v.contains(where: { $0 == "\r" || $0 == "\n" }), !hopHeaders.contains(k.lowercased()) else { continue }
            req.setValue(v, forHTTPHeaderField: k)
        }
        let max = min((d["max"] as? Int) ?? (8 << 20), 16 << 20)
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else { return ["ok": false, "status": status] }
            guard data.count <= max else { return ["ok": false, "status": status, "error": "too large"] }
            let ct = (resp as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? ""
            return ["ok": true, "status": status, "b64": data.base64EncodedString(), "contentType": ct]
        } catch {
            return ["ok": false, "error": error.localizedDescription]
        }
    }

    /// `sys.webCookies {url}`: the Cookie header WebKit would send to `url`
    /// (HttpOnly ones included; the page's JS cannot read those).
    private func cookies(_ url: String) async -> [String: Any] {
        guard let u = URL(string: url), let host = u.host?.lowercased() else { return ["ok": false, "error": "bad url"] }
        let all = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        var parts: [String] = []
        var httpOnly = 0
        let path = u.path.isEmpty ? "/" : u.path
        for c in all {
            let d = c.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
            guard host == d || host.hasSuffix("." + d), path.hasPrefix(c.path) else { continue }
            if c.isSecure && u.scheme != "https" { continue }
            if c.isHTTPOnly { httpOnly += 1 }
            parts.append("\(c.name)=\(c.value)")
        }
        return ["ok": true, "cookie": parts.joined(separator: "; "), "count": parts.count, "httpOnly": httpOnly]
    }

    /// Marks the web view(s) whose page title is `title` as the resolver's.
    private func markResolver(_ title: String) -> Int {
        var n = 0
        for w in webViews.allObjects where w.title == title {
            resCtrls.add(w.configuration.userContentController)
            n += 1
        }
        return n
    }

    fileprivate func track(_ web: WKWebView) {
        webViews.add(web)
    }

    // MARK: Configuration from the app

    private func handle(_ d: [String: Any]) -> [String: Any] {
        if d["stats"] as? Bool == true { return stats() }
        let wasOn = on
        on = d["on"] as? Bool ?? true
        if let e = d["embeds"] as? [String] { embeds = Set(e.map { $0.lowercased() }) }
        if let s = d["script"] as? String, s != script?.source {
            let old = script
            script = WKUserScript(source: s, injectionTime: .atDocumentStart, forMainFrameOnly: false)
            for c in controllers.allObjects { replaceScript(c, old: old) }
        }
        var marked = 0
        if let t = d["markResolver"] as? String { marked = markResolver(t) }
        if let json = d["rules"] as? String { loadRules(json) }
        if let json = d["resolverRules"] as? String { loadRules(json, resolver: true) }
        if wasOn != on || marked > 0 { for c in controllers.allObjects { apply(c) } }
        return ["ok": true, "rules": rulesState, "resolverRules": resRulesState, "marked": marked]
    }

    private func stats() -> [String: Any] {
        ["on": on, "rules": rulesState, "resolverRules": resRulesState, "resolverViews": resCtrls.allObjects.count,
         "navigationsDenied": navDenied, "deniedHosts": navDeniedHosts,
         "schemesDenied": schemeDenied, "views": controllers.allObjects.count]
    }

    private func loadRules(_ json: String, resolver: Bool = false) {
        let id = "rustflix-\(resolver ? "resolver" : "adblock")-\(Self.fnv(json))"
        if resolver {
            guard id != resRulesId else { return }
            resRulesId = id
            resRulesState = "compiling"
        } else {
            guard id != rulesId else { return }
            rulesId = id
            rulesState = "compiling"
        }
        guard let store = WKContentRuleListStore.default() else { rulesState = "no store"; return }
        let current = { [weak self] in resolver ? self?.resRulesId == id : self?.rulesId == id }
        store.lookUpContentRuleList(forIdentifier: id) { [weak self] list, _ in
            MainActor.assumeIsolated {
                guard let self, current() else { return }
                if let list {
                    self.rulesReady(list, how: "cached", resolver: resolver)
                    return
                }
                store.compileContentRuleList(forIdentifier: id, encodedContentRuleList: json) { list, error in
                    MainActor.assumeIsolated {
                        guard current() else { return }
                        if let list {
                            self.rulesReady(list, how: "compiled", resolver: resolver)
                        } else {
                            let why = "error: \(error?.localizedDescription ?? "?")"
                            if resolver { self.resRulesState = why } else { self.rulesState = why }
                            NSLog("rustflix/webguard: content rules failed: %@", why)
                        }
                    }
                }
            }
        }
    }

    private func rulesReady(_ list: WKContentRuleList, how: String, resolver: Bool = false) {
        let old: WKContentRuleList?
        if resolver {
            old = resRules
            resRules = list
            resRulesState = "ready (\(how))"
        } else {
            old = rules
            rules = list
            rulesState = "ready (\(how))"
        }
        for c in controllers.allObjects {
            if let old { c.remove(old) }
            apply(c)
        }
        // Earlier lists of this app (other identifiers) are no longer used.
        WKContentRuleListStore.default()?.getAvailableContentRuleListIdentifiers { ids in
            MainActor.assumeIsolated {
                for i in ids ?? [] where (i.hasPrefix("rustflix-adblock-") && i != self.rulesId)
                    || (i.hasPrefix("rustflix-resolver-") && i != self.resRulesId && !self.resRulesId.isEmpty) {
                    WKContentRuleListStore.default()?.removeContentRuleList(forIdentifier: i) { _ in }
                }
            }
        }
    }

    private static func fnv(_ s: String) -> String {
        var h: UInt64 = 0xcbf29ce484222325
        for b in s.utf8 { h = (h ^ UInt64(b)) &* 0x100000001b3 }
        return String(h, radix: 16)
    }

    // MARK: Per web view

    fileprivate func prepare(_ config: WKWebViewConfiguration) {
        let c = config.userContentController
        controllers.add(c)
        apply(c)
    }

    /// On `c`: the ad rules exactly when on; the script always (it carries
    /// the media sniffer the resolver needs; its ad parts stand down when the
    /// app says off); the resolver list on the resolver's views.
    private func apply(_ c: WKUserContentController) {
        if let rules {
            // remove + add: never twice
            c.remove(rules)
            if on { c.add(rules) }
        }
        if let resRules {
            c.remove(resRules)
            if resCtrls.contains(c) { c.add(resRules) }
        }
        if let script, !c.userScripts.contains(where: { $0 === script }) {
            c.addUserScript(script)
        }
    }

    private func replaceScript(_ c: WKUserContentController, old: WKUserScript?, add: Bool = true) {
        let others = c.userScripts.filter { $0 !== old && $0 !== script }
        c.rfGuardRemoveAllUserScriptsOriginal()
        if add, let script { c.addUserScript(script) }
        for s in others { c.addUserScript(s) }
    }

    fileprivate func afterRemoveAll(_ c: WKUserContentController) {
        guard let script, controllers.contains(c) else { return }
        c.addUserScript(script)
    }

    // MARK: Navigation

    fileprivate func hookDelegate(_ delegate: AnyObject) {
        let cls: AnyClass = object_getClass(delegate)!
        let key = ObjectIdentifier(cls)
        guard !hooked.contains(key) else { return }
        hooked.insert(key)
        hookDecide(cls)
        hookCommit(cls)
    }

    private typealias DecideIMP = @convention(c) (AnyObject, Selector, AnyObject, AnyObject, AnyObject) -> Void
    private typealias CommitIMP = @convention(c) (AnyObject, Selector, AnyObject, AnyObject?) -> Void
    private typealias PolicyBlock = @convention(block) (Int) -> Void

    private func hookDecide(_ cls: AnyClass) {
        let sel = NSSelectorFromString("webView:decidePolicyForNavigationAction:decisionHandler:")
        guard let m = class_getInstanceMethod(cls, sel) else { return }
        let orig = unsafeBitCast(method_getImplementation(m), to: DecideIMP.self)
        let block: @convention(block) (AnyObject, AnyObject, AnyObject, AnyObject) -> Void = { this, web, action, handler in
            let allow = MainActor.assumeIsolated {
                guard let web = web as? WKWebView, let action = action as? WKNavigationAction else { return true }
                return WebGuard.shared.decide(web, action)
            }
            if allow {
                orig(this, sel, web, action, handler)
            } else {
                unsafeBitCast(handler, to: PolicyBlock.self)(0) // WKNavigationActionPolicyCancel
            }
        }
        let imp = imp_implementationWithBlock(block)
        if !class_addMethod(cls, sel, imp, method_getTypeEncoding(m)) { method_setImplementation(m, imp) }
    }

    private func hookCommit(_ cls: AnyClass) {
        let sel = NSSelectorFromString("webView:didCommitNavigation:")
        let m = class_getInstanceMethod(cls, sel)
        let orig = m.map { unsafeBitCast(method_getImplementation($0), to: CommitIMP.self) }
        let block: @convention(block) (AnyObject, AnyObject, AnyObject?) -> Void = { this, web, nav in
            MainActor.assumeIsolated { WebGuard.shared.pending[ObjectIdentifier(web)] = nil }
            orig?(this, sel, web, nav)
        }
        let imp = imp_implementationWithBlock(block)
        if !class_addMethod(cls, sel, imp, "v@:@@"), let m { method_setImplementation(m, imp) }
    }

    private static func site(_ host: String) -> String {
        let p = host.lowercased().split(separator: ".").map(String.init)
        guard p.count > 2 else { return p.joined(separator: ".") }
        let sl = p[p.count - 2], tl = p[p.count - 1]
        if tl.count == 2, ["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go"].contains(sl) {
            return p.suffix(3).joined(separator: ".")
        }
        return p.suffix(2).joined(separator: ".")
    }

    fileprivate func decide(_ web: WKWebView, _ action: WKNavigationAction) -> Bool {
        guard on, let url = action.request.url else { return true }
        let scheme = (url.scheme ?? "").lowercased()
        if ["about", "data", "blob", "javascript", ""].contains(scheme) { return true }
        let webScheme = scheme == "http" || scheme == "https"
        let main = action.targetFrame?.isMainFrame ?? true
        if !webScheme {
            schemeDenied += 1
            NSLog("rustflix/webguard: refused %@ navigation", scheme)
            return false
        }
        if !main { return true }
        let id = ObjectIdentifier(web)
        let host = (url.host ?? "").lowercased()
        let site = Self.site(host)
        let cur = web.url
        // The app's own local pages (downloads play from a localhost server).
        let curHost = (cur?.host ?? "").lowercased()
        if host == "127.0.0.1" || host == "localhost" || host == "::1"
            || curHost == "127.0.0.1" || curHost == "localhost" || curHost == "::1" {
            pending[id] = Date()
            return true
        }
        let curWeb = cur.map { ($0.scheme ?? "").lowercased().hasPrefix("http") } ?? false
        if embeds.contains(site) || !curWeb || Self.site(cur?.host ?? "") == site {
            pending[id] = Date()
            return true
        }
        if let t = pending[id], Date().timeIntervalSince(t) < 15 { return true }
        navDenied += 1
        navDeniedHosts[host, default: 0] += 1
        NSLog("rustflix/webguard: refused main-frame navigation to %@", host)
        return false
    }
}

extension WKWebView {
    /// After the exchange: the body of `initWithFrame:configuration:`.
    @objc dynamic convenience init(rfGuardFrame frame: CGRect, configuration: WKWebViewConfiguration) {
        MainActor.assumeIsolated { WebGuard.shared.prepare(configuration) }
        self.init(rfGuardFrame: frame, configuration: configuration)
        MainActor.assumeIsolated { WebGuard.shared.track(self) }
    }

    /// After the exchange: the body of `setNavigationDelegate:`.
    @objc dynamic func rfGuardSetNavigationDelegate(_ delegate: AnyObject?) {
        if let delegate { MainActor.assumeIsolated { WebGuard.shared.hookDelegate(delegate) } }
        rfGuardSetNavigationDelegate(delegate)
    }
}

extension WKUserContentController {
    /// After the exchange: the body of `removeAllUserScripts`.
    @objc dynamic func rfGuardRemoveAllUserScripts() {
        rfGuardRemoveAllUserScripts()
        MainActor.assumeIsolated { WebGuard.shared.afterRemoveAll(self) }
    }

    /// WebKit's own removeAllUserScripts (no guard re-add).
    fileprivate func rfGuardRemoveAllUserScriptsOriginal() {
        // After the exchange this selector runs WebKit's implementation.
        perform(#selector(WKUserContentController.rfGuardRemoveAllUserScripts))
    }
}
