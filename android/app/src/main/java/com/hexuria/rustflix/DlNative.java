package com.hexuria.rustflix;

import android.content.Context;
import android.util.Log;
import java.io.File;
import org.json.JSONObject;

/**
 * The downloader library ({@code librustflix_dl.so}, android/rustflix-dl:
 * the desktop shell's {@code src/dl} and its streaming proxy
 * {@code src/stream} over JNI). One per process; the
 * Activity and {@link DownloadService} share it.
 *
 * <p>Storage: records in {@code files/rustflix-dl/rustflix-downloads.json};
 * downloads, one folder each, in the app's external files directory
 * ({@code Android/data/com.hexuria.rustflix/files/downloads}, removed with
 * the app, not in backups), else {@code files/downloads}.
 */
final class DlNative {
    static {
        System.loadLibrary("rustflix_dl");
    }

    private DlNative() {}

    private static boolean inited;
    static Context app;

    /** Where record changes go besides the service (the app's JS). */
    interface Listener {
        void onRecord(JSONObject record);
    }

    static volatile Listener listener;

    /** Starts the downloader once; records left running resume now. */
    static synchronized void init(Context context) {
        if (inited) return;
        inited = true;
        app = context.getApplicationContext();
        File data = new File(app.getFilesDir(), "rustflix-dl");
        File ext = app.getExternalFilesDir(null);
        File downloads = new File(ext != null ? ext : app.getFilesDir(), "downloads");
        nativeInit(data.getAbsolutePath(), downloads.getAbsolutePath());
    }

    /** One {@code dl.*} call as JSON (blocking: never on the UI thread). */
    static String call(String name, String json) {
        return nativeCall(name, json == null ? "{}" : json);
    }

    static void setMetered(boolean metered) {
        nativeSetMetered(metered);
    }

    /** From the downloader's threads: a record changed. */
    @SuppressWarnings("unused") // called from native code
    static void onEvent(String json) {
        JSONObject rec;
        try {
            rec = new JSONObject(json);
        } catch (Exception e) {
            Log.w(MainActivity.TAG, "dl event: " + e);
            return;
        }
        DownloadService.onRecord(rec);
        Listener l = listener;
        if (l != null) l.onRecord(rec);
    }

    /** Where {@code dl.stream.event}s go (the app's JS). */
    static volatile Listener streamListener;

    /** From the streaming proxy's threads: a {@code dl.stream.event}. */
    @SuppressWarnings("unused") // called from native code
    static void onStreamEvent(String json) {
        Listener l = streamListener;
        if (l == null) return;
        try {
            l.onRecord(new JSONObject(json));
        } catch (Exception e) {
            Log.w(MainActivity.TAG, "stream event: " + e);
        }
    }

    private static native void nativeInit(String dataDir, String downloadsDir);

    private static native String nativeCall(String name, String json);

    private static native void nativeSetMetered(boolean metered);
}
