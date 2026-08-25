package com.aureon.ai;

import android.service.voice.VoiceInteractionService;
import android.util.Log;

/**
 * System-level entry point. Android starts this once Aureon AI is set as the
 * phone's Default Digital Assistant (Settings > Apps > Default apps > Digital
 * assistant app).
 *
 * This is where always-listening / wake-word logic should eventually live.
 * For now it just confirms the service is alive — wire up wake-word
 * detection (Porcupine or Android SpeechRecognizer) inside onReady().
 */
public class AureonVoiceInteractionService extends VoiceInteractionService {

    private static final String TAG = "AureonVoiceService";

    @Override
    public void onReady() {
        super.onReady();
        Log.d(TAG, "Aureon voice interaction service ready.");
        // TODO: start wake-word listening here (Porcupine or SpeechRecognizer loop).
        // When "Aureon" is detected, call showSession(...) to launch the overlay:
        //
        //   showSession(new Bundle(), VoiceInteractionSession.SHOW_WITH_ASSIST);
    }

    @Override
    public void onShutdown() {
        super.onShutdown();
        Log.d(TAG, "Aureon voice interaction service shutting down.");
        // TODO: stop wake-word listening / release mic resources here.
    }
}
