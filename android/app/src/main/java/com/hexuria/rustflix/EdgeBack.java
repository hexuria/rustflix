package com.hexuria.rustflix;

import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.drawable.Drawable;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;

/**
 * Swipe from the left edge to go back, as on the iPhone, for phones with
 * the button bar (with gesture navigation the system already does it, so
 * this stays out of the way). One per window: the activity's, and each
 * dialog's (the player's).
 *
 * A finger that lands within {@link #EDGE_DP} of the left edge and moves
 * right more than it moves up or down takes the gesture over: the views
 * under it get a cancel (no scroll, no tap), a small arrow follows the
 * finger, and letting go past {@link #TRIGGER_DP} goes back. Anything else
 * (a tap, a vertical scroll that starts at the edge) passes through
 * untouched.
 */
final class EdgeBack {
    /** Sends an event on to the window's views. */
    interface Pass {
        boolean dispatch(MotionEvent e);
    }

    /** Whether the gesture applies now (button navigation). */
    interface Enabled {
        boolean get();
    }

    private static final float EDGE_DP = 24, TRIGGER_DP = 64, BUBBLE_DP = 19;

    private final View root;
    private final Enabled enabled;
    private final Runnable onBack;
    private final float density;
    private final int slop;
    private final Bubble bubble = new Bubble();

    private boolean tracking, captured, armed;
    private float x0, y0;

    EdgeBack(View root, Enabled enabled, Runnable onBack) {
        this.root = root;
        this.enabled = enabled;
        this.onBack = onBack;
        this.density = root.getResources().getDisplayMetrics().density;
        this.slop = ViewConfiguration.get(root.getContext()).getScaledTouchSlop();
    }

    /** Sees every touch of the window first. True: consumed here. */
    boolean onTouch(MotionEvent e, Pass pass) {
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                reset();
                tracking = e.getX() <= EDGE_DP * density && enabled.get();
                x0 = e.getX();
                y0 = e.getY();
                return false;
            case MotionEvent.ACTION_POINTER_DOWN:
                // A second finger: not this gesture.
                if (captured) {
                    reset();
                    return true;
                }
                tracking = false;
                return false;
            case MotionEvent.ACTION_MOVE: {
                if (!tracking) return false;
                float dx = e.getX() - x0, dy = e.getY() - y0;
                if (!captured) {
                    if (Math.abs(dy) > slop && Math.abs(dy) >= dx) {
                        tracking = false; // a vertical scroll that began at the edge
                        return false;
                    }
                    if (dx <= slop || dx < 1.5f * Math.abs(dy)) return false;
                    captured = true;
                    MotionEvent cancel = MotionEvent.obtain(e);
                    cancel.setAction(MotionEvent.ACTION_CANCEL);
                    pass.dispatch(cancel);
                    cancel.recycle();
                    root.getOverlay().add(bubble);
                }
                boolean now = dx >= TRIGGER_DP * density;
                if (now != armed) {
                    armed = now;
                    root.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK);
                }
                bubble.set(dx / (TRIGGER_DP * density), e.getY(), armed);
                return true;
            }
            case MotionEvent.ACTION_UP: {
                if (!captured) {
                    tracking = false;
                    return false;
                }
                boolean go = armed;
                reset();
                if (go) onBack.run();
                return true;
            }
            case MotionEvent.ACTION_CANCEL: {
                boolean was = captured;
                reset();
                return was;
            }
            default:
                return captured;
        }
    }

    private void reset() {
        if (captured) root.getOverlay().remove(bubble);
        tracking = captured = armed = false;
    }

    /** The arrow that follows the finger: a disc that slides in from the
     * edge and fills with the app's red once letting go will go back. */
    private final class Bubble extends Drawable {
        private final Paint disc = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint arrow = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path chevron = new Path();
        private float progress, y;
        private boolean on;

        Bubble() {
            arrow.setStyle(Paint.Style.STROKE);
            arrow.setStrokeCap(Paint.Cap.ROUND);
            arrow.setStrokeJoin(Paint.Join.ROUND);
        }

        void set(float progress, float y, boolean on) {
            this.progress = Math.max(0f, Math.min(1.25f, progress));
            this.y = y;
            this.on = on;
            setBounds(0, 0, root.getWidth(), root.getHeight());
            invalidateSelf();
        }

        @Override
        public void draw(Canvas c) {
            float r = BUBBLE_DP * density;
            float p = Math.min(1f, progress);
            // From just off the edge to a finger's width in.
            float cx = -r + p * (r + 14 * density) + Math.max(0f, progress - 1f) * 24 * density;
            float cy = Math.max(r + 8 * density, Math.min(getBounds().height() - r - 8 * density, y));
            disc.setColor(on ? 0xffe50914 : 0xe6202024);
            disc.setShadowLayer(6 * density, 0, 2 * density, 0x66000000);
            c.drawCircle(cx, cy, r, disc);
            arrow.setColor(0xffffffff);
            arrow.setAlpha((int) (255 * Math.min(1f, 0.35f + p)));
            arrow.setStrokeWidth(2.4f * density);
            float s = 6 * density;
            chevron.rewind();
            chevron.moveTo(cx + s * 0.4f, cy - s);
            chevron.lineTo(cx - s * 0.6f, cy);
            chevron.lineTo(cx + s * 0.4f, cy + s);
            c.drawPath(chevron, arrow);
        }

        @Override
        public void setAlpha(int alpha) {}

        @Override
        public void setColorFilter(ColorFilter filter) {}

        @Override
        public int getOpacity() {
            return PixelFormat.TRANSLUCENT;
        }
    }
}
