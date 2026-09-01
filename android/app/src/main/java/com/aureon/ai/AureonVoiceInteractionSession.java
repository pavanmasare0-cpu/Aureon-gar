package com.aureon.ai;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.service.voice.VoiceInteractionSession;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Locale;

/**
 * The floating overlay shown when Aureon is invoked as the system assistant.
 * Listens for speech, sends it to the Aureon backend, shows the reply, and
 * now speaks it out loud too (Text-to-Speech).
 */
public class AureonVoiceInteractionSession extends VoiceInteractionSession {

    private static final String TAG = "AureonVoiceSession";
    private static final String BACKEND_URL = "https://aureone.onrender.com/api/chat";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private SpeechRecognizer speechRecognizer;
    private TextToSpeech textToSpeech;
    private boolean ttsReady = false;
    private String pendingSpeech = null;
    private TextView statusText;
    private TextView responseText;

    public AureonVoiceInteractionSession(Context context) {
        super(context);
    }

    @Override
    public View onCreateContentView() {
        View view = LayoutInflater.from(getContext())
                .inflate(R.layout.aureon_voice_overlay, null);

        statusText = view.findViewById(R.id.aureon_status_text);
        responseText = view.findViewById(R.id.aureon_response_text);

        initTextToSpeech();
        startListening();

        return view;
    }

    private void initTextToSpeech() {
        textToSpeech = new TextToSpeech(getContext(), status -> {
            if (status == TextToSpeech.SUCCESS) {
                int langResult = textToSpeech.setLanguage(Locale.US);
                Log.d(TAG, "TTS language result: " + langResult);
                ttsReady = true;
                if (pendingSpeech != null) {
                    speak(pendingSpeech);
                    pendingSpeech = null;
                }
            } else {
                Log.e(TAG, "TextToSpeech init failed, status: " + status);
            }
        });
    }

    private void speak(String text) {
        if (text == null || text.isEmpty()) return;
        if (!ttsReady || textToSpeech == null) {
            pendingSpeech = text;
            return;
        }
        int result = textToSpeech.speak(text, TextToSpeech.QUEUE_FLUSH, null, "aureon_reply");
        Log.d(TAG, "TTS speak() result: " + result);
    }

    private void startListening() {
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            setStatus("Speech recognition not available on this device.");
            return;
        }

        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
        speechRecognizer.setRecognitionListener(new RecognitionListener() {
            @Override
            public void onReadyForSpeech(Bundle params) {
                setStatus("Listening…");
            }

            @Override
            public void onBeginningOfSpeech() {}

            @Override
            public void onRmsChanged(float rmsdB) {}

            @Override
            public void onBufferReceived(byte[] buffer) {}

            @Override
            public void onEndOfSpeech() {
                setStatus("Thinking… (first request can take up to a minute)");
            }

            @Override
            public void onError(int error) {
                Log.e(TAG, "Speech recognition error code: " + error);
                setStatus("Didn't catch that. Try again.");
            }

            @Override
            public void onResults(Bundle results) {
                ArrayList<String> matches = results.getStringArrayList(
                        SpeechRecognizer.RESULTS_RECOGNITION);
                if (matches != null && !matches.isEmpty()) {
                    String heard = matches.get(0);
                    setStatus("You said: " + heard);
                    sendToBackend(heard);
                } else {
                    setStatus("Didn't catch that. Try again.");
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
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE,
                getContext().getPackageName());

        speechRecognizer.startListening(intent);
    }

    private void sendToBackend(String message) {
        new Thread(() -> {
            try {
                JSONObject payload = new JSONObject();
                JSONArray messages = new JSONArray();
                JSONObject userMsg = new JSONObject();
                userMsg.put("role", "user");
                userMsg.put("content", message);
                messages.put(userMsg);
                payload.put("messages", messages);

                URL url = new URL(BACKEND_URL);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(60000);

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                }

                int code = conn.getResponseCode();
                BufferedReader reader = new BufferedReader(new InputStreamReader(
                        code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream(),
                        StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) sb.append(line);
                reader.close();

                JSONObject responseJson = new JSONObject(sb.toString());

                if (code >= 200 && code < 300 && responseJson.has("reply")) {
                    String reply = responseJson.getString("reply");
                    mainHandler.post(() -> showReply(reply));
                } else {
                    String errMsg = responseJson.optString("error", "Something went wrong.");
                    mainHandler.post(() -> showReply("Error: " + errMsg));
                }
            } catch (Exception e) {
                Log.e(TAG, "Backend request failed", e);
                mainHandler.post(() -> showReply("Couldn't reach Aureon's backend."));
            }
        }).start();
    }

    private void setStatus(String text) {
        mainHandler.post(() -> {
            if (statusText != null) statusText.setText(text);
        });
    }

    private void showReply(String reply) {
        if (statusText != null) statusText.setText("Aureon");
        if (responseText != null) {
            responseText.setText(reply);
            responseText.setVisibility(View.VISIBLE);
        }
        speak(reply);
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (speechRecognizer != null) {
            speechRecognizer.destroy();
            speechRecognizer = null;
        }
        if (textToSpeech != null) {
            textToSpeech.stop();
            textToSpeech.shutdown();
            textToSpeech = null;
        }
    }
}
