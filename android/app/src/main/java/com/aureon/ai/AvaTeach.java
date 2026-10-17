package com.aureon.ai;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Toast;

import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * "Teach Ava": she watches what you do in other apps/settings (through Aureon's
 * accessibility service), remembers the steps under a name, and repeats them when
 * you ask. Everything stays on this phone (SharedPreferences) - nothing is uploaded.
 *
 * Safety: password fields, OTP-like text and banking/payment/authenticator apps are
 * never recorded; a replay stops (instead of guessing) when a step can't be found or
 * looks risky (pay / transfer / erase / uninstall ...).
 */
public final class AvaTeach {
    private AvaTeach() {}

    private static final int MAX_STEPS = 60;
    private static final Object LOCK = new Object();
    private static final Pattern SENSITIVE_PKG = Pattern.compile(
            "bank|pay|wallet|upi|paytm|phonepe|gpay|authenticator|password|lastpass|bitwarden|keepass|1password|"
                    + "sbi|hdfc|icici|axis|kotak|zerodha|groww", Pattern.CASE_INSENSITIVE);
    private static final Pattern RISKY_LABEL = Pattern.compile(
            "\\b(pay|payment|transfer|send money|factory reset|erase|wipe|uninstall|delete account|purchase|buy now|place order|confirm order)\\b",
            Pattern.CASE_INSENSITIVE);

    private static AccessibilityService svc;

    // ---------------- recording state ----------------
    private static volatile boolean recording = false;
    private static String recName = "";
    private static final List<JSONObject> rec = new ArrayList<JSONObject>();
    private static String lastPkg = null;
    private static String lastClickKey = "";
    private static long lastClickAt = 0;
    private static boolean skippedSensitive = false;

    // ---------------- playback state ----------------
    private static volatile boolean playing = false;
    private static volatile boolean cancel = false;
    private static String playName = "";
    private static boolean lastOk = false;
    private static String lastMsg = "";
    private static long lastAt = 0;

    /** Called from AureonAccessibilityService.onServiceConnected(). */
    static void attach(AccessibilityService s) { svc = s; }

    private static void p(JSONObject o, String k, Object v) { try { o.put(k, v); } catch (Exception ignored) { } }

    // =====================================================================
    //  RECORDING
    // =====================================================================

    /** Called from AureonAccessibilityService.onAccessibilityEvent() for every event. */
    static void onEvent(AccessibilityService s, AccessibilityEvent e) {
        if (s != null) svc = s;
        if (!recording || e == null) return;
        try {
            CharSequence pk = e.getPackageName();
            if (pk == null) return;
            String pkg = pk.toString();
            if (pkg.equals(s.getPackageName())) return;                 // Ava's / Aureon's own windows
            if (pkg.contains("inputmethod") || pkg.contains("keyboard")) return;
            if (SENSITIVE_PKG.matcher(pkg).find()) { skippedSensitive = true; return; }
            int type = e.getEventType();
            synchronized (LOCK) {
                if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) { noteWindow(s, pkg); return; }
                if (rec.size() >= MAX_STEPS) return;
                if (type == AccessibilityEvent.TYPE_VIEW_CLICKED) noteClick(s, e, pkg);
                else if (type == AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED) noteText(s, e, pkg);
            }
        } catch (Exception ignored) { }
    }

    private static boolean isLauncher(AccessibilityService s, String pkg) {
        Intent home = new Intent(Intent.ACTION_MAIN);
        home.addCategory(Intent.CATEGORY_HOME);
        ResolveInfo ri = s.getPackageManager().resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY);
        return ri != null && ri.activityInfo != null && pkg.equals(ri.activityInfo.packageName);
    }

    private static void noteWindow(AccessibilityService s, String pkg) {
        if (pkg.equals(lastPkg)) return;
        lastPkg = pkg;
        JSONObject st = new JSONObject();
        if ("com.android.systemui".equals(pkg)) p(st, "t", "shade");
        else if (isLauncher(s, pkg)) p(st, "t", "home");
        else p(st, "t", "open");
        p(st, "pkg", pkg);
        if (rec.size() < MAX_STEPS) rec.add(st);
    }

    private static String clip(CharSequence c, int max) {
        if (c == null) return "";
        String s = c.toString().trim();
        return s.length() > max ? s.substring(0, max) : s;
    }

    /** Best human label for a tapped view: its text, description, a child's text, or its parent's. */
    private static String labelOf(AccessibilityNodeInfo n) {
        String s = clip(n.getText(), 60);
        if (!s.isEmpty()) return s;
        s = clip(n.getContentDescription(), 60);
        if (!s.isEmpty()) return s;
        s = childLabel(n, 0);
        if (!s.isEmpty()) return s;
        AccessibilityNodeInfo par = n.getParent();
        for (int up = 0; up < 2 && par != null; up++) {
            s = clip(par.getText(), 60);
            if (s.isEmpty()) s = clip(par.getContentDescription(), 60);
            if (s.isEmpty()) s = childLabel(par, 0);
            if (!s.isEmpty()) return s;
            par = par.getParent();
        }
        return "";
    }

    private static String childLabel(AccessibilityNodeInfo n, int depth) {
        if (n == null || depth > 3) return "";
        for (int i = 0; i < n.getChildCount() && i < 8; i++) {
            AccessibilityNodeInfo c = n.getChild(i);
            if (c == null) continue;
            String s = clip(c.getText(), 60);
            if (s.isEmpty()) s = clip(c.getContentDescription(), 60);
            if (s.isEmpty()) s = childLabel(c, depth + 1);
            if (!s.isEmpty()) return s;
        }
        return "";
    }

    private static void noteClick(AccessibilityService s, AccessibilityEvent e, String pkg) {
        AccessibilityNodeInfo n = e.getSource();
        if (n == null || n.isPassword()) return;
        if (!pkg.equals(lastPkg)) noteWindow(s, pkg);
        String label = labelOf(n);
        String id = n.getViewIdResourceName();
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        long now = System.currentTimeMillis();
        String key = pkg + "|" + label + "|" + id;
        if (key.equals(lastClickKey) && now - lastClickAt < 400) return;
        lastClickKey = key;
        lastClickAt = now;
        if (label.isEmpty() && id == null && r.isEmpty()) return;
        JSONObject st = new JSONObject();
        p(st, "t", "click");
        p(st, "pkg", pkg);
        p(st, "label", label);
        if (id != null) p(st, "id", id);
        p(st, "x", r.centerX());
        p(st, "y", r.centerY());
        rec.add(st);
    }

    private static void noteText(AccessibilityService s, AccessibilityEvent e, String pkg) {
        AccessibilityNodeInfo n = e.getSource();
        if (n == null || n.isPassword()) return;
        List<CharSequence> tx = e.getText();
        String text = (tx == null || tx.isEmpty()) ? "" : clip(tx.get(0), 200);
        if (text.matches("\\d{4,8}")) return;                          // looks like an OTP / PIN
        if (!pkg.equals(lastPkg)) noteWindow(s, pkg);
        String id = n.getViewIdResourceName();
        String idS = id == null ? "" : id;
        JSONObject last = rec.isEmpty() ? null : rec.get(rec.size() - 1);
        if (last != null && "type".equals(last.optString("t")) && idS.equals(last.optString("id"))) {
            p(last, "text", text);                                       // same field: keep the final text only
            return;
        }
        JSONObject st = new JSONObject();
        p(st, "t", "type");
        p(st, "pkg", pkg);
        p(st, "id", idS);
        p(st, "text", text);
        rec.add(st);
    }

    public static JSObject start(String name) {
        JSObject r = new JSObject();
        if (!AureonAccessibilityService.isEnabled()) { r.put("ok", false); r.put("error", "accessibility_off"); return r; }
        if (playing) { r.put("ok", false); r.put("error", "abhi ek kaam chal raha hai"); return r; }
        synchronized (LOCK) {
            rec.clear();
            lastPkg = null; lastClickKey = ""; lastClickAt = 0; skippedSensitive = false;
            recName = cleanName(name);
            recording = true;
        }
        r.put("ok", true);
        r.put("name", recName);
        return r;
    }

    private static String cleanName(String n) {
        String s = n == null ? "" : n.trim().replaceAll("\\s+", " ");
        if (s.length() > 40) s = s.substring(0, 40);
        return s.isEmpty() ? "mera kaam" : s;
    }

    public static JSObject stop(Context ctx, boolean save) {
        JSObject r = new JSObject();
        synchronized (LOCK) {
            recording = false;
            if (!rec.isEmpty() && "home".equals(rec.get(rec.size() - 1).optString("t"))) rec.remove(rec.size() - 1);
            r.put("name", recName);
            r.put("skippedSensitive", skippedSensitive);
            if (!save || rec.isEmpty()) { r.put("ok", false); r.put("steps", rec.size()); rec.clear(); return r; }
            try {
                JSONObject all = load(ctx);
                JSONArray steps = new JSONArray();
                List<String> apps = new ArrayList<String>();
                for (JSONObject st : rec) {
                    steps.put(st);
                    String pk = st.optString("pkg");
                    if (!pk.isEmpty() && !apps.contains(pk)) apps.add(pk);
                }
                JSONObject m = new JSONObject();
                m.put("steps", steps);
                m.put("ts", System.currentTimeMillis());
                all.put(recName, m);
                persist(ctx, all);
                r.put("ok", true);
                r.put("steps", steps.length());
                r.put("apps", appNames(ctx, apps));
            } catch (Exception ex) { r.put("ok", false); r.put("error", String.valueOf(ex.getMessage())); }
            rec.clear();
        }
        return r;
    }

    // =====================================================================
    //  STORAGE (private to this app)
    // =====================================================================

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("ava_teach", Context.MODE_PRIVATE); }

    private static JSONObject load(Context c) {
        try { return new JSONObject(prefs(c).getString("macros", "{}")); } catch (Exception e) { return new JSONObject(); }
    }

    private static void persist(Context c, JSONObject all) { prefs(c).edit().putString("macros", all.toString()).apply(); }

    private static String appLabel(Context ctx, String pkg) {
        try {
            PackageManager pm = ctx.getPackageManager();
            return String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)));
        } catch (Exception e) { return pkg; }
    }

    private static JSONArray appNames(Context ctx, List<String> pkgs) {
        JSONArray a = new JSONArray();
        for (String pk : pkgs) a.put(appLabel(ctx, pk));
        return a;
    }

    public static JSObject status(Context ctx) {
        JSObject r = new JSObject();
        r.put("enabled", AureonAccessibilityService.isEnabled());
        r.put("recording", recording);
        r.put("recName", recName);
        r.put("recSteps", rec.size());
        r.put("playing", playing);
        r.put("playName", playName);
        r.put("lastOk", lastOk);
        r.put("lastMsg", lastMsg);
        r.put("lastAt", lastAt);
        JSONArray list = new JSONArray();
        JSONObject all = load(ctx);
        java.util.Iterator<String> it = all.keys();
        while (it.hasNext()) {
            String name = it.next();
            JSONObject m = all.optJSONObject(name);
            if (m == null) continue;
            JSONArray steps = m.optJSONArray("steps");
            List<String> apps = new ArrayList<String>();
            if (steps != null) for (int i = 0; i < steps.length(); i++) {
                String pk = steps.optJSONObject(i) == null ? "" : steps.optJSONObject(i).optString("pkg");
                if (!pk.isEmpty() && !apps.contains(pk)) apps.add(pk);
            }
            JSONObject o = new JSONObject();
            p(o, "name", name);
            p(o, "steps", steps == null ? 0 : steps.length());
            p(o, "apps", appNames(ctx, apps));
            list.put(o);
        }
        r.put("macros", list);
        return r;
    }

    public static JSObject delete(Context ctx, String name) {
        JSObject r = new JSObject();
        JSONObject all = load(ctx);
        boolean had = all.has(name);
        all.remove(name);
        persist(ctx, all);
        r.put("ok", had);
        return r;
    }

    // =====================================================================
    //  PLAYBACK
    // =====================================================================

    public static JSObject play(final Context ctx, final String name) {
        JSObject r = new JSObject();
        if (!AureonAccessibilityService.isEnabled()) { r.put("ok", false); r.put("error", "accessibility_off"); return r; }
        if (recording) { r.put("ok", false); r.put("error", "abhi mai seekh rahi hu - pehle 'bas' bolo"); return r; }
        if (playing) { r.put("ok", false); r.put("error", "ek kaam pehle se chal raha hai"); return r; }
        JSONObject m = load(ctx).optJSONObject(name);
        final JSONArray steps = m == null ? null : m.optJSONArray("steps");
        if (steps == null || steps.length() == 0) { r.put("ok", false); r.put("error", "ye kaam mujhe yaad nahi hai"); return r; }
        final Context app = ctx.getApplicationContext();
        playing = true;
        cancel = false;
        playName = name;
        new Thread(new Runnable() {
            @Override public void run() { runSteps(app, name, steps); }
        }, "ava-macro").start();
        r.put("ok", true);
        r.put("steps", steps.length());
        return r;
    }

    public static void stopPlay() { cancel = true; }

    private static void toast(final Context c, final String msg) {
        new Handler(Looper.getMainLooper()).post(new Runnable() {
            @Override public void run() { try { Toast.makeText(c, msg, Toast.LENGTH_LONG).show(); } catch (Exception ignored) { } }
        });
    }

    private static void sleep(long ms) throws InterruptedException { Thread.sleep(ms); }

    private static void runSteps(Context ctx, String name, JSONArray steps) {
        boolean ok = false;
        String msg = null;
        try {
            toast(ctx, "🤖 Ava \"" + name + "\" kar rahi hai… (rokne ke liye Ava se 'ruko' bolo)");
            sleep(1500); // let Ava's panel close and the app underneath come back
            long deadline = System.currentTimeMillis() + 120000;
            int n = steps.length();
            for (int i = 0; i < n; i++) {
                if (cancel) { msg = "Ruk gayi (tumne roka)."; break; }
                if (System.currentTimeMillis() > deadline) { msg = "Time out ho gaya."; break; }
                JSONObject st = steps.getJSONObject(i);
                String err = doStep(ctx, st);
                if (err != null) { msg = "Step " + (i + 1) + "/" + n + " me ruk gayi: " + err; break; }
                sleep(900);
            }
            if (msg == null) { ok = true; msg = "Pura ho gaya ✅"; }
        } catch (InterruptedException ie) {
            msg = "Beech me ruk gayi.";
        } catch (Exception ex) {
            msg = "Error: " + ex.getMessage();
        } finally {
            playing = false;
            lastOk = ok;
            lastMsg = msg == null ? "" : msg;
            lastAt = System.currentTimeMillis();
            toast(ctx, (ok ? "✅ " : "⚠️ ") + "Ava: " + lastMsg);
        }
    }

    /** Returns null when the step worked, otherwise a short reason. */
    private static String doStep(Context ctx, JSONObject st) throws InterruptedException {
        String t = st.optString("t");
        String pkg = st.optString("pkg");
        if ("home".equals(t)) {
            AureonAccessibilityService.globalAction(AccessibilityService.GLOBAL_ACTION_HOME);
            sleep(700);
            return null;
        }
        if ("shade".equals(t)) {
            AureonAccessibilityService.globalAction(Build.VERSION.SDK_INT >= 31
                    ? AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS : AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS);
            sleep(900);
            return null;
        }
        if ("open".equals(t)) {
            Intent li = ctx.getPackageManager().getLaunchIntentForPackage(pkg);
            if (li == null) return null; // not a launchable app (a dialog/system window): it will appear by itself
            li.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try { (svc != null ? svc : ctx).startActivity(li); } catch (Exception e) { return "app nahi khul paayi (" + appLabel(ctx, pkg) + ")"; }
            if (!waitPkg(pkg, 8000)) return "\"" + appLabel(ctx, pkg) + "\" khul nahi paayi";
            return null;
        }
        if ("type".equals(t)) {
            waitPkg(pkg, 3000);
            return AureonAccessibilityService.typeText(st.optString("text")) ? null : "text likhne ki jagah nahi mili";
        }
        if ("click".equals(t)) {
            String label = st.optString("label");
            if (!label.isEmpty() && RISKY_LABEL.matcher(label).find()) return "\"" + label + "\" risky lagta hai - ye khud kar lo";
            waitPkg(pkg, 4000);
            for (int attempt = 0; attempt < 4; attempt++) {
                if (cancel) return "roka gaya";
                AccessibilityNodeInfo node = findNode(st);
                if (node != null) { if (clickNodeOrParent(node)) return null; }
                if (attempt < 3) { AureonAccessibilityService.scroll(true); sleep(600); }
            }
            if (label.isEmpty() && st.has("x")) { // unlabeled icon: last resort = the recorded spot
                return AureonAccessibilityService.tap((float) st.optDouble("x"), (float) st.optDouble("y")) ? null : "icon par tap nahi hua";
            }
            return "\"" + (label.isEmpty() ? "button" : label) + "\" screen par nahi mila";
        }
        return null;
    }

    private static boolean waitPkg(String pkg, int timeoutMs) throws InterruptedException {
        long end = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < end) {
            if (pkg.equals(AureonAccessibilityService.activePackage())) return true;
            sleep(300);
        }
        return pkg.equals(AureonAccessibilityService.activePackage());
    }

    private static AccessibilityNodeInfo findNode(JSONObject st) {
        if (svc == null) return null;
        AccessibilityNodeInfo root = svc.getRootInActiveWindow();
        if (root == null) return null;
        String id = st.optString("id");
        String label = st.optString("label");
        AccessibilityNodeInfo best = null;
        if (!id.isEmpty()) {
            List<AccessibilityNodeInfo> byId = root.findAccessibilityNodeInfosByViewId(id);
            if (byId != null) {
                for (AccessibilityNodeInfo c : byId) {
                    if (best == null) best = c;
                    if (!label.isEmpty() && (label.equalsIgnoreCase(clip(c.getText(), 60)) || label.equalsIgnoreCase(labelOf(c)))) { best = c; break; }
                }
            }
            if (best != null && (byId.size() == 1 || label.isEmpty())) return best;
        }
        if (!label.isEmpty()) {
            List<AccessibilityNodeInfo> byText = root.findAccessibilityNodeInfosByText(label);
            if (byText != null) {
                for (AccessibilityNodeInfo c : byText) {
                    if (label.equalsIgnoreCase(clip(c.getText(), 60)) || label.equalsIgnoreCase(clip(c.getContentDescription(), 60))) return c;
                }
                if (!byText.isEmpty()) return byText.get(0);
            }
        }
        return best;
    }

    private static boolean clickNodeOrParent(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo cur = node;
        for (int i = 0; i < 6 && cur != null; i++) {
            if (cur.isClickable() && cur.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
            cur = cur.getParent();
        }
        Rect r = new Rect();
        node.getBoundsInScreen(r);
        return !r.isEmpty() && AureonAccessibilityService.tap(r.centerX(), r.centerY());
    }
}
