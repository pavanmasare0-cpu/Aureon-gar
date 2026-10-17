package com.aureon.ai;

import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Base64;
import android.util.DisplayMetrics;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Ava's "eyes": while this service runs (and ONLY then) the screen is captured with
 * MediaProjection, downscaled, and a JPEG is POSTed to the Aureon backend
 * (/api/ava/screen/frame) whenever the picture has changed. The backend turns it
 * into a short text summary and throws the image away.
 *
 * Privacy rules built in:
 *  - starts only after the user accepts Android's own "start recording?" dialog;
 *  - a persistent notification with a Stop button is always visible while running;
 *  - nothing is sent while the screen is off or the lock screen is showing;
 *  - FLAG_SECURE windows (banking apps, password managers, incognito tabs) come out
 *    black from MediaProjection — fully black frames are never sent;
 *  - the device key can only POST frames; it cannot read anything.
 */
public class AvaScreenWatchService extends Service {

    private static final String ACTION_STOP = "com.aureon.ai.AVA_SCREEN_STOP";
    private static final String CHANNEL_ID = "ava_screen_watch";
    private static final int NOTIFICATION_ID = 7312;
    private static final int MAX_SIDE = 720;
    private static volatile boolean active = false;

    public static boolean isActive() { return active; }

    public static void start(Context c, int resultCode, Intent data, String backendUrl, String key, int intervalMs) {
        Intent i = new Intent(c, AvaScreenWatchService.class);
        i.putExtra("code", resultCode);
        i.putExtra("data", data);
        i.putExtra("url", backendUrl);
        i.putExtra("key", key);
        i.putExtra("interval", intervalMs);
        ContextCompat.startForegroundService(c, i);
    }

    public static void stop(Context c) {
        c.stopService(new Intent(c, AvaScreenWatchService.class));
    }

    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private HandlerThread thread;
    private Handler handler;
    private final ExecutorService uploader = Executors.newSingleThreadExecutor();
    private volatile boolean uploading = false;
    private volatile boolean screenOn = true;
    private String endpoint, key;
    private long intervalMs = 6000;
    private long lastSentAt = 0;
    private int[] prevThumb;

    // ---- video mode ----
    // While the screen keeps moving (a video), take 4 frames ~2s apart and send them as ONE
    // 2x2 contact sheet, so the AI can follow what happens over time (and costs 1 call, not 4).
    private final java.util.ArrayList<Bitmap> burst = new java.util.ArrayList<>();
    private long lastBurstAt = 0;
    private boolean videoLike = false;
    private int[] lastGrabThumb;
    private int calmGrabs = 0;
    private static final int VIDEO_DIFF = 14;          // average brightness change that counts as "video / lots of motion"
    private static final long BURST_GAP_MS = 1800;
    private static final int BURST_FRAMES = 4;
    private int outW, outH;
    private BroadcastReceiver screenReceiver;
    private boolean running = false;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (running) return START_NOT_STICKY;

        // Android 14: startForeground (type mediaProjection) must come BEFORE getMediaProjection.
        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }

        try {
            String base = intent.getStringExtra("url");
            key = intent.getStringExtra("key");
            intervalMs = Math.max(4000, intent.getIntExtra("interval", 6000));
            int code = intent.getIntExtra("code", 0);
            Intent data = intent.getParcelableExtra("data");
            if (base == null || key == null || data == null) throw new IllegalStateException("missing start data");
            endpoint = base.replaceAll("/+$", "") + "/api/ava/screen/frame";

            MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            projection = mpm.getMediaProjection(code, data);
            if (projection == null) throw new IllegalStateException("projection denied");

            thread = new HandlerThread("AvaScreenWatch");
            thread.start();
            handler = new Handler(thread.getLooper());
            // Required on Android 14+ before createVirtualDisplay; also fires if the user stops sharing from the system UI.
            projection.registerCallback(new MediaProjection.Callback() {
                @Override public void onStop() { stopSelf(); }
            }, handler);

            DisplayMetrics dm = getResources().getDisplayMetrics();
            float scale = Math.min(1f, (float) MAX_SIDE / Math.max(dm.widthPixels, dm.heightPixels));
            outW = Math.max(2, Math.round(dm.widthPixels * scale) & ~1);
            outH = Math.max(2, Math.round(dm.heightPixels * scale) & ~1);
            reader = ImageReader.newInstance(outW, outH, PixelFormat.RGBA_8888, 2);
            display = projection.createVirtualDisplay("AvaScreen", outW, outH, dm.densityDpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, handler);

            screenReceiver = new BroadcastReceiver() {
                @Override public void onReceive(Context ctx, Intent i) { screenOn = !Intent.ACTION_SCREEN_OFF.equals(i.getAction()); }
            };
            IntentFilter f = new IntentFilter(Intent.ACTION_SCREEN_OFF);
            f.addAction(Intent.ACTION_SCREEN_ON);
            registerReceiver(screenReceiver, f);

            running = true;
            active = true;
            handler.postDelayed(this::tick, intervalMs);
        } catch (Exception e) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private void tick() {
        if (!running) return;
        try { grabAndMaybeSend(); } catch (Throwable ignored) { /* never crash the service over one frame */ }
        if (running && handler != null) handler.postDelayed(this::tick, 1500);
    }

    private void grabAndMaybeSend() {
        if (!screenOn || uploading) return;
        KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        if (km != null && km.isKeyguardLocked()) return; // never look at the lock screen
        long now = System.currentTimeMillis();
        boolean due = now - lastSentAt >= intervalMs;
        boolean burstTime = videoLike && now - lastBurstAt >= BURST_GAP_MS;
        if (!due && !burstTime) return;

        Image img = reader.acquireLatestImage();
        if (img == null) return;
        Bitmap frame;
        try {
            Image.Plane p = img.getPlanes()[0];
            ByteBuffer buf = p.getBuffer();
            int pixelStride = p.getPixelStride();
            int rowPadding = p.getRowStride() - pixelStride * outW;
            Bitmap padded = Bitmap.createBitmap(outW + rowPadding / pixelStride, outH, Bitmap.Config.ARGB_8888);
            padded.copyPixelsFromBuffer(buf);
            frame = Bitmap.createBitmap(padded, 0, 0, outW, outH);
            if (frame != padded) padded.recycle();
        } finally {
            img.close();
        }

        // 16x16 brightness thumbnail: skip black frames (FLAG_SECURE) and unchanged screens.
        Bitmap t = Bitmap.createScaledBitmap(frame, 16, 16, true);
        int[] cur = new int[256];
        long sum = 0;
        for (int y = 0; y < 16; y++) {
            for (int x = 0; x < 16; x++) {
                int c = t.getPixel(x, y);
                int l = (((c >> 16) & 0xff) + ((c >> 8) & 0xff) + (c & 0xff)) / 3;
                cur[y * 16 + x] = l;
                sum += l;
            }
        }
        t.recycle();
        if (sum / 256 < 4) { frame.recycle(); return; }

        // How much did the screen change since the previous grab? Big and steady = a video.
        long mdiff = 0;
        if (lastGrabThumb != null) {
            for (int i = 0; i < 256; i++) mdiff += Math.abs(cur[i] - lastGrabThumb[i]);
            mdiff /= 256;
        }
        lastGrabThumb = cur;
        if (mdiff >= VIDEO_DIFF) { videoLike = true; calmGrabs = 0; }
        else if (videoLike && ++calmGrabs >= 2) { videoLike = false; calmGrabs = 0; }
        if (videoLike) {
            if (!burst.isEmpty() && now - lastBurstAt > 12000) clearBurst(); // stale tiles from an earlier clip
            burst.add(frame); // the frame becomes a tile (not recycled here)
            lastBurstAt = now;
            if (burst.size() >= BURST_FRAMES) sendSheet();
            return;
        }
        if (!burst.isEmpty()) { if (burst.size() >= 2) sendSheet(); else clearBurst(); }
        if (!due) { frame.recycle(); return; }
        if (prevThumb != null) {
            long diff = 0;
            for (int i = 0; i < 256; i++) diff += Math.abs(cur[i] - prevThumb[i]);
            if (diff / 256 < 3) { frame.recycle(); return; }
        }
        prevThumb = cur;

        ByteArrayOutputStream out = new ByteArrayOutputStream(96 * 1024);
        frame.compress(Bitmap.CompressFormat.JPEG, 55, out);
        frame.recycle();
        final String b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        lastSentAt = now;
        uploading = true;
        uploader.execute(() -> {
            try { post(b64); } finally { uploading = false; }
        });
    }

    private void clearBurst() {
        for (Bitmap b : burst) b.recycle();
        burst.clear();
    }

    /** Joins the collected tiles into one 2-column contact sheet (time order: left to right, top to bottom) and uploads it. */
    private void sendSheet() {
        final int n = burst.size();
        if (n == 0) return;
        int cols = 2, rows = (n + 1) / 2;
        Bitmap first = burst.get(0);
        int tw = first.getWidth(), th = first.getHeight();
        Bitmap sheet = Bitmap.createBitmap(tw * cols, th * rows, Bitmap.Config.ARGB_8888);
        android.graphics.Canvas cv = new android.graphics.Canvas(sheet);
        cv.drawColor(android.graphics.Color.BLACK);
        android.graphics.Paint pn = new android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG);
        for (int i = 0; i < n; i++) {
            Bitmap b = burst.get(i);
            cv.drawBitmap(b, (i % cols) * tw, (i / cols) * th, pn);
            b.recycle();
        }
        burst.clear();
        ByteArrayOutputStream out = new ByteArrayOutputStream(160 * 1024);
        sheet.compress(Bitmap.CompressFormat.JPEG, 50, out);
        sheet.recycle();
        final String b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        lastSentAt = System.currentTimeMillis();
        uploading = true;
        uploader.execute(() -> {
            try { post(b64, n); } finally { uploading = false; }
        });
    }

    private void post(String b64) { post(b64, 1); }

    private void post(String b64, int frames) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(endpoint).openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(10000);
            c.setReadTimeout(30000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("x-ava-device", key);
            byte[] body = ("{\"image\":\"" + b64 + "\",\"w\":" + outW + ",\"h\":" + outH + ",\"frames\":" + frames + "}").getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = c.getOutputStream()) { os.write(body); }
            int code = c.getResponseCode();
            if (code == 401 || code == 403) stopSelf(); // key revoked / feature switched off on the server
            if (code >= 200 && code < 300) {
                // The server tells how Ava "feels" about the screen: angry / sad / shy.
                java.util.regex.Matcher mm = java.util.regex.Pattern
                        .compile("\"mood\"\\s*:\\s*\"(angry|sad|shy)\"").matcher(readSmall(c));
                if (mm.find()) AvaOverlayService.showMood(mm.group(1));
            }
        } catch (Exception ignored) {
            // offline or server asleep: the next changed frame will try again
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String readSmall(HttpURLConnection c) {
        try (java.io.InputStream is = c.getInputStream()) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[1024];
            int n, total = 0;
            while (total < 4096 && (n = is.read(buf)) > 0) { bo.write(buf, 0, n); total += n; }
            return bo.toString("UTF-8");
        } catch (Exception e) {
            return "";
        }
    }

    private Notification buildNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Ava screen dekh rahi hai", NotificationManager.IMPORTANCE_LOW));
        }
        Intent stop = new Intent(this, AvaScreenWatchService.class).setAction(ACTION_STOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, piFlags);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentTitle("👁 Ava screen dekh rahi hai")
                .setContentText("Sirf text-summary yaad rakhti hai, photo nahi. Band karne ke liye dabao.")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Band karo", stopPi)
                .setContentIntent(stopPi)
                .build();
    }

    @Override
    public void onDestroy() {
        running = false;
        active = false;
        try { if (screenReceiver != null) unregisterReceiver(screenReceiver); } catch (Exception ignored) { }
        try { if (display != null) display.release(); } catch (Exception ignored) { }
        try { if (reader != null) reader.close(); } catch (Exception ignored) { }
        try { if (projection != null) projection.stop(); } catch (Exception ignored) { }
        if (thread != null) thread.quitSafely();
        uploader.shutdown();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) { return null; }
}
