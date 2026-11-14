package com.hexuria.rustflix;

import android.app.Activity;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Rect;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.util.Log;
import android.util.Rational;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import com.longbridge.nsh.NshView;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Picture-in-picture for the player (Android's side of the player's PiP
 * button; app/lib/player.ts drives it):
 *
 * <ul>
 *   <li>{@code sys.pip {aspect?}} enters PiP now (the button).
 *   <li>{@code sys.pipState {paused, aspect?}} keeps the remote actions and
 *       auto-enter current: while the player shows and plays, leaving the
 *       app (Home, recents) enters PiP by itself ({@code setAutoEnterEnabled}
 *       on Android 12+, {@code onUserLeaveHint} before).
 *   <li>Remote actions: −10 s, play/pause, +10 s, sent to the app as
 *       {@code sys.pipAction {a: "back" | "toggle" | "fwd"}}.
 *   <li>In PiP every view of the player's window except the web view and
 *       its ancestors is hidden (the app's controls, the title), and the app
 *       hears {@code sys.pip {on}}; expanding restores them. Dismissing the
 *       PiP window pauses the video ({@code sys.pipAction {a: "pause"}}).
 * </ul>
 *
 * <p>PiP is per activity: the whole task shrinks, the player's Dialog
 * window with it (it belongs to the activity's token), laid out again at
 * the PiP window's size.
 */
final class Pip {
    private static final String ACTION = "com.hexuria.rustflix.PIP_ACTION";

    private final Activity activity;
    private NshView nsh;
    private boolean player, paused = true, inPip;
    private Rational aspect = new Rational(16, 9);
    /** Views hidden for PiP, with their visibility before. */
    private final Map<View, Integer> hidden = new HashMap<>();

    private final BroadcastReceiver actions = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent i) {
            String a = i.getStringExtra("a");
            if (a == null) return;
            // The app's own player plays: the actions drive it directly.
            NativeVideo v = NativeVideo.current();
            if (v != null) {
                v.remote(a);
                return;
            }
            if (nsh != null) nsh.send("sys.pipAction", java.util.Collections.singletonMap("a", a));
        }
    };

    /** The activity's (one per process in this app). */
    private static Pip instance;

    Pip(Activity activity) {
        this.activity = activity;
        instance = this;
    }

    static Activity activity() {
        return instance == null ? null : instance.activity;
    }

    /** {@code rustflix.video}'s {@code enterPip} command. */
    static boolean enterFor(NativeVideo v) {
        return instance != null && instance.enter();
    }

    /** A native player started / stopped playing, or its size changed. */
    static void nativeStateChanged() {
        if (instance != null) instance.update();
    }

    /** Whether something plays that PiP would show: the app's own player,
     * else the web player (sys.playerWindow / sys.pipState). */
    private boolean playing() {
        NativeVideo v = NativeVideo.current();
        if (v != null) return v.isPlaying();
        return player && !paused;
    }

    private boolean showing() {
        return NativeVideo.current() != null || player;
    }

    static boolean supported(Activity a) {
        return a.getPackageManager().hasSystemFeature(android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    void register(NshView nsh) {
        this.nsh = nsh;
        IntentFilter f = new IntentFilter(ACTION);
        if (Build.VERSION.SDK_INT >= 33) activity.registerReceiver(actions, f, Context.RECEIVER_NOT_EXPORTED);
        else activity.registerReceiver(actions, f);
        nsh.handle("sys.pip", (d, r) -> {
            readAspect(d);
            r.resolve(enter());
        });
        nsh.handle("sys.pipState", (d, r) -> {
            if (d instanceof Map) paused = !Boolean.FALSE.equals(((Map<?, ?>) d).get("paused"));
            readAspect(d);
            update();
            r.resolve(null);
        });
    }

    void destroy() {
        try {
            activity.unregisterReceiver(actions);
        } catch (RuntimeException ignored) {
        }
    }

    /** The player shows (from sys.playerWindow) or not. */
    void setPlayer(boolean on) {
        if (player == on) return;
        player = on;
        if (!on) paused = true;
        update();
    }

    private void readAspect(Object d) {
        if (!(d instanceof Map)) return;
        Object w = ((Map<?, ?>) d).get("w"), h = ((Map<?, ?>) d).get("h");
        if (w instanceof Number && h instanceof Number && ((Number) w).intValue() > 0 && ((Number) h).intValue() > 0) {
            // PiP accepts 1:2.39 … 2.39:1.
            double r = ((Number) w).doubleValue() / ((Number) h).doubleValue();
            r = Math.max(1 / 2.39, Math.min(2.39, r));
            aspect = new Rational((int) Math.round(r * 1000), 1000);
        }
    }

    private boolean enter() {
        if (!showing() || !supported(activity)) return false;
        try {
            return activity.enterPictureInPictureMode(params());
        } catch (RuntimeException e) {
            Log.w(MainActivity.TAG, "pip: " + e);
            return false;
        }
    }

    /** Android 8–11: leaving the app while a video plays enters PiP. */
    void onUserLeaveHint() {
        if (Build.VERSION.SDK_INT < 31 && playing()) enter();
    }

    private void update() {
        if (!supported(activity)) return;
        try {
            activity.setPictureInPictureParams(params());
        } catch (RuntimeException e) {
            Log.w(MainActivity.TAG, "pip params: " + e);
        }
    }

    private PictureInPictureParams params() {
        Rational ratio = aspect;
        NativeVideo v = NativeVideo.current();
        if (v != null) {
            int[] size = v.videoSize();
            if (size[0] > 0 && size[1] > 0) {
                double r = Math.max(1 / 2.39, Math.min(2.39, size[0] / (double) size[1]));
                ratio = new Rational((int) Math.round(r * 1000), 1000);
            }
        }
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder()
                .setAspectRatio(ratio)
                .setActions(remoteActions());
        Rect hint = videoRect();
        if (hint != null) b.setSourceRectHint(hint);
        if (Build.VERSION.SDK_INT >= 31) {
            b.setAutoEnterEnabled(playing());
            b.setSeamlessResizeEnabled(false);
        }
        return b.build();
    }

    private List<RemoteAction> remoteActions() {
        List<RemoteAction> list = new ArrayList<>();
        list.add(action("back", android.R.drawable.ic_media_rew, "Back 10 seconds", 1));
        list.add(!playing()
                ? action("toggle", android.R.drawable.ic_media_play, "Play", 2)
                : action("toggle", android.R.drawable.ic_media_pause, "Pause", 2));
        list.add(action("fwd", android.R.drawable.ic_media_ff, "Forward 10 seconds", 3));
        return list;
    }

    private RemoteAction action(String a, int icon, String title, int code) {
        Intent i = new Intent(ACTION).setPackage(activity.getPackageName()).putExtra("a", a);
        PendingIntent pi = PendingIntent.getBroadcast(activity, code, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new RemoteAction(Icon.createWithResource(activity, icon), title, title, pi);
    }

    /** The player's web view on screen (the PiP animation starts from it). */
    private Rect videoRect() {
        NativeVideo v = NativeVideo.current();
        if (v != null) return v.screenRect();
        WebView w = playerWebView();
        if (w == null || !w.isShown()) return null;
        Rect r = new Rect();
        return w.getGlobalVisibleRect(r) && !r.isEmpty() ? r : null;
    }

    private WebView playerWebView() {
        View main = activity.getWindow().getDecorView();
        for (View root : WebViewTweaks.windowRoots()) {
            if (root == main || !root.isAttachedToWindow()) continue;
            WebView w = find(root);
            if (w != null) return w;
        }
        return null;
    }

    private static WebView find(View v) {
        if (v instanceof WebView) return (WebView) v;
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) {
                WebView w = find(g.getChildAt(i));
                if (w != null) return w;
            }
        }
        return null;
    }

    void onPictureInPictureModeChanged(boolean on) {
        inPip = on;
        NativeVideo v = NativeVideo.current();
        View keep = v != null ? v.pictureView() : playerWebView();
        if (on && keep != null) {
            hideAllBut(keep.getRootView(), keep);
        } else {
            for (Map.Entry<View, Integer> e : hidden.entrySet()) e.getKey().setVisibility(e.getValue());
            hidden.clear();
        }
        NativeVideo.pipChanged(on);
        if (nsh != null) nsh.send("sys.pip", java.util.Collections.singletonMap("on", on));
    }

    /** The PiP window was dismissed (the activity stops while in PiP). */
    void onStop() {
        if (!inPip) return;
        NativeVideo v = NativeVideo.current();
        if (v != null) v.remote("pause");
        else if (nsh != null) nsh.send("sys.pipAction", java.util.Collections.singletonMap("a", "pause"));
    }

    /** Hides every view under {@code root} that neither is nor holds {@code keep}. */
    private void hideAllBut(View root, View keep) {
        if (root == keep) return;
        if (!(root instanceof ViewGroup) || !holds((ViewGroup) root, keep)) {
            if (root.getVisibility() == View.VISIBLE) {
                hidden.put(root, root.getVisibility());
                root.setVisibility(View.INVISIBLE);
            }
            return;
        }
        ViewGroup g = (ViewGroup) root;
        for (int i = 0; i < g.getChildCount(); i++) hideAllBut(g.getChildAt(i), keep);
    }

    private static boolean holds(ViewGroup g, View v) {
        for (View p = v; p != null; p = p.getParent() instanceof View ? (View) p.getParent() : null) {
            if (p == g) return true;
        }
        return false;
    }
}
