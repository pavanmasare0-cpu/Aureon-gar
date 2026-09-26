package com.aureon.ai;

import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.telephony.TelephonyManager;

import java.util.Locale;

/**
 * Core "who's calling" logic, shared by AureonCallReceiver (manifest-
 * declared, works when it works) and AureonCallListenerService (a
 * persistent foreground service with its OWN dynamically-registered
 * receiver — kept alive by the foreground notification, which survives
 * OEM battery managers far more reliably than a static manifest receiver
 * alone on phones like ColorOS/Realme).
 */
final class AureonCallAnnouncer {
    private AureonCallAnnouncer() {}

    // Both AureonCallReceiver (static manifest receiver) AND
    // AureonCallListenerService (its own dynamically-registered receiver)
    // are active at the same time by design (see class comment below), so a
    // single ring reliably delivers PHONE_STATE=RINGING to both of them
    // within milliseconds of each other. Without this guard that meant the
    // caller's name/number got spoken twice, back to back, on every call.
    // Same pattern as ALARM_ANNOUNCE_COOLDOWN_MS in AureonAccessibilityService.
    private static final long ANNOUNCE_COOLDOWN_MS = 3000;
    private static volatile long lastAnnounceAt = 0;

    /** Call from any PHONE_STATE broadcast receiver, static or dynamic. */
    static void handlePhoneStateIntent(Context context, Intent intent) {
        if (intent == null || !TelephonyManager.ACTION_PHONE_STATE_CHANGED.equals(intent.getAction())) return;

        String state = intent.getStringExtra(TelephonyManager.EXTRA_STATE);
        if (!TelephonyManager.EXTRA_STATE_RINGING.equals(state)) return;

        long now = System.currentTimeMillis();
        if (now - lastAnnounceAt < ANNOUNCE_COOLDOWN_MS) return; // duplicate fire for the same ring, ignore
        lastAnnounceAt = now;

        // Requires READ_CALL_LOG on Android 9+ (API 28) for this extra to
        // actually be populated — with only READ_PHONE_STATE it's empty.
        String number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER);
        String name = (number != null && !number.trim().isEmpty())
                ? lookupContactName(context, number) : null;

        String announcement = name != null
                ? (name + " is calling")
                : (number != null && !number.trim().isEmpty()
                        ? ("Incoming call from " + number)
                        : "You have an incoming call");

        speak(context.getApplicationContext(), announcement);
    }

    private static String lookupContactName(Context context, String phoneNumber) {
        // Primary lookup — Android's own PhoneLookup provider, which
        // normally handles country-code/formatting differences internally.
        String name = lookupViaPhoneLookup(context, phoneNumber);
        if (name != null) return name;

        // Fallback: PhoneLookup can still miss a match on some OEM ROMs when
        // the incoming number's format differs from how it's saved in
        // Contacts (e.g. incoming "9876543210" vs saved "+91 98765 43210").
        // Compare just the last 10 digits against every saved number instead.
        String digitsOnly = phoneNumber.replaceAll("[^0-9]", "");
        if (digitsOnly.length() < 10) return null;
        String last10 = digitsOnly.substring(digitsOnly.length() - 10);

        Cursor cursor = null;
        try {
            Uri uri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI;
            cursor = context.getContentResolver().query(uri,
                    new String[]{ ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                            ContactsContract.CommonDataKinds.Phone.NUMBER },
                    null, null, null);
            if (cursor != null) {
                int nameIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME);
                int numIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER);
                while (cursor.moveToNext()) {
                    String savedNumber = numIdx >= 0 ? cursor.getString(numIdx) : null;
                    if (savedNumber == null) continue;
                    String savedDigits = savedNumber.replaceAll("[^0-9]", "");
                    if (savedDigits.length() >= 10
                            && savedDigits.substring(savedDigits.length() - 10).equals(last10)) {
                        return nameIdx >= 0 ? cursor.getString(nameIdx) : null;
                    }
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) cursor.close();
        }
        return null;
    }

    private static String lookupViaPhoneLookup(Context context, String phoneNumber) {
        Cursor cursor = null;
        try {
            Uri uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(phoneNumber));
            cursor = context.getContentResolver().query(uri,
                    new String[]{ ContactsContract.PhoneLookup.DISPLAY_NAME }, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(ContactsContract.PhoneLookup.DISPLAY_NAME);
                if (idx >= 0) return cursor.getString(idx);
            }
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) cursor.close();
        }
        return null;
    }

    // Kept alive for the whole process instead of created fresh per call —
    // TextToSpeech's async init (binding to the system TTS service) can
    // take a very noticeable moment, which was the main cause of the
    // announcement arriving well after the phone had already been ringing
    // for a while. Pre-warming it once (see warmUp()) means a ring just
    // uses an engine that's already sitting there ready to speak.
    private static volatile TextToSpeech sharedEngine;
    private static volatile boolean sharedEngineReady = false;
    private static final Object ENGINE_LOCK = new Object();

    /** Call once, early (e.g. MainActivity.onCreate / AureonCallListenerService.onCreate),
     *  to pay TTS's init cost before any call actually rings. Safe to call more than once. */
    static void warmUp(Context appContext) {
        synchronized (ENGINE_LOCK) {
            if (sharedEngine != null) return;
            sharedEngine = new TextToSpeech(appContext.getApplicationContext(), status -> {
                sharedEngineReady = (status == TextToSpeech.SUCCESS);
                if (sharedEngineReady) sharedEngine.setLanguage(Locale.getDefault());
            });
        }
    }

    private static void speak(Context appContext, String text) {
        warmUp(appContext); // no-op if already warmed/warming
        if (sharedEngineReady) {
            sharedEngine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "aureon_call_announce");
            return;
        }
        // Engine not ready yet (very first call right after boot, before
        // warmUp() finished) — fall back to a one-off engine for just this
        // announcement so the caller's name still gets spoken.
        final TextToSpeech[] fallback = new TextToSpeech[1];
        fallback[0] = new TextToSpeech(appContext.getApplicationContext(), status -> {
            if (status != TextToSpeech.SUCCESS || fallback[0] == null) return;
            fallback[0].setLanguage(Locale.getDefault());
            fallback[0].setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) {}
                @Override public void onDone(String utteranceId) { shutdownQuietly(); }
                @Override public void onError(String utteranceId) { shutdownQuietly(); }
                private void shutdownQuietly() {
                    if (fallback[0] != null) {
                        try { fallback[0].shutdown(); } catch (Exception ignored) {}
                        fallback[0] = null;
                    }
                }
            });
            fallback[0].speak(text, TextToSpeech.QUEUE_FLUSH, null, "aureon_call_announce");
        });
    }
}
