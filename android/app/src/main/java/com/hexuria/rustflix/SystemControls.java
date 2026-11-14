package com.hexuria.rustflix;

import android.app.Activity;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.media.AudioManager;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import com.longbridge.nsh.NshView;
import java.util.HashMap;
import java.util.Map;

/**
 * {@code sys.*} for the player (app/lib/system.ts; the Android side of
 * ios/Rustflix/SystemControls.swift):
 *
 * <ul>
 *   <li>{@code sys.getBrightness / setBrightness / restoreBrightness}: the
 *       window's own brightness ({@code screenBrightness}), never the
 *       system setting — so no WRITE_SETTINGS permission, and Android puts
 *       the user's level back by itself whenever the app is not in front.
 *   <li>{@code sys.getVolume / setVolume}: the media stream's volume
 *       (AudioManager), without the system's volume panel (the player
 *       draws its own).
 *   <li>{@code sys.playerWindow {on, fullscreen, pageTouches}}: while the
 *       player shows the screen stays on. Inline (as the iPhone player
 *       opens) the window follows the device's orientation with the system
 *       bars shown; in full screen (the player's Full screen button, the
 *       counterpart of AVKit's full screen on iPhone) it turns landscape
 *       with the sensor and the bars hide (immersive, swipe to peek). On
 *       Android 13+ the back gesture leaves full screen first, reported to
 *       the app as {@code sys.fullscreen {on: false}}.
 * </ul>
 */
final class SystemControls {
    private final Activity activity;
    private final AudioManager audio;
    private boolean player, fullscreen;
    /** Picture-in-picture follows the player (set by MainActivity). */
    Pip pip;
    private NshView nsh;
    /** The back callback that leaves full screen (Android 13+), and where. */
    private Object backCallback;
    private android.window.OnBackInvokedDispatcher backDispatcher;

    SystemControls(Activity activity) {
        this.activity = activity;
        this.audio = (AudioManager) activity.getSystemService(Context.AUDIO_SERVICE);
    }

    void register(NshView nsh) {
        this.nsh = nsh;
        // Version and build for Settings → About.
        nsh.handle("sys.appInfo", (d, r) -> {
            Map<String, Object> m = new HashMap<>();
            try {
                android.content.pm.PackageInfo p =
                    activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
                m.put("version", p.versionName);
                m.put("build", String.valueOf(
                    android.os.Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode));
            } catch (Exception e) {
                // Left empty: the app falls back to its bundled version.
            }
            r.resolve(m);
        });
        nsh.handle("sys.getBrightness", (d, r) -> r.resolve(value(brightness())));
        nsh.handle("sys.setBrightness", (d, r) -> {
            Double v = arg(d);
            if (v != null) setWindowBrightness((float) Math.max(0.01, v));
            r.resolve(value(v != null ? v : brightness()));
        });
        nsh.handle("sys.restoreBrightness", (d, r) -> {
            setWindowBrightness(WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE);
            r.resolve(value(brightness()));
        });
        nsh.handle("sys.getVolume", (d, r) -> r.resolve(value(volume())));
        nsh.handle("sys.setVolume", (d, r) -> {
            Double v = arg(d);
            if (v != null) {
                int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                try {
                    audio.setStreamVolume(AudioManager.STREAM_MUSIC, (int) Math.round(v * max), 0);
                } catch (SecurityException e) {
                    // Do Not Disturb policy or a fixed-volume device: leave it.
                    Log.w(MainActivity.TAG, "setStreamVolume: " + e.getMessage());
                }
            }
            r.resolve(value(volume()));
        });
        nsh.handle("sys.playerWindow", (d, r) -> {
            Map<?, ?> m = d instanceof Map ? (Map<?, ?>) d : java.util.Collections.emptyMap();
            setPlayer(Boolean.TRUE.equals(m.get("on")), Boolean.TRUE.equals(m.get("fullscreen")));
            WebViewTweaks.setPlayerPageTouches(Boolean.TRUE.equals(m.get("pageTouches")));
            r.resolve(null);
        });
    }

    // --- Brightness ---------------------------------------------------------------

    private float brightness() {
        float w = activity.getWindow().getAttributes().screenBrightness;
        if (w >= 0) return w;
        // The system's level: 0–255 on most devices (an approximation where
        // the device maps it non-linearly; the swipe only needs a start).
        try {
            int s = Settings.System.getInt(activity.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS);
            return Math.max(0f, Math.min(1f, s / 255f));
        } catch (Settings.SettingNotFoundException e) {
            return 1f;
        }
    }

    private void setWindowBrightness(float v) {
        WindowManager.LayoutParams lp = activity.getWindow().getAttributes();
        lp.screenBrightness = v;
        activity.getWindow().setAttributes(lp);
    }

    private float volume() {
        int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        return max <= 0 ? 1f : audio.getStreamVolume(AudioManager.STREAM_MUSIC) / (float) max;
    }

    // --- The player's window ------------------------------------------------------

    private void setPlayer(boolean on, boolean full) {
        full = on && full;
        if (player == on && fullscreen == full) return;
        player = on;
        fullscreen = full;
        if (pip != null) pip.setPlayer(on);
        if (on) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        activity.setRequestedOrientation(full
                ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                : ActivityInfo.SCREEN_ORIENTATION_FULL_USER);
        bars();
        backLeavesFullscreen(full);
    }

    /** Back in front, or a window came or went: the bars as they should be. */
    void reapply() {
        if (player) bars();
        if (fullscreen) backLeavesFullscreen(true);
    }

    /** While in full screen, back leaves it (on the player's own window:
     * NSH's Dialog) before the player hears it: the back key on every
     * version ({@link #guardBackKey}), the back gesture / callback on
     * Android 13+. */
    private void backLeavesFullscreen(boolean on) {
        View main = activity.getWindow().getDecorView();
        View target = main;
        for (View root : WebViewTweaks.windowRoots()) {
            if (root != main && root.isAttachedToWindow()) target = root;
        }
        if (on) guardBackKey(target);
        if (Build.VERSION.SDK_INT < 33) return;
        if (backCallback != null && backDispatcher != null) {
            backDispatcher.unregisterOnBackInvokedCallback((android.window.OnBackInvokedCallback) backCallback);
        }
        backCallback = null;
        backDispatcher = null;
        if (!on) return;
        android.window.OnBackInvokedDispatcher d = target.findOnBackInvokedDispatcher();
        if (d == null) return;
        android.window.OnBackInvokedCallback cb = this::leaveFullscreen;
        d.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_OVERLAY, cb);
        backCallback = cb;
        backDispatcher = d;
    }

    /** Every window's bars: NSH shows the player in a Dialog, whose window
     * (focused while it is up) decides what the system bars do. */
    private void bars() {
        for (View root : WebViewTweaks.windowRoots()) bars(root);
    }

    @SuppressWarnings("deprecation")
    private void bars(View root) {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = root.getWindowInsetsController();
            if (c == null) return;
            if (player && fullscreen) {
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(WindowInsets.Type.systemBars());
            } else {
                c.show(WindowInsets.Type.systemBars());
            }
        } else {
            int flags = root.getSystemUiVisibility();
            int immersive = View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
            root.setSystemUiVisibility(player && fullscreen ? flags | immersive : flags & ~immersive);
        }
    }

    private boolean swallowBackKey;

    /** Player windows whose key events already pass {@link #guardBackKey}. */
    private final java.util.Set<View> guarded = java.util.Collections.newSetFromMap(new java.util.WeakHashMap<>());

    /**
     * The back KEY (a 3-button navigation bar, a keyboard, {@code adb input
     * keyevent}) also reaches NSH's Dialog through its key listener, which
     * closes the player, besides the back callback above. While in full
     * screen the dialog window's {@code Window.Callback} takes it first and
     * only leaves full screen. Reaches the window through DecorView's
     * {@code mWindow} (a non-SDK field, reflection); where that is refused
     * the key keeps NSH's behaviour (the gesture still works).
     */
    private void guardBackKey(View root) {
        if (guarded.contains(root) || root == activity.getWindow().getDecorView()) return;
        try {
            java.lang.reflect.Field f = root.getClass().getDeclaredField("mWindow");
            f.setAccessible(true);
            android.view.Window w = (android.view.Window) f.get(root);
            if (w == null) return;
            final android.view.Window.Callback inner = w.getCallback();
            if (inner == null) return;
            android.view.Window.Callback wrapped = (android.view.Window.Callback) java.lang.reflect.Proxy.newProxyInstance(
                    android.view.Window.Callback.class.getClassLoader(),
                    new Class<?>[] {android.view.Window.Callback.class},
                    (proxy, method, args) -> {
                        if ("dispatchKeyEvent".equals(method.getName())
                                && args[0] instanceof android.view.KeyEvent
                                && ((android.view.KeyEvent) args[0]).getKeyCode() == android.view.KeyEvent.KEYCODE_BACK) {
                            android.view.KeyEvent e = (android.view.KeyEvent) args[0];
                            // A press that began in full screen is ours to
                            // the end (the back callback may leave full
                            // screen between its down and its up).
                            if (e.getAction() == android.view.KeyEvent.ACTION_DOWN) swallowBackKey = fullscreen;
                            if (swallowBackKey) {
                                if (e.getAction() == android.view.KeyEvent.ACTION_UP) {
                                    swallowBackKey = false;
                                    if (!e.isCanceled()) leaveFullscreen();
                                }
                                return true;
                            }
                        }
                        try {
                            return method.invoke(inner, args);
                        } catch (java.lang.reflect.InvocationTargetException ex) {
                            throw ex.getCause();
                        }
                    });
            w.setCallback(wrapped);
            guarded.add(root);
        } catch (ReflectiveOperationException | RuntimeException e) {
            Log.w(MainActivity.TAG, "back key guard: " + e);
        }
    }

    private void leaveFullscreen() {
        if (!fullscreen) return;
        setPlayer(player, false);
        if (nsh != null) nsh.send("sys.fullscreen", java.util.Collections.singletonMap("on", false));
    }

    // --- Arguments ----------------------------------------------------------------

    private static Map<String, Object> value(double v) {
        Map<String, Object> m = new HashMap<>();
        m.put("value", Math.max(0, Math.min(1, v)));
        return m;
    }

    /** {@code {value: number}} clamped to 0…1, or null. */
    private static Double arg(Object data) {
        if (!(data instanceof Map)) return null;
        Object v = ((Map<?, ?>) data).get("value");
        if (!(v instanceof Number)) return null;
        double d = ((Number) v).doubleValue();
        if (Double.isNaN(d) || Double.isInfinite(d)) return null;
        return Math.max(0, Math.min(1, d));
    }
}
