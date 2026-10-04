package com.aureon.ai;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * "Love Camera" — a live camera mode that reads whatever question is
 * currently visible (paper, a screen, a book — handwritten or printed, in
 * Hindi, English, or any other language) and shows a full answer/solution
 * in an overlay panel, updating automatically as the visible question
 * changes.
 *
 * Every ~2.5s (while no request is already in flight) a frame is captured
 * and sent to Gemini directly — skipping the Render backend entirely for
 * the fastest possible reply. Gemini both reads the question AND answers
 * it in one call (asked to return strict JSON: {"question","answer"}),
 * which is far more robust across languages and messy handwriting than an
 * on-device OCR step would be.
 *
 * A lightweight perceptual hash (dHash) of each frame is compared against
 * a small in-memory cache: if the current view closely matches a question
 * already answered this session, the cached answer is shown instantly with
 * no network call — this is what stops the same question (or the same
 * still-held page) from being re-sent to Gemini on every capture tick.
 *
 * Launched like any other tool action — see
 * AureonAgentActions.openLoveCamera() — not part of the accessibility/
 * screen-typing action set, since this only reads the camera and never
 * touches another app's UI.
 */
public class LoveCameraActivity extends AppCompatActivity {

    private static final String TAG = "LoveCamera";
    // Calls Gemini directly instead of going through the Render backend —
    // Render's free tier can take 30-50s to wake up from a cold start,
    // which is far too slow for a live "read the question, show the
    // answer" flow. "gemini-flash-latest" is the same fast-model alias the
    // backend prefers (see rankCandidates() in server.js).
    private static final String GEMINI_URL =
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=" + BuildConfig.GEMINI_API_KEY;
    // Fallback when Gemini errors out — Groq's own inference hardware, so
    // still fast. Groq's only current vision-capable model is this Qwen
    // model (they don't have a Llama vision model any more); check
    // console.groq.com/docs/vision if this ever needs updating.
    private static final String GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
    private static final String GROQ_VISION_MODEL = "qwen/qwen3.8-27b";
    // Was 2500 — the Gemini free tier can be as tight as 20 requests/day,
    // and every scan cycle (whether or not it finds anything new) is one
    // request. Widening this buys a lot more usable time before hitting
    // that daily cap. Still fast enough to feel responsive.
    private static final long CAPTURE_INTERVAL_MS = 8000;
    private static final int FUZZY_MATCH_THRESHOLD = 6; // out of 64 dHash bits — "close enough to be the same view"
    private static final int MAX_CACHE_ENTRIES = 25;
    private static final int REQUEST_PERMISSIONS = 2001;
    // No hard cap on retries — this screen stays open until the user closes
    // it, so instead of giving up we just back off to a slower retry pace
    // after real errors (silence/no-match is the normal idle state, not an
    // error, and always retries immediately).
    private static final int SLOW_RETRY_AFTER_ERRORS = 4;
    private static final long VOICE_RETRY_DELAY_MS = 500;
    private static final long VOICE_SLOW_RETRY_DELAY_MS = 4000;
    private static final String VISION_PROMPT_BASE =
            "Look at this image. If it has a question written or printed in it (handwritten or " +
            "typed, in Hindi, English, or any other language, possibly tilted), read it and " +
            "answer it — for a math or logic question, show the key working steps briefly and " +
            "then the final answer; for a factual question, just the direct answer. Reply in the " +
            "same language as the question. " +
            "Separately, if a person's face is clearly visible anywhere in the image, briefly " +
            "describe their mood/expression in a few words (e.g. \"looks cheerful\", \"looks " +
            "tired\", \"looks sad\") — do this for whoever is in frame, not just a specific " +
            "person; identification is never needed, just the expression. If they appear sad, " +
            "upset, or distressed, also write one short, warm, caring check-in line asking if " +
            "they're okay (in Hinglish, unless a question in another language makes that " +
            "language more natural). " +
            "Separately again, briefly describe what activity or work is visibly going on in " +
            "the frame in a few words (e.g. \"cooking on a stove\", \"writing in a notebook\", " +
            "\"typing on a laptop\", \"fixing a bicycle\", \"assembling furniture\") — this is " +
            "about the scene/action, not a person's identity. Leave it empty if nothing " +
            "particular is happening (e.g. an empty room, or a static object with no action). " +
            "Respond with ONLY a JSON object, no other text, in exactly this shape: " +
            "{\"question\": \"\", \"answer\": \"\", \"mood\": \"\", \"checkin\": \"\", \"greeting\": \"\", \"activity\": \"\"}. " +
            "Leave any field empty (\"\") if it doesn't apply — e.g. no readable question, no " +
            "face clearly visible, the person doesn't look upset, or no clear activity to describe.";

    private static final String OWNER_PHOTO_PROMPT_ADDITION =
            " The FIRST image you were given is a reference photo of Pavan, the owner of this " +
            "app. The SECOND image is the current live camera frame — that is the one to read " +
            "the question and mood from. If Pavan's face is recognizably the same person as in " +
            "the reference photo, put one short warm greeting using his name (e.g. \"Hey Pavan!\") " +
            "in the \"greeting\" field; otherwise leave \"greeting\" empty. Never guess a name for " +
            "anyone who isn't a clear match to the reference photo.";

    // Typed chat (keyboard row under the answer panel). The latest camera
    // frame rides along as context, so "ye kya hai?" works while pointing
    // the camera at something.
    private static final int CHAT_IMAGE_MAX_SIDE = 1280;
    private static final int CHAT_HISTORY_MAX_TURNS = 12; // individual messages kept (6 exchanges)
    private static final String CHAT_SYSTEM_PROMPT =
            "You are Aureon, a warm, friendly AI assistant chatting inside the user's phone camera screen. " +
            "Reply in the same language the user writes in (Hindi, Hinglish, English, or anything else), " +
            "casually and briefly — a few sentences unless they ask for detail. A live photo from the phone's " +
            "camera is attached to the user's message for context: use it only if their message is about what " +
            "they're looking at (an object, some text, a problem on paper, their own expression); otherwise " +
            "ignore it and never mention it. Never identify a real person by name from their face.";

    private TextView questionText;
    private TextView answerText;
    private ProgressBar loadingSpinner;
    private EditText chatInput;

    // chatMode pauses the auto-scan loop (and ignores late scan results) so
    // typed-chat answers don't get overwritten; the 📷 button turns it off.
    private volatile boolean chatMode = false;
    private volatile boolean chatInFlight = false;
    private final List<String[]> chatHistory = new ArrayList<>(); // {"user"|"assistant", text}

    private ImageCapture imageCapture;
    private ProcessCameraProvider cameraProvider;
    private PreviewView previewView;
    private CameraSelector currentSelector = CameraSelector.DEFAULT_BACK_CAMERA;
    private ExecutorService cameraExecutor;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<Long, String> answerCache = new LinkedHashMap<>();

    private volatile boolean requestInFlight = false;
    private String ownerPhotoBase64; // null if the owner hasn't uploaded a reference photo (Settings)

    // Talk to Aureon right here, same as anywhere else in the app — no
    // wake word needed, having this screen open is the signal. Voice input
    // feeds the same chat pipeline as the keyboard row, but replies are
    // also spoken back (see startChatTurn's speakReply flag).
    private SpeechRecognizer speechRecognizer;
    private TextToSpeech textToSpeech;
    private boolean ttsReady = false;
    private boolean voiceListeningActive = false;
    private int consecutiveVoiceErrors = 0;

    // Manual mute — default is Aureon listening continuously the whole
    // time this screen is open (no wake word needed). The mic button lets
    // the user turn that off without closing Love Camera, e.g. if they
    // want to talk to someone else in the room without Aureon picking it
    // up. startVoiceListening() checks this and no-ops while it's true, so
    // any already-scheduled retry just quietly does nothing instead of
    // restarting the recognizer.
    private volatile boolean voiceManuallyOff = false;
    private Button micToggleButton;

    // So a sad/upset expression gets spoken ONCE, not every ~2.5s scan
    // cycle for as long as the person keeps looking the same way.
    private static final long CHECKIN_SPEAK_COOLDOWN_MS = 45000;
    private String lastSpokenCheckin = "";
    private long lastCheckinSpokenAt = 0;

    private final Runnable captureLoop = new Runnable() {
        @Override public void run() {
            if (!requestInFlight && !chatMode) {
                captureFrame();
            }
            mainHandler.postDelayed(this, CAPTURE_INTERVAL_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_love_camera);

        previewView = findViewById(R.id.love_camera_preview);
        questionText = findViewById(R.id.love_camera_question);
        answerText = findViewById(R.id.love_camera_answer);
        loadingSpinner = findViewById(R.id.love_camera_spinner);
        Button closeButton = findViewById(R.id.love_camera_close);
        closeButton.setOnClickListener(v -> finish());
        Button flipButton = findViewById(R.id.love_camera_flip);
        flipButton.setOnClickListener(v -> flipCamera());
        micToggleButton = findViewById(R.id.love_camera_mic_toggle);
        micToggleButton.setOnClickListener(v -> toggleVoiceManually());

        MaxHeightScrollView scroll = findViewById(R.id.love_camera_scroll);
        scroll.setMaxHeightPx((int) (240 * getResources().getDisplayMetrics().density));
        chatInput = findViewById(R.id.love_camera_input);
        findViewById(R.id.love_camera_send).setOnClickListener(v -> sendChatMessage());
        findViewById(R.id.love_camera_scan_btn).setOnClickListener(v -> resumeScanning());
        chatInput.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_SEND) {
                sendChatMessage();
                return true;
            }
            return false;
        });

        cameraExecutor = Executors.newSingleThreadExecutor();
        loadOwnerPhoto();
        initTextToSpeech();

        // Background wake-word listening backs off while this screen owns
        // the mic — released in onDestroy(). Same coordination the main
        // voice session uses, so the two never fight over the microphone.
        AureonMicCoordinator.setSessionActive(true);

        List<String> needed = new ArrayList<>();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.CAMERA);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.RECORD_AUDIO);
        }
        if (needed.isEmpty()) {
            startCamera();
            startVoiceListening();
        } else {
            ActivityCompat.requestPermissions(this, needed.toArray(new String[0]), REQUEST_PERMISSIONS);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_PERMISSIONS) return;

        boolean cameraGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        boolean micGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;

        if (cameraGranted) {
            startCamera();
        } else {
            answerText.setText("Camera permission is needed for Love Camera to read questions.");
            mainHandler.postDelayed(this::finish, 2000);
            return;
        }
        // Voice is a bonus on top of the camera, not required — if denied,
        // the keyboard row still works fine, so just skip listening.
        if (micGranted) startVoiceListening();
    }

    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> cameraProviderFuture = ProcessCameraProvider.getInstance(this);
        cameraProviderFuture.addListener(() -> {
            try {
                cameraProvider = cameraProviderFuture.get();
                bindCameraUseCases();
                mainHandler.postDelayed(captureLoop, CAPTURE_INTERVAL_MS);
            } catch (ExecutionException | InterruptedException e) {
                Log.e(TAG, "Camera init failed", e);
                answerText.setText("Couldn't start the camera.");
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private void bindCameraUseCases() {
        if (cameraProvider == null) return;
        Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());

        imageCapture = new ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                .build();

        cameraProvider.unbindAll();
        Camera camera = cameraProvider.bindToLifecycle(this, currentSelector, preview, imageCapture);
    }

    // Switches between back and front (selfie) camera. Front camera matters
    // most for the mood/owner-recognition side of Love Camera — reading a
    // question off paper naturally wants the back camera, but checking your
    // own face wants the front one.
    private void flipCamera() {
        currentSelector = (currentSelector == CameraSelector.DEFAULT_BACK_CAMERA)
                ? CameraSelector.DEFAULT_FRONT_CAMERA
                : CameraSelector.DEFAULT_BACK_CAMERA;
        bindCameraUseCases();
    }

    // Loaded once at startup — a friend or stranger in frame just won't get a
    // "greeting" from Gemini since they won't match this reference photo.
    private void loadOwnerPhoto() {
        new Thread(() -> {
            File file = new File(getFilesDir(), "owner_reference.jpg");
            if (!file.exists()) return;
            try (FileInputStream fis = new FileInputStream(file);
                 ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = fis.read(buffer)) != -1) bos.write(buffer, 0, read);
                ownerPhotoBase64 = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
            } catch (Exception e) {
                Log.w(TAG, "Couldn't load owner reference photo", e);
            }
        }).start();
    }

    private void captureFrame() {
        if (imageCapture == null) return;
        imageCapture.takePicture(cameraExecutor, new ImageCapture.OnImageCapturedCallback() {
            @Override
            public void onCaptureSuccess(@NonNull ImageProxy image) {
                byte[] jpegBytes = imageProxyToJpegBytes(image);
                image.close();
                if (jpegBytes != null) processFrame(jpegBytes);
            }

            @Override
            public void onError(@NonNull ImageCaptureException exception) {
                Log.w(TAG, "Frame capture failed", exception);
            }
        });
    }

    private byte[] imageProxyToJpegBytes(ImageProxy image) {
        try {
            ImageProxy.PlaneProxy plane = image.getPlanes()[0];
            ByteBuffer buffer = plane.getBuffer();
            byte[] bytes = new byte[buffer.remaining()];
            buffer.get(bytes);
            return bytes;
        } catch (Exception e) {
            Log.w(TAG, "Couldn't read captured frame", e);
            return null;
        }
    }

    // Runs on cameraExecutor (background thread).
    private void processFrame(byte[] jpegBytes) {
        Bitmap bitmap = BitmapFactory.decodeByteArray(jpegBytes, 0, jpegBytes.length);
        if (bitmap == null) return;
        long hash = computeDHash(bitmap);
        bitmap.recycle();

        String cached = findCachedAnswer(hash);
        if (cached != null) {
            applyResult(cached);
            return;
        }

        requestInFlight = true;
        mainHandler.post(() -> loadingSpinner.setVisibility(View.VISIBLE));
        fetchAnswerForImage(jpegBytes, hash);
    }

    // Difference hash: cheap, rotation-sensitive but good enough to tell
    // "basically the same page held up again" from "a genuinely new view".
    private long computeDHash(Bitmap bitmap) {
        Bitmap small = Bitmap.createScaledBitmap(bitmap, 9, 8, true);
        long hash = 0;
        int bit = 0;
        for (int y = 0; y < 8; y++) {
            for (int x = 0; x < 8; x++) {
                int left = luminance(small.getPixel(x, y));
                int right = luminance(small.getPixel(x + 1, y));
                if (left > right) hash |= (1L << bit);
                bit++;
            }
        }
        small.recycle();
        return hash;
    }

    private int luminance(int pixel) {
        int r = (pixel >> 16) & 0xFF, g = (pixel >> 8) & 0xFF, b = pixel & 0xFF;
        return (r * 299 + g * 587 + b * 114) / 1000;
    }

    private int hammingDistance(long a, long b) {
        return Long.bitCount(a ^ b);
    }

    private synchronized String findCachedAnswer(long hash) {
        for (Map.Entry<Long, String> e : answerCache.entrySet()) {
            if (hammingDistance(hash, e.getKey()) <= FUZZY_MATCH_THRESHOLD) {
                return e.getValue();
            }
        }
        return null;
    }

    private synchronized void cacheAnswer(long hash, String rawJson) {
        if (answerCache.size() >= MAX_CACHE_ENTRIES) {
            Long oldestKey = answerCache.keySet().iterator().next();
            answerCache.remove(oldestKey);
        }
        answerCache.put(hash, rawJson);
    }

    private void fetchAnswerForImage(byte[] jpegBytes, long hash) {
        new Thread(() -> {
            String rawReply;
            try {
                rawReply = callGeminiVision(jpegBytes);
            } catch (Exception geminiErr) {
                String geminiMsg = geminiErr.getMessage() != null ? geminiErr.getMessage() : geminiErr.getClass().getSimpleName();
                Log.w(TAG, "Gemini vision failed, falling back to Groq", geminiErr);
                try {
                    rawReply = callGroqVision(jpegBytes);
                } catch (Exception groqErr) {
                    String groqMsg = groqErr.getMessage() != null ? groqErr.getMessage() : groqErr.getClass().getSimpleName();
                    Log.e(TAG, "Groq vision fallback also failed", groqErr);
                    rawReply = jsonError("Gemini: " + geminiMsg + " | Groq: " + groqMsg);
                }
            }

            requestInFlight = false;

            String question = "", answer = "", mood = "", checkin = "", greeting = "", activity = "";
            try {
                JSONObject parsed = new JSONObject(rawReply);
                question = parsed.optString("question", "");
                answer = parsed.optString("answer", "");
                mood = parsed.optString("mood", "");
                checkin = parsed.optString("checkin", "");
                greeting = parsed.optString("greeting", "");
                activity = parsed.optString("activity", "");
            } catch (Exception ignore) {
                // Model didn't return valid JSON — fall back to showing raw text as the answer.
                answer = rawReply;
            }

            boolean isErrorReply = answer.startsWith("Error") || answer.startsWith("Couldn't");
            boolean nothingToShow = question.trim().isEmpty() && mood.trim().isEmpty()
                    && checkin.trim().isEmpty() && greeting.trim().isEmpty() && activity.trim().isEmpty();
            if (nothingToShow && !isErrorReply) {
                // Nothing readable/notable in this frame — leave whatever's already on screen.
                mainHandler.post(() -> loadingSpinner.setVisibility(View.GONE));
                return;
            }

            cacheAnswer(hash, rawReply);
            applyResult(rawReply);
        }).start();
    }

    // Throws on any failure (network error, non-2xx response, empty reply) so
    // fetchAnswerForImage's catch block can fall through to Groq.
    private String callGeminiVision(byte[] jpegBytes) throws Exception {
        if (BuildConfig.GEMINI_API_KEY == null || BuildConfig.GEMINI_API_KEY.isEmpty()) {
            throw new IllegalStateException("No Gemini API key configured on this build.");
        }
        String base64Image = Base64.encodeToString(jpegBytes, Base64.NO_WRAP);
        JSONObject framePart = new JSONObject().put("inlineData", new JSONObject()
                .put("mimeType", "image/jpeg")
                .put("data", base64Image));

        String prompt = VISION_PROMPT_BASE;
        JSONArray parts = new JSONArray();
        if (ownerPhotoBase64 != null) {
            JSONObject referencePart = new JSONObject().put("inlineData", new JSONObject()
                    .put("mimeType", "image/jpeg")
                    .put("data", ownerPhotoBase64));
            parts.put(referencePart); // reference photo first, so the prompt's "FIRST image" is correct
            prompt += OWNER_PHOTO_PROMPT_ADDITION;
        }
        parts.put(framePart).put(new JSONObject().put("text", prompt));

        JSONObject userContent = new JSONObject().put("role", "user").put("parts", parts);
        JSONObject payload = new JSONObject().put("contents", new JSONArray().put(userContent));

        URL url = new URL(GEMINI_URL);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setDoOutput(true);
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(30000);
        try (OutputStream os = conn.getOutputStream()) {
            os.write(payload.toString().getBytes(StandardCharsets.UTF_8));
        }

        int code = conn.getResponseCode();
        JSONObject responseJson = new JSONObject(readStream(
                code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream()));

        if (code < 200 || code >= 300) {
            JSONObject errObj = responseJson.optJSONObject("error");
            throw new IOException(errObj != null ? errObj.optString("message", "Gemini error") : "Gemini error " + code);
        }
        JSONArray candidates = responseJson.optJSONArray("candidates");
        JSONObject firstCandidate = candidates != null && candidates.length() > 0 ? candidates.optJSONObject(0) : null;
        JSONObject content = firstCandidate != null ? firstCandidate.optJSONObject("content") : null;
        JSONArray responseParts = content != null ? content.optJSONArray("parts") : null;
        StringBuilder textOut = new StringBuilder();
        if (responseParts != null) {
            for (int i = 0; i < responseParts.length(); i++) {
                textOut.append(responseParts.optJSONObject(i).optString("text", ""));
            }
        }
        if (textOut.length() == 0) throw new IOException("Empty Gemini response");
        return stripJsonFences(textOut.toString());
    }

    // Groq fallback — same prompt/JSON contract as Gemini, just OpenAI-style
    // request/response shape (image as a data: URL) since that's what
    // Groq's API expects.
    private String callGroqVision(byte[] jpegBytes) throws Exception {
        if (BuildConfig.GROQ_API_KEY == null || BuildConfig.GROQ_API_KEY.isEmpty()) {
            throw new IllegalStateException("No Groq API key configured on this build.");
        }
        String base64Image = Base64.encodeToString(jpegBytes, Base64.NO_WRAP);

        String prompt = VISION_PROMPT_BASE;
        JSONArray content = new JSONArray();
        if (ownerPhotoBase64 != null) {
            content.put(new JSONObject().put("type", "image_url").put("image_url",
                    new JSONObject().put("url", "data:image/jpeg;base64," + ownerPhotoBase64)));
            prompt += OWNER_PHOTO_PROMPT_ADDITION;
        }
        content.put(new JSONObject().put("type", "image_url").put("image_url",
                new JSONObject().put("url", "data:image/jpeg;base64," + base64Image)));
        content.put(new JSONObject().put("type", "text").put("text", prompt));

        JSONObject userMessage = new JSONObject().put("role", "user").put("content", content);
        JSONObject payload = new JSONObject()
                .put("model", GROQ_VISION_MODEL)
                .put("messages", new JSONArray().put(userMessage));

        URL url = new URL(GROQ_URL);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("Authorization", "Bearer " + BuildConfig.GROQ_API_KEY);
        conn.setDoOutput(true);
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(30000);
        try (OutputStream os = conn.getOutputStream()) {
            os.write(payload.toString().getBytes(StandardCharsets.UTF_8));
        }

        int code = conn.getResponseCode();
        JSONObject responseJson = new JSONObject(readStream(
                code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream()));

        if (code < 200 || code >= 300) {
            JSONObject errObj = responseJson.optJSONObject("error");
            throw new IOException(errObj != null ? errObj.optString("message", "Groq error") : "Groq error " + code);
        }
        JSONArray choices = responseJson.optJSONArray("choices");
        JSONObject firstChoice = choices != null && choices.length() > 0 ? choices.optJSONObject(0) : null;
        JSONObject message = firstChoice != null ? firstChoice.optJSONObject("message") : null;
        String text = message != null ? message.optString("content", "") : "";
        if (text.isEmpty()) throw new IOException("Empty Groq response");
        return stripJsonFences(text);
    }

    private String readStream(InputStream is) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) sb.append(line);
        reader.close();
        return sb.toString();
    }

    // ---------------------------------------------------------------
    // Typed chat — keyboard row under the answer panel
    // ---------------------------------------------------------------

    private void sendChatMessage() {
        String text = chatInput.getText().toString().trim();
        if (text.isEmpty() || chatInFlight) return;
        chatInput.setText("");
        hideKeyboard();
        startChatTurn(text, false);
    }

    // Shared by the keyboard row and voice input. speakReply is true only
    // for voice turns — a typed message gets a silent/visual reply, same
    // as before; a spoken one gets spoken back, like talking to Aureon
    // anywhere else in the app.
    private void startChatTurn(String text, boolean speakReply) {
        AureonProactiveScheduler.markInteraction(this); // resets the "been quiet" clock — covers both keyboard and voice turns here
        if (chatInFlight) return;
        chatMode = true; // pause auto-scan while chatting
        chatInFlight = true;
        questionText.setText("You: " + text);
        answerText.setText("…");
        loadingSpinner.setVisibility(View.VISIBLE);

        // Grab a fresh frame so "ye kya hai?" refers to what the camera is
        // looking at right now (or the person's face/expression), not
        // whatever it saw a minute ago.
        if (imageCapture == null) {
            runChat(text, null, speakReply);
            return;
        }
        imageCapture.takePicture(cameraExecutor, new ImageCapture.OnImageCapturedCallback() {
            @Override
            public void onCaptureSuccess(@NonNull ImageProxy image) {
                byte[] small = null;
                try {
                    small = downscaleUpright(imageProxyToJpegBytes(image), image.getImageInfo().getRotationDegrees());
                } catch (Exception e) {
                    Log.w(TAG, "Couldn't prepare chat frame — sending text only", e);
                }
                image.close();
                runChat(text, small, speakReply);
            }

            @Override
            public void onError(@NonNull ImageCaptureException exception) {
                Log.w(TAG, "Chat frame capture failed — sending text only", exception);
                runChat(text, null, speakReply);
            }
        });
    }

    private void resumeScanning() {
        chatMode = false;
        synchronized (chatHistory) { chatHistory.clear(); }
        chatInput.setText("");
        hideKeyboard();
        questionText.setText("Point the camera at a question…");
        answerText.setText("");
    }

    private void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(chatInput.getWindowToken(), 0);
    }

    // Shrinks the camera frame (full-res is several MB — far too slow to
    // upload per chat message) and bakes in the rotation, since re-encoding
    // drops the EXIF orientation tag.
    private byte[] downscaleUpright(byte[] jpeg, int rotationDegrees) {
        if (jpeg == null) return null;
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, bounds);
        int longSide = Math.max(bounds.outWidth, bounds.outHeight);
        int sample = 1;
        while (longSide / (sample * 2) >= CHAT_IMAGE_MAX_SIDE) sample *= 2;

        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sample;
        Bitmap bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, opts);
        if (bmp == null) return null;
        if (rotationDegrees != 0) {
            Matrix m = new Matrix();
            m.postRotate(rotationDegrees);
            Bitmap rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
            if (rotated != bmp) bmp.recycle();
            bmp = rotated;
        }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.JPEG, 80, bos);
        bmp.recycle();
        return bos.toByteArray();
    }

    private void runChat(String text, byte[] imageJpeg, boolean speakReply) {
        final List<String[]> history;
        synchronized (chatHistory) { history = new ArrayList<>(chatHistory); }

        new Thread(() -> {
            String reply = null;
            String geminiErrMsg = null;
            String groqErrMsg = null;
            try {
                reply = chatWithGemini(text, imageJpeg, history);
            } catch (Exception geminiErr) {
                geminiErrMsg = geminiErr.getMessage() != null ? geminiErr.getMessage() : geminiErr.getClass().getSimpleName();
                Log.w(TAG, "Gemini chat failed, falling back to Groq", geminiErr);
                try {
                    reply = chatWithGroq(text, imageJpeg, history);
                } catch (Exception groqErr) {
                    groqErrMsg = groqErr.getMessage() != null ? groqErr.getMessage() : groqErr.getClass().getSimpleName();
                    Log.e(TAG, "Groq chat fallback also failed", groqErr);
                }
            }

            if (reply != null) {
                synchronized (chatHistory) {
                    chatHistory.add(new String[]{"user", text});
                    chatHistory.add(new String[]{"assistant", reply});
                    while (chatHistory.size() > CHAT_HISTORY_MAX_TURNS) chatHistory.remove(0);
                }
            }
            // Show the real exception text — a silent generic message here
            // is undebuggable without logcat, which isn't available in this
            // Codespace-only, no-PC workflow.
            final String shown = reply != null ? reply
                    : "Error — Gemini: " + geminiErrMsg + " | Groq: " + groqErrMsg;
            chatInFlight = false;
            mainHandler.post(() -> {
                loadingSpinner.setVisibility(View.GONE);
                answerText.setText(shown);
                if (speakReply) {
                    speak(shown); // resumes listening itself once done (see initTextToSpeech)
                }
            });
        }).start();
    }

    private String chatWithGemini(String text, byte[] imageJpeg, List<String[]> history) throws Exception {
        if (BuildConfig.GEMINI_API_KEY == null || BuildConfig.GEMINI_API_KEY.isEmpty()) {
            throw new IllegalStateException("No Gemini API key configured on this build.");
        }
        JSONArray contents = new JSONArray();
        for (String[] turn : history) {
            contents.put(new JSONObject()
                    .put("role", turn[0].equals("assistant") ? "model" : "user")
                    .put("parts", new JSONArray().put(new JSONObject().put("text", turn[1]))));
        }
        JSONArray parts = new JSONArray();
        if (imageJpeg != null) {
            parts.put(new JSONObject().put("inlineData", new JSONObject()
                    .put("mimeType", "image/jpeg")
                    .put("data", Base64.encodeToString(imageJpeg, Base64.NO_WRAP))));
        }
        parts.put(new JSONObject().put("text", text));
        contents.put(new JSONObject().put("role", "user").put("parts", parts));

        JSONObject payload = new JSONObject()
                .put("contents", contents)
                .put("systemInstruction", new JSONObject().put("parts",
                        new JSONArray().put(new JSONObject().put("text", CHAT_SYSTEM_PROMPT))));

        JSONObject json = postJson(GEMINI_URL, payload, null);
        JSONArray candidates = json.optJSONArray("candidates");
        JSONObject first = candidates != null && candidates.length() > 0 ? candidates.optJSONObject(0) : null;
        JSONObject content = first != null ? first.optJSONObject("content") : null;
        JSONArray outParts = content != null ? content.optJSONArray("parts") : null;
        StringBuilder out = new StringBuilder();
        if (outParts != null) {
            for (int i = 0; i < outParts.length(); i++) out.append(outParts.optJSONObject(i).optString("text", ""));
        }
        if (out.toString().trim().isEmpty()) throw new IOException("Empty Gemini response");
        return out.toString().trim();
    }

    private String chatWithGroq(String text, byte[] imageJpeg, List<String[]> history) throws Exception {
        if (BuildConfig.GROQ_API_KEY == null || BuildConfig.GROQ_API_KEY.isEmpty()) {
            throw new IllegalStateException("No Groq API key configured on this build.");
        }
        JSONArray messages = new JSONArray();
        messages.put(new JSONObject().put("role", "system").put("content", CHAT_SYSTEM_PROMPT));
        for (String[] turn : history) {
            messages.put(new JSONObject().put("role", turn[0]).put("content", turn[1]));
        }
        if (imageJpeg != null) {
            JSONArray content = new JSONArray();
            content.put(new JSONObject().put("type", "image_url").put("image_url", new JSONObject()
                    .put("url", "data:image/jpeg;base64," + Base64.encodeToString(imageJpeg, Base64.NO_WRAP))));
            content.put(new JSONObject().put("type", "text").put("text", text));
            messages.put(new JSONObject().put("role", "user").put("content", content));
        } else {
            messages.put(new JSONObject().put("role", "user").put("content", text));
        }

        JSONObject payload = new JSONObject().put("model", GROQ_VISION_MODEL).put("messages", messages);
        JSONObject json = postJson(GROQ_URL, payload, BuildConfig.GROQ_API_KEY);
        JSONArray choices = json.optJSONArray("choices");
        JSONObject first = choices != null && choices.length() > 0 ? choices.optJSONObject(0) : null;
        JSONObject message = first != null ? first.optJSONObject("message") : null;
        String reply = message != null ? message.optString("content", "") : "";
        if (reply.trim().isEmpty()) throw new IOException("Empty Groq response");
        return reply.trim();
    }

    // Shared POST helper for the chat calls. Throws on any non-2xx so the
    // caller can fall through to the next provider.
    private JSONObject postJson(String urlStr, JSONObject payload, String bearerToken) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json");
        if (bearerToken != null) conn.setRequestProperty("Authorization", "Bearer " + bearerToken);
        conn.setDoOutput(true);
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(30000);
        try (OutputStream os = conn.getOutputStream()) {
            os.write(payload.toString().getBytes(StandardCharsets.UTF_8));
        }
        int code = conn.getResponseCode();
        JSONObject json = new JSONObject(readStream(
                code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream()));
        if (code < 200 || code >= 300) {
            JSONObject err = json.optJSONObject("error");
            throw new IOException(err != null ? err.optString("message", "HTTP " + code) : "HTTP " + code);
        }
        return json;
    }

    // Also used for a cache hit, so both paths render identically.
    private void applyResult(String rawJson) {
        if (chatMode) {
            // A scan result landed after the user started typing — don't
            // clobber the chat reply on screen.
            mainHandler.post(() -> { if (!chatInFlight) loadingSpinner.setVisibility(View.GONE); });
            return;
        }
        String question = "", answer = "", mood = "", checkin = "", greeting = "", activity = "";
        try {
            JSONObject parsed = new JSONObject(rawJson);
            question = parsed.optString("question", "");
            answer = parsed.optString("answer", "");
            mood = parsed.optString("mood", "");
            checkin = parsed.optString("checkin", "");
            greeting = parsed.optString("greeting", "");
            activity = parsed.optString("activity", "");
        } catch (Exception e) {
            answer = rawJson;
        }

        // A caring check-in takes priority over showing the raw answer — the
        // point is for the person to notice it, not for it to get buried
        // under whatever text answer happened to come back this frame.
        // When there's no question/checkin/answer at all, fall back to the
        // activity description so the panel isn't left blank while scanning
        // a scene with nothing written in it.
        String displayAnswer = !checkin.trim().isEmpty() ? checkin
                : !answer.trim().isEmpty() ? answer
                : question.trim().isEmpty() && !activity.trim().isEmpty() ? activity
                : "";
        if (!greeting.trim().isEmpty()) displayAnswer = greeting + (displayAnswer.isEmpty() ? "" : "  " + displayAnswer);

        final String finalQuestion = question;
        final String finalAnswer = displayAnswer;
        final String finalMood = mood;
        final String finalCheckin = checkin;
        final String finalActivity = activity;
        mainHandler.post(() -> {
            loadingSpinner.setVisibility(View.GONE);
            if (!finalQuestion.trim().isEmpty()) {
                questionText.setText(finalQuestion);
            } else if (!finalMood.trim().isEmpty() || !finalActivity.trim().isEmpty()) {
                // Combine both when both are present, e.g. "Mood: cheerful · Activity: cooking".
                StringBuilder header = new StringBuilder();
                if (!finalMood.trim().isEmpty()) header.append("Mood: ").append(finalMood);
                if (!finalActivity.trim().isEmpty()) {
                    if (header.length() > 0) header.append("  ·  ");
                    header.append("Activity: ").append(finalActivity);
                }
                questionText.setText(header.toString());
            }
            if (!finalAnswer.isEmpty()) answerText.setText(finalAnswer);

            // Speak a caring check-in unprompted — but only once per
            // "episode" (same wording within the cooldown window is
            // skipped) and never while chatMode is true, i.e. never
            // interrupting an actual conversation turn. (applyResult
            // already returns early when chatMode is true, before this
            // point, so reaching here already means nothing's in flight.)
            boolean sameAsLast = finalCheckin.equalsIgnoreCase(lastSpokenCheckin);
            boolean cooldownPassed = System.currentTimeMillis() - lastCheckinSpokenAt > CHECKIN_SPEAK_COOLDOWN_MS;
            if (!finalCheckin.trim().isEmpty() && (!sameAsLast || cooldownPassed)) {
                lastSpokenCheckin = finalCheckin;
                lastCheckinSpokenAt = System.currentTimeMillis();
                speak(finalCheckin);
            }
        });
    }

    private String jsonError(String message) {
        try {
            return new JSONObject().put("question", "").put("answer", "Error: " + message).toString();
        } catch (Exception e) {
            return "{\"question\":\"\",\"answer\":\"Error\"}";
        }
    }

    private String stripJsonFences(String s) {
        String t = s.trim();
        if (t.startsWith("```")) {
            int firstNewline = t.indexOf('\n');
            if (firstNewline != -1) t = t.substring(firstNewline + 1);
            if (t.endsWith("```")) t = t.substring(0, t.length() - 3);
        }
        return t.trim();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        mainHandler.removeCallbacks(captureLoop);
        cameraExecutor.shutdown();
        voiceListeningActive = false;
        if (speechRecognizer != null) {
            speechRecognizer.destroy();
            speechRecognizer = null;
        }
        if (textToSpeech != null) {
            textToSpeech.stop();
            textToSpeech.shutdown();
        }
        AureonMicCoordinator.setSessionActive(false);
    }

    // ---------------------------------------------------------------
    // Voice conversation — talk to Aureon right here, no wake word needed
    // ---------------------------------------------------------------

    private void initTextToSpeech() {
        textToSpeech = new TextToSpeech(this, status -> ttsReady = status == TextToSpeech.SUCCESS);
        textToSpeech.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String utteranceId) {}

            @Override public void onDone(String utteranceId) {
                // Only resume listening once Aureon's own voice has fully
                // finished — otherwise the recognizer would just hear itself.
                mainHandler.post(LoveCameraActivity.this::startVoiceListening);
            }

            @Override public void onError(String utteranceId) {
                mainHandler.post(LoveCameraActivity.this::startVoiceListening);
            }
        });
    }

    private void speak(String text) {
        // Stop listening first — this can fire (e.g. an unprompted mood
        // check-in) while the recognizer happens to be mid-cycle, and
        // without this it could pick up Aureon's own voice as input.
        if (speechRecognizer != null && voiceListeningActive) {
            speechRecognizer.cancel();
            voiceListeningActive = false;
        }
        if (!ttsReady || textToSpeech == null || text == null || text.trim().isEmpty()) {
            // No TTS available — still need to resume listening ourselves
            // since there's no onDone callback coming.
            startVoiceListening();
            return;
        }
        textToSpeech.speak(text, TextToSpeech.QUEUE_FLUSH, null, "love_camera_reply");
    }

    private void startVoiceListening() {
        if (isFinishing() || isDestroyed()) return;
        if (voiceManuallyOff) return; // user muted Aureon with the mic button
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return;
        if (voiceListeningActive) return;
        if (!SpeechRecognizer.isRecognitionAvailable(this)) return;

        if (speechRecognizer == null) {
            speechRecognizer = SpeechRecognizer.createSpeechRecognizer(this);
            speechRecognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) {}
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rmsdB) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() { voiceListeningActive = false; }
                @Override public void onPartialResults(Bundle partialResults) {}
                @Override public void onEvent(int eventType, Bundle params) {}

                @Override
                public void onResults(Bundle results) {
                    voiceListeningActive = false;
                    consecutiveVoiceErrors = 0;
                    java.util.ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    String heard = matches != null && !matches.isEmpty() ? matches.get(0) : "";
                    if (!heard.trim().isEmpty()) {
                        handleVoiceInput(heard.trim());
                    } else {
                        startVoiceListening();
                    }
                }

                @Override
                public void onError(int error) {
                    voiceListeningActive = false;
                    // Silence is the normal idle state (camera just sitting
                    // there) — retry immediately, it's not a real error.
                    if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                        mainHandler.postDelayed(LoveCameraActivity.this::startVoiceListening, VOICE_RETRY_DELAY_MS);
                        return;
                    }
                    consecutiveVoiceErrors++;
                    long delay = consecutiveVoiceErrors >= SLOW_RETRY_AFTER_ERRORS ? VOICE_SLOW_RETRY_DELAY_MS : VOICE_RETRY_DELAY_MS;
                    mainHandler.postDelayed(LoveCameraActivity.this::startVoiceListening, delay);
                }
            });
        }

        android.content.Intent intent = new android.content.Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
        try {
            voiceListeningActive = true;
            speechRecognizer.startListening(intent);
        } catch (Exception e) {
            voiceListeningActive = false;
            Log.w(TAG, "Couldn't start voice listening", e);
        }
    }

    // Mic button — flips voiceManuallyOff and immediately stops/restarts
    // listening to match, rather than waiting for the next natural cycle.
    private void toggleVoiceManually() {
        voiceManuallyOff = !voiceManuallyOff;
        if (voiceManuallyOff) {
            if (textToSpeech != null) textToSpeech.stop(); // don't let a reply keep talking after muting
            if (speechRecognizer != null && voiceListeningActive) {
                speechRecognizer.cancel();
                voiceListeningActive = false;
            }
            micToggleButton.setText("\ud83d\udd07"); // muted-mic icon
        } else {
            micToggleButton.setText("\ud83c\udf99\ufe0f"); // mic icon
            startVoiceListening();
        }
    }

    private void handleVoiceInput(String heard) {
        if (chatInFlight) {
            // Busy with another turn (e.g. a keyboard message just sent) —
            // don't process this one, but don't leave listening stuck off
            // either.
            mainHandler.postDelayed(this::startVoiceListening, VOICE_RETRY_DELAY_MS);
            return;
        }
        startChatTurn(heard, true);
    }
}
