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
 * Primary path: WakeWordDetector (raw AudioRecord + the 3-model ONNX
 * pipeline in assets/wakeword/). This does NOT take Android audio focus, so
 * it runs continuously in the background without pausing/ducking music —
 * unlike the old approach below.
 *
 * Fallback path (only used if the ONNX models aren't present yet, i.e.
 * WakeWordDetector.init() fails): the previous implementation, which polls
 * with Android's built-in SpeechRecognizer restarted every ~800ms. This
 * works, but each restart briefly takes audio focus, which is why music
 * playback used to pause repeatedly while this fallback was in use. It
 * exists purely so the assistant still responds to "Aureon" before the
 * proper models are added — once they're in assets/wakeword/, this class
 * automatically switches to the ONNX path with no further code changes.
 *
 * DEBUG: posts a notification with whatever it heard on every fallback-path result.
 */
public class AureonVoiceInteractionService extends VoiceInteractionService {

    private static final String TAG = "AureonVoiceService";
    private static final String CHANNEL_ID = "aureon_debug_channel";
    private static final int NOTIF_ID = 4242;
    private static final long RESTART_DELAY_MS = 800;
    private static final long POST_SESSION_RESTART_DELAY_MS = 8000;

    // Matches "aureon" plus known mis-hearings from Google's recognizer.
    // Only used by the SpeechRecognizer fallback path below.
    private static final String[] WAKE_WORD_VARIANTS = {
            "aureon", "oreon", "aurion", "aurian", "arion", "oreion", "everyone"
    };

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean listeningEnabled = false;

    // ---- Coordination with the assistant overlay (AureonVoiceInteractionSession) ----
    // Both this background wake-word listener and the overlay's own
    // command-recognizer want the mic at the same time once a session is
    // open — without this, they fought over it (whichever grabbed the mic
    // for that instant "won"), which is why a follow-up thing said right
    // after Aureon's first reply sometimes got swallowed by this ambient
    // listener instead of reaching the actual session.
    private static volatile boolean sessionActive = false;
    private static AureonVoiceInteractionService runningInstance;

    /** Called by AureonVoiceInteractionSession when it opens/closes. */
    static void notifySessionActive(boolean active) {
        sessionActive = active;
        AureonVoiceInteractionService svc = runningInstance;
        if (svc == null) return;
        svc.handler.post(() -> {
            if (active) svc.stopListening();
            else if (svc.listeningEnabled) svc.startListening();
        });
    }

    // ---- Primary path: ONNX wake-word engine (no audio-focus impact) ----
    private WakeWordDetector wakeWordDetector;
    private boolean usingOnnxEngine = false;

    // ---- Fallback path: Android SpeechRecognizer polling loop ----
    private SpeechRecognizer wakeWordRecognizer;

    @Override
    public void onReady() {
        super.onReady();
        Log.d(TAG, "Aureon voice interaction service ready.");
        createNotificationChannel();
        runningInstance = this;
        listeningEnabled = true;
        if (!sessionActive) startListening();
    }

    @Override
    public void onShutdown() {
        super.onShutdown();
        Log.d(TAG, "Aureon voice interaction service shutting down.");
        listeningEnabled = false;
        if (runningInstance == this) runningInstance = null;
        stopListening();
        if (wakeWordDetector != null) {
            wakeWordDetector.release();
            wakeWordDetector = null;
        }
    }

    private void startListening() {
        if (!listeningEnabled || sessionActive) return;

        if (wakeWordDetector == null) {
            wakeWordDetector = new WakeWordDetector(this, new WakeWordDetector.Listener() {
                @Override
                public void onWakeWordDetected(float score) {
                    handler.post(() -> onWakeWordHeard("aureon (onnx, score=" + score + ")"));
                }

                @Override
                public void onError(String message) {
                    Log.e(TAG, "WakeWordDetector error: " + message);
                    // Model files missing/broken — fall back so the assistant
                    // still works while they're added.
                    handler.post(() -> {
                        usingOnnxEngine = false;
                        startWakeWordListeningFallback();
                    });
                }
            });
        }

        try {
            if (wakeWordDetector.init()) {
                usingOnnxEngine = true;
                wakeWordDetector.start();
                Log.d(TAG, "Listening for wake word via ONNX engine (audio-focus-safe).");
                return;
            }
        } catch (Exception e) {
            // e.g. RECORD_AUDIO not granted yet, or a bad model file — fall
            // back rather than taking the whole service down.
            Log.e(TAG, "WakeWordDetector failed to start", e);
        }

        usingOnnxEngine = false;
        Log.w(TAG, "ONNX wake-word engine unavailable — using SpeechRecognizer fallback "
                + "(this fallback briefly interrupts music on every listen cycle).");
        startWakeWordListeningFallback();
    }

    private void stopListening() {
        if (wakeWordDetector != null) wakeWordDetector.stop();
        stopWakeWordListeningFallback();
    }

    private void onWakeWordHeard(String debugLabel) {
        Log.d(TAG, "Wake word detected — launching Aureon overlay. (" + debugLabel + ")");
        stopListening();
        showSession(new Bundle(), VoiceInteractionSession.SHOW_WITH_ASSIST);
        handler.postDelayed(() -> {
            listeningEnabled = true;
            startListening();
        }, POST_SESSION_RESTART_DELAY_MS);
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

    // ---------------- SpeechRecognizer fallback (pre-ONNX-models only) ----------------

    private void startWakeWordListeningFallback() {
        if (!listeningEnabled || usingOnnxEngine || sessionActive) return;
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            Log.e(TAG, "Speech recognition not available on this device.");
            return;
        }

        stopWakeWordListeningFallback();

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
                    onWakeWordHeard("aureon (speech-recognizer fallback)");
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
        if (!listeningEnabled || usingOnnxEngine || sessionActive) return;
        handler.postDelayed(this::startWakeWordListeningFallback, RESTART_DELAY_MS);
    }

    private void stopWakeWordListeningFallback() {
        if (wakeWordRecognizer != null) {
            try {
                wakeWordRecognizer.cancel();
                wakeWordRecognizer.destroy();
            } catch (Exception ignored) {}
            wakeWordRecognizer = null;
        }
    }
}
