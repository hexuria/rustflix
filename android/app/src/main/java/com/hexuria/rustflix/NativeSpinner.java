package com.hexuria.rustflix;

import android.content.res.ColorStateList;
import android.graphics.Color;
import android.view.View;
import android.widget.ProgressBar;
import com.longbridge.nsh.NshComponent;
import com.longbridge.nsh.NshComponentContext;
import com.longbridge.nsh.NshView;

/**
 * {@code rustflix.spinner} (app/lib/nativespinner.tsx): Android's own
 * indeterminate progress ring, filling the box the app lays out. Props:
 * {@code color} ("#rrggbb" / "#aarrggbb").
 */
final class NativeSpinner implements NshComponent {
    private final ProgressBar bar;

    NativeSpinner(NshComponentContext ctx) {
        bar = new ProgressBar(ctx.getContext());
        bar.setIndeterminate(true);
        tint(0xffd4d4d8);
    }

    static void register(NshView nsh) {
        nsh.registerComponent("rustflix.spinner", NativeSpinner::new);
    }

    @Override
    public View view() {
        return bar;
    }

    @Override
    public void setProp(String name, Object value) {
        if (!"color".equals(name) || !(value instanceof String)) return;
        try {
            tint(Color.parseColor((String) value));
        } catch (IllegalArgumentException e) {
            // Not a colour: the tint stays.
        }
    }

    private void tint(int argb) {
        bar.setIndeterminateTintList(ColorStateList.valueOf(argb));
    }
}
