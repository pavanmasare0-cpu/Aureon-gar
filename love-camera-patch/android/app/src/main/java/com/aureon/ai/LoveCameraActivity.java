package com.aureon.ai;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.pm.PackageManager;
import android.media.Image;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * "Love Camera" — a live camera mode that reads whatever question is
 * currently visible (paper, a screen, a book) and shows Aureon's answer in
 * an overlay panel in real time, updating automatically whenever the
 * visible question changes.
 *
 * Text detection (ML Kit) runs fully on-device — offline, free, fast — so
 * every camera frame is filtered locally first. Only once the same text has
 * been read for a few consecutive frames (STABLE_FRAMES_NEEDED), and it's a
 * genuinely new question, does anything go to the network. A per-question
 * cache means flipping back to a question already answered this session
 * shows the cached answer instantly with no extra backend call.
 *
 * Launched like any other tool action — see
 * AureonAgentActions.openLoveCamera() — not part of the accessibility/
 * screen-typing action set, since this only reads the camera and never
 * touches another app's UI.
 */
public class LoveCameraActivity extends AppCompatActivity {

    private static final String TAG = "LoveCamera";
    private static final String BACKEND_URL = "https://aureone.onrender.com/api/chat";
    private static final int STABLE_FRAMES_NEEDED = 3;
    private static final int REQUEST_CAMERA_PERMISSION = 2001;
    private static final String QUICK_ANSWER_SYSTEM_PROMPT =
            "You are answering a single question that was just read off a live camera feed " +
            "(off a book, screen, or piece of paper). Reply with ONLY the direct answer — as " +
            "short as possible (ideally a word, a number, or one short sentence). No " +
            "explanation, no restating the question, no greeting, no extra commentary.";

    private TextView questionText;
    private TextView answerText;
    private ProgressBar loadingSpinner;

    private ExecutorService cameraExecutor;
    private TextRecognizer textRecognizer;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<String, String> answerCache = new HashMap<>();

    private String pendingQuestion = "";
    private int pendingStableCount = 0;
    private String lastAnsweredQuestion = "";
    private boolean requestInFlight = false;

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
        textRecognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);

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
            } catch (ExecutionException | InterruptedException e) {
                Log.e(TAG, "Camera init failed", e);
                answerText.setText("Couldn't start the camera.");
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private void bindCameraUseCases(ProcessCameraProvider cameraProvider, PreviewView previewView) {
        Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());

        ImageAnalysis imageAnalysis = new ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build();
        imageAnalysis.setAnalyzer(cameraExecutor, this::analyzeFrame);

        cameraProvider.unbindAll();
        Camera camera = cameraProvider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, imageAnalysis);
    }

    @SuppressLint("UnsafeOptInUsageError")
    private void analyzeFrame(ImageProxy imageProxy) {
        Image mediaImage = imageProxy.getImage();
        if (mediaImage == null) { imageProxy.close(); return; }

        InputImage image = InputImage.fromMediaImage(mediaImage, imageProxy.getImageInfo().getRotationDegrees());
        textRecognizer.process(image)
                .addOnSuccessListener(this::onTextDetected)
                .addOnFailureListener(e -> Log.w(TAG, "Text recognition failed", e))
                .addOnCompleteListener(task -> imageProxy.close());
    }

    // Debounce: only treat text as "the question" once the same reading has
    // held steady for a few frames in a row (handles motion blur / a frame
    // caught mid-scroll). Then only fetch an answer if it's a question we
    // haven't already answered — flipping back to a prior one hits the cache.
    private void onTextDetected(Text visionText) {
        String detected = visionText.getText().trim();
        if (detected.length() < 4) return; // near-empty read; ignore, keep last good answer on screen

        if (detected.equalsIgnoreCase(pendingQuestion)) {
            pendingStableCount++;
        } else {
            pendingQuestion = detected;
            pendingStableCount = 1;
        }

        if (pendingStableCount == STABLE_FRAMES_NEEDED
                && !pendingQuestion.equalsIgnoreCase(lastAnsweredQuestion)
                && !requestInFlight) {
            lastAnsweredQuestion = pendingQuestion;
            final String question = pendingQuestion;
            mainHandler.post(() -> questionText.setText(question));

            String cached = answerCache.get(question.toLowerCase());
            if (cached != null) {
                mainHandler.post(() -> answerText.setText(cached));
            } else {
                fetchAnswer(question);
            }
        }
    }

    private void fetchAnswer(String question) {
        requestInFlight = true;
        mainHandler.post(() -> {
            loadingSpinner.setVisibility(View.VISIBLE);
            answerText.setText("…");
        });

        new Thread(() -> {
            String answer;
            try {
                JSONObject userMsg = new JSONObject();
                userMsg.put("role", "user");
                userMsg.put("content", question);
                JSONArray messages = new JSONArray().put(userMsg);

                JSONObject payload = new JSONObject();
                payload.put("messages", messages);
                payload.put("systemPrompt", QUICK_ANSWER_SYSTEM_PROMPT);

                URL url = new URL(BACKEND_URL);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(45000);
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
                answer = (code >= 200 && code < 300)
                        ? responseJson.optString("reply", "(no answer)")
                        : "Error: " + responseJson.optString("error", "something went wrong");
            } catch (Exception e) {
                Log.e(TAG, "Backend request failed", e);
                answer = "Couldn't reach Aureon's backend.";
            }

            final String finalAnswer = answer;
            answerCache.put(question.toLowerCase(), finalAnswer);
            mainHandler.post(() -> {
                loadingSpinner.setVisibility(View.GONE);
                // Only display it if this is still the question on screen —
                // stops a slow reply from overwriting a newer answer.
                if (question.equalsIgnoreCase(lastAnsweredQuestion)) {
                    answerText.setText(finalAnswer);
                }
                requestInFlight = false;
            });
        }).start();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        cameraExecutor.shutdown();
        textRecognizer.close();
    }
}
