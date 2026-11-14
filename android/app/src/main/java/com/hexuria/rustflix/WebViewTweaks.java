package com.hexuria.rustflix;

import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import java.util.Collections;
import java.util.Set;
import java.util.WeakHashMap;

/**
 * The web view settings the player's embed pages need, applied to every
 * {@link WebView} NSH creates (the Android side of
 * ios/Rustflix/InlineMediaPlayback.swift). NSH's WebBox (nsh 0.4.0) only
 * enables JavaScript and DOM storage and exposes no configuration hook, so
 * the web views are found in the windows' view trees after each layout
 * pass and configured once, before their pages have loaded media:
 *
 * <ul>
 *   <li>media may start without a user gesture inside the page (the user
 *       pressed Play on the title page; the bridge script starts the video)
 *   <li>third-party cookies: the embeds play from iframes of other origins
 *   <li>mixed content in compatibility mode (http images/media on https
 *       pages; never active http content)
 *   <li>pop-ups: multiple windows "supported" with no window ever created —
 *       {@code window.open} from an embed's ad scripts goes nowhere instead
 *       of replacing the player page
 *   <li>black before the page paints, and no default video poster
 * </ul>
 */
final class WebViewTweaks {
    private WebViewTweaks() {}

    private static final Set<WebView> done = Collections.newSetFromMap(new WeakHashMap<>());
    private static final Set<View> roots = Collections.newSetFromMap(new WeakHashMap<>());

    /** Starts with the activity's own view tree; {@link #rescan} picks up
     * the windows NSH opens later (a {@code Dialog} per modal: the player
     * lives in one). */
    static void watch(ViewGroup root) {
        root.getViewTreeObserver().addOnGlobalLayoutListener(WebViewTweaks::rescan);
        root.post(() -> mainRoot = new java.lang.ref.WeakReference<>(root.getRootView()));
    }

    /** The activity window's root view (NSH's pages; not its dialogs). */
    private static java.lang.ref.WeakReference<View> mainRoot;

    /** {@code sys.webViews}: the web views of every window — {@code {count,
     * views: [{url, shown, alpha, width, height, window}]}} (the native
     * player's tests check that no page is on screen). */
    static void registerHost(com.longbridge.nsh.NshView nsh) {
        // sys.webCookies {url}: the Cookie header WebView sends to url
        // (HttpOnly included), as the Apple hosts answer it.
        nsh.handle("sys.webCookies", (d, r) -> {
            Object u = d instanceof java.util.Map ? ((java.util.Map<?, ?>) d).get("url") : null;
            java.util.Map<String, Object> m = new java.util.HashMap<>();
            if (!(u instanceof String) || !((String) u).startsWith("http")) {
                m.put("ok", false);
                m.put("error", "bad url");
            } else {
                String c = CookieManager.getInstance().getCookie((String) u);
                m.put("ok", true);
                m.put("cookie", c == null ? "" : c);
                m.put("count", c == null || c.isEmpty() ? 0 : c.split(";").length);
            }
            r.resolve(m);
        });
        nsh.handle("sys.webViews", (d, r) -> {
            java.util.List<java.util.Map<String, Object>> list = new java.util.ArrayList<>();
            View main = mainRoot == null ? null : mainRoot.get();
            for (View root : windowRoots()) collect(root, root == main ? "main" : "dialog", list);
            java.util.Map<String, Object> m = new java.util.HashMap<>();
            m.put("count", list.size());
            m.put("views", list);
            r.resolve(m);
        });
    }

    private static void collect(View v, String window, java.util.List<java.util.Map<String, Object>> out) {
        if (v instanceof WebView) {
            WebView w = (WebView) v;
            float alpha = 1f;
            for (View p = w; p != null; p = p.getParent() instanceof View ? (View) p.getParent() : null) alpha *= p.getAlpha();
            java.util.Map<String, Object> m = new java.util.HashMap<>();
            m.put("url", w.getUrl());
            m.put("shown", w.isShown() && alpha > 0.01f);
            m.put("alpha", alpha);
            m.put("width", w.getWidth());
            m.put("height", w.getHeight());
            m.put("window", window);
            out.add(m);
            return;
        }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) collect(g.getChildAt(i), window, out);
        }
    }

    /** Every window of the process: watch its view tree (each layout pass
     * of a window scans it for new web views). Call when a window may
     * have come or gone (focus changes). */
    static void rescan() {
        for (View root : windowRoots()) {
            if (roots.add(root)) {
                root.getViewTreeObserver().addOnGlobalLayoutListener(() -> scan(root));
                View main = mainRoot == null ? null : mainRoot.get();
                if (root != main) {
                    // Dialog windows (the player's) are small: scan before
                    // every frame too, so a new web view is configured
                    // before its page asks for anything.
                    root.getViewTreeObserver().addOnPreDrawListener(() -> {
                        scan(root);
                        return true;
                    });
                }
            }
            scan(root);
        }
    }

    @SuppressWarnings({"unchecked", "PrivateApi", "DiscouragedPrivateApi"})
    static java.util.List<View> windowRoots() {
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            return android.view.inspector.WindowInspector.getGlobalWindowViews();
        }
        // Android 8–9: the same list, from WindowManagerGlobal (greylisted, allowed there).
        try {
            Class<?> wmg = Class.forName("android.view.WindowManagerGlobal");
            Object instance = wmg.getMethod("getInstance").invoke(null);
            java.lang.reflect.Field views = wmg.getDeclaredField("mViews");
            views.setAccessible(true);
            return new java.util.ArrayList<>((java.util.List<View>) views.get(instance));
        } catch (ReflectiveOperationException | RuntimeException e) {
            return java.util.Collections.emptyList();
        }
    }

    private static void scan(View v) {
        if (v instanceof WebView) {
            WebView web = (WebView) v;
            if (done.add(web)) configure(web);
            return; // a WebView's own children are Chromium's
        }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0, n = g.getChildCount(); i < n; i++) scan(g.getChildAt(i));
        }
    }

    /** Whether the player's page gets touches: only while it is "blind"
     * (sys.playerWindow's pageTouches). */
    private static boolean playerPageTouches = true;

    static void setPlayerPageTouches(boolean on) {
        playerPageTouches = on;
    }

    /**
     * NSH's Android views pass touches through to a native view under them,
     * so a tap on the player's controls also reached the embed page (its
     * own controls came up under the app's). On iOS the overlay takes them.
     * A web view in another window than the activity's — the player's, in
     * NSH's Dialog — gets no touches unless the app allows it. This
     * replaces WebBox's own listener, which does the same for the rest:
     * keep enclosing scroll views out of the page's gestures. (WebBox's
     * {@code scrollEnabled={false}} is not reproduced; the app sets it on
     * no web view.)
     */
    private static boolean onTouch(View v, android.view.MotionEvent e) {
        View main = mainRoot == null ? null : mainRoot.get();
        boolean player = main != null && v.getRootView() != main;
        if (player && !playerPageTouches) return true;
        if (e.getActionMasked() == android.view.MotionEvent.ACTION_DOWN && v.getParent() != null) {
            v.getParent().requestDisallowInterceptTouchEvent(true);
        }
        return false;
    }

    private static void configure(WebView web) {
        web.setOnTouchListener(WebViewTweaks::onTouch);
        // NSH's client only answers media-capture requests: keep that, and
        // draw no default poster (a grey Android robot) for the posterless
        // <video> elements embed pages carry.
        final android.webkit.WebChromeClient nshChrome = web.getWebChromeClient();
        web.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public void onPermissionRequest(android.webkit.PermissionRequest request) {
                if (nshChrome != null) nshChrome.onPermissionRequest(request);
                else request.deny();
            }

            @Override
            public android.graphics.Bitmap getDefaultVideoPoster() {
                return android.graphics.Bitmap.createBitmap(1, 1, android.graphics.Bitmap.Config.ARGB_8888);
            }

            /** No spinner of WebView's own over a loading video (the app draws one). */
            @Override
            public android.view.View getVideoLoadingProgressView() {
                return new android.view.View(web.getContext());
            }
        });
        WebSettings s = web.getSettings();
        // The player's page (in NSH's Dialog) starts its video itself. The
        // hidden resolver (the activity's own window) must never be heard:
        // there, unmuted playback needs a gesture — in every frame, which
        // the resolver's muting script (top frame only) cannot reach.
        View main = mainRoot == null ? null : mainRoot.get();
        s.setMediaPlaybackRequiresUserGesture(main != null && web.getRootView() == main);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setBackgroundColor(Color.BLACK);
        final android.webkit.WebViewClient nshClient = web.getWebViewClient();
        if (nshClient != null) web.setWebViewClient(new Sniffer(nshClient, main != null && web.getRootView() == main));
        // Ad blocking and navigation guards wrap whatever clients are set above.
        WebGuard.install(web);
        // NSH loads the page before this runs: a download's localhost page
        // must come through the Sniffer (Android's own player page), so it
        // loads once more.
        String url = web.getUrl();
        if (url != null && url.startsWith("http://127.0.0.1:") && url.contains("/player.html")) web.reload();
    }

    /**
     * NSH's WebViewClient, unchanged (every callback it overrides goes to
     * it), plus media-request sniffing. The page bridge (app/lib/player.ts)
     * records stream links from fetch/XHR/resource timing in the top
     * document only, because NSH's Android WebView injects its scripts there
     * alone (evaluateJavascript at page start); embeds that load their
     * player in a cross-origin iframe never show the link to it. Here every
     * request of every frame is seen: an HLS playlist or an mp4 is handed to
     * the page's own channel as the bridge's stream report
     * ({@code {t: -2, streams, hdrs, ua}} through {@code window.nsh.postMessage}),
     * which the hidden link resolver (lib/resolver.ts) and the player already
     * take. Nothing is blocked or changed.
     */
    private static final class Sniffer extends android.webkit.WebViewClient {
        private static final java.util.regex.Pattern MEDIA =
                java.util.regex.Pattern.compile("\\.(m3u8|mp4)(\\?|#|$)", java.util.regex.Pattern.CASE_INSENSITIVE);
        private static final String NO_POSTER = "(function(){if(window.__rfNoPoster)return;window.__rfNoPoster=1;"
                + "var P='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';"
                + "var vs=document.getElementsByTagName('video');"
                + "var all=function(){for(var i=0;i<vs.length;i++){try{if(!vs[i].getAttribute('poster'))vs[i].setAttribute('poster',P);}catch(e){}}};"
                + "all();try{new MutationObserver(all).observe(document,{childList:true,subtree:true});}catch(e){}})();";
        private final android.webkit.WebViewClient nsh;
        /** Links already reported for the current page. */
        private final Set<String> reported = Collections.synchronizedSet(new java.util.HashSet<>());

        /** Off: blocking images and fonts in the resolver stopped Vidfast's
         * player from ever requesting its stream on the emulator. */
        private static final boolean SKIP_MEDIA_EXTRAS = false;

        /** The hidden resolver's view (the activity's own window). */
        private final boolean resolver;

        Sniffer(android.webkit.WebViewClient nsh, boolean resolver) {
            this.nsh = nsh;
            this.resolver = resolver;
        }

        private static final java.util.regex.Pattern FONT =
                java.util.regex.Pattern.compile("\\.(woff2?|ttf|otf|eot)$", java.util.regex.Pattern.CASE_INSENSITIVE);

        /** The resolver needs no pictures or fonts: an empty answer saves the
         * emulated device's network and CPU. (Only what the browser asks for
         * as an image — Accept image/* — or a font file; playlists and
         * segments, even disguised as images, are fetched with Accept: any.) */
        private boolean skip(android.webkit.WebResourceRequest request) {
            if (!resolver || request.isForMainFrame()) return false;
            java.util.Map<String, String> h = request.getRequestHeaders();
            String accept = h == null ? null : h.get("Accept");
            if (accept != null && accept.startsWith("image/")) return true;
            String path = request.getUrl().getPath();
            return path != null && FONT.matcher(path).find();
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
            return nsh.shouldOverrideUrlLoading(view, request);
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            reported.clear();
            nsh.onPageStarted(view, url, favicon);
            // Belt and braces for the default video poster (see configure):
            // poster-less videos of the top document get a transparent one,
            // so a poster WebView fetched before our chrome client was in
            // place (cached per web view) never shows.
            view.evaluateJavascript(NO_POSTER, null);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            nsh.onPageFinished(view, url);
        }

        @Override
        public void onReceivedError(WebView view, android.webkit.WebResourceRequest request,
                android.webkit.WebResourceError error) {
            nsh.onReceivedError(view, request, error);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
            return nsh.onRenderProcessGone(view, detail);
        }

        /** On a WebView thread: note media requests, load nothing ourselves. */
        @Override
        public android.webkit.WebResourceResponse shouldInterceptRequest(WebView view,
                android.webkit.WebResourceRequest request) {
            String url = request.getUrl().toString();
            String scheme = request.getUrl().getScheme();
            android.webkit.WebResourceResponse local = localPlayer(request);
            if (local != null) return local;
            if (SKIP_MEDIA_EXTRAS && skip(request)) {
                return new android.webkit.WebResourceResponse("text/plain", "utf-8", 204, "No Content",
                        java.util.Collections.emptyMap(), new java.io.ByteArrayInputStream(new byte[0]));
            }
            if (("https".equals(scheme) || "http".equals(scheme))
                    && !"127.0.0.1".equals(request.getUrl().getHost())
                    && MEDIA.matcher(request.getUrl().getPath() == null ? "" : request.getUrl().getPath() + "?").find()
                    && reported.add(url)) {
                report(view, url, request.getRequestHeaders());
            }
            return null;
        }

        /**
         * A finished download's page from the downloader's localhost server
         * ({@code http://127.0.0.1:<port>/<token>/<id>/player.html?f=…}):
         * Android's own page (assets/local-player.html: fragmented-MP4 HLS
         * through Media Source Extensions, which WebView's built-in HLS
         * cannot parse); its playlists and segments still come from the
         * server. Null for every other request.
         */
        private static android.webkit.WebResourceResponse localPlayer(android.webkit.WebResourceRequest request) {
            android.net.Uri u = request.getUrl();
            if (!"http".equals(u.getScheme()) || !"127.0.0.1".equals(u.getHost())) return null;
            String path = u.getPath();
            if (path == null || !path.endsWith("/player.html") || !request.isForMainFrame()) return null;
            android.content.Context c = DlNative.app;
            if (c == null) return null;
            try {
                java.util.Map<String, String> headers = new java.util.HashMap<>();
                headers.put("Cache-Control", "no-store");
                return new android.webkit.WebResourceResponse("text/html", "utf-8", 200, "OK", headers,
                        c.getAssets().open("local-player.html"));
            } catch (java.io.IOException e) {
                return null;
            }
        }

        /** {@code scheme://host[:port]} of a URL, or null. */
        static String originOf(String url) {
            if (url == null || url.isEmpty()) return null;
            android.net.Uri u = android.net.Uri.parse(url);
            if (u.getScheme() == null || u.getHost() == null) return null;
            return u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
        }

        private static void report(WebView view, String url, java.util.Map<String, String> headers) {
            try {
                org.json.JSONObject h = new org.json.JSONObject();
                String referer = null, origin = null;
                if (headers != null) {
                    for (java.util.Map.Entry<String, String> e : headers.entrySet()) {
                        h.put(e.getKey(), e.getValue());
                        if ("Referer".equalsIgnoreCase(e.getKey())) referer = e.getValue();
                        if ("Origin".equalsIgnoreCase(e.getKey())) origin = e.getValue();
                    }
                }
                // What the native player's proxy needs (plan §2.1, §2.4): the
                // origin of the FRAME that made the request (its Referer),
                // not the top page's; and the media host's cookies.
                String frame = origin != null ? origin : originOf(referer);
                if (frame != null && origin == null) h.put("Origin", frame);
                String cookies = android.webkit.CookieManager.getInstance().getCookie(url);
                if (cookies != null && !cookies.isEmpty()) h.put("Cookie", cookies);
                org.json.JSONObject msg = new org.json.JSONObject()
                        .put("t", -2)
                        .put("streams", new org.json.JSONArray().put(url))
                        .put("hdrs", new org.json.JSONObject().put(url, h))
                        .put("src", "android");
                if (frame != null) msg.put("frameOrigin", frame);
                if (referer != null) msg.put("frame", referer);
                if (cookies != null && !cookies.isEmpty()) {
                    msg.put("cookies", cookies);
                    msg.put("ck", cookies);
                }
                String ua = headers == null ? null : headers.get("User-Agent");
                if (ua != null) msg.put("ua", ua);
                String js = "(function(){try{if(window.nsh&&window.nsh.postMessage)window.nsh.postMessage("
                        + org.json.JSONObject.quote(msg.toString()) + ");}catch(e){}})();";
                view.post(() -> view.evaluateJavascript(js, null));
            } catch (org.json.JSONException ignored) {
            }
        }
    }
}
