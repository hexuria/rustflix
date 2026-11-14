package com.hexuria.rustflix;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** The Cancel action of a download's notification: {@code dl.cancel}. */
public final class DownloadActionReceiver extends BroadcastReceiver {
    static final String ACTION_CANCEL = "com.hexuria.rustflix.CANCEL_DOWNLOAD";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_CANCEL.equals(intent.getAction())) return;
        long id = intent.getLongExtra("id", 0);
        if (id <= 0) return;
        PendingResult done = goAsync();
        DlNative.init(context);
        new Thread(() -> {
            try {
                DlNative.call("dl.cancel", "{\"id\":" + id + "}");
            } finally {
                done.finish();
            }
        }, "rustflix-dl-cancel").start();
    }
}
