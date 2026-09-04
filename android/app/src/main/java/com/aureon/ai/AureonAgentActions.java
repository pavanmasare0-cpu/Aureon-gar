package com.aureon.ai;

import android.app.SearchManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.BatteryManager;
import android.provider.AlarmClock;
import android.provider.MediaStore;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.List;
import java.util.Locale;

/**
 * Phase 6 — Agent: plain Android implementations of the NON-sensitive tools
 * (get_battery, open_app, set_alarm, search_web, open_url, play_music),
 * shared by the system voice assistant (AureonVoiceInteractionSession).
 *
 * make_call and send_sms are deliberately NOT here. Voice never
 * auto-executes those — a misheard word placing a real call or sending a
 * real text is too risky with no visual confirmation. Voice tells the user
 * to confirm those two in the chat screen instead, where
 * AureonActionsPlugin.java (the Capacitor-side twin of this class) handles
 * them with an on-screen confirm dialog first.
 */
public class AureonAgentActions {

    public static class ActionException extends Exception {
        public ActionException(String message) { super(message); }
    }

    public static JSONObject getBattery(Context ctx) throws JSONException {
        BatteryManager bm = (BatteryManager) ctx.getSystemService(Context.BATTERY_SERVICE);
        int level = bm != null ? bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) : -1;

        IntentFilter filter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
        Intent batteryStatus = ctx.registerReceiver(null, filter);
        int status = batteryStatus != null ? batteryStatus.getIntExtra(BatteryManager.EXTRA_STATUS, -1) : -1;
        boolean charging = status == BatteryManager.BATTERY_STATUS_CHARGING
                || status == BatteryManager.BATTERY_STATUS_FULL;

        JSONObject ret = new JSONObject();
        ret.put("level", level);
        ret.put("charging", charging);
        return ret;
    }

    public static JSONObject openApp(Context ctx, String appName) throws ActionException, JSONException {
        if (appName == null || appName.trim().isEmpty()) throw new ActionException("app_name is required");

        PackageManager pm = ctx.getPackageManager();
        // queryIntentActivities against LAUNCHER, not getInstalledApplications —
        // Android 11+ hides most apps from the latter unless the caller
        // declares <queries> for them individually. Querying by the launcher
        // intent (declared as a wildcard <queries> entry in the manifest)
        // is the documented way to see every launchable app regardless.
        Intent launcherIntent = new Intent(Intent.ACTION_MAIN);
        launcherIntent.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> apps = pm.queryIntentActivities(launcherIntent, 0);
        String needle = appName.trim().toLowerCase(Locale.US);

        ResolveInfo bestMatch = null;
        for (ResolveInfo info : apps) {
            String label = info.loadLabel(pm).toString();
            String labelLower = label.toLowerCase(Locale.US);
            if (labelLower.equals(needle)) { bestMatch = info; break; }
            if (bestMatch == null && labelLower.contains(needle)) bestMatch = info;
        }
        if (bestMatch == null) throw new ActionException("Could not find an app matching \"" + appName + "\"");

        String packageName = bestMatch.activityInfo.packageName;
        Intent launchIntent = pm.getLaunchIntentForPackage(packageName);
        if (launchIntent == null) throw new ActionException("Found \"" + appName + "\" but it can't be launched directly");
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(launchIntent);

        JSONObject ret = new JSONObject();
        ret.put("opened", bestMatch.loadLabel(pm).toString());
        return ret;
    }

    public static JSONObject setAlarm(Context ctx, int hour, int minute, String label) throws ActionException, JSONException {
        Intent intent = new Intent(AlarmClock.ACTION_SET_ALARM);
        intent.putExtra(AlarmClock.EXTRA_HOUR, hour);
        intent.putExtra(AlarmClock.EXTRA_MINUTES, minute);
        intent.putExtra(AlarmClock.EXTRA_MESSAGE, label != null ? label : "Aureon Alarm");
        intent.putExtra(AlarmClock.EXTRA_SKIP_UI, false);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (intent.resolveActivity(ctx.getPackageManager()) == null) {
            throw new ActionException("No clock app found to set the alarm");
        }
        ctx.startActivity(intent);

        JSONObject ret = new JSONObject();
        ret.put("alarmSet", String.format(Locale.US, "%02d:%02d", hour, minute));
        return ret;
    }

    public static JSONObject searchWeb(Context ctx, String query) throws ActionException, JSONException {
        if (query == null || query.trim().isEmpty()) throw new ActionException("query is required");
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setData(Uri.parse("https://www.google.com/search?q=" + Uri.encode(query)));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(intent);

        JSONObject ret = new JSONObject();
        ret.put("searched", query);
        return ret;
    }

    public static JSONObject openUrl(Context ctx, String url) throws ActionException, JSONException {
        if (url == null || url.trim().isEmpty()) throw new ActionException("url is required");
        String fixed = (!url.startsWith("http://") && !url.startsWith("https://")) ? "https://" + url : url;
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setData(Uri.parse(fixed));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(intent);

        JSONObject ret = new JSONObject();
        ret.put("opened", fixed);
        return ret;
    }

    public static JSONObject composeEmail(Context ctx, String to, String subject, String body) throws ActionException, JSONException {
        Intent intent = new Intent(Intent.ACTION_SENDTO);
        intent.setData(Uri.parse("mailto:" + (to != null ? Uri.encode(to) : "")));
        intent.putExtra(Intent.EXTRA_SUBJECT, subject != null ? subject : "");
        intent.putExtra(Intent.EXTRA_TEXT, body != null ? body : "");
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        if (intent.resolveActivity(ctx.getPackageManager()) == null) {
            throw new ActionException("No email app found");
        }
        ctx.startActivity(intent);

        JSONObject ret = new JSONObject();
        ret.put("composed", true);
        ret.put("subject", subject);
        return ret;
    }

    public static JSONObject sendWhatsappMessage(Context ctx, String number, String message) throws ActionException, JSONException {
        if (number == null || number.trim().isEmpty()) throw new ActionException("number is required");
        String cleanNumber = number.replaceAll("[^0-9]", "");

        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setData(Uri.parse("https://wa.me/" + cleanNumber + "?text=" + Uri.encode(message != null ? message : "")));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        if (intent.resolveActivity(ctx.getPackageManager()) == null) {
            throw new ActionException("Could not open WhatsApp");
        }
        ctx.startActivity(intent);

        JSONObject ret = new JSONObject();
        ret.put("opened", true);
        ret.put("to", number);
        return ret;
    }

    public static JSONObject playMusic(Context ctx, String query) throws ActionException, JSONException {
        if (query == null || query.trim().isEmpty()) throw new ActionException("query is required");

        try {
            Intent intent = new Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH);
            intent.putExtra(SearchManager.QUERY, query);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (intent.resolveActivity(ctx.getPackageManager()) != null) {
                ctx.startActivity(intent);
                JSONObject ret = new JSONObject();
                ret.put("playing", query);
                return ret;
            }
        } catch (Exception ignored) {
            // fall through to the browser fallback below
        }

        Intent fallback = new Intent(Intent.ACTION_VIEW);
        fallback.setData(Uri.parse("https://www.youtube.com/results?search_query=" + Uri.encode(query)));
        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(fallback);

        JSONObject ret = new JSONObject();
        ret.put("playing", query);
        ret.put("via", "youtube");
        return ret;
    }

    public static class LocalIntent {
        public final String name;
        public final JSONObject args;
        public LocalIntent(String name, JSONObject args) {
            this.name = name;
            this.args = args;
        }
    }

    // Same offline shortcut as www/app.js's matchLocalIntent() — deliberately
    // simple keyword/regex matching (not AI), covering only the three
    // zero-network actions. Used by voice so battery/open-app/alarm commands
    // work even with no internet at all; anything else falls through to the
    // normal backend request.
    public static LocalIntent matchLocalIntent(String text) throws JSONException {
        if (text == null) return null;
        String lower = text.trim().toLowerCase(Locale.US);

        if (lower.matches(".*\\bbattery\\b.*") || (lower.contains("charge") && lower.contains("kitn"))) {
            return new LocalIntent("get_battery", new JSONObject());
        }

        String appName = null;
        java.util.regex.Matcher m1 = java.util.regex.Pattern.compile("^open\\s+(.+)$").matcher(lower);
        if (m1.matches()) {
            appName = m1.group(1).trim();
        } else {
            java.util.regex.Matcher m2 = java.util.regex.Pattern
                    .compile("^(.+?)\\s+(khol do|khol den|kholo|khol|open karo|open kar do)$")
                    .matcher(lower);
            if (m2.matches()) appName = m2.group(1).trim();
        }
        if (appName != null && !appName.isEmpty()) {
            JSONObject args = new JSONObject();
            args.put("app_name", appName);
            return new LocalIntent("open_app", args);
        }

        if (lower.contains("alarm")) {
            java.util.regex.Matcher tm = java.util.regex.Pattern.compile("(\\d{1,2})[:.](\\d{2})").matcher(lower);
            if (tm.find()) {
                int hour = Integer.parseInt(tm.group(1));
                int minute = Integer.parseInt(tm.group(2));
                if (lower.contains("pm") && hour < 12) hour += 12;
                if (lower.contains("am") && hour == 12) hour = 0;
                JSONObject args = new JSONObject();
                args.put("hour", hour);
                args.put("minute", minute);
                args.put("label", "Aureon Alarm");
                return new LocalIntent("set_alarm", args);
            }
            java.util.regex.Matcher bm = java.util.regex.Pattern.compile("(\\d{1,2})\\s*baje").matcher(lower);
            if (bm.find()) {
                int hour = Integer.parseInt(bm.group(1));
                if ((lower.contains("shaam") || lower.contains("evening") || lower.contains("raat") || lower.contains("night")) && hour < 12) {
                    hour += 12;
                }
                JSONObject args = new JSONObject();
                args.put("hour", hour);
                args.put("minute", 0);
                args.put("label", "Aureon Alarm");
                return new LocalIntent("set_alarm", args);
            }
        }

        return null;
    }
}
