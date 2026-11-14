package com.hexuria.rustflix;

import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Icon-only bottom tabs. NSH's Android tab bar always draws a label under
 * each icon, and on some screens the label's descenders are cut by the
 * gesture area. The labels are hidden here and the icons centred in the
 * bar; each tab keeps its name as its content description, so TalkBack
 * still reads "Home", "Search", ….
 *
 * NSH's tab item class is private (and may be renamed by R8), so a tab is
 * recognised by its shape: a clickable vertical LinearLayout with a content
 * description and exactly two children — a FrameLayout holding one
 * ImageView (the icon in its indicator) and a TextView showing that same
 * description.
 */
final class TabBarTweaks {
    private TabBarTweaks() {}

    /** Hides tab labels under {@code root} now and after every layout pass. */
    static void watch(ViewGroup root) {
        root.getViewTreeObserver().addOnGlobalLayoutListener(() -> apply(root));
    }

    private static void apply(View view) {
        if (!(view instanceof ViewGroup)) return;
        ViewGroup group = (ViewGroup) view;
        if (isTab(group)) {
            hideLabel((LinearLayout) group);
            return;
        }
        for (int i = 0; i < group.getChildCount(); i++) apply(group.getChildAt(i));
    }

    private static boolean isTab(ViewGroup group) {
        if (!(group instanceof LinearLayout) || !group.isClickable()) return false;
        if (((LinearLayout) group).getOrientation() != LinearLayout.VERTICAL) return false;
        CharSequence name = group.getContentDescription();
        if (name == null || name.length() == 0 || group.getChildCount() != 2) return false;
        View first = group.getChildAt(0);
        View second = group.getChildAt(1);
        if (!(first instanceof FrameLayout) || !(second instanceof TextView)) return false;
        FrameLayout indicator = (FrameLayout) first;
        if (indicator.getChildCount() != 1 || !(indicator.getChildAt(0) instanceof ImageView)) return false;
        return name.toString().contentEquals(((TextView) second).getText());
    }

    private static void hideLabel(LinearLayout tab) {
        View label = tab.getChildAt(1);
        // Already done: nothing to change, so this layout pass asks for no other.
        if (label.getVisibility() == View.GONE) return;
        label.setVisibility(View.GONE);
        // The icon sat above the label; alone, it belongs in the middle.
        tab.setGravity(Gravity.CENTER);
        int vertical = Math.min(tab.getPaddingTop(), tab.getPaddingBottom());
        tab.setPadding(tab.getPaddingLeft(), vertical, tab.getPaddingRight(), vertical);
    }
}
