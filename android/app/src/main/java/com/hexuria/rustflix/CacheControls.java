package com.hexuria.rustflix;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.WebStorage;
import android.webkit.WebView;
import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * {@code cache.*} for Settings → Storage (app/lib/cache.ts; the Android side
 * of ios/Rustflix/CacheControls.swift):
 *
 * <pre>
 *   cache.info               -> { images, web, site } in bytes
 *   cache.clear { what }     -> { freed } in bytes
 * </pre>
 *
 * images: NSH's image disk cache, {@code <cache>/nsh/<app id>/images}
 *         (NshCacheOptions' default); its contents go, the directory stays.
 * web:    the WebView's HTTP cache, {@code <cache>/WebView}; cleared with
 *         {@code WebView.clearCache(true)}.
 * site:   the WebView's cookies and storage (local storage, IndexedDB, …),
 *         {@code <data>/app_webview}; cleared with CookieManager and
 *         WebStorage.
 *
 * Sizes are walked off the main thread; a missing directory counts as 0.
 */
final class CacheControls {
    private final Activity activity;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final File images, web, site;

    CacheControls(Activity activity) {
        this.activity = activity;
        String id = appId(activity);
        images = new File(new File(new File(activity.getCacheDir(), "nsh"), id), "images");
        web = new File(activity.getCacheDir(), "WebView");
        site = new File(activity.getApplicationInfo().dataDir, "app_webview");
    }

    /** The nsh.json id from the bundle's nsh/app.json (names NSH's directories). */
    private static String appId(Activity a) {
        try (InputStream in = a.getAssets().open("nsh/app.json")) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            String id = new JSONObject(out.toString(StandardCharsets.UTF_8.name())).optString("id", "");
            if (!id.isEmpty() && !id.contains("/") && !id.equals(".") && !id.equals("..")) return id;
        } catch (Exception ignored) {
        }
        return a.getPackageName();
    }

    void register(NshView nsh) {
        nsh.handle("cache.info", (d, r) -> io.execute(() -> {
            Map<String, Object> m = new HashMap<>();
            m.put("images", size(images));
            m.put("web", size(web));
            m.put("site", size(site));
            r.resolve(m);
        }));
        nsh.handle("cache.clear", (d, r) -> {
            Object what = d instanceof Map ? ((Map<?, ?>) d).get("what") : null;
            if ("images".equals(what)) {
                io.execute(() -> {
                    long before = size(images);
                    clearContents(images);
                    freed(r, before - size(images));
                });
            } else if ("web".equals(what)) {
                measureThen(web, r, () -> {
                    WebView w = new WebView(activity);
                    w.clearCache(true);
                    w.destroy();
                });
            } else if ("site".equals(what)) {
                measureThen(site, r, () -> {
                    CookieManager.getInstance().removeAllCookies(null);
                    CookieManager.getInstance().flush();
                    WebStorage.getInstance().deleteAllData();
                });
            } else {
                freed(r, 0);
            }
        });
    }

    /** Size of dir, then clear on the main thread, then size again (after
     * the WebView's own threads have had a moment to delete). */
    private void measureThen(File dir, NshHostReply r, Runnable clear) {
        io.execute(() -> {
            long before = size(dir);
            main.post(() -> {
                try {
                    clear.run();
                } catch (RuntimeException e) {
                    android.util.Log.w(MainActivity.TAG, "cache.clear: " + e);
                }
                main.postDelayed(() -> io.execute(() -> freed(r, before - size(dir))), 500);
            });
        });
    }

    private static void freed(NshHostReply r, long bytes) {
        Map<String, Object> m = new HashMap<>();
        m.put("freed", Math.max(0, bytes));
        r.resolve(m);
    }

    /** Bytes of the regular files under dir (symlinks not followed). */
    private static long size(File dir) {
        if (dir == null) return 0;
        File[] items = dir.listFiles();
        if (items == null) return dir.isFile() ? dir.length() : 0;
        long total = 0;
        for (File f : items) {
            if (isLink(f)) continue;
            total += f.isDirectory() ? size(f) : f.length();
        }
        return total;
    }

    private static void clearContents(File dir) {
        File[] items = dir.listFiles();
        if (items == null) return;
        for (File f : items) delete(f);
    }

    private static void delete(File f) {
        if (f.isDirectory() && !isLink(f)) {
            File[] items = f.listFiles();
            if (items != null) for (File c : items) delete(c);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static boolean isLink(File f) {
        return java.nio.file.Files.isSymbolicLink(f.toPath());
    }
}
