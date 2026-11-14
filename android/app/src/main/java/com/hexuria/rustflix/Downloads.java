package com.hexuria.rustflix;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.util.Log;
import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * {@code dl.*} for app/lib/downloads.ts (gated by capabilities.host "dl.*"),
 * the same host API as the desktop shell (src/dl) and the iPhone app
 * (Downloads.swift), answered by the same Rust downloader ({@link DlNative}):
 * {@code dl.list}, {@code dl.start}, {@code dl.cancel}, {@code dl.remove},
 * {@code dl.playUrl}, {@code dl.space}, {@code dl.nextId}, {@code dl.options}
 * ({@code wifiOnly}; no folder change). {@code dl.reveal} answers
 * {@code {ok: false}}. Record changes arrive as {@code dl.event}.
 *
 * <p>Calls run on worker threads (a remove waits for its transfer to stop).
 * The first {@code dl.start} asks for POST_NOTIFICATIONS on Android 13+;
 * downloads work without it (only the progress notifications stay hidden).
 */
final class Downloads {
    private static final String[] CALLS = {
        "dl.list", "dl.start", "dl.cancel", "dl.remove", "dl.playUrl",
        "dl.space", "dl.nextId", "dl.options", "dl.reveal", "dl.adopt",
        // The streaming proxy for the app's own player (src/stream).
        "dl.stream.open", "dl.stream.update", "dl.stream.close", "dl.stream.stats", "dl.stream.debug",
    };

    private final Activity activity;
    private final ExecutorService work = Executors.newCachedThreadPool();
    private NshView nsh;

    Downloads(Activity activity) {
        this.activity = activity;
        DlNative.init(activity);
        DownloadService.channel(activity);
    }

    void register(NshView nsh) {
        this.nsh = nsh;
        for (String name : CALLS) {
            nsh.handle(name, (data, reply) -> {
                if ("dl.start".equals(name)) askNotifications();
                String json = data == null ? "{}" : String.valueOf(JSONObject.wrap(data));
                work.execute(() -> answer(reply, DlNative.call(name, json)));
            });
        }
        DlNative.listener = rec -> nsh.post(() -> nsh.send("dl.event", rec));
        DlNative.streamListener = ev -> nsh.send("dl.stream.event", ev);
        watchNetwork();
        // Records resumed at init: bring the service up for them.
        work.execute(() -> {
            DlNative.call("dl.list", "{}");
            activity.runOnUiThread(DownloadService::sync);
        });
    }

    /** The app's Downloads tab (a notification was tapped). */
    void openTab() {
        if (nsh != null) nsh.send("dl.openTab", null);
    }

    void destroy() {
        DlNative.listener = null;
        DlNative.streamListener = null;
        work.shutdown();
    }

    private static void answer(NshHostReply reply, String json) {
        try {
            Object v = new JSONTokener(json).nextValue();
            reply.resolve(v == JSONObject.NULL ? null : v);
        } catch (Exception e) {
            reply.reject("bad answer from the downloader: " + e.getMessage());
        }
    }

    /** Android 13+: ask once, at the first download. */
    private void askNotifications() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        SharedPreferences prefs = activity.getSharedPreferences("rustflix", Context.MODE_PRIVATE);
        if (prefs.getBoolean("askedNotifications", false)) return;
        prefs.edit().putBoolean("askedNotifications", true).apply();
        activity.requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 0x4d4c);
    }

    /** Wi-Fi only: the downloader hears whether the network is metered. */
    private void watchNetwork() {
        ConnectivityManager cm = (ConnectivityManager) activity.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        try {
            cm.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
                @Override
                public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                    DlNative.setMetered(!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED));
                }
            });
        } catch (RuntimeException e) {
            Log.w(MainActivity.TAG, "network callback: " + e);
        }
    }
}
