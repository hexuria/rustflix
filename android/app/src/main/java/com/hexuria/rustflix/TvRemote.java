package com.hexuria.rustflix;

import android.app.Activity;
import android.app.UiModeManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.speech.RecognizerIntent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.SystemClock;
import android.util.Log;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import com.longbridge.nsh.NshView;
import java.util.HashMap;
import java.util.Map;

/**
 * The TV remote (Android TV / Google TV; docs/ANDROID.md, "Android TV /
 * Google TV"). NSH's Android views take no key focus, so Android's own
 * D-pad focus search finds nothing; the app moves its own focus instead,
 * from keys this class hands it:
 *
 * <ul>
 *   <li>{@code sys.deviceInfo} → {@code {tv, leanback, touch}}.
 *   <li>{@code sys.keyCapture {on}} → {@code {ok: true}}: while on (from
 *       launch on a TV), the remote's keys are consumed here and sent to the
 *       app as {@code sys.key {key, action, repeat, editing}}, from every
 *       window: the activity's ({@link MainActivity#dispatchKeyEvent}) and
 *       each of NSH's modal Dialogs, the player's among them (the window
 *       callback {@link SystemControls} puts on them). Back is never taken.
 *   <li>{@code sys.tap {x, y}} → {@code {ok: true}}: a tap at that point
 *       (dp) of the focused window (a source's own page in the player, with
 *       the select key).
 * </ul>
 *
 * <p>While capture is on no web view takes key focus ({@link WebViewTweaks}),
 * and a window that gains focus gives it to its holder (the NshView, or the
 * dialog's decor view) unless a text field has it.
 */
final class TvRemote {
    private final Activity activity;
    private NshView nsh;
    /** On a TV (UI mode television, or a leanback device). */
    final boolean tv;
    private static volatile boolean capture;
    /** Capture came on: dialogs already open start passing their keys
     * (SystemControls.wrapDialogs; set by MainActivity). */
    Runnable onCapture;
    /** Keys whose press went to the app, with the press's {@code editing}:
     * their release goes there too. */
    private final Map<Integer, Boolean> pressed = new HashMap<>();

    /** What the launching intent asked to open (a search result, a query):
     * the interface takes it once it runs (sys.openRequest). */
    private Map<String, Object> pendingOpen;

    /** An intent of the system's search (SearchProvider.request): at launch
     * it waits for the interface; later it goes there at once (sys.open). */
    void open(Intent intent, boolean launch) {
        Map<String, Object> m = SearchProvider.request(intent);
        if (m == null) return;
        if (launch || nsh == null) pendingOpen = m;
        else nsh.send("sys.open", m);
    }

    void destroy() {
        stopRecognizer();
    }

    /** startActivityForResult's code for the voice input (sys.voice). */
    private static final int REQ_VOICE = 0x5631;
    /** Google TV's voice input (the Assistant's, with the remote's microphone). */
    private static final String TV_VOICE_INPUT = "com.google.android.katniss";
    private boolean listening;

    TvRemote(Activity activity) {
        this.activity = activity;
        this.tv = isTv(activity);
        capture = tv;
    }

    static boolean isTv(Context c) {
        UiModeManager ui = (UiModeManager) c.getSystemService(Context.UI_MODE_SERVICE);
        return (ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION)
                || c.getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK);
    }

    /** Whether the remote's keys go to the app now (sys.keyCapture). */
    static boolean capturing() {
        return capture;
    }

    void register(NshView nsh) {
        this.nsh = nsh;
        nsh.handle("sys.deviceInfo", (d, r) -> {
            PackageManager pm = activity.getPackageManager();
            Map<String, Object> m = new HashMap<>();
            m.put("tv", tv);
            m.put("leanback", pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK));
            m.put("touch", pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN));
            r.resolve(m);
        });
        nsh.handle("sys.keyCapture", (d, r) -> {
            boolean on = d instanceof Map && Boolean.TRUE.equals(((Map<?, ?>) d).get("on"));
            activity.runOnUiThread(() -> setCapture(on));
            r.resolve(java.util.Collections.singletonMap("ok", true));
        });
        // Voice input: a speech recognizer activity, which asks for no
        // permission of ours. On Google TV the TV's own voice input
        // (Katniss) is asked for by name: it listens through the remote's
        // microphone, while the default answer to this intent there is
        // Speech Services, which listens to the TV's built-in microphone
        // (often off at the TV's privacy switch). {check: true}
        // answers {available}; otherwise it starts listening, answers
        // {ok}, and what was said comes as the event sys.voiceResult {text}
        // ("" when nothing was heard or it was cancelled).
        nsh.handle("sys.voice", (d, r) -> {
            Map<?, ?> m = d instanceof Map ? (Map<?, ?>) d : java.util.Collections.emptyMap();
            Intent in = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            in.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            in.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            in.setPackage(TV_VOICE_INPUT);
            if (in.resolveActivity(activity.getPackageManager()) == null) in.setPackage(null);
            // First choice: the app listens itself (startRecognizer), so
            // what is said comes straight back; the recognizer's own screen
            // is the fallback where no recognition service can be bound.
            boolean service = android.speech.SpeechRecognizer.isRecognitionAvailable(activity);
            boolean can = service || in.resolveActivity(activity.getPackageManager()) != null;
            if (Boolean.TRUE.equals(m.get("check"))) {
                r.resolve(java.util.Collections.singletonMap("available", can));
                return;
            }
            if (service) {
                // hold: keep listening (through pauses) until sys.voiceStop.
                // A new request takes over from one still under way (its
                // answer is no longer wanted).
                if (listening) abandon();
                hold = Boolean.TRUE.equals(m.get("hold"));
                heardSoFar = "";
                fastFails = 0;
                silences = 0;
                lastError = 0;
                holdUntil = SystemClock.uptimeMillis() + MAX_HOLD_MS;
                boolean started = listen();
                r.resolve(java.util.Collections.singletonMap("ok", started));
                return;
            }
            Object prompt = m.get("prompt");
            if (prompt instanceof String && !((String) prompt).isEmpty()) {
                in.putExtra(RecognizerIntent.EXTRA_PROMPT, (String) prompt);
            }
            boolean ok = false;
            if (can && !listening) {
                try {
                    activity.startActivityForResult(in, REQ_VOICE);
                    listening = true;
                    ok = true;
                } catch (ActivityNotFoundException | SecurityException e) {
                    Log.w(MainActivity.TAG, "voice input: " + e);
                }
            }
            r.resolve(java.util.Collections.singletonMap("ok", ok));
        });
        // The system's search (SearchProvider): the interface's TMDB key for
        // the provider, and what the launching intent asked to open.
        nsh.handle("sys.searchKey", (d, r) -> {
            Object k = d instanceof Map ? ((Map<?, ?>) d).get("key") : null;
            SearchProvider.setKey(activity, k instanceof String ? (String) k : "");
            r.resolve(java.util.Collections.singletonMap("ok", true));
        });
        nsh.handle("sys.openRequest", (d, r) -> {
            Map<String, Object> m = pendingOpen;
            pendingOpen = null;
            r.resolve(m);
        });
        // Hold to talk: sys.voiceStop ends the listening now (what was heard
        // comes as sys.voiceResult); sys.voiceHold {on: false} lets it end
        // by itself at the next pause (the key was only tapped).
        nsh.handle("sys.voiceStop", (d, r) -> {
            hold = false;
            Log.i(MainActivity.TAG, "voice: released, kept " + heardSoFar.length() + " chars, in flight " + lastPartial.length());
            if (listening && recognizer != null) {
                if (lastPartial.isEmpty() && !heardSoFar.isEmpty()) {
                    // Between phrases: what was kept is all of it.
                    heard(heardSoFar);
                } else {
                    // Mid-phrase (or nothing yet): the recognizer is left to
                    // finish it (cutting it off loses the words); its last
                    // partial answer stands in if it never does.
                    final int mine = ++voiceSession;
                    activity.getWindow().getDecorView().postDelayed(() -> {
                        if (listening && voiceSession == mine) heard(join(heardSoFar, lastPartial));
                    }, 1500);
                }
            }
            r.resolve(java.util.Collections.singletonMap("ok", true));
        });
        nsh.handle("sys.voiceHold", (d, r) -> {
            hold = d instanceof Map && Boolean.TRUE.equals(((Map<?, ?>) d).get("on"));
            r.resolve(java.util.Collections.singletonMap("ok", true));
        });
        nsh.handle("sys.tap", (d, r) -> {
            Map<?, ?> m = d instanceof Map ? (Map<?, ?>) d : java.util.Collections.emptyMap();
            Object x = m.get("x"), y = m.get("y");
            if (x instanceof Number && y instanceof Number) {
                float fx = ((Number) x).floatValue(), fy = ((Number) y).floatValue();
                activity.runOnUiThread(() -> tap(fx, fy));
            }
            r.resolve(java.util.Collections.singletonMap("ok", true));
        });
    }

    // --- Listening in the app (SpeechRecognizer) -------------------------------------
    //
    // On Android TV the recognition service to ask is the TV's own
    // (Katniss): it is the one that opens the remote's microphone. The
    // default service elsewhere. RECORD_AUDIO is asked for at the first use.

    private static final int REQ_MIC = 0x5632;
    private static final String TV_RECOGNIZER =
            "com.google.android.apps.tvsearch.voice.recognition.KatnissRecognitionService";
    private android.speech.SpeechRecognizer recognizer;
    private boolean waitingForMic;
    /** Hold to talk: the recognizer is started again each time it ends at
     * a pause, and what it heard is kept, until sys.voiceStop. */
    private boolean hold;
    /** A held key whose release never came must not listen for ever. */
    private static final long MAX_HOLD_MS = 60_000;
    private long holdUntil;
    private String heardSoFar = "";
    /** The phrase being heard now, as far as the recognizer has said. */
    private String lastPartial = "";
    private int voiceSession;

    /** When the recognizer was last started, and how many times in a row
     * it gave up at once: a held key must not restart it in a tight loop. */
    private long startedAt;
    private int fastFails;
    /** Silent recognizer runs in a row while it is kept on. */
    private int silences;
    /** Why the last listening ended with nothing (a SpeechRecognizer error
     * code; 0 when it did not fail). */
    private int lastError;

    /** Drops the listening under way without an answer. */
    private void abandon() {
        stopRecognizer();
        listening = false;
        waitingForMic = false;
        hold = false;
        heardSoFar = "";
        lastPartial = "";
        voiceSession++;
    }

    private static String join(String a, String b) {
        return a.isEmpty() ? b : b.isEmpty() ? a : a + " " + b;
    }

    /** Starts listening, asking for the microphone permission first when it
     * is not granted yet: whether it is under way. Main thread. */
    private boolean listen() {
        if (activity.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            waitingForMic = true;
            listening = true;
            // The permission dialog takes the key's release: not held.
            hold = false;
            activity.requestPermissions(new String[] {android.Manifest.permission.RECORD_AUDIO}, REQ_MIC);
            return true;
        }
        return startRecognizer();
    }

    /** MainActivity.onRequestPermissionsResult. */
    void onPermissionResult(int request, int[] grants) {
        if (request != REQ_MIC || !waitingForMic) return;
        waitingForMic = false;
        if (grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED) {
            if (!startRecognizer()) heard("");
        } else {
            Log.i(MainActivity.TAG, "voice: microphone permission refused");
            heard("");
        }
    }

    private boolean startRecognizer() {
        stopRecognizer();
        lastPartial = "";
        startedAt = SystemClock.uptimeMillis();
        try {
            android.content.ComponentName tvService = new android.content.ComponentName(TV_VOICE_INPUT, TV_RECOGNIZER);
            Intent probe = new Intent(android.speech.RecognitionService.SERVICE_INTERFACE).setComponent(tvService);
            boolean onTv = activity.getPackageManager().resolveService(probe, 0) != null;
            recognizer = onTv
                    ? android.speech.SpeechRecognizer.createSpeechRecognizer(activity, tvService)
                    : android.speech.SpeechRecognizer.createSpeechRecognizer(activity);
            Log.i(MainActivity.TAG, "voice: listening with " + (onTv ? "the TV's recognizer" : "the default recognizer"));
            recognizer.setRecognitionListener(new android.speech.RecognitionListener() {
                @Override
                public void onReadyForSpeech(android.os.Bundle params) {
                    partial(heardSoFar);
                }

                @Override
                public void onBeginningOfSpeech() {}

                @Override
                public void onRmsChanged(float rms) {}

                @Override
                public void onBufferReceived(byte[] buffer) {}

                @Override
                public void onEndOfSpeech() {}

                @Override
                public void onError(int error) {
                    Log.i(MainActivity.TAG, "voice: error " + error + (hold ? " (kept on)" : ""));
                    lastError = error;
                    // Held through a silence: listen on.
                    boolean quiet = error == android.speech.SpeechRecognizer.ERROR_NO_MATCH
                            || error == android.speech.SpeechRecognizer.ERROR_SPEECH_TIMEOUT;
                    long now = SystemClock.uptimeMillis();
                    fastFails = now - startedAt < 700 ? fastFails + 1 : 0;
                    // Kept on through a silence: listen on, but once something
                    // was said, two silences in a row are the end of it.
                    silences = quiet ? silences + 1 : 0;
                    boolean done = !heardSoFar.isEmpty() && silences >= 2;
                    if (hold && quiet && !done && fastFails < 3 && now < holdUntil && startRecognizer()) return;
                    heard(join(heardSoFar, lastPartial));
                }

                @Override
                public void onResults(android.os.Bundle results) {
                    String said = first(results);
                    if (said.isEmpty()) said = lastPartial;
                    lastPartial = "";
                    if (!said.isEmpty()) silences = 0;
                    String all = join(heardSoFar, said);
                    if (hold) {
                        // Held through a pause: keep it and listen on.
                        heardSoFar = all;
                        partial(all);
                        if (SystemClock.uptimeMillis() < holdUntil && startRecognizer()) return;
                    }
                    heard(all);
                }

                @Override
                public void onPartialResults(android.os.Bundle results) {
                    String p = first(results);
                    lastPartial = p;
                    partial(join(heardSoFar, p));
                }

                @Override
                public void onEvent(int type, android.os.Bundle params) {}
            });
            Intent in = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            in.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            in.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            in.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            in.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.getPackageName());
            // A title takes a breath to say: do not end at the first short
            // pause (a recognizer may ignore these).
            in.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500);
            in.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2500);
            in.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 2000);
            listening = true;
            recognizer.startListening(in);
            return true;
        } catch (RuntimeException e) {
            Log.w(MainActivity.TAG, "voice: " + e);
            stopRecognizer();
            listening = false;
            return false;
        }
    }

    private static String first(android.os.Bundle results) {
        java.util.ArrayList<String> said = results == null ? null
                : results.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION);
        return said != null && !said.isEmpty() && said.get(0) != null ? said.get(0) : "";
    }

    private void stopRecognizer() {
        if (recognizer == null) return;
        try {
            recognizer.destroy();
        } catch (RuntimeException e) {
            // already gone
        }
        recognizer = null;
    }

    /** What is being said, so far (sys.voicePartial). */
    private void partial(String text) {
        if (nsh != null) nsh.send("sys.voicePartial", java.util.Collections.singletonMap("text", text));
    }

    /** The end of listening: what was said, "" for nothing (sys.voiceResult). */
    private void heard(String text) {
        listening = false;
        hold = false;
        heardSoFar = "";
        lastPartial = "";
        voiceSession++;
        stopRecognizer();
        Log.i(MainActivity.TAG, "voice: heard " + text.length() + " chars");
        Map<String, Object> m = new HashMap<>();
        m.put("text", text);
        // Nothing heard because it failed (3: the microphone could not be
        // opened; 9: no permission), not because nobody spoke.
        m.put("error", text.isEmpty() ? lastError : 0);
        if (nsh != null) nsh.send("sys.voiceResult", m);
    }

    /** The voice input's answer (MainActivity.onActivityResult): whether
     * the result was this class's. */
    boolean onActivityResult(int request, int result, Intent data) {
        if (request != REQ_VOICE) return false;
        listening = false;
        String text = "";
        if (result == Activity.RESULT_OK && data != null) {
            java.util.ArrayList<String> said = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
            if (said != null && !said.isEmpty() && said.get(0) != null) text = said.get(0);
        }
        if (nsh != null) nsh.send("sys.voiceResult", java.util.Collections.singletonMap("text", text));
        return true;
    }

    /** Main thread. */
    private void setCapture(boolean on) {
        if (capture == on) return;
        capture = on;
        WebViewTweaks.keyFocus(!on);
        if (!on) return;
        if (onCapture != null) onCapture.run();
        // Whatever holds focus now gives it up (a web view, a tab).
        for (View root : WebViewTweaks.windowRoots()) {
            if (root.hasWindowFocus()) settleFocus(root);
        }
    }

    // --- Keys ---------------------------------------------------------------------

    /** The app's name for a remote key, or null (not forwarded). */
    static String keyName(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP: return "up";
            case KeyEvent.KEYCODE_DPAD_DOWN: return "down";
            case KeyEvent.KEYCODE_DPAD_LEFT: return "left";
            case KeyEvent.KEYCODE_DPAD_RIGHT: return "right";
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_BUTTON_A: return "select";
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: return "playpause";
            case KeyEvent.KEYCODE_MEDIA_PLAY: return "play";
            case KeyEvent.KEYCODE_MEDIA_PAUSE: return "pause";
            case KeyEvent.KEYCODE_MEDIA_STOP: return "stop";
            case KeyEvent.KEYCODE_MEDIA_REWIND: return "rewind";
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: return "forward";
            case KeyEvent.KEYCODE_MEDIA_NEXT: return "next";
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS: return "prev";
            case KeyEvent.KEYCODE_MENU: return "menu";
            default: return null;
        }
    }

    /**
     * A key event of {@code window}, before anything in it sees the key (its
     * window callback). True: taken (sent to the app as {@code sys.key}).
     *
     * <p>In a text field only up and down are taken: the field loses focus to
     * {@code holder} (the window's NshView or decor view) and the keyboard
     * hides, and the key goes out with {@code editing: true}. Every other key
     * is the field's.
     */
    boolean dispatch(KeyEvent e, Window window, View holder) {
        int code = e.getKeyCode();
        String key = keyName(code);
        if (key == null) return false;
        if (e.getAction() == KeyEvent.ACTION_UP) {
            // Its press went to the app (even if capture ended since).
            Boolean editing = pressed.remove(code);
            if (editing == null) return false;
            send(key, "up", 0, editing);
            return true;
        }
        if (e.getAction() != KeyEvent.ACTION_DOWN || !capture) return false;
        View focus = window.getCurrentFocus();
        boolean editing = focus instanceof EditText;
        if (editing) {
            if (code != KeyEvent.KEYCODE_DPAD_UP && code != KeyEvent.KEYCODE_DPAD_DOWN) return false;
            InputMethodManager imm = (InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) imm.hideSoftInputFromWindow(focus.getWindowToken(), 0);
            takeFocus(holder);
        }
        pressed.put(code, editing);
        send(key, "down", e.getRepeatCount(), editing);
        return true;
    }

    private void send(String key, String action, int repeat, boolean editing) {
        if (nsh == null) return;
        Map<String, Object> m = new HashMap<>();
        m.put("key", key);
        m.put("action", action);
        m.put("repeat", repeat);
        m.put("editing", editing);
        nsh.send("sys.key", m);
    }

    // --- Focus --------------------------------------------------------------------

    /**
     * A window gained focus (or capture came on) while capture is on: unless
     * a text field has it, focus goes to the window's holder — the NshView in
     * the activity's window, the decor view in a dialog's — so no web view or
     * tab keeps it. Keys reach the window callback whatever has focus; this
     * keeps them from a focused child's own handling when capture ends, and
     * gives up/down in a text field somewhere to go.
     */
    void settleFocus(View root) {
        if (!capture) return;
        View holder = holderOf(root);
        View focus = root.findFocus();
        if (focus == holder || focus instanceof EditText) return;
        takeFocus(holder);
    }

    private View holderOf(View root) {
        if (nsh != null && nsh.getRootView() == root) return nsh;
        return root;
    }

    /** NshView holds focus by itself; a dialog's decor view is made to. */
    private static void takeFocus(View holder) {
        if (!holder.isFocusable()) {
            holder.setFocusable(true);
            holder.setFocusableInTouchMode(true);
            holder.setDefaultFocusHighlightEnabled(false);
            if (holder instanceof ViewGroup) {
                ((ViewGroup) holder).setDescendantFocusability(ViewGroup.FOCUS_BEFORE_DESCENDANTS);
            }
        }
        holder.requestFocus();
    }

    // --- Taps ---------------------------------------------------------------------

    /** A tap at (x, y) dp of the focused window, sent through its window
     * callback as a touch screen's down and, a moment later, up. */
    private void tap(float x, float y) {
        View target = null;
        for (View root : WebViewTweaks.windowRoots()) {
            if (root.isAttachedToWindow() && root.hasWindowFocus()) target = root;
        }
        if (target == null) target = activity.getWindow().getDecorView();
        float density = target.getResources().getDisplayMetrics().density;
        float px = x * density, py = y * density;
        long down = SystemClock.uptimeMillis();
        View root = target;
        touch(root, down, down, MotionEvent.ACTION_DOWN, px, py);
        root.postDelayed(() -> touch(root, down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, px, py), 60);
    }

    private static void touch(View root, long down, long at, int action, float x, float y) {
        if (!root.isAttachedToWindow()) return;
        MotionEvent e = MotionEvent.obtain(down, at, action, x, y, 0);
        e.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        try {
            root.dispatchTouchEvent(e);
        } catch (RuntimeException ex) {
            Log.w(MainActivity.TAG, "sys.tap: " + ex);
        } finally {
            e.recycle();
        }
    }
}
