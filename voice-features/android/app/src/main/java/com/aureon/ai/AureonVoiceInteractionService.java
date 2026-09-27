package com.aureon.ai;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.service.voice.VoiceInteractionService;
import android.service.voice.VoiceInteractionSession;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import java.util.ArrayList;
import java.util.Locale;

/**
 * System-level entry point. Android starts this once Aureon AI is set as the
 * phone's Default Digital Assistant.
 *
 * Continuously listens in short bursts using Android's built-in
 * SpeechRecognizer, checking each result for the word "aureon" (and known
 * mis-hearings — Google's recognizer often hears "Aureon" as "everyone").
 * When heard, it launches the overlay session (AureonVoiceInteractionSession).
 *
 * DEBUG: posts a notification with whatever it heard on every result.
 */
public class AureonVoiceInteractionService extends VoiceInteractionService {

    private static final String TAG = "AureonVoiceService";
    private static final String CHANNEL_ID = "aureon_debug_channel";
    private static final int NOTIF_ID = 4242;
    private static final long RESTART_DELAY_MS = 800;

    // Matches "aureon" plus known mis-hearings from Google's recognizer.
    private static final String[] WAKE_WORD_VARIANTS = {
            "aureon", "oreon", "aurion", "aurian", "arion", "oreion", "everyone"
    };

    private final Handler handler = new Handler(Looper.getMainLooper());
    private SpeechRecognizer wakeWordRecognizer;
    private boolean listeningEnabled = false;

    @Override
    public void onReady() {
        super.onReady();
        Log.d(TAG, "Aureon voice interaction service ready.");
        createNotificationChannel();
        listeningEnabled = true;
        startWakeWordListening();
    }

    @Override
    public void onShutdown() {
        super.onShutdown();
        Log.d(TAG, "Aureon voice interaction service shutting down.");
        listeningEnabled = false;
        stopWakeWordListening();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Aureon Debug", NotificationManager.IMPORTANCE_LOW);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    private void showHeardNotification(String text) {
        try {
            NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                    .setContentTitle("Aureon heard:")
                    .setContentText(text)
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .setAutoCancel(true);
            NotificationManagerCompat.from(this).notify(NOTIF_ID, builder.build());
        } catch (SecurityException e) {
            Log.e(TAG, "Notification permission not granted", e);
        }
    }

    private void startWakeWordListening() {
        if (!listeningEnabled) return;
        if (AureonMicCoordinator.isSessionActive()) {
            // A conversation session already owns the mic — don't start a
            // second SpeechRecognizer on top of it. Wait for it to finish.
            waitForSessionEndThenResume();
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            Log.e(TAG, "Speech recognition not available on this device.");
            return;
        }

        stopWakeWordListening();

        wakeWordRecognizer = SpeechRecognizer.createSpeechRecognizer(this);
        wakeWordRecognizer.setRecognitionListener(new RecognitionListener() {
            @Override
            public void onReadyForSpeech(Bundle params) {}

            @Override
            public void onBeginningOfSpeech() {}

            @Override
            public void onRmsChanged(float rmsdB) {}

            @Override
            public void onBufferReceived(byte[] buffer) {}

            @Override
            public void onEndOfSpeech() {}

            @Override
            public void onError(int error) {
                scheduleRestart();
            }

            @Override
            public void onResults(Bundle results) {
                ArrayList<String> matches = results.getStringArrayList(
                        SpeechRecognizer.RESULTS_RECOGNITION);

                boolean heardWakeWord = false;
                String heardText = null;

                if (matches != null && !matches.isEmpty()) {
                    heardText = matches.get(0);
                    for (String phrase : matches) {
                        if (phrase == null) continue;
                        String lower = phrase.toLowerCase(Locale.getDefault());
                        for (String variant : WAKE_WORD_VARIANTS) {
                            if (lower.contains(variant)) {
                                heardWakeWord = true;
                                break;
                            }
                        }
                        if (heardWakeWord) break;
                    }
                }

                if (heardText != null) {
                    showHeardNotification(heardText);
                }

                if (heardWakeWord) {
                    Log.d(TAG, "Wake word detected — launching Aureon overlay.");
                    stopWakeWordListening();
                    showSession(new Bundle(), VoiceInteractionSession.SHOW_WITH_ASSIST);
                    listeningEnabled = true;
                    waitForSessionEndThenResume();
                } else {
                    scheduleRestart();
                }
            }

            @Override
            public void onPartialResults(Bundle partialResults) {}

            @Override
            public void onEvent(int eventType, Bundle params) {}
        });

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);

        try {
            wakeWordRecognizer.startListening(intent);
        } catch (Exception e) {
            Log.e(TAG, "Failed to start wake-word listening", e);
            scheduleRestart();
        }
    }

    private void scheduleRestart() {
        if (!listeningEnabled) return;
        if (AureonMicCoordinator.isSessionActive()) {
            waitForSessionEndThenResume();
            return;
        }
        handler.postDelayed(this::startWakeWordListening, RESTART_DELAY_MS);
    }

    private static final long SESSION_POLL_INTERVAL_MS = 1000;

    // Polls the shared flag rather than resuming on a blind timer — as soon
    // as the session actually ends (any length conversation), wake-word
    // listening picks back up; while it's still going, this just keeps
    // waiting instead of contending for the mic.
    private void waitForSessionEndThenResume() {
        handler.postDelayed(() -> {
            if (!listeningEnabled) return;
            if (AureonMicCoordinator.isSessionActive()) {
                waitForSessionEndThenResume();
            } else {
                startWakeWordListening();
            }
        }, SESSION_POLL_INTERVAL_MS);
    }

    private void stopWakeWordListening() {
        if (wakeWordRecognizer != null) {
            try {
                wakeWordRecognizer.cancel();
                wakeWordRecognizer.destroy();
            } catch (Exception ignored) {}
            wakeWordRecognizer = null;
        }
    }
}
