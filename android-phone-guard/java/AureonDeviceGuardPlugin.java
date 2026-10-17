package com.aureon.ai;

import android.app.KeyguardManager;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.os.SystemClock;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.util.List;

/**
 * Phone Security Check — READ-ONLY.
 *
 * Collects security-relevant settings of THIS phone and the list of installed (non-system) apps
 * and hands them to the web layer, which sends them to the owner's own backend
 * (/api/security/device/report). It changes nothing on the phone, reads no app data, no
 * messages, no files. All judgement ("is this risky?") happens on the backend so the rules
 * can be updated without rebuilding the APK.
 *
 * Needs: QUERY_ALL_PACKAGES in AndroidManifest (Android 11+ hides other apps otherwise).
 */
@CapacitorPlugin(name = "AureonDeviceGuard")
public class AureonDeviceGuardPlugin extends Plugin {

    private static final String[] SU_PATHS = {
        "/system/bin/su", "/system/xbin/su", "/sbin/su", "/system/su", "/system/sd/xbin/su",
        "/data/local/xbin/su", "/data/local/bin/su", "/data/local/su", "/su/bin/su",
        "/system/app/Superuser.apk", "/sbin/magisk", "/system/bin/magisk"
    };
    private static final String[] ROOT_APPS = {
        "com.topjohnwu.magisk", "eu.chainfire.supersu", "com.noshufou.android.su",
        "com.koushikdutta.superuser", "com.thirdparty.superuser", "me.weishu.kernelsu"
    };
    // permissions the backend cares about (short names, only those that are actually GRANTED are sent)
    private static final String[] WATCH_PERMS = {
        "READ_SMS", "RECEIVE_SMS", "SEND_SMS", "READ_CALL_LOG", "RECORD_AUDIO", "CAMERA",
        "READ_CONTACTS", "ACCESS_FINE_LOCATION", "READ_PHONE_STATE"
    };

    @PluginMethod
    public void scan(PluginCall call) {
        new Thread(() -> {
            try {
                call.resolve(collect());
            } catch (Throwable t) {
                call.reject("scan failed: " + t.getClass().getSimpleName());
            }
        }).start();
    }

    private JSObject collect() throws Exception {
        Context ctx = getContext();
        PackageManager pm = ctx.getPackageManager();
        JSObject out = new JSObject();

        // ---- device ----
        JSObject dev = new JSObject();
        dev.put("manufacturer", Build.MANUFACTURER);
        dev.put("model", Build.MODEL);
        dev.put("release", Build.VERSION.RELEASE);
        dev.put("sdk", Build.VERSION.SDK_INT);
        dev.put("securityPatch", Build.VERSION.SDK_INT >= 23 ? Build.VERSION.SECURITY_PATCH : "");
        out.put("device", dev);

        // ---- security settings ----
        JSObject sec = new JSObject();
        KeyguardManager km = (KeyguardManager) ctx.getSystemService(Context.KEYGUARD_SERVICE);
        sec.put("screenLock", km != null && (Build.VERSION.SDK_INT >= 23 ? km.isDeviceSecure() : km.isKeyguardSecure()));
        sec.put("adb", Settings.Global.getInt(ctx.getContentResolver(), Settings.Global.ADB_ENABLED, 0) == 1);
        sec.put("devOptions", Settings.Global.getInt(ctx.getContentResolver(), Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) == 1);
        String tags = Build.TAGS;
        sec.put("testKeys", tags != null && tags.contains("test-keys"));
        JSArray root = new JSArray();
        for (String p : SU_PATHS) { if (new File(p).exists()) root.put(p); }
        for (String pkg : ROOT_APPS) { if (isInstalled(pm, pkg)) root.put(pkg); }
        sec.put("rootSigns", root);
        out.put("security", sec);

        // ---- powers scam / spy apps like to abuse ----
        out.put("accessibility", componentPackages(Settings.Secure.getString(ctx.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)));
        out.put("notificationListeners", componentPackages(Settings.Secure.getString(ctx.getContentResolver(), "enabled_notification_listeners")));
        JSArray admins = new JSArray();
        DevicePolicyManager dpm = (DevicePolicyManager) ctx.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm != null) {
            List<ComponentName> list = dpm.getActiveAdmins();
            if (list != null) { for (ComponentName cn : list) admins.put(cn.getPackageName()); }
        }
        out.put("deviceAdmins", admins);

        // ---- installed (non-system) apps ----
        // (one small query per app instead of one huge GET_PERMISSIONS list — avoids TransactionTooLargeException)
        JSArray apps = new JSArray();
        List<ApplicationInfo> infos = pm.getInstalledApplications(0);
        int count = 0;
        for (ApplicationInfo ai : infos) {
            boolean system = (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0 || (ai.flags & ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0;
            if (system) continue;
            if (count++ >= 500) break;
            JSObject a = new JSObject();
            a.put("pkg", ai.packageName);
            a.put("label", String.valueOf(pm.getApplicationLabel(ai)));
            a.put("installer", installerOf(pm, ai.packageName));
            a.put("targetSdk", ai.targetSdkVersion);
            JSArray perms = new JSArray();
            try {
                PackageInfo pi = pm.getPackageInfo(ai.packageName, PackageManager.GET_PERMISSIONS);
                if (pi.requestedPermissions != null && pi.requestedPermissionsFlags != null) {
                    for (int i = 0; i < pi.requestedPermissions.length; i++) {
                        boolean granted = (pi.requestedPermissionsFlags[i] & PackageInfo.REQUESTED_PERMISSION_GRANTED) != 0;
                        if (!granted) continue;
                        String full = pi.requestedPermissions[i];
                        String shortName = full.substring(full.lastIndexOf('.') + 1);
                        for (String w : WATCH_PERMS) { if (w.equals(shortName)) { perms.put(w); break; } }
                    }
                }
            } catch (Throwable ignored) { }
            a.put("perms", perms);
            apps.put(a);
        }
        out.put("apps", apps);

        // ---- plain phone health ----
        JSObject health = new JSObject();
        try {
            StatFs st = new StatFs(Environment.getDataDirectory().getPath());
            health.put("storageFreePct", (int) Math.round(100.0 * st.getAvailableBytes() / Math.max(1L, st.getTotalBytes())));
        } catch (Throwable ignored) { }
        Intent bat = ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (bat != null) {
            health.put("batteryTempC", bat.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0);
            int level = bat.getIntExtra(BatteryManager.EXTRA_LEVEL, -1), scale = bat.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
            if (level >= 0) health.put("batteryPct", Math.round(100f * level / scale));
        }
        health.put("uptimeH", Math.round(SystemClock.elapsedRealtime() / 3600000.0));
        out.put("health", health);
        return out;
    }

    private static boolean isInstalled(PackageManager pm, String pkg) {
        try { pm.getPackageInfo(pkg, 0); return true; } catch (Throwable e) { return false; }
    }

    private static String installerOf(PackageManager pm, String pkg) {
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                return pm.getInstallSourceInfo(pkg).getInstallingPackageName();
            }
            return pm.getInstallerPackageName(pkg);
        } catch (Throwable e) { return null; }
    }

    /** "com.a/.Svc:com.b/com.b.Svc"  ->  ["com.a","com.b"] */
    private static JSArray componentPackages(String raw) {
        JSArray arr = new JSArray();
        if (raw == null || raw.isEmpty()) return arr;
        for (String part : raw.split(":")) {
            int slash = part.indexOf('/');
            String pkg = slash > 0 ? part.substring(0, slash) : part;
            if (!pkg.isEmpty()) arr.put(pkg);
        }
        return arr;
    }
}
