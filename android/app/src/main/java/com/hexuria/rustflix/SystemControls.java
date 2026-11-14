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
    /** Settings → General → "Hide Android's navigation buttons": kept here so
     * a launch starts with it, before the app's bundle has loaded. */
    private boolean hideNav;
    private static final String PREFS = "rustflix.ui";
    private static final String KEY_HIDE_NAV = "hideNavButtons";
    /** Picture-in-picture follows the player (set by MainActivity). */
    Pip pip;
    private NshView nsh;
    /** The back callback that leaves full screen (Android 13+), and where. */
    private Object backCallback;
    private android.window.OnBackInvokedDispatcher backDispatcher;

    SystemControls(Activity activity) {
        this.activity = activity;
        this.audio = (AudioManager) activity.getSystemService(Context.AUDIO_SERVICE);
        this.hideNav = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_HIDE_NAV, true);
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
        // {hidden}: whether the navigation buttons stay out of the app
        // (only with button navigation; see `hidesNavButtons`).
        nsh.handle("sys.navBar", (d, r) -> {
            Map<?, ?> m = d instanceof Map ? (Map<?, ?>) d : java.util.Collections.emptyMap();
            boolean hidden = Boolean.TRUE.equals(m.get("hidden"));
            if (hidden != hideNav) {
                hideNav = hidden;
                activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_HIDE_NAV, hidden).apply();
            }
            activity.runOnUiThread(this::bars);
            Map<String, Object> out = new HashMap<>();
            out.put("ok", true);
            out.put("buttons", buttonNavigation());
            r.resolve(out);
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
            // The player's window opens (or closes) around this call.
            activity.runOnUiThread(this::watchNewWindows);
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
        if (player || hideNav) {
            bars();
            watchNewWindows();
        }
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

    /** Frames left of looking for a window that has just been added. */
    private int watchFrames;
    private final android.view.Choreographer.FrameCallback watch = new android.view.Choreographer.FrameCallback() {
        @Override
        public void doFrame(long frameTimeNanos) {
            bars();
            if (--watchFrames > 0) android.view.Choreographer.getInstance().postFrameCallback(this);
        }
    };

    /**
     * A window is about to open (the player's Dialog, another modal): for
     * the next half second its bars are set the frame it is added, before
     * it takes focus. Left until the focus change, the system first shows
     * the navigation buttons for the new window and then hides them again
     * — the flicker this avoids. Main thread.
     */
    private void watchNewWindows() {
        boolean idle = watchFrames <= 0;
        watchFrames = 30;
        if (idle) android.view.Choreographer.getInstance().postFrameCallback(watch);
    }

    /** What each window's bars were last set to (0 shown, 1 no navigation
     * buttons, 2 none): a window is only asked again when that changes. */
    private final java.util.Map<View, Integer> barState = new java.util.WeakHashMap<>();

    /** Every window's bars: NSH shows the player in a Dialog, whose window
     * (focused while it is up) decides what the system bars do. */
    private void bars() {
        View decor = activity.getWindow().getDecorView();
        boolean seen = false;
        for (View root : WebViewTweaks.windowRoots()) {
            seen |= root == decor;
            bars(root);
        }
        // At launch the activity's window is not listed yet.
        if (!seen) bars(decor);
    }

    /** Whether the system bar holds buttons (three or two) rather than the
     * gesture pill: `config_navBarInteractionMode` is 0 or 1 for buttons, 2
     * for gestures. Unknown (Android before 10): buttons. */
    boolean buttonNavigation() {
        android.content.res.Resources res = activity.getResources();
        int id = res.getIdentifier("config_navBarInteractionMode", "integer", "android");
        return id == 0 || res.getInteger(id) != 2;
    }

    /** The navigation buttons are kept away: the setting is on and the
     * phone has buttons. With gestures the thin pill stays (hiding it would
     * only make the back swipe need a second try). */
    private boolean hidesNavButtons() {
        return hideNav && buttonNavigation();
    }

    @SuppressWarnings("deprecation")
    private void bars(View root) {
        // The player's own window (NSH's modal Dialog) is transparent and
        // lays its content out below the status bar, so the page under it
        // (a title's banner) showed behind the clock and battery. Black
        // behind the whole window: the strip matches the player. The window
        // goes away with the player, so nothing is put back.
        if (player && root != activity.getWindow().getDecorView()) root.setBackgroundColor(0xff000000);
        // Its touches (the edge swipe back) and its back key pass through us.
        guardBackKey(root);
        boolean all = player && fullscreen;
        boolean nav = !all && hidesNavButtons();
        int want = all ? 2 : nav ? 1 : 0;
        Integer had = barState.put(root, want);
        if (had != null && had == want) return;
        if (Build.VERSION.SDK_INT >= 30) {
            // The activity's own window has a controller before it is attached.
            WindowInsetsController c = root == activity.getWindow().getDecorView()
                    ? activity.getWindow().getInsetsController()
                    : root.getWindowInsetsController();
            if (c == null) {
                barState.remove(root); // not attached yet: asked again next time
                return;
            }
            if (all) {
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(WindowInsets.Type.systemBars());
            } else if (nav) {
                // A swipe up from the bottom edge shows the buttons for a
                // moment, over the app.
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.show(WindowInsets.Type.statusBars());
                c.hide(WindowInsets.Type.navigationBars());
            } else {
                c.show(WindowInsets.Type.systemBars());
            }
        } else {
            int flags = root.getSystemUiVisibility();
            int navOnly = View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
            int immersive = View.SYSTEM_UI_FLAG_FULLSCREEN | navOnly;
            flags &= ~immersive;
            if (all) flags |= immersive;
            else if (nav) flags |= navOnly;
            root.setSystemUiVisibility(flags);
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
            // Swipe from the left edge: the same as the back key, sent
            // through this window's callback (so full screen is left first).
            final EdgeBack edge = new EdgeBack(root, this::buttonNavigation, () -> {
                android.view.Window.Callback cb = w.getCallback();
                if (cb == null) return;
                long now = android.os.SystemClock.uptimeMillis();
                cb.dispatchKeyEvent(new android.view.KeyEvent(now, now, android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_BACK, 0));
                cb.dispatchKeyEvent(new android.view.KeyEvent(now, now, android.view.KeyEvent.ACTION_UP, android.view.KeyEvent.KEYCODE_BACK, 0));
            });
            android.view.Window.Callback wrapped = (android.view.Window.Callback) java.lang.reflect.Proxy.newProxyInstance(
                    android.view.Window.Callback.class.getClassLoader(),
                    new Class<?>[] {android.view.Window.Callback.class},
                    (proxy, method, args) -> {
                        if ("dispatchTouchEvent".equals(method.getName())
                                && args != null && args.length == 1 && args[0] instanceof android.view.MotionEvent) {
                            boolean taken = edge.onTouch((android.view.MotionEvent) args[0], e -> {
                                try {
                                    return Boolean.TRUE.equals(method.invoke(inner, e));
                                } catch (ReflectiveOperationException ex) {
                                    return false;
                                }
                            });
                            if (taken) return true;
                        }
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
