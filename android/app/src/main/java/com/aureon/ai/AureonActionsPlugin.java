package com.aureon.ai;

import android.Manifest;
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
import android.telephony.SmsManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

// Phase 6 — Agent: native actions the AI can trigger on the phone.
// Each method here corresponds 1:1 to a tool the backend defines for Gemini
// function-calling (see backend/server.js AGENT_TOOLS). www/app.js calls
// these through window.Capacitor.Plugins.AureonActions after the model
// requests a tool call.
@CapacitorPlugin(
    name = "AureonActions",
    permissions = {
        @Permission(strings = { Manifest.permission.CALL_PHONE }, alias = "call"),
        @Permission(strings = { Manifest.permission.SEND_SMS }, alias = "sms")
    }
)
public class AureonActionsPlugin extends Plugin {

    @PluginMethod
    public void getBattery(PluginCall call) {
        Context ctx = getContext();
        BatteryManager bm = (BatteryManager) ctx.getSystemService(Context.BATTERY_SERVICE);
        int level = bm != null ? bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) : -1;

        IntentFilter filter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
        Intent batteryStatus = ctx.registerReceiver(null, filter);
        int status = batteryStatus != null ? batteryStatus.getIntExtra(BatteryManager.EXTRA_STATUS, -1) : -1;
        boolean charging = status == BatteryManager.BATTERY_STATUS_CHARGING
                || status == BatteryManager.BATTERY_STATUS_FULL;

        JSObject ret = new JSObject();
        ret.put("level", level);
        ret.put("charging", charging);
        call.resolve(ret);
    }

    @PluginMethod
    public void openApp(PluginCall call) {
        String appName = call.getString("app_name");
        if (appName == null || appName.trim().isEmpty()) {
            call.reject("app_name is required");
            return;
        }

        PackageManager pm = getContext().getPackageManager();
        // queryIntentActivities against LAUNCHER, not getInstalledApplications —
        // Android 11+ hides most apps from the latter unless declared in
        // <queries>. Querying by the launcher intent (a wildcard <queries>
        // entry in the manifest) is the documented way to see every
        // launchable app regardless.
        Intent launcherIntent = new Intent(Intent.ACTION_MAIN);
        launcherIntent.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> apps = pm.queryIntentActivities(launcherIntent, 0);
        String needle = appName.trim().toLowerCase(Locale.US);

        ResolveInfo bestMatch = null;
        for (ResolveInfo info : apps) {
            String label = info.loadLabel(pm).toString();
            String labelLower = label.toLowerCase(Locale.US);
            if (labelLower.equals(needle)) {
                bestMatch = info;
                break; // exact match — stop looking
            }
            if (bestMatch == null && labelLower.contains(needle)) {
                bestMatch = info;
            }
        }

        if (bestMatch == null) {
            call.reject("Could not find an app matching \"" + appName + "\"");
            return;
        }

        String packageName = bestMatch.activityInfo.packageName;
        Intent launchIntent = pm.getLaunchIntentForPackage(packageName);
        if (launchIntent == null) {
            call.reject("Found \"" + appName + "\" but it can't be launched directly");
            return;
        }
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(launchIntent);

        JSObject ret = new JSObject();
        ret.put("opened", bestMatch.loadLabel(pm).toString());
        call.resolve(ret);
    }

    @PluginMethod
    public void makeCall(PluginCall call) {
        String number = call.getString("number");
        if (number == null || number.trim().isEmpty()) {
            call.reject("number is required");
            return;
        }
        if (getPermissionState("call") != PermissionState.GRANTED) {
            requestPermissionForAlias("call", call, "callPermsCallback");
            return;
        }
        doMakeCall(call, number);
    }

    @PermissionCallback
    private void callPermsCallback(PluginCall call) {
        String number = call.getString("number");
        if (getPermissionState("call") == PermissionState.GRANTED) {
            doMakeCall(call, number);
        } else {
            call.reject("Call permission was denied");
        }
    }

    private void doMakeCall(PluginCall call, String number) {
        Intent intent = new Intent(Intent.ACTION_CALL);
        intent.setData(Uri.parse("tel:" + Uri.encode(number)));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);

        JSObject ret = new JSObject();
        ret.put("called", number);
        call.resolve(ret);
    }

    @PluginMethod
    public void sendSms(PluginCall call) {
        String number = call.getString("number");
        String message = call.getString("message");
        if (number == null || number.trim().isEmpty() || message == null) {
            call.reject("number and message are required");
            return;
        }
        if (getPermissionState("sms") != PermissionState.GRANTED) {
            requestPermissionForAlias("sms", call, "smsPermsCallback");
            return;
        }
        doSendSms(call, number, message);
    }

    @PermissionCallback
    private void smsPermsCallback(PluginCall call) {
        String number = call.getString("number");
        String message = call.getString("message");
        if (getPermissionState("sms") == PermissionState.GRANTED) {
            doSendSms(call, number, message);
        } else {
            call.reject("SMS permission was denied");
        }
    }

    private void doSendSms(PluginCall call, String number, String message) {
        try {
            SmsManager smsManager = SmsManager.getDefault();
            ArrayList<String> parts = smsManager.divideMessage(message);
            smsManager.sendMultipartTextMessage(number, null, parts, null, null);

            JSObject ret = new JSObject();
            ret.put("sent", true);
            ret.put("to", number);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not send SMS: " + e.getMessage());
        }
    }

    @PluginMethod
    public void setAlarm(PluginCall call) {
        Integer hour = call.getInt("hour");
        Integer minute = call.getInt("minute");
        String label = call.getString("label", "Aureon Alarm");
        if (hour == null || minute == null) {
            call.reject("hour and minute are required");
            return;
        }

        Intent intent = new Intent(AlarmClock.ACTION_SET_ALARM);
        intent.putExtra(AlarmClock.EXTRA_HOUR, hour);
        intent.putExtra(AlarmClock.EXTRA_MINUTES, minute);
        intent.putExtra(AlarmClock.EXTRA_MESSAGE, label);
        intent.putExtra(AlarmClock.EXTRA_SKIP_UI, false);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        if (intent.resolveActivity(getContext().getPackageManager()) != null) {
            getContext().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("alarmSet", String.format(Locale.US, "%02d:%02d", hour, minute));
            call.resolve(ret);
        } else {
            call.reject("No clock app found to set the alarm");
        }
    }

    @PluginMethod
    public void searchWeb(PluginCall call) {
        String query = call.getString("query");
        if (query == null || query.trim().isEmpty()) {
            call.reject("query is required");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setData(Uri.parse("https://www.google.com/search?q=" + Uri.encode(query)));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);

        JSObject ret = new JSObject();
        ret.put("searched", query);
        call.resolve(ret);
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("url is required");
            return;
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "https://" + url;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setData(Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);

        JSObject ret = new JSObject();
        ret.put("opened", url);
        call.resolve(ret);
    }

    @PluginMethod
    public void composeEmail(PluginCall call) {
        String to = call.getString("to");
        String subject = call.getString("subject", "");
        String body = call.getString("body", "");

        Intent intent = new Intent(Intent.ACTION_SENDTO);
        intent.setData(Uri.parse("mailto:" + (to != null ? Uri.encode(to) : "")));
        intent.putExtra(Intent.EXTRA_SUBJECT, subject);
        intent.putExtra(Intent.EXTRA_TEXT, body);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        if (intent.resolveActivity(getContext().getPackageManager()) == null) {
            call.reject("No email app found");
            return;
        }
        getContext().startActivity(intent);

        JSObject ret = new JSObject();
        ret.put("composed", true);
        ret.put("subject", subject);
        call.resolve(ret);
    }

    @PluginMethod
    public void playMusic(PluginCall call) {
        String query = call.getString("query");
        if (query == null || query.trim().isEmpty()) {
            call.reject("query is required");
            return;
        }

        try {
            Intent intent = new Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH);
            intent.putExtra(SearchManager.QUERY, query);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (intent.resolveActivity(getContext().getPackageManager()) != null) {
                getContext().startActivity(intent);
                JSObject ret = new JSObject();
                ret.put("playing", query);
                call.resolve(ret);
                return;
            }
        } catch (Exception ignored) {
            // fall through to the browser fallback below
        }

        // No music app registered for the media-search intent — fall back to
        // opening a YouTube search so something useful still happens.
        Intent fallback = new Intent(Intent.ACTION_VIEW);
        fallback.setData(Uri.parse("https://www.youtube.com/results?search_query=" + Uri.encode(query)));
        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(fallback);

        JSObject ret = new JSObject();
        ret.put("playing", query);
        ret.put("via", "youtube");
        call.resolve(ret);
    }

    @PluginMethod
    public void sendWhatsappMessage(PluginCall call) {
        String number = call.getString("number");
        String message = call.getString("message", "");
        if (number == null || number.trim().isEmpty()) {
            call.reject("number is required");
            return;
        }
        // Strip anything but digits — wa.me needs a plain country-code number.
        String cleanNumber = number.replaceAll("[^0-9]", "");

        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setData(Uri.parse("https://wa.me/" + cleanNumber + "?text=" + Uri.encode(message)));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        if (intent.resolveActivity(getContext().getPackageManager()) == null) {
            call.reject("Could not open WhatsApp");
            return;
        }
        getContext().startActivity(intent);

        JSObject ret = new JSObject();
        ret.put("opened", true);
        ret.put("to", number);
        call.resolve(ret);
    }

    // Opens Android's keyboard-management settings so the user can switch on
    // "Aureon Voice Typing" (see AureonVoiceKeyboardService) — lets them
    // dictate into any app's text field, not just Aureon's own chat.
    @PluginMethod
    public void openKeyboardSettings(PluginCall call) {
        Intent intent = new Intent(android.provider.Settings.ACTION_INPUT_METHOD_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}