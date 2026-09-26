package com.aureon.ai;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.widget.Button;
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
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
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
    private static final long CAPTURE_INTERVAL_MS = 2500;
    private static final int FUZZY_MATCH_THRESHOLD = 6; // out of 64 dHash bits — "close enough to be the same view"
    private static final int MAX_CACHE_ENTRIES = 25;
    private static final int REQUEST_CAMERA_PERMISSION = 2001;
    private static final String VISION_PROMPT =
            "Look at this image and find the question written or printed in it. It may be " +
            "handwritten or typed, in Hindi, English, or any other language, and may be tilted. " +
            "Respond with ONLY a JSON object, no other text, in exactly this shape: " +
            "{\"question\": \"<the question exactly as written, in its original language>\", " +
            "\"answer\": \"<a complete answer — for a math or logic question, show the key working " +
            "steps briefly and then the final answer; for a factual question, just the direct " +
            "answer>\"}. Reply in the same language as the question. If there is no readable " +
            "question anywhere in the image, respond with exactly: {\"question\": \"\", \"answer\": \"\"}";

    private TextView questionText;
    private TextView answerText;
    private ProgressBar loadingSpinner;

    private ImageCapture imageCapture;
    private ExecutorService cameraExecutor;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<Long, String> answerCache = new LinkedHashMap<>();

    private volatile boolean requestInFlight = false;

    private final Runnable captureLoop = new Runnable() {
        @Override public void run() {
            if (!requestInFlight) {
                captureFrame();
            }
            mainHandler.postDelayed(this, CAPTURE_INTERVAL_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_love_camera);

        PreviewView previewView = findViewById(R.id.love_camera_preview);
        questionText = findViewById(R.id.love_camera_question);
        answerText = findViewById(R.id.love_camera_answer);
        loadingSpinner = findViewById(R.id.love_camera_spinner);
        Button closeButton = findViewById(R.id.love_camera_close);
        closeButton.setOnClickListener(v -> finish());

        cameraExecutor = Executors.newSingleThreadExecutor();

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED) {
            startCamera(previewView);
        } else {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.CAMERA}, REQUEST_CAMERA_PERMISSION);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_CAMERA_PERMISSION) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startCamera(findViewById(R.id.love_camera_preview));
            } else {
                answerText.setText("Camera permission is needed for Love Camera to read questions.");
                mainHandler.postDelayed(this::finish, 2000);
            }
        }
    }

    private void startCamera(PreviewView previewView) {
        ListenableFuture<ProcessCameraProvider> cameraProviderFuture = ProcessCameraProvider.getInstance(this);
        cameraProviderFuture.addListener(() -> {
            try {
                ProcessCameraProvider cameraProvider = cameraProviderFuture.get();
                bindCameraUseCases(cameraProvider, previewView);
                mainHandler.postDelayed(captureLoop, CAPTURE_INTERVAL_MS);
            } catch (ExecutionException | InterruptedException e) {
                Log.e(TAG, "Camera init failed", e);
                answerText.setText("Couldn't start the camera.");
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private void bindCameraUseCases(ProcessCameraProvider cameraProvider, PreviewView previewView) {
        Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());

        imageCapture = new ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                .build();

        cameraProvider.unbindAll();
        Camera camera = cameraProvider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, imageCapture);
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
                if (BuildConfig.GEMINI_API_KEY == null || BuildConfig.GEMINI_API_KEY.isEmpty()) {
                    throw new IllegalStateException("No Gemini API key configured on this build.");
                }
                String base64Image = Base64.encodeToString(jpegBytes, Base64.NO_WRAP);

                JSONObject imagePart = new JSONObject().put("inlineData", new JSONObject()
                        .put("mimeType", "image/jpeg")
                        .put("data", base64Image));
                JSONObject textPart = new JSONObject().put("text", VISION_PROMPT);
                JSONObject userContent = new JSONObject()
                        .put("role", "user")
                        .put("parts", new JSONArray().put(imagePart).put(textPart));

                JSONObject payload = new JSONObject();
                payload.put("contents", new JSONArray().put(userContent));

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
                BufferedReader reader = new BufferedReader(new InputStreamReader(
                        code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream(),
                        StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) sb.append(line);
                reader.close();

                JSONObject responseJson = new JSONObject(sb.toString());
                if (code < 200 || code >= 300) {
                    JSONObject errObj = responseJson.optJSONObject("error");
                    String msg = errObj != null ? errObj.optString("message", "something went wrong") : "something went wrong";
                    rawReply = jsonError(msg);
                } else {
                    JSONArray candidates = responseJson.optJSONArray("candidates");
                    JSONObject firstCandidate = candidates != null && candidates.length() > 0 ? candidates.optJSONObject(0) : null;
                    JSONObject content = firstCandidate != null ? firstCandidate.optJSONObject("content") : null;
                    JSONArray parts = content != null ? content.optJSONArray("parts") : null;
                    StringBuilder textOut = new StringBuilder();
                    if (parts != null) {
                        for (int i = 0; i < parts.length(); i++) {
                            textOut.append(parts.optJSONObject(i).optString("text", ""));
                        }
                    }
                    rawReply = textOut.length() > 0 ? stripJsonFences(textOut.toString()) : jsonError("(no answer)");
                }
            } catch (Exception e) {
                Log.e(TAG, "Direct Gemini vision request failed", e);
                rawReply = jsonError("Couldn't reach Gemini.");
            }

            requestInFlight = false;

            String question = "";
            String answer = "";
            try {
                JSONObject parsed = new JSONObject(rawReply);
                question = parsed.optString("question", "");
                answer = parsed.optString("answer", "");
            } catch (Exception ignore) {
                // Model didn't return valid JSON — fall back to showing raw text as the answer.
                answer = rawReply;
            }

            if (question.trim().isEmpty() && !answer.startsWith("Error") && !answer.startsWith("Couldn't")) {
                // Nothing readable in this frame — leave whatever answer is already on screen.
                mainHandler.post(() -> loadingSpinner.setVisibility(View.GONE));
                return;
            }

            cacheAnswer(hash, rawReply);
            applyResult(rawReply);
        }).start();
    }

    // Also used for a cache hit, so both paths render identically.
    private void applyResult(String rawJson) {
        String question;
        String answer;
        try {
            JSONObject parsed = new JSONObject(rawJson);
            question = parsed.optString("question", "");
            answer = parsed.optString("answer", "");
        } catch (Exception e) {
            question = "";
            answer = rawJson;
        }
        final String finalQuestion = question;
        final String finalAnswer = answer;
        mainHandler.post(() -> {
            loadingSpinner.setVisibility(View.GONE);
            if (!finalQuestion.trim().isEmpty()) questionText.setText(finalQuestion);
            answerText.setText(finalAnswer);
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
    }
}
