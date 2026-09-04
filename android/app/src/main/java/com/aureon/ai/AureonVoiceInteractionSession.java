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
import org.json.JSONException;
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
    private static final int AGENT_LOOP_LIMIT = 3;

    // Same wording app.js sends, so voice and chat behave consistently.
    private static final String AGENT_SYSTEM_PROMPT =
            "You are Aureon, a friendly and casual AI assistant — talk like a helpful friend, not a formal machine. " +
            "Keep responses warm, natural, and conversational, never stiff or robotic. Match the user's language " +
            "style — if they speak in Hinglish or Hindi, respond that way naturally. Keep it concise unless asked " +
            "for detail.\n\n" +
            "You can also directly control the user's phone using tools: check battery, open an app, set an " +
            "alarm, search the web, open a URL, play music, compose an email draft, or open a pre-filled " +
            "WhatsApp message. When the user asks you to do one of these things, call the matching tool instead " +
            "of just explaining how. You also have make_call and send_sms tools, but over voice you must NOT " +
            "call them yourself — if the user asks to call or text someone, tell them to ask you the same thing " +
            "from the chat screen instead, since that's where you can confirm it visually. Never write out a " +
            "fake tool call as plain text — only use the real function-calling mechanism, or just say so in " +
            "plain words if you can't.";

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

    private boolean sessionActive = true;

    private void initTextToSpeech() {
        textToSpeech = new TextToSpeech(getContext(), status -> {
            if (status == TextToSpeech.SUCCESS) {
                int langResult = textToSpeech.setLanguage(Locale.US);
                Log.d(TAG, "TTS language result: " + langResult);
                ttsReady = true;
                textToSpeech.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String utteranceId) {}

                    @Override
                    public void onDone(String utteranceId) {
                        // After Aureon finishes speaking its reply, start
                        // listening again automatically so the user can keep
                        // talking without repeating the wake word.
                        if ("aureon_reply".equals(utteranceId) && sessionActive) {
                            mainHandler.postDelayed(AureonVoiceInteractionSession.this::startListening, 300);
                        }
                    }

                    @Override public void onError(String utteranceId) {}
                });
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
                    handleHeardText(heard);
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

    // Offline shortcut: battery / open app / set alarm never need the AI
    // backend at all — check for those locally first, straight from what
    // was heard, with zero network involved. Anything else still needs
    // internet, same as before.
    private void handleHeardText(String heard) {
        try {
            AureonAgentActions.LocalIntent local = AureonAgentActions.matchLocalIntent(heard);
            if (local != null) {
                setStatus("Thinking…");
                try {
                    JSONObject result = runNonSensitiveAction(local.name, local.args);
                    String note = describeAction(local.name, local.args, result);
                    mainHandler.post(() -> showReply(note));
                } catch (AureonAgentActions.ActionException ae) {
                    mainHandler.post(() -> showReply("Couldn't do that: " + ae.getMessage()));
                }
                return;
            }
        } catch (JSONException e) {
            Log.e(TAG, "Local intent match failed", e);
        }
        sendToBackend(heard);
    }

    private void sendToBackend(String message) {
        JSONArray messages = new JSONArray();
        try {
            JSONObject userMsg = new JSONObject();
            userMsg.put("role", "user");
            userMsg.put("content", message);
            messages.put(userMsg);
        } catch (JSONException e) {
            Log.e(TAG, "Failed to build initial message", e);
            return;
        }
        continueConversation(messages, 0);
    }

    // Phase 6 — Agent: same request/response loop as www/app.js's
    // runAgentTurn(), reimplemented natively since the voice overlay has no
    // access to the WebView/Capacitor bridge. Recurses when the model asks
    // for a tool call, feeding the tool's result back in, until it produces
    // a final spoken reply (or the safety depth limit is hit).
    private void continueConversation(JSONArray messages, int depth) {
        if (depth == 0) setStatus("Thinking… (first request can take up to a minute)");

        new Thread(() -> {
            try {
                JSONObject payload = new JSONObject();
                payload.put("messages", messages);
                payload.put("tools", true);
                payload.put("systemPrompt", AGENT_SYSTEM_PROMPT);

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

                if (code < 200 || code >= 300) {
                    String errMsg = responseJson.optString("error", "Something went wrong.");
                    mainHandler.post(() -> showReply("Error: " + errMsg));
                    return;
                }

                if (responseJson.has("functionCall")) {
                    handleFunctionCall(messages, responseJson.getJSONObject("functionCall"), depth);
                } else {
                    String reply = responseJson.optString("reply", "(empty response)");
                    mainHandler.post(() -> showReply(reply));
                }
            } catch (Exception e) {
                Log.e(TAG, "Backend request failed", e);
                mainHandler.post(() -> showReply("Couldn't reach Aureon's backend."));
            }
        }).start();
    }

    private void handleFunctionCall(JSONArray messages, JSONObject functionCall, int depth) {
        try {
            String name = functionCall.optString("name", "");
            JSONObject args = functionCall.optJSONObject("args");
            if (args == null) args = new JSONObject();

            if (depth >= AGENT_LOOP_LIMIT) {
                mainHandler.post(() -> showReply("That got stuck — try asking again."));
                return;
            }

            JSONObject resultPayload;
            String spokenNote = null;

            if ("make_call".equals(name) || "send_sms".equals(name)) {
                // Never auto-execute sensitive actions from voice — no
                // on-screen confirmation is possible here.
                resultPayload = new JSONObject().put("result", "Voice can't do this directly — ask the user to confirm it in the Aureon chat screen.");
            } else {
                try {
                    JSONObject actionResult = runNonSensitiveAction(name, args);
                    resultPayload = new JSONObject().put("result", actionResult);
                    spokenNote = describeAction(name, args, actionResult);
                } catch (AureonAgentActions.ActionException ae) {
                    resultPayload = new JSONObject().put("result", new JSONObject().put("error", ae.getMessage()));
                }
            }

            JSONObject assistantTurn = new JSONObject();
            assistantTurn.put("role", "assistant");
            assistantTurn.put("functionCall", functionCall);
            messages.put(assistantTurn);

            JSONObject functionResponseWrapper = new JSONObject();
            functionResponseWrapper.put("name", name);
            functionResponseWrapper.put("response", resultPayload);
            JSONObject functionTurn = new JSONObject();
            functionTurn.put("role", "function");
            functionTurn.put("functionResponse", functionResponseWrapper);
            messages.put(functionTurn);

            if (spokenNote != null) {
                final String note = spokenNote;
                mainHandler.post(() -> {
                    if (statusText != null) statusText.setText(note);
                });
            }

            continueConversation(messages, depth + 1);
        } catch (JSONException e) {
            Log.e(TAG, "Failed to handle function call", e);
            mainHandler.post(() -> showReply("Something went wrong running that action."));
        }
    }

    private JSONObject runNonSensitiveAction(String name, JSONObject args) throws AureonAgentActions.ActionException, JSONException {
        Context ctx = getContext();
        switch (name) {
            case "get_battery":
                return AureonAgentActions.getBattery(ctx);
            case "open_app":
                return AureonAgentActions.openApp(ctx, args.optString("app_name"));
            case "set_alarm":
                return AureonAgentActions.setAlarm(ctx, args.optInt("hour"), args.optInt("minute"), args.optString("label", null));
            case "search_web":
                return AureonAgentActions.searchWeb(ctx, args.optString("query"));
            case "open_url":
                return AureonAgentActions.openUrl(ctx, args.optString("url"));
            case "play_music":
                return AureonAgentActions.playMusic(ctx, args.optString("query"));
            case "compose_email":
                return AureonAgentActions.composeEmail(ctx, args.optString("to", null), args.optString("subject"), args.optString("body"));
            case "send_whatsapp_message":
                return AureonAgentActions.sendWhatsappMessage(ctx, args.optString("number"), args.optString("message"));
            default:
                throw new AureonAgentActions.ActionException("Unknown action: " + name);
        }
    }

    private String describeAction(String name, JSONObject args, JSONObject result) {
        switch (name) {
            case "get_battery":
                return "Battery: " + result.optInt("level", -1) + "%" + (result.optBoolean("charging") ? " (charging)" : "");
            case "open_app":
                return "Opened " + result.optString("opened", args.optString("app_name"));
            case "set_alarm":
                return "Alarm set for " + result.optString("alarmSet");
            case "search_web":
                return "Searching: " + args.optString("query");
            case "open_url":
                return "Opened " + result.optString("opened", args.optString("url"));
            case "play_music":
                return "Playing: " + args.optString("query");
            case "compose_email":
                return "Opened email draft: " + args.optString("subject");
            case "send_whatsapp_message":
                return "Opened WhatsApp to " + args.optString("number") + " — tap send to deliver it";
            default:
                return "Done";
        }
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
        sessionActive = false;
        mainHandler.removeCallbacksAndMessages(null);
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
