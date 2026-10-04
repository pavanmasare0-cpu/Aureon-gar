package com.aureon.ai;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Calendar;
import java.util.concurrent.Executors;

// JARVIS-style proactive check-ins — Aureon reaches out on its own, instead
// of only ever replying. Two triggers:
//   1. A daily message at a fixed hour (good night / "how was your day").
//   2. A "it's been quiet a while" check-in if there's been no interaction
//      (voice, Love Camera, or typed chat) for several hours.
// Delivered both ways at once: a tappable notification AND spoken aloud via
// TTS, same as the user asked for.
//
// Implementation note: uses self-rescheduling AlarmManager one-shots
// (setAndAllowWhileIdle) rather than setRepeating or WorkManager — no new
// Gradle dependency, survives Doze, and doesn't need the special "exact
// alarm" permission since none of this needs to-the-second precision.
public class AureonProactiveScheduler {
    private static final String TAG = "AureonProactive";
    private static final String PREFS_NAME = "aureon_proactive_prefs";
    private static final String KEY_LAST_INTERACTION = "last_interaction_at";
    private static final String KEY_LAST_SILENCE_ALERT = "last_silence_alert_at";

    private static final int DAILY_HOUR_24 = 22; // 10 PM local time
    private static final long SILENCE_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000L;   // check every 2h
    private static final long SILENCE_THRESHOLD_MS = 7 * 60 * 60 * 1000L;        // quiet for 7h+ triggers it
    private static final long SILENCE_ALERT_COOLDOWN_MS = 8 * 60 * 60 * 1000L;   // don't re-alert more than once per 8h

    private static final String ACTION_DAILY = "com.aureon.ai.PROACTIVE_DAILY";
    private static final String ACTION_SILENCE_CHECK = "com.aureon.ai.PROACTIVE_SILENCE_CHECK";

    private static final String REPORT_URL = "https://aureone.onrender.com/api/proactive-message";
    private static final String NOTIF_CHANNEL_ID = "aureon_proactive";
    private static final int NOTIF_ID = 5501;

    // --- public API ---

    // Call once, e.g. from MainActivity.onCreate() — idempotent, re-arming
    // with the same alarms every launch is harmless (AlarmManager replaces
    // a pending alarm with the same PendingIntent).
    public static void scheduleAll(Context context) {
        scheduleNextDaily(context);
        scheduleNextSilenceCheck(context);
    }

    // Call this from every place a real interaction happens (voice command
    // handled, Love Camera turn, typed chat message sent) — resets the
    // "quiet for X hours" clock. Cheap (one SharedPreferences write), safe
    // to call often.
    public static void markInteraction(Context context) {
        prefs(context).edit().putLong(KEY_LAST_INTERACTION, System.currentTimeMillis()).apply();
    }

    // --- scheduling ---

    private static void scheduleNextDaily(Context context) {
        Calendar next = Calendar.getInstance();
        next.set(Calendar.HOUR_OF_DAY, DAILY_HOUR_24);
        next.set(Calendar.MINUTE, 0);
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);
        if (next.getTimeInMillis() <= System.currentTimeMillis()) {
            next.add(Calendar.DAY_OF_YEAR, 1);
        }
        scheduleAlarm(context, ACTION_DAILY, next.getTimeInMillis(), 1);
    }

    private static void scheduleNextSilenceCheck(Context context) {
        scheduleAlarm(context, ACTION_SILENCE_CHECK, System.currentTimeMillis() + SILENCE_CHECK_INTERVAL_MS, 2);
    }

    private static void scheduleAlarm(Context context, String action, long triggerAtMillis, int requestCode) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        Intent intent = new Intent(context, AureonProactiveReceiver.class).setAction(action);
        PendingIntent pi = PendingIntent.getBroadcast(
                context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, pi);
        } catch (Exception ignored) {
            // Best-effort — a missed proactive message isn't worth crashing over.
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    // --- the receiver AlarmManager actually fires ---

    public static class AureonProactiveReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            Context appContext = context.getApplicationContext();
            String action = intent.getAction();
            if (ACTION_DAILY.equals(action)) {
                scheduleNextDaily(appContext); // reschedule tomorrow before doing anything else
                triggerProactiveMessage(appContext, "daily_night");
            } else if (ACTION_SILENCE_CHECK.equals(action)) {
                scheduleNextSilenceCheck(appContext); // reschedule the next check regardless
                long now = System.currentTimeMillis();
                long lastInteraction = prefs(appContext).getLong(KEY_LAST_INTERACTION, now); // assume "just used" if never recorded
                long lastSilenceAlert = prefs(appContext).getLong(KEY_LAST_SILENCE_ALERT, 0);
                boolean quietLongEnough = (now - lastInteraction) >= SILENCE_THRESHOLD_MS;
                boolean notAlertedRecently = (now - lastSilenceAlert) >= SILENCE_ALERT_COOLDOWN_MS;
                if (quietLongEnough && notAlertedRecently) {
                    prefs(appContext).edit().putLong(KEY_LAST_SILENCE_ALERT, now).apply();
                    triggerProactiveMessage(appContext, "silence_checkin");
                }
            }
        }
    }

    // --- generate + deliver ---

    private static void triggerProactiveMessage(Context context, String reason) {
        Executors.newSingleThreadExecutor().execute(() -> {
            String token = AureonAgentActions.getFreshIdToken(context);
            if (token == null) return; // never logged in on this device — nothing to personalize/send yet

            String message = fetchProactiveMessage(token, reason);
            if (message == null || message.trim().isEmpty()) return;

            showNotification(context, message);
            speak(context, message);
        });
    }

    private static String fetchProactiveMessage(String idToken, String reason) {
        try {
            JSONObject body = new JSONObject();
            body.put("reason", reason);

            URL url = new URL(REPORT_URL);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + idToken);
            conn.setDoOutput(true);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(20000); // generating a reply can take a few seconds
            try (java.io.OutputStream os = conn.getOutputStream()) {
                os.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = conn.getResponseCode();
            java.io.InputStream is = code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream();
            java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(is, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();
            conn.disconnect();

            if (code < 200 || code >= 300) return null;
            JSONObject json = new JSONObject(sb.toString());
            return json.optString("message", null);
        } catch (Exception e) {
            return null;
        }
    }

    private static void showNotification(Context context, String message) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = nm.getNotificationChannel(NOTIF_CHANNEL_ID);
            if (channel == null) {
                channel = new NotificationChannel(NOTIF_CHANNEL_ID, "Aureon check-ins", NotificationManager.IMPORTANCE_DEFAULT);
                channel.setDescription("Aureon reaching out on its own — daily check-ins and 'it's been quiet' messages.");
                nm.createNotificationChannel(channel);
            }
        }
        // POST_NOTIFICATIONS (Android 13+) is requested at MainActivity
        // launch, same as every other permission this app needs — if the
        // owner hasn't granted it yet, this just silently can't post,
        // exactly like any other Android notification would.
        if (ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED
                && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return;
        }

        Intent openApp = new Intent(context, MainActivity.class);
        openApp.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                context, 0, openApp, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification notification = new Notification.Builder(context, NOTIF_CHANNEL_ID)
                .setSmallIcon(context.getApplicationInfo().icon)
                .setContentTitle("Aureon")
                .setContentText(message)
                .setStyle(new Notification.BigTextStyle().bigText(message))
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .build();

        try {
            NotificationManagerCompat.from(context).notify(NOTIF_ID, notification);
        } catch (SecurityException ignored) {
            // Permission revoked between the check above and here — not worth crashing over.
        }
    }

    private static void speak(Context context, String message) {
        final TextToSpeech[] ttsHolder = new TextToSpeech[1];
        ttsHolder[0] = new TextToSpeech(context, status -> {
            if (status != TextToSpeech.SUCCESS || ttsHolder[0] == null) return;
            TextToSpeech tts = ttsHolder[0];
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) {}
                @Override public void onDone(String utteranceId) { tts.shutdown(); }
                @Override public void onError(String utteranceId) { tts.shutdown(); }
            });
            tts.speak(message, TextToSpeech.QUEUE_FLUSH, null, "aureon_proactive");
        });
    }
}
