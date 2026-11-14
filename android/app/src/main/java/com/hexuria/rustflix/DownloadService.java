package com.hexuria.rustflix;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONObject;

/**
 * Keeps transfers going while the app is in the background: a foreground
 * service of type {@code dataSync} that runs while any download record is
 * {@code running} and stops itself when the queue is idle. The transfers
 * themselves run in the downloader library's threads (same process); the
 * service only keeps the process at foreground priority and shows progress.
 *
 * <p>Notifications (channel "Downloads", low importance): the service's own
 * summary (mandatory; shown in the shade only with POST_NOTIFICATIONS on
 * Android 13+) and one per download with its progress and a Cancel action.
 * Tapping either opens the app on its Downloads tab.
 *
 * <p>Android 15 limits {@code dataSync} services to about 6 hours in 24;
 * at the limit ({@link #onTimeout}) the service stops and transfers carry
 * on only while the system keeps the process (unfinished ones resume at the
 * next launch).
 */
public final class DownloadService extends Service {
    static final String CHANNEL = "downloads";
    static final String ACTION_OPEN = "com.hexuria.rustflix.OPEN_DOWNLOADS";
    private static final int SUMMARY_ID = 1;
    private static final int ITEM_BASE = 1000;

    /** Running records by id (process-wide; any thread). */
    private static final Map<Long, JSONObject> running = new LinkedHashMap<>();
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static DownloadService instance;
    private static boolean starting;

    /** A record changed (from {@link DlNative#onEvent}, any thread). */
    static void onRecord(JSONObject rec) {
        long id = rec.optLong("id");
        String status = rec.optString("status");
        synchronized (running) {
            if ("running".equals(status)) running.put(id, rec);
            else running.remove(id);
        }
        main.post(() -> {
            if (!"running".equals(status)) {
                Context c = DlNative.app;
                if (c != null) notifications(c).cancel(ITEM_BASE + (int) id);
            }
            sync();
        });
    }

    /** Starts or stops the service to match the queue; refreshes it. */
    static void sync() {
        Context c = DlNative.app;
        if (c == null) return;
        boolean busy;
        synchronized (running) {
            busy = !running.isEmpty();
        }
        if (busy && instance == null && !starting) {
            starting = true;
            try {
                c.startForegroundService(new Intent(c, DownloadService.class));
            } catch (RuntimeException e) {
                // Not allowed from the background (Android 12+): the next
                // event while the app is in front starts it.
                starting = false;
                Log.w(MainActivity.TAG, "download service: " + e);
            }
        } else if (instance != null) {
            if (busy) instance.refresh();
            else instance.finish();
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        starting = false;
        channel(this);
        Notification n = summary();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(SUMMARY_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(SUMMARY_ID, n);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        sync();
        // Not restarted by the system: the app resumes unfinished records
        // itself at its next launch.
        return START_NOT_STICKY;
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        Log.w(MainActivity.TAG, "download service: dataSync time limit reached");
        finish();
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void finish() {
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
        instance = null;
    }

    private void refresh() {
        NotificationManager nm = notifications(this);
        nm.notify(SUMMARY_ID, summary());
        Map<Long, JSONObject> now;
        synchronized (running) {
            now = new LinkedHashMap<>(running);
        }
        for (Map.Entry<Long, JSONObject> e : now.entrySet()) {
            nm.notify(ITEM_BASE + (int) (long) e.getKey(), item(e.getKey(), e.getValue()));
        }
    }

    private Notification summary() {
        int n;
        double sum = 0;
        int known = 0;
        synchronized (running) {
            n = running.size();
            for (JSONObject r : running.values()) {
                if (!r.isNull("progress")) {
                    sum += r.optDouble("progress", 0);
                    known++;
                }
            }
        }
        String title = n <= 1 ? "Downloading" : "Downloading " + n + " videos";
        Notification.Builder b = builder(this)
                .setContentTitle(title)
                .setContentText(known > 0 ? Math.round(sum / known) + "%" : "Starting…")
                .setOngoing(true)
                .setGroup(CHANNEL)
                .setGroupSummary(true);
        if (known > 0) b.setProgress(100, (int) Math.round(sum / known), false);
        else b.setProgress(0, 0, true);
        return b.build();
    }

    private Notification item(long id, JSONObject r) {
        boolean known = !r.isNull("progress");
        int pct = (int) Math.round(r.optDouble("progress", 0));
        String name = r.optString("name", "Video");
        String text = known ? pct + "%" : r.optString("message", "");
        Intent cancel = new Intent(this, DownloadActionReceiver.class)
                .setAction(DownloadActionReceiver.ACTION_CANCEL)
                .putExtra("id", id);
        PendingIntent cancelPi = PendingIntent.getBroadcast(this, (int) id, cancel,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return builder(this)
                .setContentTitle(name)
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setGroup(CHANNEL)
                .setProgress(100, known ? pct : 0, !known)
                .addAction(new Notification.Action.Builder(null, "Cancel", cancelPi).build())
                .build();
    }

    private static Notification.Builder builder(Context c) {
        Intent open = new Intent(c, MainActivity.class)
                .setAction(ACTION_OPEN)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(c, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentIntent(pi)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_PROGRESS);
    }

    static void channel(Context c) {
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Progress of video downloads");
        notifications(c).createNotificationChannel(ch);
    }

    private static NotificationManager notifications(Context c) {
        return (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
    }
}
