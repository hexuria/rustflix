package com.hexuria.rustflix;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowInsetsController;
import com.longbridge.nsh.NshView;

/**
 * Hosts the NSH runtime ({@link NshView}) edge to edge and registers the
 * app's {@code nsh/host} handlers (the Android side of
 * ios/Rustflix/RustflixApp.swift):
 *
 * <ul>
 *   <li>{@code sys.*} — brightness / volume swipes, the player's window mode
 *       ({@link SystemControls})
 *   <li>{@code cache.*} — Settings → Storage ({@link CacheControls})
 *   <li>{@code perf.*} — the FPS monitor ({@link PerfMonitor})
 *   <li>{@code dl.*} — offline downloads ({@link Downloads}: the Rust
 *       downloader of src/dl over JNI, {@link DownloadService} in the
 *       background)
 * </ul>
 */
public final class MainActivity extends Activity {
    static final String TAG = "rustflix";

    private NshView nsh;
    private SystemControls sys;
    private PerfMonitor perf;
    private Downloads downloads;
    private Pip pip;
    private EdgeBack edgeBack;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        edgeToEdge();
        // Before any view exists: the navigation buttons are asked away
        // ahead of the window's first frame, so they do not show and then
        // slide out.
        sys = new SystemControls(this);
        sys.reapply();
        // Swipe from the left edge to go back (phones with the button bar).
        // At a tab's first page there is nothing to go back to: it does
        // nothing there, it never leaves the app.
        edgeBack = new EdgeBack(getWindow().getDecorView(), sys::buttonNavigation, () -> {
            if (nsh != null) nsh.handleBack();
        });

        // Laid out without the navigation bar's inset while the buttons are
        // kept away (SystemControls.layoutInsets), from the first frame.
        nsh = new NshView(this) {
            @Override
            public android.view.WindowInsets getRootWindowInsets() {
                return sys.layoutInsets(super.getRootWindowInsets());
            }

            @Override
            public android.view.WindowInsets onApplyWindowInsets(android.view.WindowInsets insets) {
                return super.onApplyWindowInsets(sys.layoutInsets(insets));
            }
        };
        nsh.setBackgroundColor(0xff000000);
        nsh.setErrorListener(message -> Log.e(TAG, "nsh: " + message));
        // An app on its own, not a module in another app: room to spare on
        // slow phones (the embedded defaults are a 256 MB heap, 10 s to load,
        // 2 s per call, and stop the app when exceeded).
        nsh.setLimits(1024, 0, 60_000, 20_000, 0);
        setContentView(nsh);

        // Web views NSH creates get the settings the player needs.
        WebViewTweaks.watch(nsh);
        // Icon-only bottom tabs (the labels were being cut off).
        TabBarTweaks.watch(nsh);
        WebGuard.register(nsh);

        pip = new Pip(this);
        pip.register(nsh);
        sys.pip = pip;
        sys.register(nsh);
        new CacheControls(this).register(nsh);
        perf = new PerfMonitor(this);
        perf.register(nsh);
        downloads = new Downloads(this);
        downloads.register(nsh);
        // The app's own player (rustflix.video, Media3) and sys.webViews.
        NativeVideo.register(nsh);
        // The system's own loading ring (rustflix.spinner).
        NativeSpinner.register(nsh);
        WebViewTweaks.registerHost(nsh);

        nsh.loadAssetBundle("nsh");
        if (DownloadService.ACTION_OPEN.equals(getIntent().getAction())) downloads.openTab();
    }

    /** A download notification was tapped while the app runs. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (downloads != null && DownloadService.ACTION_OPEN.equals(intent.getAction())) downloads.openTab();
    }

    /** Draw behind the status and navigation bars; the app pads itself with
     * env(safe-area-inset-*) from the insets NshView reports. */
    @SuppressWarnings("deprecation")
    private void edgeToEdge() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getDecorView().getWindowInsetsController();
            int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            if (c != null) c.setSystemBarsAppearance(0, light); // light icons on the dark app
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        getWindow().setStatusBarColor(0);
        getWindow().setNavigationBarColor(0);
        if (Build.VERSION.SDK_INT >= 29) getWindow().setNavigationBarContrastEnforced(false);
    }

    /** Android 8–12 (and 13+ without the manifest's
     * enableOnBackInvokedCallback): the app gets the back button first. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (nsh == null || !nsh.handleBack()) super.onBackPressed();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // A window came or went (NSH shows modals, the player among them,
        // in Dialogs): watch its web views too.
        WebViewTweaks.rescan();
        if (sys != null) {
            sys.reapply();
            if (hasFocus) sys.focusGained();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (sys != null) sys.reapply();
    }

    /** The FPS monitor only watches (its two-finger triple tap); the edge
     * swipe back takes a touch over once it is clearly that gesture. */
    @Override
    public boolean dispatchTouchEvent(android.view.MotionEvent e) {
        if (perf != null) perf.observe(e);
        if (edgeBack != null && edgeBack.onTouch(e, super::dispatchTouchEvent)) return true;
        return super.dispatchTouchEvent(e);
    }

    /** Android 8–11: Home / recents while a video plays enters PiP. */
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (pip != null) pip.onUserLeaveHint();
    }

    @Override
    public void onPictureInPictureModeChanged(boolean inPip, android.content.res.Configuration config) {
        super.onPictureInPictureModeChanged(inPip, config);
        if (pip != null) pip.onPictureInPictureModeChanged(inPip);
    }

    @Override
    protected void onStop() {
        if (pip != null) pip.onStop();
        NativeVideo.onActivityStop(this);
        super.onStop();
    }

    @Override
    protected void onStart() {
        super.onStart();
        NativeVideo.onActivityStart();
    }

    @Override
    protected void onDestroy() {
        if (pip != null) pip.destroy();
        if (perf != null) perf.stop();
        // Transfers keep running in the process (DownloadService); only
        // the app's listener goes.
        if (downloads != null) downloads.destroy();
        if (nsh != null) nsh.destroy();
        super.onDestroy();
    }
}
