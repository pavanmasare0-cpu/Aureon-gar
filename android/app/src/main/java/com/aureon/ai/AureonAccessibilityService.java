package com.aureon.ai;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * User-enabled automation bridge. Android requires the user to explicitly
 * enable this service in Accessibility settings before cross-app automation
 * can read UI text, click controls, type, scroll, or perform navigation.
 */
public class AureonAccessibilityService extends AccessibilityService {
    private static AureonAccessibilityService instance;
    private volatile String lastScreenText = "";

    @Override public void onServiceConnected() { instance = this; }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event != null && event.getEventType() != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
            lastScreenText = readScreen();
        }
    }
    @Override public void onInterrupt() {}
    @Override public void onDestroy() { if (instance == this) instance = null; super.onDestroy(); }

    public static boolean isEnabled() { return instance != null; }
    public static String readScreen() { return instance == null ? "" : instance.readScreenInternal(); }

    /** Returns visible UI text/content descriptions from the active window. */
    private String readScreenInternal() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return "";
        StringBuilder out = new StringBuilder();
        appendNodeText(root, out, 0);
        root.recycle();
        return out.toString().trim();
    }

    private void appendNodeText(AccessibilityNodeInfo node, StringBuilder out, int depth) {
        if (node == null || depth > 40) return;
        CharSequence text = node.getText();
        CharSequence desc = node.getContentDescription();
        String value = text != null ? text.toString().trim() : "";
        if (TextUtils.isEmpty(value) && desc != null) value = desc.toString().trim();
        if (!TextUtils.isEmpty(value)) {
            String normalized = value.replaceAll("\\s+", " ");
            if (out.length() == 0 || !out.toString().contains("\n" + normalized + "\n")) out.append(normalized).append('\n');
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                appendNodeText(child, out, depth + 1);
                child.recycle();
            }
        }
    }

    public static boolean typeText(String text) {
        if (instance == null || TextUtils.isEmpty(text)) return false;
        AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) return false;
        AccessibilityNodeInfo target = findFocusedEditable(root);
        if (target == null) target = findFirstEditable(root);
        if (target == null) { root.recycle(); return false; }
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        boolean ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        target.recycle(); root.recycle();
        return ok;
    }

    public static boolean appendText(String text) {
        if (instance == null || TextUtils.isEmpty(text)) return false;
        AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) return false;
        AccessibilityNodeInfo target = findFocusedEditable(root);
        if (target == null) target = findFirstEditable(root);
        if (target == null) { root.recycle(); return false; }
        CharSequence old = target.getText();
        String combined = (old == null ? "" : old.toString()) + text;
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, combined);
        boolean ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        target.recycle(); root.recycle();
        return ok;
    }

    public static boolean clickText(String query) {
        if (instance == null || TextUtils.isEmpty(query)) return false;
        AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) return false;
        AccessibilityNodeInfo target = findByText(root, query.toLowerCase(Locale.ROOT));
        boolean ok = target != null && clickNode(target);
        if (target != null) target.recycle();
        root.recycle();
        return ok;
    }

    /**
     * Same as clickText(), but polls for up to timeoutMs — useful right
     * after navigating to a new screen, where the target text may not be
     * in the accessibility tree yet because the screen is still loading.
     * Returns as soon as the click succeeds, or false after the timeout.
     */
    public static boolean clickTextWithRetry(String query, int timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (clickText(query)) return true;
            try { Thread.sleep(300); } catch (InterruptedException ignored) { return false; }
        }
        return false;
    }

    /** Same idea as clickTextWithRetry, but just checks presence (no click). */
    public static boolean waitForText(String query, int timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (instance != null && readScreen().toLowerCase(Locale.ROOT).contains(query.toLowerCase(Locale.ROOT))) {
                return true;
            }
            try { Thread.sleep(300); } catch (InterruptedException ignored) { return false; }
        }
        return false;
    }

    public static boolean scroll(boolean forward) {
        if (instance == null) return false;
        AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) return false;
        boolean ok = performScroll(root, forward);
        root.recycle();
        return ok;
    }

    public static boolean globalAction(int action) {
        return instance != null && instance.performGlobalAction(action);
    }

    public static boolean tap(float x, float y) {
        if (instance == null || android.os.Build.VERSION.SDK_INT < 24) return false;
        Path path = new Path(); path.moveTo(x, y);
        GestureDescription.StrokeDescription stroke = new GestureDescription.StrokeDescription(path, 0, 80);
        return instance.dispatchGesture(new GestureDescription.Builder().addStroke(stroke).build(), null, null);
    }

    private static boolean performScroll(AccessibilityNodeInfo node, boolean forward) {
        if (node.isScrollable()) {
            int action = forward ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD;
            if (node.performAction(action)) return true;
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                boolean ok = performScroll(child, forward);
                child.recycle();
                if (ok) return true;
            }
        }
        return false;
    }

    private static boolean clickNode(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo current = node;
        while (current != null) {
            if (current.isClickable() && current.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
            AccessibilityNodeInfo parent = current.getParent();
            if (current != node) current.recycle();
            current = parent;
        }
        return false;
    }

    private static AccessibilityNodeInfo findFocusedEditable(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isFocused() && node.isEditable()) return AccessibilityNodeInfo.obtain(node);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            AccessibilityNodeInfo found = findFocusedEditable(child);
            if (child != null) child.recycle();
            if (found != null) return found;
        }
        return null;
    }

    private static AccessibilityNodeInfo findFirstEditable(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isEditable() && node.isEnabled()) return AccessibilityNodeInfo.obtain(node);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            AccessibilityNodeInfo found = findFirstEditable(child);
            if (child != null) child.recycle();
            if (found != null) return found;
        }
        return null;
    }

    private static AccessibilityNodeInfo findByText(AccessibilityNodeInfo node, String query) {
        if (node == null) return null;
        String t = node.getText() == null ? "" : node.getText().toString().toLowerCase(Locale.ROOT);
        String d = node.getContentDescription() == null ? "" : node.getContentDescription().toString().toLowerCase(Locale.ROOT);
        if (t.contains(query) || d.contains(query)) return AccessibilityNodeInfo.obtain(node);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            AccessibilityNodeInfo found = findByText(child, query);
            if (child != null) child.recycle();
            if (found != null) return found;
        }
        return null;
    }
}
