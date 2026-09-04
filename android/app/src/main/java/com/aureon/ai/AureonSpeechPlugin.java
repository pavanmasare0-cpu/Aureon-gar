package com.aureon.ai;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * Bridges the in-app chat mic button to the SAME native voice pipeline
 * used by the system-wide "Hey Aureon" assistant: on-device (offline)
 * speech recognition when available, followed by OfflineVoiceCommandEngine
 * so simple device actions (open app, open settings, type text, etc.)
 * run instantly without hitting the AI backend or needing internet.
 *
 * Accepts an optional "lang" string (BCP-47, e.g. "hi-IN", "mr-IN",
 * "en-IN") from the JS side so the person can pick which language they're
 * about to speak. If omitted, the recognizer uses the phone's current
 * system language.
 */
@CapacitorPlugin(
        name = "AureonSpeech",
        permissions = {
                @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
        }
)
public class AureonSpeechPlugin extends Plugin {

    private SpeechRecognizer speechRecognizer;

    @PluginMethod
    public void listen(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micPermsCallback");
            return;
        }
        startListening(call);
    }

    @PermissionCallback
    private void micPermsCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            startListening(call);
        } else {
            call.reject("Microphone permission denied. Enable it in phone Settings \u2192 Apps \u2192 Aureon \u2192 Permissions.");
        }
    }

    private void startListening(PluginCall call) {
        final String lang = call.getString("lang"); // e.g. "hi-IN", "mr-IN", "en-IN", or null for device default

        getActivity().runOnUiThread(() -> {
            if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                call.reject("Speech recognition is not available on this device.");
                return;
            }

            final boolean offlineAvailable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    && SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext());

            cleanup();

            speechRecognizer = offlineAvailable
                    ? SpeechRecognizer.createOnDeviceSpeechRecognizer(getContext())
                    : SpeechRecognizer.createSpeechRecognizer(getContext());

            speechRecognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) {}
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rmsdB) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() {}

                @Override
                public void onError(int error) {
                    call.reject("Didn't catch that (error code " + error + "). Try again.");
                    cleanup();
                }

                @Override
                public void onResults(Bundle results) {
                    ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    String heard = (matches != null && !matches.isEmpty()) ? matches.get(0) : "";

                    JSObject ret = new JSObject();
                    ret.put("text", heard);
                    ret.put("offline", offlineAvailable);
                    ret.put("handled", false);

                    if (!heard.isEmpty()) {
                        final String[] messageHolder = new String[]{null};
                        boolean handled = OfflineVoiceCommandEngine.handle(
                                getContext(), heard, message -> messageHolder[0] = message);
                        ret.put("handled", handled);
                        if (handled && messageHolder[0] != null) {
                            ret.put("message", messageHolder[0]);
                        }
                    }

                    call.resolve(ret);
                    cleanup();
                }

                @Override public void onPartialResults(Bundle partialResults) {}
                @Override public void onEvent(int eventType, Bundle params) {}
            });

            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
            intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
            if (lang != null && !lang.isEmpty() && !lang.equalsIgnoreCase("auto")) {
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
            }

            speechRecognizer.startListening(intent);
        });
    }

    private void cleanup() {
        if (speechRecognizer != null) {
            speechRecognizer.destroy();
            speechRecognizer = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        cleanup();
        super.handleOnDestroy();
    }
}
