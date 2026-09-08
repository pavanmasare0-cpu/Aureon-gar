package com.aureon.ai;

import android.content.BroadcastReceiver;
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
 * Announces who's calling ("Pavan is calling") the moment the phone starts
 * ringing — independent of whether Aureon is set as the Default Digital
 * Assistant, since this is a plain manifest-registered broadcast receiver,
 * not the voice-interaction service.
 *
 * PHONE_STATE is one of the implicit broadcasts Android still delivers to
 * manifest-declared receivers even from a stopped/background app (it's on
 * Android's compatibility exemption list from the Android 8 background
 * broadcast limits), so this works without needing a foreground service.
 */
public class AureonCallReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!TelephonyManager.ACTION_PHONE_STATE_CHANGED.equals(intent.getAction())) return;

        String state = intent.getStringExtra(TelephonyManager.EXTRA_STATE);
        if (!TelephonyManager.EXTRA_STATE_RINGING.equals(state)) return;

        // Reading the number here requires READ_CALL_LOG on Android 9+ (API
        // 28) — with only READ_PHONE_STATE, this extra comes back empty on
        // those versions.
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

    private String lookupContactName(Context context, String phoneNumber) {
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

    /** A fresh short-lived TTS engine per call — created, used once, then shut down. */
    private void speak(Context appContext, String text) {
        final TextToSpeech[] engine = new TextToSpeech[1];
        engine[0] = new TextToSpeech(appContext, status -> {
            if (status != TextToSpeech.SUCCESS || engine[0] == null) return;
            engine[0].setLanguage(Locale.getDefault());
            engine[0].setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) {}
                @Override public void onDone(String utteranceId) { shutdownQuietly(); }
                @Override public void onError(String utteranceId) { shutdownQuietly(); }
                private void shutdownQuietly() {
                    if (engine[0] != null) {
                        try { engine[0].shutdown(); } catch (Exception ignored) {}
                        engine[0] = null;
                    }
                }
            });
            engine[0].speak(text, TextToSpeech.QUEUE_FLUSH, null, "aureon_call_announce");
        });
    }
}
