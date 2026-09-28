package com.aureon.ai;

import android.app.Dialog;
import android.content.Context;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.graphics.Matrix;
import android.graphics.RectF;
import android.graphics.SurfaceTexture;
import android.media.MediaPlayer;
import android.os.Build;
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
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
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
    // How many recent messages (3 exchanges) ride along with each request so
    // follow-ups make sense: "Tejas ko message karo" -> "kya bhejun?" -> "hi".
    private static final int VOICE_CONTEXT_MESSAGES = 6;
    private static final String BACKEND_SAVE_URL = "https://aureone.onrender.com/api/chat/save";
    private static final String MEMORY_URL_BASE = "https://aureone.onrender.com/api/memory?uid=";
    private static final int AGENT_LOOP_LIMIT = 3;

    // Same wording app.js sends, so voice and chat behave consistently.
    private static final String AGENT_SYSTEM_PROMPT =
            "You are Aureon, a friendly and casual AI assistant — talk like a helpful friend, not a formal machine. " +
            "Keep responses warm, natural, and conversational, never stiff or robotic. Match the user's language " +
            "style — if they speak in Hinglish or Hindi, respond that way naturally, including casual filler " +
            "words like \"are\", \"yaar\", \"bhai\" — treat those as normal conversation, not part of the command " +
            "itself. Keep it concise unless asked for detail.\n\n" +
            "You can also directly control the user's phone using tools: check battery, open an app, set an " +
            "alarm, search the web, open a URL, play music, play a specific video on YouTube directly, compose " +
            "an email draft, open a pre-filled WhatsApp message, send an Instagram DM to a contact by name, " +
            "read back the latest visible message in an Instagram chat, share live location with a contact " +
            "via WhatsApp, or open the Love Camera (a live camera mode that reads a question visible on " +
            "screen/paper and shows the answer in real time). When the user asks you to do one of these things — in any language, e.g. \"Instagram " +
            "mein Preeti ko text bhejo\", \"Pavan ko WhatsApp pe live location bhejo\" — call the matching tool " +
            "instead of just explaining how. send_instagram_message and send_whatsapp_live_location will always " +
            "ask the user a spoken yes/no before actually happening, so go ahead and call them directly — you " +
            "don't need to ask for confirmation yourself, the app handles that. You also have make_call and " +
            "send_sms tools, but over voice you must NOT call them yourself — if the user asks to call or text " +
            "someone via SMS, tell them to ask you the same thing from the chat screen instead, since that's " +
            "where you can confirm it visually.\n\n" +
            "MESSAGING: if the user asks to message or WhatsApp someone but hasn't said what to send " +
            "(e.g. \"Tejas ko message karo\"), ask one short question like \"Kya message bhejun?\" — their " +
            "next reply is the message itself, so use the earlier turns to know who it's for, then call " +
            "send_whatsapp_message with contact_name and message. WhatsApp only opens with the message " +
            "pre-filled, so tell them to tap Send themselves.\n\n" +
            "REMEMBERING: whenever the user asks you to remember, note down, or remind them of something " +
            "later — e.g. \"yaad rakhna\", \"note kar lo\", \"kal doodh lana hai yaad rakhna\", \"remind me " +
            "to...\" — you MUST call the save_reminder tool with what to remember; never just say you will " +
            "remember it, because without the tool call nothing is actually saved. Whenever the user asks what " +
            "they forgot or wants to be reminded — e.g. \"kuch bhul raha hu\", \"yaad dila do\", \"kya yaad " +
            "rakhna tha\", \"koi reminder hai kya\" — call recall_reminders and read back what it returns " +
            "naturally (or say plainly that nothing is saved). For lasting facts about the user themselves " +
            "(name, family, preferences, habits) call update_memory. Only tell the user you saved or " +
            "remembered something after the tool call actually succeeded.\n\n" +
            "Never write out a fake tool call as plain text — only use the " +
            "real function-calling mechanism, or just say so in plain words if you can't.";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private SpeechRecognizer speechRecognizer;
    private TextToSpeech textToSpeech;
    private boolean ttsReady = false;
    private String pendingSpeech = null;
    private TextView statusText;
    private TextView responseText;

    // Voice confirmation state for sensitive actions (Instagram DM,
    // WhatsApp live location) — set right before asking "yes or no?" so the
    // *next* thing heard is treated as a confirmation answer, not a new
    // command.
    private boolean awaitingConfirmation = false;
    private JSONObject pendingFunctionCall = null;
    private String pendingThoughtSignature = null;
    private JSONArray pendingMessages = null;
    private int pendingDepth = 0;
    private int confirmationAttempts = 0;

    // Voice-chat-save: every exchange in this session gets appended here
    // and pushed to the same Firestore collection typed chats use (see
    // /api/chat/save in server.js), so voice conversations show up in
    // Recent Chats too. One id per session (one "Aureon" invocation =
    // one saved chat, growing turn by turn).
    private final String voiceChatId = "voice_" + System.currentTimeMillis();
    private final JSONArray voiceChatLog = new JSONArray();
    private String lastHeardText = null;

    // Voice-side memory-fetch: pulled once at session start (best-effort,
    // non-blocking) and folded into the system prompt on every request
    // this session makes, so Aureon actually uses what update_memory has
    // saved about this user instead of starting fresh every time.
    private String personalMemoryText = null;

    public AureonVoiceInteractionSession(Context context) {
        super(context);
    }

    private AureonEnergyOrbView orbView; // kept for backward-compat field name, unused now
    private TextureView orbTexture;
    private MediaPlayer orbMediaPlayer;
    private static final int ORB_VIDEO_WIDTH = 480;
    private static final int ORB_VIDEO_HEIGHT = 480;

    // Applies fullscreen to the session's actual system Window (not just
    // the content View) — getWindow() here returns a Dialog per the
    // VoiceInteractionSession API; its own getWindow() is the real
    // android.view.Window. Without this, the status bar area is reserved
    // as a gap regardless of flags set on the inflated content view.
    private void applyFullscreen() {
        Dialog dialog = getWindow();
        if (dialog == null) return;
        Window window = dialog.getWindow();
        if (window == null) return;

        window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT);
        window.addFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    @Override
    public View onCreateContentView() {
        View view = LayoutInflater.from(getContext())
                .inflate(R.layout.aureon_voice_overlay, null);

        // True fullscreen — apply to the actual system Window (not just this
        // content view), which is what actually controls whether the status
        // bar area is drawn over or left as a gap. VoiceInteractionSession's
        // getWindow() returns a Dialog; its own getWindow() is the real
        // android.view.Window the framework created for this session.
        applyFullscreen();

        statusText = view.findViewById(R.id.aureon_status_text);
        responseText = view.findViewById(R.id.aureon_response_text);
        orbTexture = view.findViewById(R.id.aureon_orb_texture);
        // The orb video is a plain rectangular MP4 (no alpha channel — video
        // formats generally can't have a transparent background), so its
        // square corners show as a hard black box over the nebula backdrop.
        // Clipping the TextureView to a circular outline crops those corners
        // away, leaving just the round orb visible.
        orbTexture.setOutlineProvider(new android.view.ViewOutlineProvider() {
            @Override
            public void getOutline(View v, android.graphics.Outline outline) {
                outline.setOval(0, 0, v.getWidth(), v.getHeight());
            }
        });
        orbTexture.setClipToOutline(true);
        setupOrbVideo();

        // Tell the background wake-word listener to back off from the mic
        // for as long as this session is running (see AureonMicCoordinator).
        AureonMicCoordinator.setSessionActive(true);
        fetchPersonalMemory();

        initTextToSpeech();
        startListening();

        return view;
    }

    private void setupOrbVideo() {
        orbTexture.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override
            public void onSurfaceTextureAvailable(SurfaceTexture surface, int width, int height) {
                startOrbMediaPlayer(new Surface(surface));
                configureOrbTransform(width, height);
            }

            @Override
            public void onSurfaceTextureSizeChanged(SurfaceTexture surface, int width, int height) {
                configureOrbTransform(width, height);
            }

            @Override
            public boolean onSurfaceTextureDestroyed(SurfaceTexture surface) {
                return true;
            }

            @Override
            public void onSurfaceTextureUpdated(SurfaceTexture surface) {}
        });
    }

    private void startOrbMediaPlayer(Surface surface) {
        try {
            AssetFileDescriptor afd = getContext().getResources().openRawResourceFd(R.raw.aureon_orb);
            orbMediaPlayer = new MediaPlayer();
            orbMediaPlayer.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            afd.close();
            orbMediaPlayer.setSurface(surface);
            orbMediaPlayer.setLooping(true);
            orbMediaPlayer.setVolume(0f, 0f); // background animation, no sound
            orbMediaPlayer.setOnPreparedListener(MediaPlayer::start);
            // Some devices don't reliably honor setLooping(true) with
            // hardware-decoded video into a TextureView — if playback ever
            // stops on its own, just start it again instead of leaving a
            // black frame on screen.
            orbMediaPlayer.setOnCompletionListener(mp -> {
                try { mp.start(); } catch (Exception ignored) {}
            });
            orbMediaPlayer.setOnErrorListener((mp, what, extra) -> {
                Log.e(TAG, "Orb video error what=" + what + " extra=" + extra);
                try { mp.reset(); startOrbMediaPlayer(surface); } catch (Exception ignored) {}
                return true;
            });
            orbMediaPlayer.prepareAsync();
        } catch (Exception e) {
            Log.e(TAG, "Failed to start orb video", e);
        }
    }

    // The TextureView is a fixed 300dp square matching the video's own
    // square aspect ratio, so this just does a plain fill — no cropping
    // needed since both are 1:1. Kept generic (rather than assuming
    // identical size) in case the video's resolution ever changes.
    private void configureOrbTransform(int viewWidth, int viewHeight) {
        if (orbTexture == null) return;
        Matrix matrix = new Matrix();
        RectF viewRect = new RectF(0, 0, viewWidth, viewHeight);
        RectF bufferRect = new RectF(0, 0, ORB_VIDEO_WIDTH, ORB_VIDEO_HEIGHT);
        float centerX = viewRect.centerX();
        float centerY = viewRect.centerY();
        bufferRect.offset(centerX - bufferRect.centerX(), centerY - bufferRect.centerY());
        matrix.setRectToRect(viewRect, bufferRect, Matrix.ScaleToFit.FILL);
        float scale = Math.max(
                (float) viewHeight / ORB_VIDEO_HEIGHT,
                (float) viewWidth / ORB_VIDEO_WIDTH);
        matrix.postScale(scale, scale, centerX, centerY);
        orbTexture.setTransform(matrix);
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
                            mainHandler.postDelayed(() -> {
                                // Hide the floating overlay after the first
                                // exchange — from here on it's audio-only:
                                // saying "open WhatsApp" brings WhatsApp
                                // straight to the front instead of showing
                                // Aureon's popup in the way. The session
                                // itself (and listening) keeps running
                                // hidden until "stop"/"cancel" is heard.
                                hide();
                                startListening();
                            }, 300);
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

    private int consecutiveListenErrors = 0;
    private static final int MAX_CONSECUTIVE_ERRORS = 4;

    private void startListening() {
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            setStatus("Speech recognition not available on this device.");
            return;
        }

        // Destroy any previous recognizer first — creating a new one on top
        // of a still-alive one is how listening silently stops responding
        // after a while (leaked recognizer holding the mic).
        if (speechRecognizer != null) {
            speechRecognizer.destroy();
            speechRecognizer = null;
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
                if (speechRecognizer != null) {
                    speechRecognizer.destroy();
                    speechRecognizer = null;
                }

                // Permission/client setup errors won't fix themselves by
                // retrying — retrying those in a loop just burns battery.
                if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                    setStatus("Aureon needs microphone permission — check Settings.");
                    return;
                }

                consecutiveListenErrors++;
                if (consecutiveListenErrors >= MAX_CONSECUTIVE_ERRORS) {
                    // Stop auto-retrying after repeated failures in a row
                    // (e.g. no mic input at all) so it doesn't loop forever
                    // silently draining battery — but this is NOT a dead
                    // end: saying "Aureon" again re-invokes this session
                    // fresh, no app restart needed.
                    setStatus("Didn't catch that a few times — say \"Aureon\" again to retry.");
                    return;
                }

                setStatus("Didn't catch that. Try again.");
                if (sessionActive) {
                    mainHandler.postDelayed(AureonVoiceInteractionSession.this::startListening, 500);
                }
            }

            @Override
            public void onResults(Bundle results) {
                consecutiveListenErrors = 0;
                ArrayList<String> matches = results.getStringArrayList(
                        SpeechRecognizer.RESULTS_RECOGNITION);
                if (matches != null && !matches.isEmpty()) {
                    String heard = matches.get(0);
                    setStatus("You said: " + heard);
                    handleHeardText(heard);
                } else {
                    setStatus("Didn't catch that. Try again.");
                    if (sessionActive) {
                        mainHandler.postDelayed(AureonVoiceInteractionSession.this::startListening, 500);
                    }
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
        // en-IN recognizes Hinglish (mixed Hindi/English in one sentence)
        // far more reliably than the en-US default — Google's en-US model
        // is tuned for American accents/vocabulary and drops or mangles
        // Hindi words entirely.
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-IN");
        intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false);

        speechRecognizer.startListening(intent);
    }

    // Offline shortcut: battery / open app / set alarm never need the AI
    // backend at all — check for those locally first, straight from what
    // was heard, with zero network involved. Anything else still needs
    // internet, same as before.
    private void handleHeardText(String heard) {
        String lower = heard == null ? "" : heard.trim().toLowerCase(Locale.ROOT);
        lastHeardText = heard;
        if (isStopCommand(lower)) {
            stopEverything();
            return;
        }

        // A sensitive action is waiting on a yes/no answer — whatever was
        // just heard is that answer, not a new command. Handled completely
        // separately from normal command parsing below.
        if (awaitingConfirmation) {
            handleConfirmationAnswer(lower);
            return;
        }

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

    // "Stop"/"cancel" (and Hindi/Marathi equivalents) should always work —
    // even mid-speech or mid-action — as an immediate off-switch, without
    // needing the cloud backend or an agent loop to interpret it.
    private String buildConfirmationPrompt(String name, JSONObject args) {
        if ("send_instagram_message".equals(name)) {
            return "Confirm — Instagram pe " + args.optString("contact_name", "unknown")
                    + " ko ye bhejun: " + args.optString("message", "") + "? Haan ya nahi bolo.";
        }
        if ("send_whatsapp_live_location".equals(name)) {
            return "Confirm — " + args.optString("contact_name", "unknown")
                    + " ko WhatsApp pe " + args.optString("duration", "15 minutes")
                    + " ke liye live location bhejun? Haan ya nahi bolo.";
        }
        return "Confirm this action? Haan ya nahi bolo.";
    }

    private boolean isAffirmative(String lower) {
        return lower.equals("haan") || lower.equals("han") || lower.equals("yes")
                || lower.equals("ok") || lower.equals("okay") || lower.equals("theek hai")
                || lower.contains("kar do") || lower.contains("bhej do") || lower.contains("send kar")
                || lower.contains("haan kar") || lower.contains("go ahead") || lower.contains("confirm");
    }

    private boolean isNegative(String lower) {
        return lower.equals("nahi") || lower.equals("nahin") || lower.equals("no")
                || lower.equals("nako") || lower.equals("cancel") || lower.contains("mat kar")
                || lower.contains("mat bhejo") || lower.contains("rehne do") || lower.contains("don't");
    }

    // Runs once we've heard the answer to a sensitive-action confirmation
    // prompt (asked from handleFunctionCall). Unclear answers are treated
    // as a decline by default after one re-ask — staying silent about an
    // unclear "maybe" is safer than guessing yes on something irreversible.
    private void handleConfirmationAnswer(String lower) {
        boolean yes = isAffirmative(lower);
        boolean no = isNegative(lower);

        if (!yes && !no) {
            confirmationAttempts++;
            if (confirmationAttempts < 2) {
                mainHandler.post(() -> showReply("Samjha nahi — bhejun ye? Haan ya nahi bolo."));
                return; // stays in awaitingConfirmation state, asks again
            }
            yes = false; // unclear twice in a row — default to NOT sending
            no = true;
        }

        awaitingConfirmation = false;
        JSONObject functionCall = pendingFunctionCall;
        String thoughtSignature = pendingThoughtSignature;
        JSONArray messages = pendingMessages;
        int depth = pendingDepth;
        pendingFunctionCall = null;
        pendingThoughtSignature = null;
        pendingMessages = null;

        if (no) {
            mainHandler.post(() -> showReply("Theek hai, cancel kar diya."));
            return;
        }

        try {
            String name = functionCall.optString("name", "");
            JSONObject args = functionCall.optJSONObject("args");
            if (args == null) args = new JSONObject();

            JSONObject resultPayload;
            String spokenNote = null;
            try {
                JSONObject actionResult = runNonSensitiveAction(name, args);
                resultPayload = new JSONObject().put("result", actionResult);
                spokenNote = describeAction(name, args, actionResult);
            } catch (AureonAgentActions.ActionException ae) {
                resultPayload = new JSONObject().put("result", new JSONObject().put("error", ae.getMessage()));
            }

            JSONObject assistantTurn = new JSONObject();
            assistantTurn.put("role", "assistant");
            assistantTurn.put("functionCall", functionCall);
            if (thoughtSignature != null) assistantTurn.put("thoughtSignature", thoughtSignature);
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
            Log.e(TAG, "Failed to execute confirmed action", e);
            mainHandler.post(() -> showReply("Something went wrong running that action."));
        }
    }

    private boolean isStopCommand(String lower) {
        if (lower.isEmpty()) return false;
        switch (lower) {
            case "stop":
            case "cancel":
            case "रुको":
            case "रुक जाओ":
            case "बंद करो":
            case "थांबा":
            case "थांब":
                return true;
            default:
                return lower.contains("stop karo") || lower.contains("cancel karo")
                        || lower.contains("ruk jao") || lower.contains("band karo");
        }
    }

    private void stopEverything() {
        if (textToSpeech != null) {
            textToSpeech.stop();
        }
        if (speechRecognizer != null) {
            speechRecognizer.cancel();
        }
        sessionActive = false;
        setStatus("Cancelled.");
        // Actually end the interaction (not just pause it) — matches "chalta
        // rahega jab tak stop na bolu": stop should be a real, final off
        // switch, not just a silent pause that could confuse whether Aureon
        // is still listening in the background or not.
        mainHandler.post(() -> {
            showReply("Ok, ruk gaya.");
            mainHandler.postDelayed(this::finish, 1200);
        });
    }

    private void sendToBackend(String message) {
        JSONArray messages = new JSONArray();
        try {
            // Recent turns first (voiceChatLog always holds whole user/assistant
            // pairs), skipping exchanges that just ended in an error message.
            int start = Math.max(0, voiceChatLog.length() - VOICE_CONTEXT_MESSAGES);
            for (int i = start; i + 1 < voiceChatLog.length(); i += 2) {
                JSONObject u = voiceChatLog.getJSONObject(i);
                JSONObject a = voiceChatLog.getJSONObject(i + 1);
                String reply = a.optString("content", "");
                if (reply.startsWith("Error") || reply.startsWith("Couldn't")) continue;
                messages.put(u);
                messages.put(a);
            }
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
                String systemPromptToSend = AGENT_SYSTEM_PROMPT;
                if (personalMemoryText != null && !personalMemoryText.trim().isEmpty()) {
                    systemPromptToSend += "\n\nThings you remember about this user from past " +
                            "conversations (use naturally where relevant, don't just recite them):\n" + personalMemoryText;
                }
                payload.put("systemPrompt", systemPromptToSend);
                String uid = AureonAgentActions.getStoredUid(getContext());
                if (!uid.isEmpty()) payload.put("uid", uid);

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
                    String thoughtSignature = responseJson.optString("thoughtSignature", null);
                    handleFunctionCall(messages, responseJson.getJSONObject("functionCall"), thoughtSignature, depth);
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

    // Best-effort, non-blocking — a slow or failed fetch just means this
    // session starts without memory context rather than delaying anything
    // the user is doing. No uid (not logged in) means nothing to fetch.
    private void fetchPersonalMemory() {
        String uid = AureonAgentActions.getStoredUid(getContext());
        if (uid.isEmpty()) return;
        new Thread(() -> {
            try {
                URL url = new URL(MEMORY_URL_BASE + java.net.URLEncoder.encode(uid, "UTF-8"));
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(10000);
                int code = conn.getResponseCode();
                if (code >= 200 && code < 300) {
                    JSONObject json = new JSONObject(readStream(conn.getInputStream()));
                    String text = json.optString("text", "");
                    if (!text.trim().isEmpty()) personalMemoryText = text;
                }
            } catch (Exception e) {
                Log.w(TAG, "Personal memory fetch failed (non-fatal)", e);
            }
        }).start();
    }

    // Best-effort, non-blocking, fire-and-forget — a failed save here
    // should never interrupt or delay the actual conversation. No uid
    // (not logged in) means nowhere to save it, so skip silently.
    private void logTurnToCloud(String userText, String assistantText) {
        String uid = AureonAgentActions.getStoredUid(getContext());
        if (uid.isEmpty() || userText == null || assistantText == null) return;
        try {
            voiceChatLog.put(new JSONObject().put("role", "user").put("content", userText));
            voiceChatLog.put(new JSONObject().put("role", "assistant").put("content", assistantText));
        } catch (JSONException e) {
            return;
        }
        final JSONArray logSnapshot;
        try {
            logSnapshot = new JSONArray(voiceChatLog.toString()); // copy — the live log keeps growing on the main thread
        } catch (JSONException e) {
            return;
        }
        new Thread(() -> {
            try {
                JSONObject payload = new JSONObject();
                payload.put("uid", uid);
                payload.put("chatId", voiceChatId);
                payload.put("messages", logSnapshot);

                URL url = new URL(BACKEND_SAVE_URL);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(15000);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                }
                conn.getResponseCode(); // drain the response; result isn't needed
            } catch (Exception e) {
                Log.w(TAG, "Voice chat save failed (non-fatal)", e);
            }
        }).start();
    }

    private String readStream(java.io.InputStream is) throws java.io.IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) sb.append(line);
        reader.close();
        return sb.toString();
    }

    private void handleFunctionCall(JSONArray messages, JSONObject functionCall, String thoughtSignature, int depth) {
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
            } else if ("send_instagram_message".equals(name) || "send_whatsapp_live_location".equals(name)) {
                // These DO complete a real send/share with no further human
                // tap involved, so unlike open_app/play_music they need an
                // explicit spoken yes before anything happens. Park the
                // call and messages, ask the question, and pick this back
                // up in handleConfirmationAnswer() once we hear yes/no.
                pendingFunctionCall = functionCall;
                pendingThoughtSignature = thoughtSignature;
                pendingMessages = messages;
                pendingDepth = depth;
                confirmationAttempts = 0;
                awaitingConfirmation = true;
                // args gets reassigned above (args == null check), so it's
                // not effectively-final — lambdas require that. Copy into
                // final locals just for the capture.
                final String fName = name;
                final JSONObject fArgs = args;
                mainHandler.post(() -> showReply(buildConfirmationPrompt(fName, fArgs)));
                return;
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
            // Echo Gemini's thought_signature back exactly as received —
            // "thinking" models require this on every subsequent turn that
            // includes a prior function call, or they error out / degrade.
            if (thoughtSignature != null) assistantTurn.put("thoughtSignature", thoughtSignature);
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
            case "open_love_camera":
                return AureonAgentActions.openLoveCamera(ctx);
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
                return AureonAgentActions.sendWhatsappMessage(ctx, args.optString("number"), args.optString("contact_name"), args.optString("message"));
            case "read_instagram_message":
                return AureonAgentActions.readInstagramMessage(ctx, args.optString("contact_name"));
            case "play_youtube":
                return AureonAgentActions.youtubeSearch(ctx, args.optString("query"));
            case "send_instagram_message":
                return AureonAgentActions.sendInstagramMessage(ctx, args.optString("contact_name"), args.optString("message"));
            case "send_whatsapp_live_location":
                return AureonAgentActions.sendWhatsappLiveLocation(ctx, args.optString("contact_name"), args.optString("duration", "15 minutes"));
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
                return "Opened WhatsApp to " + result.optString("to", args.optString("contact_name", args.optString("number"))) + " — tap send to deliver it";
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
        logTurnToCloud(lastHeardText, reply);
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        sessionActive = false;
        AureonMicCoordinator.setSessionActive(false);
        mainHandler.removeCallbacksAndMessages(null);
        if (orbView != null) {
            orbView.stopAnimating();
            orbView = null;
        }
        if (orbMediaPlayer != null) {
            try {
                orbMediaPlayer.stop();
            } catch (Exception ignored) {}
            orbMediaPlayer.release();
            orbMediaPlayer = null;
        }
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
