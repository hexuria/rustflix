package com.hexuria.rustflix;

import android.app.Activity;
import android.graphics.Color;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.util.TypedValue;
import android.view.FrameMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.FrameLayout;
import android.widget.TextView;
import com.longbridge.nsh.NshView;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * {@code perf.*}: the FPS monitor, the recorder and the spike capture
 * (app/lib/perf.ts; the Android counterpart of ios/Rustflix/PerfMonitor.swift).
 *
 * <p>Frames come from the window's FrameMetrics (frames the app actually
 * rendered and how long each took, with the platform's own split, API 24+),
 * delivered on a thread of their own, so an idle screen shows 0 fps rather
 * than the display's rate and measuring adds nothing to the UI thread. A
 * frame is red when its total duration is over one refresh. Every red frame
 * goes to {@code files/perf-spikes.jsonl} with that split (input, animation,
 * layout/measure, draw, sync, command issue, swap buffers, GPU), the route
 * and scenario step, so a spike says where its time went.
 *
 * <p>Once a second the panel (a fixed-size text over the top-left corner:
 * updating it lays out nothing else; it takes only its own touches: a tap
 * folds it to one line, a long press saves the recording) shows fps, the
 * worst frame and its biggest part, frames over one refresh, and the JS
 * thread's lag and worst task that perf.ts posts ({@code perf.js}). While the
 * panel shows or the recorder is on, one JSON line per second goes to
 * {@code files/perf.jsonl} (rolled at 2 MB). Nothing runs while both are
 * off. A two-finger triple tap anywhere toggles the panel (observed in
 * {@link MainActivity#dispatchTouchEvent}; no touch is consumed or delayed).
 */
final class PerfMonitor {
    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private NshView nsh;
    private HandlerThread metricsThread;
    private Window.OnFrameMetricsAvailableListener listener;
    private TextView hud;
    private boolean hudOn, recordOn, collapsed;
    private volatile float refreshMs = 16.67f;

    // This second (written on the metrics thread, read on main: guarded by this).
    private int frames, janky;
    private double worstMs;
    private String worstPart = "";
    private String route = "", step = "", jsLine = "";
    private JSONObject js = new JSONObject();
    private final List<JSONObject> spikes = new ArrayList<>();

    private final Runnable second = new Runnable() {
        @Override
        public void run() {
            tick();
            main.postDelayed(this, 1000);
        }
    };

    PerfMonitor(Activity activity) {
        this.activity = activity;
    }

    void register(NshView nsh) {
        this.nsh = nsh;
        nsh.handle("perf.set", (d, r) -> {
            Map<?, ?> m = d instanceof Map ? (Map<?, ?>) d : java.util.Collections.emptyMap();
            boolean h = Boolean.TRUE.equals(m.get("hud")), rec = Boolean.TRUE.equals(m.get("record"));
            main.post(() -> set(h, rec));
            r.resolve(null);
        });
        nsh.handle("perf.js", (d, r) -> {
            if (d instanceof Map) jsReport((Map<?, ?>) d);
            r.resolve(null);
        });
        nsh.handle("perf.route", (d, r) -> {
            if (d instanceof Map) {
                Object v = ((Map<?, ?>) d).get("route");
                Object s = ((Map<?, ?>) d).get("step");
                synchronized (this) {
                    if (v != null) route = v.toString();
                    if (s != null) step = s.toString();
                }
            }
            r.resolve(null);
        });
        nsh.handle("perf.save", (d, r) -> {
            try {
                r.resolve(save());
            } catch (Exception e) {
                r.reject(String.valueOf(e));
            }
        });
        nsh.handle("perf.block", (d, r) -> {
            double ms = 0;
            if (d instanceof Map && ((Map<?, ?>) d).get("ms") instanceof Number) {
                ms = Math.min(2000, ((Number) ((Map<?, ?>) d).get("ms")).doubleValue());
            }
            final double block = ms;
            main.post(() -> {
                // A frame is due first, so the block delays it: FrameMetrics
                // reports only frames that are drawn.
                activity.getWindow().getDecorView().invalidate();
                selftestBlock(block);
            });
            r.resolve(null);
        });
    }

    /** Self-test: the UI thread busy for exactly {@code ms}. */
    private static void selftestBlock(double ms) {
        long until = SystemClock.uptimeMillis() + (long) ms;
        long x = 0;
        while (SystemClock.uptimeMillis() < until) x = x * 6364136223846793005L + 1;
        if (x == 42) android.util.Log.v(MainActivity.TAG, "");
    }

    private void set(boolean hud, boolean record) {
        hudOn = hud;
        recordOn = record;
        showHud(hud);
        if (hud || record) start();
        else stop();
    }

    // --- The two-finger triple tap ------------------------------------------------

    private long[] taps = new long[3];
    private int tapCount;
    private long downAt;
    private boolean twoDown;

    /** Watches every touch (never consumes one): three two-finger taps
     * within a second toggle the panel through the app. */
    void observe(MotionEvent e) {
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downAt = e.getEventTime();
                twoDown = false;
                break;
            case MotionEvent.ACTION_POINTER_DOWN:
                if (e.getPointerCount() == 2) twoDown = true;
                else twoDown = false;
                break;
            case MotionEvent.ACTION_UP:
                if (twoDown && e.getEventTime() - downAt < 300) {
                    long now = e.getEventTime();
                    if (tapCount > 0 && now - taps[tapCount - 1] > 500) tapCount = 0;
                    taps[tapCount++] = now;
                    if (tapCount == 3) {
                        tapCount = 0;
                        if (nsh != null) nsh.send("perf.toggle", null);
                    }
                }
                twoDown = false;
                break;
            case MotionEvent.ACTION_CANCEL:
                twoDown = false;
                tapCount = 0;
                break;
            default:
                break;
        }
    }

    // --- Measuring ----------------------------------------------------------------------

    private static double ms(FrameMetrics m, int id) {
        return m.getMetric(id) / 1e6;
    }

    private void start() {
        if (listener != null) return;
        metricsThread = new HandlerThread("rustflix-perf");
        metricsThread.start();
        refreshMs = 1000f / Math.max(1f, activity.getWindowManager().getDefaultDisplay().getRefreshRate());
        listener = (window, metrics, dropped) -> {
            final float budget = refreshMs;
            double total = ms(metrics, FrameMetrics.TOTAL_DURATION);
            // Late: past the frame's own deadline (API 31+: what the
            // platform counts as janky), else over one refresh.
            double deadline = android.os.Build.VERSION.SDK_INT >= 31
                    ? ms(metrics, FrameMetrics.DEADLINE) : budget;
            if (!(deadline > 0)) deadline = budget;
            boolean late = total > deadline;
            JSONObject spike = null;
            String part = "";
            if (late) {
                String[] names = {"input", "animation", "layout", "draw", "sync", "command", "swap", "gpu", "delay"};
                int[] ids = {
                    FrameMetrics.INPUT_HANDLING_DURATION, FrameMetrics.ANIMATION_DURATION,
                    FrameMetrics.LAYOUT_MEASURE_DURATION, FrameMetrics.DRAW_DURATION,
                    FrameMetrics.SYNC_DURATION, FrameMetrics.COMMAND_ISSUE_DURATION,
                    FrameMetrics.SWAP_BUFFERS_DURATION,
                    android.os.Build.VERSION.SDK_INT >= 31 ? FrameMetrics.GPU_DURATION : FrameMetrics.TOTAL_DURATION,
                    FrameMetrics.UNKNOWN_DELAY_DURATION,
                };
                try {
                    JSONObject split = new JSONObject();
                    double best = -1;
                    for (int i = 0; i < names.length; i++) {
                        if (names[i].equals("gpu") && android.os.Build.VERSION.SDK_INT < 31) continue;
                        double v = ms(metrics, ids[i]);
                        split.put(names[i], Math.round(v * 100) / 100.0);
                        if (v > best) {
                            best = v;
                            part = names[i];
                        }
                    }
                    spike = new JSONObject();
                    spike.put("t", System.currentTimeMillis());
                    spike.put("platform", "android");
                    spike.put("budget", Math.round(deadline * 100) / 100.0);
                    spike.put("cost", Math.round(total * 100) / 100.0);
                    spike.put("split", split);
                    spike.put("reason", String.format(Locale.US, "%s %.1f of %.1f ms", part, best, total));
                } catch (Exception ignored) {
                }
            }
            synchronized (PerfMonitor.this) {
                frames++;
                if (total > worstMs) {
                    worstMs = total;
                    worstPart = part;
                }
                if (late) janky++;
                if (spike != null && spikes.size() < 200) {
                    try {
                        spike.put("route", route);
                        spike.put("step", step);
                    } catch (Exception ignored) {
                    }
                    spikes.add(spike);
                }
            }
        };
        activity.getWindow().addOnFrameMetricsAvailableListener(listener, new Handler(metricsThread.getLooper()));
        main.postDelayed(second, 1000);
    }

    void stop() {
        main.removeCallbacks(second);
        if (listener != null) {
            try {
                activity.getWindow().removeOnFrameMetricsAvailableListener(listener);
            } catch (RuntimeException ignored) {
            }
            listener = null;
        }
        if (metricsThread != null) {
            metricsThread.quitSafely();
            metricsThread = null;
        }
    }

    private void showHud(boolean on) {
        if (on && hud == null) {
            hud = new TextView(activity);
            hud.setTextColor(Color.WHITE);
            hud.setBackgroundColor(0xB0000000);
            hud.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
            hud.setTypeface(android.graphics.Typeface.MONOSPACE);
            hud.setMaxLines(3);
            float d = activity.getResources().getDisplayMetrics().density;
            int pad = (int) (6 * d);
            hud.setPadding(pad, pad / 2, pad, pad / 2);
            hud.setText("fps …");
            hud.setOnClickListener(v -> {
                collapsed = !collapsed;
                tick(false);
            });
            hud.setOnLongClickListener(v -> {
                if (nsh != null) nsh.send("perf.saveRequest", null);
                return true;
            });
            // A fixed size: new text never lays the window out again.
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                    (int) (250 * d), (int) (52 * d), Gravity.TOP | Gravity.START);
            int top = 0;
            android.view.WindowInsets insets = activity.getWindow().getDecorView().getRootWindowInsets();
            if (insets != null) top = insets.getSystemWindowInsetTop();
            lp.topMargin = top + pad;
            lp.leftMargin = pad;
            ((ViewGroup) activity.getWindow().getDecorView()).addView(hud, lp);
        } else if (!on && hud != null) {
            ((ViewGroup) hud.getParent()).removeView(hud);
            hud = null;
        }
    }

    private void jsReport(Map<?, ?> d) {
        double lag = d.get("lagMax") instanceof Number ? ((Number) d.get("lagMax")).doubleValue() : 0;
        String worst = "";
        double worstTask = 0;
        Object longs = d.get("long");
        if (longs instanceof List) {
            for (Object o : (List<?>) longs) {
                if (o instanceof List && ((List<?>) o).size() >= 2 && ((List<?>) o).get(0) instanceof Number) {
                    double ms = ((Number) ((List<?>) o).get(0)).doubleValue();
                    if (ms > worstTask) {
                        worstTask = ms;
                        worst = String.valueOf(((List<?>) o).get(1));
                    }
                }
            }
        }
        synchronized (this) {
            js = new JSONObject(d);
            Object s = d.get("step");
            if (s != null) step = s.toString();
            jsLine = String.format(Locale.US, "js lag %.0f ms%s", lag,
                    worstTask > 0 ? String.format(Locale.US, " · %.0f ms %s", worstTask, worst) : "");
        }
    }

    private void tick() {
        tick(true);
    }

    private void tick(boolean closeSecond) {
        // The display's mode may have changed (refresh rate switching).
        refreshMs = 1000f / Math.max(1f, activity.getWindowManager().getDefaultDisplay().getRefreshRate());
        int f, j;
        double w;
        String r, s, jl, wp;
        JSONObject jsNow;
        List<JSONObject> sp;
        synchronized (this) {
            f = frames;
            j = janky;
            w = worstMs;
            wp = worstPart;
            r = route;
            s = step;
            jl = jsLine;
            jsNow = js;
            sp = new ArrayList<>(spikes);
            if (closeSecond) {
                frames = 0;
                janky = 0;
                worstMs = 0;
                worstPart = "";
                js = new JSONObject();
                spikes.clear();
            }
        }
        if (hudOn && hud != null) {
            hud.setText(collapsed
                    ? String.format(Locale.US, "%d fps · worst %.1f ms", f, w)
                    : String.format(Locale.US, "%d fps · worst %.1f ms %s · %d slow%s", f, w, wp, j,
                            jl.isEmpty() ? "" : "\n" + jl));
        }
        if (closeSecond && (recordOn || hudOn) && metricsThread != null) {
            // Files are written on the monitor's thread, never the UI thread.
            final int ff = f, jj = j;
            final double ww = w;
            new Handler(metricsThread.getLooper()).post(() -> record(ff, ww, jj, r, s, jsNow, sp));
        }
    }

    private File dir() {
        return activity.getFilesDir();
    }

    private static void append(File file, String rolled, String line) throws Exception {
        if (file.length() > 2_000_000) {
            //noinspection ResultOfMethodCallIgnored
            file.renameTo(new File(file.getParentFile(), rolled));
        }
        try (FileOutputStream out = new FileOutputStream(file, true)) {
            out.write((line + "\n").getBytes(StandardCharsets.UTF_8));
        }
    }

    private void record(int f, double w, int j, String r, String s, JSONObject jsNow, List<JSONObject> sp) {
        try {
            JSONObject line = new JSONObject();
            line.put("t", System.currentTimeMillis());
            line.put("platform", "android");
            line.put("hz", Math.round(1000 / refreshMs));
            line.put("frames", f);
            line.put("max", Math.round(w * 100) / 100.0);
            line.put("drop", f > 0 ? Math.round(j * 100.0 / f) / 100.0 : 0);
            line.put("over", j);
            line.put("spikes", sp.size());
            line.put("route", r);
            line.put("step", s);
            line.put("js", jsNow);
            append(new File(dir(), "perf.jsonl"), "perf.1.jsonl", line.toString());
            File spikesFile = new File(dir(), "perf-spikes.jsonl");
            for (JSONObject spike : sp) {
                spike.put("js", jsNow.optJSONArray("long") != null ? jsNow.optJSONArray("long") : new JSONArray());
                append(spikesFile, "perf-spikes.1.jsonl", spike.toString());
            }
        } catch (Exception e) {
            android.util.Log.w(MainActivity.TAG, "perf record: " + e);
        }
    }

    /** Rotates both files to timestamped names and copies them to the
     * app's external files folder ({@code Android/data/<app>/files}),
     * where they can be pulled or shared. */
    private Map<String, Object> save() throws Exception {
        long stamp = System.currentTimeMillis() / 1000;
        List<String> files = new ArrayList<>();
        File ext = activity.getExternalFilesDir(null);
        for (String[] p : new String[][] {{"perf.jsonl", "perf-" + stamp + ".jsonl"}, {"perf-spikes.jsonl", "perf-spikes-" + stamp + ".jsonl"}}) {
            File from = new File(dir(), p[0]);
            if (!from.exists()) continue;
            File to = new File(dir(), p[1]);
            if (!from.renameTo(to)) continue;
            File out = to;
            if (ext != null) {
                File copy = new File(ext, p[1]);
                try (InputStream in = new FileInputStream(to); OutputStream o = new FileOutputStream(copy)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
                }
                out = copy;
            }
            files.add(out.getAbsolutePath());
        }
        Map<String, Object> r = new java.util.HashMap<>();
        r.put("ok", true);
        r.put("dir", ext != null ? ext.getAbsolutePath() : dir().getAbsolutePath());
        r.put("files", files);
        return r;
    }
}
