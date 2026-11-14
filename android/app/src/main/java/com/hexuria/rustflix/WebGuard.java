package com.hexuria.rustflix;

import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Message;
import android.util.Log;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.GeolocationPermissions;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.longbridge.nsh.NshView;
import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Ad blocking in the player's and the resolver's web views (the Android
 * side of app/lib/adblock.ts; iOS: ios/Rustflix/WebGuard.swift, macOS:
 * src/webguard.rs).
 *
 * <ul>
 *   <li>{@code shouldInterceptRequest}: requests to the ad hosts and URL
 *       patterns the app hands over ({@code sys.webGuard}) get an empty
 *       answer and never reach the network; media, playlists and subtitles
 *       always pass, and so do the embed hosts.
 *   <li>{@code shouldOverrideUrlLoading}: the main frame may only go to the
 *       embed hosts, the site it shows, or on through server redirects; no
 *       frame may open a non-web scheme (Play Store / intent links).
 *   <li>Chrome client: no window is ever created, JS dialogs and
 *       {@code beforeunload} never show, geolocation and camera/microphone
 *       requests are refused.
 * </ul>
 *
 * <p>The clients NSH (and {@link WebViewTweaks}) installed are kept: every
 * other callback goes to them. The in-page layers (window/link locks,
 * isolation) come with the player bridge in the top document; Android
 * offers no document-start script for inner frames, so those rely on the
 * network layer here.
 *
 * <p>Hooks: {@code WebGuard.register(nsh)} in MainActivity.onCreate, and
 * {@code WebGuard.install(web)} at the end of WebViewTweaks.configure (after
 * it set its chrome client).
 */
final class WebGuard {
    private WebGuard() {}

    private static final String TAG = "rustflix";

    private static volatile boolean on = true;
    private static volatile Set<String> adHosts = new HashSet<>();
    private static volatile Set<String> embeds = new HashSet<>();
    private static volatile List<Rule> patterns = new ArrayList<>();
    private static volatile List<Pattern> allow = new ArrayList<>();

    private static final Map<String, Integer> blocked = new HashMap<>();
    private static int navDenied;
    private static int schemeDenied;
    private static int dialogs;
    private static int prompts;

    private static final class Rule {
        final Pattern re;
        final Set<String> types;
        final boolean third;

        Rule(Pattern re, Set<String> types, boolean third) {
            this.re = re;
            this.types = types;
            this.third = third;
        }
    }

    /** {@code sys.webGuard}: {on, hosts, embeds, patterns, allow} or {stats}. */
    static void register(NshView nsh) {
        nsh.handle("sys.webGuard", (data, reply) -> {
            try {
                JSONObject d = data instanceof Map ? new JSONObject((Map<?, ?>) data) : new JSONObject();
                if (d.optBoolean("stats", false)) {
                    reply.resolve(stats());
                    return;
                }
                configure(d);
                Map<String, Object> out = new HashMap<>();
                out.put("ok", true);
                out.put("hosts", adHosts.size());
                reply.resolve(out);
            } catch (Exception e) {
                reply.reject(String.valueOf(e));
            }
        });
        // A GET with the page's headers, for the subtitle files a source's
        // page offers (arbitrary hosts; the app's own fetch only reaches
        // nsh.json's hosts). Off the UI thread.
        nsh.handle("sys.webFetch", (data, reply) -> new Thread(() -> {
            try {
                reply.resolve(webFetch(data instanceof Map ? (Map<?, ?>) data : new HashMap<>()));
            } catch (Exception e) {
                Map<String, Object> out = new HashMap<>();
                out.put("ok", false);
                out.put("error", String.valueOf(e));
                reply.resolve(out);
            }
        }, "rustflix-webfetch").start());
    }

    private static final Set<String> HOP = new HashSet<>(java.util.Arrays.asList(
            "host", "content-length", "connection", "transfer-encoding", "range", "accept-encoding"));

    /** {url, headers?, max?} → {ok, status, b64, contentType} (2xx, at most
     * max bytes, default 8 MB, never above 16 MB) or {ok:false, status?, error?}. */
    static Map<String, Object> webFetch(Map<?, ?> d) throws java.io.IOException {
        Map<String, Object> out = new HashMap<>();
        Object u = d.get("url");
        String url = u instanceof String ? (String) u : "";
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            out.put("ok", false);
            out.put("error", "bad url");
            return out;
        }
        long max = 8L << 20;
        if (d.get("max") instanceof Number) max = Math.min(((Number) d.get("max")).longValue(), 16L << 20);
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true);
        if (d.get("headers") instanceof Map) {
            for (Map.Entry<?, ?> e : ((Map<?, ?>) d.get("headers")).entrySet()) {
                String k = String.valueOf(e.getKey());
                if (!(e.getValue() instanceof String)) continue;
                String v = (String) e.getValue();
                if (k.isEmpty() || k.matches(".*[\\r\\n:].*") || v.matches("(?s).*[\\r\\n].*")) continue;
                if (HOP.contains(k.toLowerCase(Locale.ROOT))) continue;
                c.setRequestProperty(k, v);
            }
        }
        int status = c.getResponseCode();
        out.put("status", status);
        if (status < 200 || status >= 300) {
            out.put("ok", false);
            c.disconnect();
            return out;
        }
        String ct = c.getContentType();
        java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
        try (java.io.InputStream in = c.getInputStream()) {
            byte[] b = new byte[16384];
            int n;
            while ((n = in.read(b)) > 0) {
                buf.write(b, 0, n);
                if (buf.size() > max) {
                    out.put("ok", false);
                    out.put("error", "too large");
                    return out;
                }
            }
        } finally {
            c.disconnect();
        }
        out.put("ok", true);
        out.put("b64", android.util.Base64.encodeToString(buf.toByteArray(), android.util.Base64.NO_WRAP));
        out.put("contentType", ct == null ? "" : ct);
        return out;
    }

    static void configure(JSONObject d) {
        on = d.optBoolean("on", true);
        Set<String> h = new HashSet<>();
        JSONArray a = d.optJSONArray("hosts");
        for (int i = 0; a != null && i < a.length(); i++) h.add(a.optString(i).toLowerCase(Locale.ROOT));
        if (a != null) adHosts = h;
        Set<String> e = new HashSet<>();
        JSONArray em = d.optJSONArray("embeds");
        for (int i = 0; em != null && i < em.length(); i++) e.add(em.optString(i).toLowerCase(Locale.ROOT));
        if (em != null) embeds = e;
        JSONArray p = d.optJSONArray("patterns");
        if (p != null) {
            List<Rule> rules = new ArrayList<>();
            for (int i = 0; i < p.length(); i++) {
                JSONObject r = p.optJSONObject(i);
                if (r == null) continue;
                try {
                    Set<String> types = new HashSet<>();
                    JSONArray t = r.optJSONArray("types");
                    for (int j = 0; t != null && j < t.length(); j++) types.add(t.optString(j));
                    rules.add(new Rule(Pattern.compile(r.optString("re"), Pattern.CASE_INSENSITIVE), types,
                            r.optBoolean("third", false)));
                } catch (RuntimeException ex) {
                    Log.w(TAG, "webguard: bad pattern " + r.optString("re"));
                }
            }
            patterns = rules;
        }
        JSONArray al = d.optJSONArray("allow");
        if (al != null) {
            List<Pattern> ps = new ArrayList<>();
            for (int i = 0; i < al.length(); i++) {
                try {
                    ps.add(Pattern.compile(al.optString(i), Pattern.CASE_INSENSITIVE));
                } catch (RuntimeException ex) {
                    // skipped
                }
            }
            allow = ps;
        }
    }

    private static synchronized Map<String, Object> stats() {
        Map<String, Object> o = new HashMap<>();
        o.put("on", on);
        o.put("blocked", new HashMap<>(blocked));
        o.put("navigationsDenied", navDenied);
        o.put("schemesDenied", schemeDenied);
        o.put("dialogs", dialogs);
        o.put("prompts", prompts);
        return o;
    }

    private static synchronized void count(String host) {
        Integer n = blocked.get(host);
        blocked.put(host, n == null ? 1 : n + 1);
    }

    private static final Set<String> SECOND = new HashSet<>(java.util.Arrays.asList(
            "co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go"));

    /** The registrable part of a host, as app/lib/adblock.ts siteOf. */
    static String site(String host) {
        if (host == null) return "";
        String h = host.toLowerCase(Locale.ROOT);
        if (h.endsWith(".")) h = h.substring(0, h.length() - 1);
        String[] p = h.split("\\.");
        if (p.length <= 2) return h;
        String sl = p[p.length - 2], tl = p[p.length - 1];
        int n = 2;
        if (tl.length() == 2 && SECOND.contains(sl)) n = 3;
        StringBuilder b = new StringBuilder();
        for (int i = p.length - n; i < p.length; i++) {
            if (b.length() > 0) b.append('.');
            b.append(p[i]);
        }
        return b.toString();
    }

    private static boolean listed(String host, Set<String> set) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        while (!h.isEmpty()) {
            if (set.contains(h)) return true;
            int i = h.indexOf('.');
            if (i < 0) return false;
            h = h.substring(i + 1);
        }
        return false;
    }

    /** WebKit's resource types, guessed from the request (Android gives none). */
    private static String type(WebResourceRequest r) {
        if (r.isForMainFrame()) return "document";
        String accept = r.getRequestHeaders() == null ? null : r.getRequestHeaders().get("Accept");
        if (accept == null) return "fetch";
        if (accept.startsWith("text/html")) return "document";
        if (accept.contains("text/css")) return "style-sheet";
        if (accept.startsWith("image/")) return "image";
        // "*/*" is both scripts and XHR/fetch (hls.js): only a .js path is
        // taken for a script, so a stream on a cheap TLD is never blocked.
        String path = r.getUrl().getPath();
        if (accept.equals("*/*") && path != null && path.endsWith(".js")) return "script";
        return "fetch";
    }

    /** The app's own pages (a download's localhost player, about:blank,
     * nothing loaded yet): every guard here stands aside on them. */
    static boolean appPage(String url) {
        if (url == null || url.isEmpty() || url.startsWith("about:") || url.startsWith("data:")) return true;
        String h = Uri.parse(url).getHost();
        return h != null && (h.equals("127.0.0.1") || h.equals("localhost") || h.equals("[::1]"));
    }

    /** Whether {@code url} (requested by {@code page}) must not load. */
    static boolean blocks(String url, String page, String type) {
        if (!on) return false;
        Uri u = Uri.parse(url);
        String host = u.getHost();
        if (host == null) return false;
        // The downloader's localhost server and pages it serves: never.
        if (appPage(url) || (page != null && appPage(page))) return false;
        for (Pattern a : allow) if (a.matcher(url).find()) return false;
        if (listed(site(host), embeds)) return false;
        if (listed(host, adHosts)) return true;
        boolean third = page == null || !site(host).equals(site(Uri.parse(page).getHost()));
        for (Rule r : patterns) {
            if (!r.types.isEmpty() && !r.types.contains(type)) continue;
            if (r.third && !third) continue;
            if (r.re.matcher(url).find()) return true;
        }
        return false;
    }

    /** Whether a navigation of the main frame to {@code url} may go ahead. */
    static boolean mainAllowed(String url, String current, boolean redirect) {
        if (!on) return true;
        Uri u = Uri.parse(url);
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        if (scheme.equals("about") || scheme.equals("data") || scheme.equals("blob") || scheme.equals("javascript")) return true;
        if (!scheme.equals("http") && !scheme.equals("https")) return false;
        // Leaving one of the app's own pages: the app navigates, not a page ad.
        if (current != null && !current.startsWith("http")) return true;
        if (current != null && appPage(current)) return true;
        String h = u.getHost() == null ? "" : u.getHost();
        if (h.equals("127.0.0.1") || h.equals("localhost") || h.equals("[::1]")) return true;
        String target = site(h);
        if (embeds.contains(target) || redirect) return true;
        if (current == null || !current.startsWith("http")) return true;
        return site(Uri.parse(current).getHost()).equals(target);
    }

    private static WebResourceResponse empty() {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", h,
                new ByteArrayInputStream(new byte[0]));
    }

    /** Wraps {@code web}'s current clients. Call once per web view, after
     * its other clients are set. */
    static void install(WebView web) {
        final WebViewClient inner = web.getWebViewClient();
        final WebChromeClient chrome = web.getWebChromeClient();
        web.setWebViewClient(new Client(inner));
        web.setWebChromeClient(new Chrome(chrome));
    }

    private static final class Client extends WebViewClient {
        private final WebViewClient in;

        Client(WebViewClient in) {
            this.in = in != null ? in : new WebViewClient();
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (url.startsWith("http")) {
                // The page's URL is only readable on the UI thread; the
                // embeds' own frames are first-party enough here.
                String page = request.getRequestHeaders() == null ? null : request.getRequestHeaders().get("Referer");
                if (blocks(url, page, type(request))) {
                    count(String.valueOf(request.getUrl().getHost()));
                    return empty();
                }
            }
            return in.shouldInterceptRequest(view, request);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (appPage(view.getUrl())) return in.shouldOverrideUrlLoading(view, request);
            String scheme = request.getUrl().getScheme() == null ? "" : request.getUrl().getScheme();
            boolean web = scheme.equals("http") || scheme.equals("https");
            if (on && !web && !scheme.equals("about") && !scheme.equals("data") && !scheme.equals("blob")
                    && !scheme.equals("javascript")) {
                synchronized (WebGuard.class) { schemeDenied++; }
                Log.i(TAG, "webguard: refused " + scheme + ": navigation");
                return true;
            }
            if (request.isForMainFrame() && !mainAllowed(url, view.getUrl(), request.isRedirect())) {
                synchronized (WebGuard.class) { navDenied++; }
                Log.i(TAG, "webguard: refused main-frame navigation to " + request.getUrl().getHost());
                return true;
            }
            return in.shouldOverrideUrlLoading(view, request);
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            in.onPageStarted(view, url, favicon);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            in.onPageFinished(view, url);
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            in.onPageCommitVisible(view, url);
        }

        @Override
        public void onLoadResource(WebView view, String url) {
            in.onLoadResource(view, url);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            in.onReceivedError(view, request, error);
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            in.onReceivedHttpError(view, request, response);
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
            in.onReceivedSslError(view, handler, error);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            return in.onRenderProcessGone(view, detail);
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            in.doUpdateVisitedHistory(view, url, isReload);
        }
    }

    private static final class Chrome extends WebChromeClient {
        private final WebChromeClient in;

        Chrome(WebChromeClient in) {
            this.in = in != null ? in : new WebChromeClient();
        }

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            return false;
        }

        @Override
        public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
            if (!on || appPage(view.getUrl())) return in.onJsAlert(view, url, message, result);
            synchronized (WebGuard.class) { dialogs++; }
            result.cancel();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
            if (!on || appPage(view.getUrl())) return in.onJsConfirm(view, url, message, result);
            synchronized (WebGuard.class) { dialogs++; }
            result.cancel();
            return true;
        }

        @Override
        public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, JsPromptResult result) {
            if (!on || appPage(view.getUrl())) return in.onJsPrompt(view, url, message, defaultValue, result);
            synchronized (WebGuard.class) { dialogs++; }
            result.cancel();
            return true;
        }

        @Override
        public boolean onJsBeforeUnload(WebView view, String url, String message, JsResult result) {
            if (!on || appPage(view.getUrl())) return in.onJsBeforeUnload(view, url, message, result);
            result.confirm();
            return true;
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            synchronized (WebGuard.class) { prompts++; }
            callback.invoke(origin, false, false);
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            if (!on) {
                in.onPermissionRequest(request);
                return;
            }
            synchronized (WebGuard.class) { prompts++; }
            request.deny();
        }

        @Override
        public Bitmap getDefaultVideoPoster() {
            return in.getDefaultVideoPoster();
        }

        @Override
        public View getVideoLoadingProgressView() {
            return in.getVideoLoadingProgressView();
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            in.onShowCustomView(view, callback);
        }

        @Override
        public void onHideCustomView() {
            in.onHideCustomView();
        }

        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            in.onProgressChanged(view, newProgress);
        }

        @Override
        public void onReceivedTitle(WebView view, String title) {
            in.onReceivedTitle(view, title);
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
            return in.onConsoleMessage(consoleMessage);
        }
    }
}
