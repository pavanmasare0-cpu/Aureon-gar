package com.aureon.ai;

import android.app.Activity;
import android.app.Application;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.BlurMaskFilter;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.SweepGradient;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;

import androidx.core.content.ContextCompat;

/**
 * Ava on the phone screen: a small glowing flying bot drawn over every other
 * app (Android "Display over other apps" permission). She roams the screen by
 * herself exactly like the in-app Ava; tap her to start a voice conversation
 * (opens Aureon's assistant session when Aureon is the Default Assistant,
 * otherwise opens the app), drag her to move her.
 *
 * She hides automatically while an Aureon screen is open, because the in-app
 * Ava is already there.
 *
 * Toggle: Settings -> General -> "Ava phone screen par" in the app.
 */
public class AvaOverlayService extends Service {

    private static final String PREFS = "ava_prefs";
    private static final String KEY_ENABLED = "overlay_enabled";
    private static final String CHANNEL_ID = "ava_overlay";
    private static final int NOTIFICATION_ID = 4822;
    private static final float WIN_DP = 96f;

    // ---------- static helpers (used by the plugin / MainActivity) ----------
    public static boolean isEnabled(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, false);
    }

    public static void setEnabled(Context c, boolean on) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ENABLED, on).apply();
    }

    public static boolean canDraw(Context c) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(c);
    }

    public static void start(Context c) {
        ContextCompat.startForegroundService(c, new Intent(c, AvaOverlayService.class));
    }

    public static void stop(Context c) {
        c.stopService(new Intent(c, AvaOverlayService.class));
    }

    public static void startIfEnabled(Context c) {
        try {
            if (isEnabled(c) && canDraw(c)) start(c);
        } catch (Exception ignored) {
            // best effort
        }
    }

    // ---------- instance state ----------
    private final Handler handler = new Handler(Looper.getMainLooper());
    private WindowManager wm;
    private OrbView orb;
    private WindowManager.LayoutParams lp;
    private float density;
    private int screenW, screenH, win;

    private float x, y, vx, vy, tx, ty, wait = 1.5f;
    private boolean dragging = false;
    private int aureonActivitiesStarted = 0;
    private long lastTick = 0;
    private Application.ActivityLifecycleCallbacks lifecycle;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (orb == null) return;
            long now = System.nanoTime();
            float dt = lastTick == 0 ? 0.033f : Math.min(0.05f, (now - lastTick) / 1e9f);
            lastTick = now;

            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            boolean screenOn = pm == null || pm.isInteractive();
            boolean hidden = aureonActivitiesStarted > 0 || !screenOn;
            if (hidden) {
                if (orb.getVisibility() != View.GONE) orb.setVisibility(View.GONE);
                handler.postDelayed(this, 500);
                return;
            }
            if (orb.getVisibility() != View.VISIBLE) orb.setVisibility(View.VISIBLE);

            if (!dragging) {
                if (wait > 0) {
                    wait -= dt;
                } else if (Math.hypot(tx - x, ty - y) < dp(16)) {
                    wait = 1.2f + (float) Math.random() * 2.4f;
                    pickTarget();
                }
                float k = 2.0f, c = 2.3f;
                vx += ((tx - x) * k - vx * c) * dt;
                vy += ((ty - y) * k - vy * c) * dt;
                float sp = (float) Math.hypot(vx, vy), cap = 230f * density;
                if (sp > cap) { vx *= cap / sp; vy *= cap / sp; }
                x += vx * dt;
                y += vy * dt;
            }
            x = clamp(x, 0, screenW - win);
            y = clamp(y, 0, screenH - win);
            lp.x = (int) x;
            lp.y = (int) y;
            try {
                if (orb.isAttachedToWindow()) wm.updateViewLayout(orb, lp);
            } catch (Exception ignored) { }
            orb.step(dt, dragging ? 0 : vx / density, dragging ? 0 : vy / density);
            handler.postDelayed(this, 33);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        density = getResources().getDisplayMetrics().density;
        screenW = getResources().getDisplayMetrics().widthPixels;
        screenH = getResources().getDisplayMetrics().heightPixels;
        win = (int) (WIN_DP * density);

        lifecycle = new Application.ActivityLifecycleCallbacks() {
            @Override public void onActivityCreated(Activity a, Bundle b) { }
            @Override public void onActivityStarted(Activity a) { aureonActivitiesStarted++; }
            @Override public void onActivityResumed(Activity a) { }
            @Override public void onActivityPaused(Activity a) { }
            @Override public void onActivityStopped(Activity a) { if (aureonActivitiesStarted > 0) aureonActivitiesStarted--; }
            @Override public void onActivitySaveInstanceState(Activity a, Bundle b) { }
            @Override public void onActivityDestroyed(Activity a) { }
        };
        getApplication().registerActivityLifecycleCallbacks(lifecycle);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, buildNotification());
        if (!canDraw(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (orb == null) addOrb();
        return START_STICKY;
    }

    private void addOrb() {
        orb = new OrbView(this, density);
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        lp = new WindowManager.LayoutParams(
                win, win, type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        x = screenW - win - dp(6);
        y = screenH * 0.4f;
        lp.x = (int) x;
        lp.y = (int) y;
        pickTarget();

        final int slop = ViewConfiguration.get(this).getScaledTouchSlop();
        orb.setOnTouchListener(new View.OnTouchListener() {
            float downX, downY, startX, startY;
            boolean moved;

            @Override
            public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = e.getRawX(); downY = e.getRawY();
                        startX = x; startY = y;
                        moved = false;
                        orb.setPressedState(true);
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx = e.getRawX() - downX, dy = e.getRawY() - downY;
                        if (!moved && Math.hypot(dx, dy) > slop * 1.5f) {
                            moved = true;
                            dragging = true;
                            vx = vy = 0;
                        }
                        if (moved) {
                            x = startX + dx;
                            y = startY + dy;
                        }
                        return true;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        orb.setPressedState(false);
                        if (moved) {
                            dragging = false;
                            tx = x; ty = y;
                            wait = 4f;
                        } else if (e.getActionMasked() == MotionEvent.ACTION_UP) {
                            onTapped();
                        }
                        return true;
                    default:
                        return true;
                }
            }
        });

        try {
            wm.addView(orb, lp);
        } catch (Exception ex) {
            orb = null;
            stopSelf();
            return;
        }
        lastTick = 0;
        handler.post(tick);
    }

    private void onTapped() {
        orb.hop();
        // Best experience: Aureon is the Default Assistant -> its voice session
        // opens right over whatever app is on screen (listens, answers aloud,
        // runs phone actions). Otherwise just open the app.
        if (!AureonVoiceInteractionService.showFromOverlay()) {
            try {
                Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName());
                if (i != null) {
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                }
            } catch (Exception ignored) { }
        }
    }

    private void pickTarget() {
        float m = dp(4);
        float rx = (float) Math.random(), ry = (float) Math.random();
        tx = m + rx * Math.max(10, screenW - win - 2 * m);
        ty = m + ry * Math.max(10, screenH - win - 2 * m);
        if (Math.hypot(tx - x, ty - y) < dp(140)) {
            tx = screenW - win - m - rx * dp(60);
            ty = screenH * (0.15f + 0.6f * ry);
        }
    }

    private float dp(float v) { return v * density; }

    private static float clamp(float v, float a, float b) { return Math.max(a, Math.min(b, v)); }

    private Notification buildNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID, "Ava on screen", NotificationManager.IMPORTANCE_MIN);
                channel.setDescription("Keeps Ava floating over other apps.");
                channel.setShowBadge(false);
                nm.createNotificationChannel(channel);
            }
        }
        Notification.Builder builder = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return builder
                .setContentTitle("Ava")
                .setContentText("Ava screen par ghoom rahi hai — band karne ke liye Aureon Settings")
                .setSmallIcon(android.R.drawable.ic_menu_info_details)
                .setOngoing(true)
                .setPriority(Notification.PRIORITY_MIN)
                .build();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (lifecycle != null) {
            try { getApplication().unregisterActivityLifecycleCallbacks(lifecycle); } catch (Exception ignored) { }
        }
        if (orb != null) {
            try { wm.removeView(orb); } catch (Exception ignored) { }
            orb = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // =====================================================================
    // The orb itself — drawn with Canvas, same look as the in-app Ava.
    // =====================================================================
    private static class OrbView extends View {
        private final float d;
        private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint glowP = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF rect = new RectF();
        private final Path star = new Path();

        private float time = 0f, vxDp = 0f, hopT = -1f, blinkT = 0f;
        private boolean pressed = false;
        private float cx, cy, r;
        private Shader glowShader, sphereShader, ringShader;

        OrbView(Context ctx, float density) {
            super(ctx);
            d = density;
            setLayerType(LAYER_TYPE_SOFTWARE, null); // needed for BlurMaskFilter glows
        }

        void setPressedState(boolean v) { pressed = v; invalidate(); }

        void hop() { hopT = 0f; }

        void step(float dt, float vxDpPerSec, float vyDpPerSec) {
            time += dt;
            vxDp = vxDpPerSec;
            blinkT += dt;
            if (blinkT > 5f) blinkT = 0f;
            if (hopT >= 0f) {
                hopT += dt / 0.6f;
                if (hopT > 1f) hopT = -1f;
            }
            invalidate();
        }

        @Override
        protected void onSizeChanged(int w, int h, int ow, int oh) {
            cx = w / 2f;
            cy = h / 2f;
            r = w * 0.29f;
            glowShader = new RadialGradient(cx, cy, r * 2.05f,
                    new int[]{0xBF7DF3FF, 0x7322D3EE, 0x528B5CF6, 0x2EFF3CAC, 0x00000000},
                    new float[]{0f, 0.3f, 0.55f, 0.7f, 1f}, Shader.TileMode.CLAMP);
            sphereShader = new RadialGradient(cx, cy + r * 0.05f, r,
                    new int[]{0x99194CAA, 0x802D8CF5, 0xF5AAF0FF, 0xFFFFFFFF, 0xF2AA82FF, 0xD9FF50B4},
                    new float[]{0f, 0.5f, 0.72f, 0.78f, 0.9f, 1f}, Shader.TileMode.CLAMP);
            ringShader = new SweepGradient(cx, cy,
                    new int[]{0xFF22D3EE, 0xFF8B5CF6, 0xFFFF3CAC, 0xFF22D3EE}, null);
        }

        @Override
        protected void onDraw(Canvas c) {
            if (glowShader == null) return;
            float bob = (float) Math.sin(time * 2 * Math.PI / 3.2) * 3f * d;
            float tilt = Math.max(-16f, Math.min(16f, vxDp * 0.06f));
            float scale = pressed ? 0.9f : 1f;
            if (hopT >= 0f) scale *= 1f + 0.18f * (float) Math.sin(Math.PI * hopT);

            // soft glow
            float pulse = 0.85f + 0.15f * (float) Math.sin(time * 2 * Math.PI / 2.6);
            p.reset(); p.setAntiAlias(true);
            p.setShader(glowShader);
            p.setAlpha((int) (255 * pulse));
            c.drawCircle(cx, cy + bob, r * 2.05f, p);
            p.setShader(null);

            c.save();
            c.translate(0, bob);
            c.rotate(tilt, cx, cy);
            c.scale(scale, scale, cx, cy);

            drawHalo(c);
            drawSphere(c);
            drawEars(c);
            drawVisor(c);
            drawSparkles(c);
            c.restore();
        }

        private void glow(Paint paint, int color, float blurDp) {
            paint.setColor(color);
            paint.setMaskFilter(new BlurMaskFilter(Math.max(1f, blurDp * d), BlurMaskFilter.Blur.NORMAL));
        }

        private void drawHalo(Canvas c) {
            // antenna
            p.reset(); p.setAntiAlias(true);
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(1.6f * d);
            p.setShader(new LinearGradient(cx, cy - r * 1.45f, cx, cy - r, 0xFFFF8BE0, 0xFF7DF3FF, Shader.TileMode.CLAMP));
            c.drawLine(cx, cy - r * 1.42f, cx, cy - r * 0.98f, p);
            p.setShader(null);
            // bulb
            p.reset(); p.setAntiAlias(true);
            glow(p, 0xFFFF3CAC, 4);
            c.drawCircle(cx, cy - r * 1.46f, r * 0.14f, p);
            p.reset(); p.setAntiAlias(true);
            p.setColor(0xFFFFB3EC);
            c.drawCircle(cx, cy - r * 1.46f, r * 0.1f, p);
            // halo ring
            rect.set(cx - r * 0.86f, cy - r * 1.28f, cx + r * 0.86f, cy - r * 0.92f);
            p.reset(); p.setAntiAlias(true); p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(2.4f * d);
            glow(p, 0xCC22D3EE, 3);
            c.drawOval(rect, p);
            p.reset(); p.setAntiAlias(true); p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(1.6f * d);
            p.setColor(0xF2AEF9FF);
            c.drawOval(rect, p);
        }

        private void drawSphere(Canvas c) {
            // outer neon glow
            glowP.reset(); glowP.setAntiAlias(true);
            glowP.setStyle(Paint.Style.STROKE);
            glowP.setStrokeWidth(4f * d);
            glow(glowP, 0xCC22D3EE, 6);
            c.drawCircle(cx, cy, r, glowP);
            glowP.setStrokeWidth(3f * d);
            glow(glowP, 0x99FF3CAC, 8);
            c.drawCircle(cx, cy + 2f * d, r, glowP);

            p.reset(); p.setAntiAlias(true);
            p.setShader(sphereShader);
            c.drawCircle(cx, cy, r, p);
            p.setShader(null);

            // rotating gradient ring
            c.save();
            c.rotate(time * 72f, cx, cy);
            p.reset(); p.setAntiAlias(true);
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(2.2f * d);
            p.setShader(ringShader);
            c.drawCircle(cx, cy, r * 1.02f, p);
            p.setShader(null);
            c.restore();

            // gloss
            c.save();
            c.rotate(-24f, cx - r * 0.35f, cy - r * 0.7f);
            rect.set(cx - r * 0.78f, cy - r * 0.95f, cx + r * 0.1f, cy - r * 0.48f);
            p.reset(); p.setAntiAlias(true);
            p.setShader(new LinearGradient(0, rect.top, 0, rect.bottom, 0xCCFFFFFF, 0x00FFFFFF, Shader.TileMode.CLAMP));
            c.drawOval(rect, p);
            p.setShader(null);
            c.restore();
        }

        private void drawEars(Canvas c) {
            float ew = r * 0.46f, eh = r * 0.9f, ey = cy + r * 0.13f;
            for (int side = -1; side <= 1; side += 2) {
                float ex = cx + side * r * 1.02f;
                rect.set(ex - ew / 2f, ey - eh / 2f, ex + ew / 2f, ey + eh / 2f);
                float rad = ew * 0.55f;
                // pink-violet glow
                p.reset(); p.setAntiAlias(true); p.setStyle(Paint.Style.FILL);
                glow(p, 0xBFFF3CAC, 5);
                c.drawRoundRect(rect, rad, rad, p);
                // dark body
                p.reset(); p.setAntiAlias(true);
                p.setShader(new LinearGradient(0, rect.top, 0, rect.bottom, 0xFF1B0F4A, 0xFF0A0524, Shader.TileMode.CLAMP));
                c.drawRoundRect(rect, rad, rad, p);
                p.setShader(null);
                // glowing slit
                p.reset(); p.setAntiAlias(true);
                p.setColor(0xF2FF96E1);
                c.drawRoundRect(ex - ew * 0.08f, rect.top + eh * 0.14f, ex + ew * 0.08f, rect.bottom - eh * 0.14f, ew * 0.08f, ew * 0.08f, p);
                // inner cyan ring
                RectF in = new RectF(rect.left + ew * 0.17f, rect.top + eh * 0.1f, rect.right - ew * 0.17f, rect.bottom - eh * 0.1f);
                p.reset(); p.setAntiAlias(true); p.setStyle(Paint.Style.STROKE);
                p.setStrokeWidth(1f * d);
                p.setColor(0x8CAEF9FF);
                c.drawRoundRect(in, rad * 0.7f, rad * 0.7f, p);
                // metallic rim
                p.reset(); p.setAntiAlias(true); p.setStyle(Paint.Style.STROKE);
                p.setStrokeWidth(1.5f * d);
                p.setShader(new LinearGradient(0, rect.top, 0, rect.bottom, 0xFFE8FDFF, 0xFFFF5CC0, Shader.TileMode.CLAMP));
                c.drawRoundRect(rect, rad, rad, p);
                p.setShader(null);
                // light dot
                p.reset(); p.setAntiAlias(true);
                p.setColor(Color.WHITE);
                c.drawCircle(ex, rect.top + eh * 0.12f, 1.3f * d, p);
            }
        }

        private void drawVisor(Canvas c) {
            rect.set(cx - r * 0.8f, cy - r * 0.52f, cx + r * 0.8f, cy + r * 0.52f);
            p.reset(); p.setAntiAlias(true);
            p.setShader(new RadialGradient(cx, cy - r * 0.25f, r * 0.9f, 0xFF0E2D6B, 0xFF050F2C, Shader.TileMode.CLAMP));
            c.drawOval(rect, p);
            p.setShader(null);
            p.reset(); p.setAntiAlias(true); p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(2f * d);
            glow(p, 0xCC22D3EE, 3);
            c.drawOval(rect, p);
            p.reset(); p.setAntiAlias(true); p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(1.3f * d);
            p.setColor(0xF222D3EE);
            c.drawOval(rect, p);

            // eyes (look where she is flying; blink every ~5s)
            float lookX = Math.max(-1f, Math.min(1f, vxDp / 90f)) * r * 0.07f;
            float blink = (blinkT > 4.8f && blinkT < 4.92f) ? 0.1f : 1f;
            float eyeW = r * 0.24f, eyeH = r * 0.4f * blink, eyeCy = cy - r * 0.06f;
            for (int side = -1; side <= 1; side += 2) {
                float ex = cx + side * r * 0.28f + lookX;
                rect.set(ex - eyeW / 2f, eyeCy - eyeH / 2f, ex + eyeW / 2f, eyeCy + eyeH / 2f);
                p.reset(); p.setAntiAlias(true); p.setStyle(Paint.Style.FILL);
                glow(p, 0xFF22D3EE, 4);
                c.drawOval(rect, p);
                p.reset(); p.setAntiAlias(true);
                p.setColor(0xFFAEF9FF);
                c.drawOval(rect, p);
                if (blink == 1f) {
                    p.setColor(Color.WHITE);
                    c.drawCircle(ex - eyeW * 0.15f, eyeCy - eyeH * 0.25f, eyeW * 0.14f, p);
                }
            }
            // smile
            rect.set(cx - r * 0.2f + lookX, cy + r * 0.02f, cx + r * 0.2f + lookX, cy + r * 0.36f);
            p.reset(); p.setAntiAlias(true); p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(2f * d);
            p.setStrokeCap(Paint.Cap.ROUND);
            p.setColor(0xFFAEF9FF);
            c.drawArc(rect, 25f, 130f, false, p);
        }

        private void drawSparkles(Canvas c) {
            float a1 = 0.5f + 0.5f * (float) Math.sin(time * 2 * Math.PI / 3.6);
            float a2 = 0.5f + 0.5f * (float) Math.sin(time * 2 * Math.PI / 3.6 + 2.1);
            star(c, cx - r * 1.55f, cy - r * 0.6f, r * 0.16f * (0.4f + a1), a1);
            star(c, cx + r * 1.6f, cy + r * 0.5f, r * 0.2f * (0.4f + a2), a2);
        }

        private void star(Canvas c, float sx, float sy, float s, float alpha) {
            star.reset();
            star.moveTo(sx, sy - s);
            star.quadTo(sx, sy, sx + s, sy);
            star.quadTo(sx, sy, sx, sy + s);
            star.quadTo(sx, sy, sx - s, sy);
            star.quadTo(sx, sy, sx, sy - s);
            p.reset(); p.setAntiAlias(true);
            p.setColor(0xFFE6FDFF);
            p.setAlpha((int) (255 * alpha));
            c.drawPath(star, p);
        }
    }
}
