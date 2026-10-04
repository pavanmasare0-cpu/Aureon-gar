package com.aureon.ai;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;

// App-wide crash catcher — not specific to Love Camera or the voice
// session, this covers ANY uncaught exception anywhere in the app. Part of
// the watchdog pipeline (see backend/watchdog.js and WATCHDOG-SETUP.md):
// this is the "app side" half, the backend is the "server side" half, both
// end up as one email to the owner.
//
// Crash time itself is too fragile to reliably finish an HTTP call before
// the process dies (network may still be mid-handshake when Android kills
// the process). So: write a small file to disk at crash time (fast, local,
// finishes before the process dies), then on the NEXT app launch, send that
// file to the backend and delete it. One crash = one email, not a loop.
//
// What this deliberately does NOT do: catch the exception and keep the app
// running as if nothing happened. A crash still crashes (same "app has
// stopped" behavior as before) — this only adds a side-channel report, it
// doesn't change how the app actually fails. Silently swallowing a crash
// and limping on in a possibly-broken state would hide real bugs rather
// than surface them.
public class AureonCrashReporter {
    private static final String TAG = "AureonCrashReporter";
    private static final String CRASH_FILE_NAME = "aureon_pending_crash.txt";
    private static final String REPORT_URL = "https://aureone.onrender.com/api/watchdog/report";

    // Call once, as early as possible — Application.onCreate() if the app
    // has one, otherwise the first line of MainActivity.onCreate() before
    // anything else runs.
    public static void install(Context appContext) {
        final Context ctx = appContext.getApplicationContext();
        final Thread.UncaughtExceptionHandler previousHandler = Thread.getDefaultUncaughtExceptionHandler();

        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            try {
                writeCrashToDisk(ctx, throwable);
            } catch (Exception writeErr) {
                Log.e(TAG, "Couldn't write crash log to disk", writeErr);
            }
            // Hand off to whatever Android/the previous handler would
            // normally do — we're only observing, not intercepting.
            if (previousHandler != null) {
                previousHandler.uncaughtException(thread, throwable);
            } else {
                System.exit(1);
            }
        });
    }

    // Call once at startup, after install() — e.g. right after
    // super.onCreate() in MainActivity. Sends last run's crash (if any) to
    // the backend, which emails the owner, then clears it so it's only
    // reported once.
    public static void reportPendingCrashIfAny(Context appContext) {
        final Context ctx = appContext.getApplicationContext();
        Executors.newSingleThreadExecutor().execute(() -> {
            File file = new File(ctx.getFilesDir(), CRASH_FILE_NAME);
            if (!file.exists()) return;
            try {
                String report = readFile(file);
                postCrashReport(report);
            } catch (Exception e) {
                Log.e(TAG, "Couldn't report pending crash", e);
            } finally {
                // Delete regardless of send success — a flaky network
                // shouldn't turn into the same old crash being re-sent
                // forever on every future launch.
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        });
    }

    private static void writeCrashToDisk(Context ctx, Throwable throwable) throws IOException {
        StringWriter sw = new StringWriter();
        throwable.printStackTrace(new PrintWriter(sw));
        String report = "device=" + Build.MANUFACTURER + " " + Build.MODEL +
                " androidSdk=" + Build.VERSION.SDK_INT +
                " time=" + System.currentTimeMillis() + "\n" + sw;
        File file = new File(ctx.getFilesDir(), CRASH_FILE_NAME);
        try (FileOutputStream fos = new FileOutputStream(file)) {
            fos.write(report.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static String readFile(File file) throws IOException {
        try (FileInputStream fis = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) file.length()];
            int read = 0;
            while (read < bytes.length) {
                int n = fis.read(bytes, read, bytes.length - read);
                if (n == -1) break;
                read += n;
            }
            return new String(bytes, 0, read, StandardCharsets.UTF_8);
        }
    }

    private static void postCrashReport(String report) throws Exception {
        JSONObject body = new JSONObject();
        body.put("source", "android_app");
        body.put("report", report);

        URL url = new URL(REPORT_URL);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setDoOutput(true);
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(10000);
        try (OutputStream os = conn.getOutputStream()) {
            os.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        conn.getResponseCode(); // drain the connection; we don't act on the response
        conn.disconnect();
    }
}
