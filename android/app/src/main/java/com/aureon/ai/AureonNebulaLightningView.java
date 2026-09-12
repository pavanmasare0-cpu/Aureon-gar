package com.aureon.ai;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.util.AttributeSet;
import android.view.View;
import android.view.animation.LinearInterpolator;

import java.util.Random;

/**
 * Full-screen animated backdrop for the Aureon listening overlay: the static
 * cosmic/nebula image (drawn as a cover-cropped bitmap, same idea as
 * ImageView's centerCrop) with a handful of crackling electric "lightning"
 * tendrils drawn on top, in the same blue/violet/gold palette as the orb
 * video itself, so the whole screen feels like one living energy field
 * instead of a static photo behind an animated circle.
 *
 * Deliberately does NOT touch the orb's own video/TextureView — this view
 * only owns the background layer, sitting behind the orb in the layout.
 *
 * Performance note: glow is faked with a few overlapping strokes of
 * decreasing width / increasing opacity (same trick as
 * AureonEnergyOrbView), not BlurMaskFilter — cheaper and more consistent
 * across devices/API levels since it avoids forcing a software layer.
 */
public class AureonNebulaLightningView extends View {

    private static final int BOLT_COUNT = 5;
    private static final int SEGMENTS_PER_BOLT = 9;
    // How often (in phase-cycles) each bolt gets a freshly re-randomized path.
    private static final float REGEN_PERIOD = 1f;

    private static final int[] BOLT_COLORS = {
            Color.parseColor("#8FD8FF"), // pale cyan-blue
            Color.parseColor("#B79CFF"), // violet
            Color.parseColor("#FFE9A8"), // warm gold (matches orb ring)
            Color.parseColor("#8FD8FF"),
            Color.parseColor("#B79CFF"),
    };

    private Bitmap nebulaBitmap;
    private final Rect srcRect = new Rect();
    private final Rect dstRect = new Rect();

    private ValueAnimator animator;
    private float phase = 0f; // 0..1, loops forever; drives both flicker and regen timing

    private final Random rnd = new Random();
    private final Path[] boltPaths = new Path[BOLT_COUNT];
    private final float[] boltSeedX = new float[BOLT_COUNT];
    private final float[] boltSeedY = new float[BOLT_COUNT];
    private final float[] boltPhaseOffset = new float[BOLT_COUNT];

    private final Paint boltPaintCore = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint boltPaintGlowInner = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint boltPaintGlowOuter = new Paint(Paint.ANTI_ALIAS_FLAG);

    public AureonNebulaLightningView(Context context) {
        super(context);
        init();
    }

    public AureonNebulaLightningView(Context context, AttributeSet attrs) {
        super(context, attrs);
        init();
    }

    private void init() {
        nebulaBitmap = BitmapFactory.decodeResource(getResources(), R.drawable.aureon_cosmic_bg);

        boltPaintCore.setStyle(Paint.Style.STROKE);
        boltPaintCore.setStrokeWidth(2.5f);
        boltPaintCore.setStrokeCap(Paint.Cap.ROUND);
        boltPaintCore.setStrokeJoin(Paint.Join.ROUND);

        boltPaintGlowInner.setStyle(Paint.Style.STROKE);
        boltPaintGlowInner.setStrokeWidth(7f);
        boltPaintGlowInner.setStrokeCap(Paint.Cap.ROUND);
        boltPaintGlowInner.setStrokeJoin(Paint.Join.ROUND);

        boltPaintGlowOuter.setStyle(Paint.Style.STROKE);
        boltPaintGlowOuter.setStrokeWidth(14f);
        boltPaintGlowOuter.setStrokeCap(Paint.Cap.ROUND);
        boltPaintGlowOuter.setStrokeJoin(Paint.Join.ROUND);

        for (int i = 0; i < BOLT_COUNT; i++) {
            boltPaths[i] = new Path();
            boltPhaseOffset[i] = rnd.nextFloat();
            randomizeBoltSeed(i);
        }

        animator = ValueAnimator.ofFloat(0f, 1f);
        animator.setDuration(4000);
        animator.setRepeatCount(ValueAnimator.INFINITE);
        animator.setInterpolator(new LinearInterpolator());
        animator.addUpdateListener(a -> {
            phase = (float) a.getAnimatedValue();
            invalidate();
        });
    }

    /** Picks a new random starting point (roughly mid-lower screen, near where
     *  the orb sits) and a new random drift direction for one bolt — called
     *  whenever that bolt's regen window comes around, so tendrils keep
     *  reshaping instead of looking frozen. */
    private void randomizeBoltSeed(int index) {
        boltSeedX[index] = 0.3f + rnd.nextFloat() * 0.4f; // fraction of width, center-ish
        boltSeedY[index] = 0.45f + rnd.nextFloat() * 0.15f; // fraction of height, near orb
    }

    private void buildBoltPath(Path path, int index, int w, int h, float localPhase) {
        path.reset();
        float startX = boltSeedX[index] * w;
        float startY = boltSeedY[index] * h;

        // Overall direction this bolt reaches toward — outward/upward into
        // the starfield, matching the reference look of tendrils rising
        // out of the orb.
        float angle = (float) (Math.PI * 1.5 + (index - BOLT_COUNT / 2f) * 0.35 + Math.sin(localPhase * Math.PI * 2) * 0.15);
        float reach = Math.min(w, h) * (0.5f + 0.25f * (float) Math.sin(localPhase * Math.PI * 2 + index));

        float x = startX;
        float y = startY;
        path.moveTo(x, y);

        for (int s = 1; s <= SEGMENTS_PER_BOLT; s++) {
            float t = s / (float) SEGMENTS_PER_BOLT;
            float targetX = startX + (float) Math.cos(angle) * reach * t;
            float targetY = startY + (float) Math.sin(angle) * reach * t;
            // jitter perpendicular to the main direction for a jagged, electric look
            float jitter = (rnd.nextFloat() - 0.5f) * 40f * (1f - t * 0.5f);
            float perpX = (float) -Math.sin(angle) * jitter;
            float perpY = (float) Math.cos(angle) * jitter;
            x = targetX + perpX;
            y = targetY + perpY;
            path.lineTo(x, y);
        }
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        int w = getWidth();
        int h = getHeight();
        if (w == 0 || h == 0) return;

        // ---- background: cover-crop the nebula bitmap, same math as centerCrop ----
        if (nebulaBitmap != null) {
            float scale = Math.max(w / (float) nebulaBitmap.getWidth(), h / (float) nebulaBitmap.getHeight());
            int drawW = Math.round(nebulaBitmap.getWidth() * scale);
            int drawH = Math.round(nebulaBitmap.getHeight() * scale);
            int left = (w - drawW) / 2;
            int top = (h - drawH) / 2;
            srcRect.set(0, 0, nebulaBitmap.getWidth(), nebulaBitmap.getHeight());
            dstRect.set(left, top, left + drawW, top + drawH);
            canvas.drawBitmap(nebulaBitmap, srcRect, dstRect, null);
        }

        // ---- animated lightning tendrils on top ----
        for (int i = 0; i < BOLT_COUNT; i++) {
            float localPhase = (phase + boltPhaseOffset[i]) % 1f;

            // Re-seed this bolt's start point once per loop (when its local
            // phase wraps past ~0), so it doesn't retrace the exact same
            // shape forever.
            if (localPhase < 0.02f) {
                randomizeBoltSeed(i);
            }

            buildBoltPath(boltPaths[i], i, w, h, localPhase);

            // Flicker: brightness pulses per-bolt so they don't all pulse in unison.
            float flicker = 0.5f + 0.5f * (float) Math.sin(localPhase * Math.PI * 2 * 3 + i);
            int alphaCore = (int) (180 + 60 * flicker);
            int alphaGlowInner = (int) (70 + 40 * flicker);
            int alphaGlowOuter = (int) (30 + 20 * flicker);

            int color = BOLT_COLORS[i % BOLT_COLORS.length];

            boltPaintGlowOuter.setColor(color);
            boltPaintGlowOuter.setAlpha(Math.max(0, Math.min(255, alphaGlowOuter)));
            canvas.drawPath(boltPaths[i], boltPaintGlowOuter);

            boltPaintGlowInner.setColor(color);
            boltPaintGlowInner.setAlpha(Math.max(0, Math.min(255, alphaGlowInner)));
            canvas.drawPath(boltPaths[i], boltPaintGlowInner);

            boltPaintCore.setColor(Color.WHITE);
            boltPaintCore.setAlpha(Math.max(0, Math.min(255, alphaCore)));
            canvas.drawPath(boltPaths[i], boltPaintCore);
        }
    }

    /** Call from the hosting session when the overlay is shown. */
    public void startAnimating() {
        if (animator != null && !animator.isStarted()) animator.start();
    }

    /** Call from the hosting session when the overlay is hidden/destroyed —
     *  stops the animation loop and frees the bitmap so it isn't held for
     *  the lifetime of the whole voice-interaction service. */
    public void stopAnimating() {
        if (animator != null) animator.cancel();
        if (nebulaBitmap != null && !nebulaBitmap.isRecycled()) {
            nebulaBitmap.recycle();
            nebulaBitmap = null;
        }
    }
}
