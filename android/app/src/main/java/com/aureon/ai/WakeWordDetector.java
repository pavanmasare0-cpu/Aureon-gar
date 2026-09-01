package com.aureon.ai;

import android.content.Context;
import android.content.res.AssetManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Log;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;
import ai.onnxruntime.NodeInfo;
import ai.onnxruntime.TensorInfo;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.Map;

/**
 * Runs the standard 3-stage wake-word pipeline used by openWakeWord (and by
 * ViolaWake, which is built on the same embedding backbone):
 *
 *   raw mic audio -> melspectrogram.onnx -> mel frames
 *   mel frames (sliding window)  -> embedding_model.onnx -> 96-dim embedding
 *   embeddings (sliding window)  -> <wake_word>.onnx      -> detection score
 *
 * Drop the three .onnx files into assets/wakeword/ (see REQUIRED_ASSETS)
 * and call start(). onWakeWordDetected() fires on a background thread
 * whenever the score crosses the threshold.
 *
 * NOTE: input/output shapes are read from each model at load time rather
 * than hardcoded, since exact dims can vary slightly between exports. The
 * FALLBACK_* constants only apply if a model reports a dynamic (-1) dim.
 */
public class WakeWordDetector {

    public interface Listener {
        void onWakeWordDetected(float score);
        void onError(String message);
    }

    private static final String TAG = "WakeWordDetector";

    private static final String ASSET_DIR = "wakeword";
    private static final String MELSPEC_MODEL = ASSET_DIR + "/melspectrogram.onnx";
    private static final String EMBEDDING_MODEL = ASSET_DIR + "/embedding_model.onnx";
    private static final String WAKEWORD_MODEL = ASSET_DIR + "/aureon.onnx";

    private static final int SAMPLE_RATE = 16000;
    private static final int CHUNK_SAMPLES = 1280; // 80ms @ 16kHz — one melspectrogram step

    // Used only when a model reports a dynamic dimension for that axis.
    private static final int FALLBACK_MEL_BINS = 32;
    private static final int FALLBACK_EMBED_WINDOW_FRAMES = 76;
    private static final int FALLBACK_EMBED_DIM = 96;
    private static final int FALLBACK_WAKEWORD_WINDOW = 16;

    private static final float DETECTION_THRESHOLD = 0.5f;
    private static final long COOLDOWN_MS = 3000;

    private final Context context;
    private final Listener listener;

    private OrtEnvironment ortEnv;
    private OrtSession melspecSession;
    private OrtSession embeddingSession;
    private OrtSession wakewordSession;

    private String melspecInputName, melspecOutputName;
    private String embeddingInputName, embeddingOutputName;
    private String wakewordInputName, wakewordOutputName;

    private int melBins = FALLBACK_MEL_BINS;
    private int embedWindowFrames = FALLBACK_EMBED_WINDOW_FRAMES;
    private int embedDim = FALLBACK_EMBED_DIM;
    private int wakewordWindow = FALLBACK_WAKEWORD_WINDOW;

    private final ArrayDeque<float[]> melFrameBuffer = new ArrayDeque<>();   // each: melBins floats
    private final ArrayDeque<float[]> embeddingBuffer = new ArrayDeque<>(); // each: embedDim floats

    private AudioRecord audioRecord;
    private Thread captureThread;
    private volatile boolean running = false;
    private long lastTriggerAt = 0;

    public WakeWordDetector(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    /** Loads the three ONNX models from assets. Call once before start(). Returns false on failure. */
    public boolean init() {
        try {
            ortEnv = OrtEnvironment.getEnvironment();

            melspecSession = ortEnv.createSession(readAsset(MELSPEC_MODEL), new OrtSession.SessionOptions());
            embeddingSession = ortEnv.createSession(readAsset(EMBEDDING_MODEL), new OrtSession.SessionOptions());
            wakewordSession = ortEnv.createSession(readAsset(WAKEWORD_MODEL), new OrtSession.SessionOptions());

            melspecInputName = firstInputName(melspecSession);
            melspecOutputName = firstOutputName(melspecSession);
            embeddingInputName = firstInputName(embeddingSession);
            embeddingOutputName = firstOutputName(embeddingSession);
            wakewordInputName = firstInputName(wakewordSession);
            wakewordOutputName = firstOutputName(wakewordSession);

            // Pull real dims where the model declares them (non-dynamic).
            long[] embedInShape = shapeOf(embeddingSession, embeddingInputName, true);
            if (embedInShape != null && embedInShape.length == 4) {
                // Expected layout: [1, window_frames, mel_bins, 1]
                if (embedInShape[1] > 0) embedWindowFrames = (int) embedInShape[1];
                if (embedInShape[2] > 0) melBins = (int) embedInShape[2];
            }
            long[] embedOutShape = shapeOf(embeddingSession, embeddingOutputName, false);
            if (embedOutShape != null) {
                long last = embedOutShape[embedOutShape.length - 1];
                if (last > 0) embedDim = (int) last;
            }
            long[] wakeInShape = shapeOf(wakewordSession, wakewordInputName, true);
            if (wakeInShape != null && wakeInShape.length == 3 && wakeInShape[1] > 0) {
                // Expected layout: [1, window, embed_dim]
                wakewordWindow = (int) wakeInShape[1];
            }

            Log.d(TAG, "Loaded wake-word models. melBins=" + melBins
                    + " embedWindowFrames=" + embedWindowFrames
                    + " embedDim=" + embedDim
                    + " wakewordWindow=" + wakewordWindow);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Failed to load wake-word models from assets/" + ASSET_DIR, e);
            if (listener != null) {
                listener.onError("Couldn't load wake-word models: " + e.getMessage());
            }
            return false;
        }
    }

    public synchronized void start() {
        if (running) return;
        if (melspecSession == null) {
            if (!init()) return;
        }

        int minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        int bufSize = Math.max(minBuf, CHUNK_SAMPLES * 4);

        audioRecord = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufSize);

        if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "AudioRecord failed to initialize.");
            if (listener != null) listener.onError("Mic init failed (check RECORD_AUDIO permission).");
            return;
        }

        running = true;
        audioRecord.startRecording();

        captureThread = new Thread(this::captureLoop, "WakeWordCapture");
        captureThread.start();
    }

    public synchronized void stop() {
        running = false;
        if (captureThread != null) {
            try { captureThread.join(500); } catch (InterruptedException ignored) {}
            captureThread = null;
        }
        if (audioRecord != null) {
            try {
                audioRecord.stop();
                audioRecord.release();
            } catch (Exception ignored) {}
            audioRecord = null;
        }
        melFrameBuffer.clear();
        embeddingBuffer.clear();
    }

    public void release() {
        stop();
        if (melspecSession != null) closeQuietly(melspecSession);
        if (embeddingSession != null) closeQuietly(embeddingSession);
        if (wakewordSession != null) closeQuietly(wakewordSession);
        melspecSession = embeddingSession = wakewordSession = null;
    }

    // ---------------- capture + inference loop ----------------

    private void captureLoop() {
        short[] pcmChunk = new short[CHUNK_SAMPLES];
        while (running) {
            int read = audioRecord.read(pcmChunk, 0, CHUNK_SAMPLES);
            if (read <= 0) continue;

            try {
                float[][] newMelFrames = runMelspectrogram(pcmChunk, read);
                for (float[] frame : newMelFrames) {
                    pushCapped(melFrameBuffer, frame, embedWindowFrames * 3);
                }

                while (melFrameBuffer.size() >= embedWindowFrames) {
                    float[] embedding = runEmbedding(latestFrames(melFrameBuffer, embedWindowFrames));
                    pushCapped(embeddingBuffer, embedding, wakewordWindow * 3);

                    if (embeddingBuffer.size() >= wakewordWindow) {
                        float score = runWakeword(latestFrames(embeddingBuffer, wakewordWindow));
                        maybeTrigger(score);
                    }
                    // Only need to run the embedding step once per new mel frame batch,
                    // so drop the oldest frame and re-check instead of tight-looping.
                    melFrameBuffer.pollFirst();
                }
            } catch (Exception e) {
                Log.e(TAG, "Inference step failed", e);
            }
        }
    }

    private void maybeTrigger(float score) {
        if (score < DETECTION_THRESHOLD) return;
        long now = System.currentTimeMillis();
        if (now - lastTriggerAt < COOLDOWN_MS) return;
        lastTriggerAt = now;
        Log.d(TAG, "Wake word detected, score=" + score);
        if (listener != null) listener.onWakeWordDetected(score);
    }

    // ---------------- ONNX calls ----------------

    private float[][] runMelspectrogram(short[] pcm, int len) throws Exception {
        float[] samples = new float[len];
        for (int i = 0; i < len; i++) samples[i] = pcm[i] / 32768.0f;

        try (OnnxTensor input = OnnxTensor.createTensor(ortEnv, FloatBuffer.wrap(samples), new long[]{1, len});
             OrtSession.Result result = melspecSession.run(Collections.singletonMap(melspecInputName, input))) {

            float[][][][] raw = tryCast4D(result.get(0).getValue());
            if (raw != null) {
                int frames = raw[0].length;
                float[][] out = new float[frames][];
                for (int f = 0; f < frames; f++) {
                    float[] bins = raw[0][f][0];
                    // openWakeWord scales raw melspectrogram output before the embedding
                    // model consumes it. Adjust/remove this if your export already does it.
                    float[] scaled = new float[bins.length];
                    for (int b = 0; b < bins.length; b++) scaled[b] = bins[b] / 10f + 2f;
                    out[f] = scaled;
                }
                return out;
            }
            Log.w(TAG, "Unexpected melspectrogram output shape — check model export.");
            return new float[0][];
        }
    }

    private float[] runEmbedding(float[][] frames) throws Exception {
        int window = frames.length;
        float[] flat = new float[window * melBins];
        for (int f = 0; f < window; f++) {
            System.arraycopy(frames[f], 0, flat, f * melBins, melBins);
        }
        try (OnnxTensor input = OnnxTensor.createTensor(ortEnv, FloatBuffer.wrap(flat),
                new long[]{1, window, melBins, 1});
             OrtSession.Result result = embeddingSession.run(Collections.singletonMap(embeddingInputName, input))) {
            return flattenToVector(result.get(0).getValue(), embedDim);
        }
    }

    private float runWakeword(float[][] embeddings) throws Exception {
        int window = embeddings.length;
        float[] flat = new float[window * embedDim];
        for (int i = 0; i < window; i++) {
            System.arraycopy(embeddings[i], 0, flat, i * embedDim, embedDim);
        }
        try (OnnxTensor input = OnnxTensor.createTensor(ortEnv, FloatBuffer.wrap(flat),
                new long[]{1, window, embedDim});
             OrtSession.Result result = wakewordSession.run(Collections.singletonMap(wakewordInputName, input))) {
            float[] out = flattenToVector(result.get(0).getValue(), 1);
            return out.length > 0 ? out[0] : 0f;
        }
    }

    // ---------------- helpers ----------------

    private byte[] readAsset(String path) throws IOException {
        AssetManager am = context.getAssets();
        try (InputStream is = am.open(path)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
            return bos.toByteArray();
        }
    }

    private static void pushCapped(ArrayDeque<float[]> deque, float[] item, int cap) {
        deque.addLast(item);
        while (deque.size() > cap) deque.pollFirst();
    }

    private static float[][] latestFrames(ArrayDeque<float[]> deque, int count) {
        float[][] out = new float[count][];
        int i = 0;
        int skip = deque.size() - count;
        for (float[] frame : deque) {
            if (skip > 0) { skip--; continue; }
            out[i++] = frame;
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static float[][][][] tryCast4D(Object value) {
        try {
            return (float[][][][]) value;
        } catch (ClassCastException e) {
            return null;
        }
    }

    /** Flattens whatever nested float[] shape ONNX Runtime handed back into a 1D vector. */
    private static float[] flattenToVector(Object value, int expectedLen) {
        java.util.List<Float> out = new java.util.ArrayList<>();
        flattenInto(value, out);
        float[] arr = new float[out.size()];
        for (int i = 0; i < arr.length; i++) arr[i] = out.get(i);
        return arr;
    }

    private static void flattenInto(Object value, java.util.List<Float> out) {
        if (value instanceof float[]) {
            for (float f : (float[]) value) out.add(f);
        } else if (value instanceof Object[]) {
            for (Object o : (Object[]) value) flattenInto(o, out);
        }
    }

    private static String firstInputName(OrtSession session) throws Exception {
        return session.getInputNames().iterator().next();
    }

    private static String firstOutputName(OrtSession session) throws Exception {
        return session.getOutputNames().iterator().next();
    }

    private static long[] shapeOf(OrtSession session, String name, boolean input) throws Exception {
        Map<String, NodeInfo> info = input ? session.getInputInfo() : session.getOutputInfo();
        NodeInfo node = info.get(name);
        if (node != null && node.getInfo() instanceof TensorInfo) {
            return ((TensorInfo) node.getInfo()).getShape();
        }
        return null;
    }

    private static void closeQuietly(OrtSession s) {
        try { s.close(); } catch (Exception ignored) {}
    }
}
