package com.aureon.ai;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.util.AttributeSet;
import android.view.View;
import android.view.animation.LinearInterpolator;

import java.util.Random;

/**
 * The animated orb shown on Aureon's voice overlay — a clean glowing sphere
 * (matching the user's reference image): a purple/magenta glowing core
 * inside a thin gold ring, with a few gold sparkles drifting around it and
 * a soft reflection underneath. No background box — fully transparent
 * outside the circle itself, so it sits directly on the overlay's dark
 * background with no square edge visible.
 */
public class AureonEnergyOrbView extends View {

    private static final int CORE_PURPLE = Color.parseColor("#C13CFF");
    private static final int CORE_PINK = Color.parseColor("#FF3CAE");
    private static final int RING_GOLD = Color.parseColor("#FFD54A");
    private static final int SPARKLE_GOLD = Color.parseColor("#FFE9A8");

    private static final int NUM_SPARKLES = 22;
    private static final int NUM_CRACKS = 10;

    private float rotation = 0f; // 0-360, drives the slow motion
    private ValueAnimator animator;

    private final Paint ringPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint corePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint crackPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint sparklePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint reflectionPaint = new Paint(Paint.ANTI_ALIAS_FLAG);

    private final float[] sparkleAngle = new float[NUM_SPARKLES];
    private final float[] sparkleRadiusFrac = new float[NUM_SPARKLES];
    private final float[] sparkleSpeed = new float[NUM_SPARKLES];
    private final float[] sparkleSize = new float[NUM_SPARKLES];

    private final float[] crackAngle = new float[NUM_CRACKS];
    private final float[] crackLenFrac = new float[NUM_CRACKS];

    public AureonEnergyOrbView(Context context) {
        super(context);
        init();
    }

    public AureonEnergyOrbView(Context context, AttributeSet attrs) {
        super(context, attrs);
        init();
    }

    private void init() {
        setBackgroundColor(Color.TRANSPARENT);

        ringPaint.setStyle(Paint.Style.STROKE);
        ringPaint.setStrokeWidth(4f);
        ringPaint.setColor(RING_GOLD);

        crackPaint.setStyle(Paint.Style.STROKE);
        crackPaint.setStrokeWidth(1.5f);
        crackPaint.setColor(Color.WHITE);
        crackPaint.setAlpha(110);

        sparklePaint.setStyle(Paint.Style.FILL);
        sparklePaint.setColor(SPARKLE_GOLD);

        reflectionPaint.setStyle(Paint.Style.FILL);

        Random rnd = new Random(11); // fixed seed — stable layout across recompositions
        for (int i = 0; i < NUM_SPARKLES; i++) {
            sparkleAngle[i] = rnd.nextFloat() * 360f;
            sparkleRadiusFrac[i] = 1.05f + rnd.nextFloat() * 0.4f; // just outside the ring
            sparkleSpeed[i] = 0.2f + rnd.nextFloat() * 0.6f;
            sparkleSize[i] = 1.5f + rnd.nextFloat() * 2f;
        }
        for (int i = 0; i < NUM_CRACKS; i++) {
            crackAngle[i] = rnd.nextFloat() * 360f;
            crackLenFrac[i] = 0.35f + rnd.nextFloat() * 0.45f;
        }
    }

    public void startAnimating() {
        if (animator != null) return;
        animator = ValueAnimator.ofFloat(0f, 360f);
        animator.setDuration(9000);
        animator.setRepeatCount(ValueAnimator.INFINITE);
        animator.setInterpolator(new LinearInterpolator());
        animator.addUpdateListener(anim -> {
            rotation = (float) anim.getAnimatedValue();
            invalidate();
        });
        animator.start();
    }

    public void stopAnimating() {
        if (animator != null) {
            animator.cancel();
            animator = null;
        }
    }

    @Override
    protected void onDetachedFromWindow() {
        super.onDetachedFromWindow();
        stopAnimating();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);

        float cx = getWidth() / 2f;
        float cy = getHeight() / 2f * 0.9f; // leave room below for the reflection
        float orbRadius = Math.min(getWidth(), getHeight()) / 2f * 0.62f;
        if (orbRadius <= 0) return;

        double t = rotation / 360.0;

        // 1) Soft reflection ellipse underneath
        float reflY = cy + orbRadius * 1.35f;
        reflectionPaint.setShader(new RadialGradient(
                cx, reflY, orbRadius * 0.9f,
                new int[]{withAlpha(CORE_PURPLE, 90), Color.TRANSPARENT},
                new float[]{0f, 1f},
                Shader.TileMode.CLAMP));
        canvas.save();
        canvas.scale(1f, 0.25f, cx, reflY);
        canvas.drawCircle(cx, reflY, orbRadius * 0.9f, reflectionPaint);
        canvas.restore();

        // 2) Purple/pink glowing core, filling the circle
        float corePulse = (float) (0.92 + 0.08 * Math.sin(t * Math.PI * 2 * 2));
        corePaint.setShader(new RadialGradient(
                cx, cy, orbRadius * corePulse,
                new int[]{Color.WHITE, CORE_PINK, CORE_PURPLE, withAlpha(CORE_PURPLE, 0)},
                new float[]{0f, 0.35f, 0.8f, 1f},
                Shader.TileMode.CLAMP));
        canvas.drawCircle(cx, cy, orbRadius * corePulse, corePaint);

        // 3) Faint crackle texture lines inside, slowly rotating
        canvas.save();
        canvas.rotate(rotation * 0.5f, cx, cy);
        for (int i = 0; i < NUM_CRACKS; i++) {
            double angle = Math.toRadians(crackAngle[i]);
            float len = orbRadius * crackLenFrac[i];
            float x1 = cx + (float) (Math.cos(angle) * len * 0.15);
            float y1 = cy + (float) (Math.sin(angle) * len * 0.15);
            float x2 = cx + (float) (Math.cos(angle) * len);
            float y2 = cy + (float) (Math.sin(angle) * len);
            canvas.drawLine(x1, y1, x2, y2, crackPaint);
        }
        canvas.restore();

        // 4) Thin gold ring outline
        canvas.drawCircle(cx, cy, orbRadius, ringPaint);

        // 5) Gold sparkle dust drifting just outside the ring
        for (int i = 0; i < NUM_SPARKLES; i++) {
            double angle = Math.toRadians(sparkleAngle[i] + rotation * sparkleSpeed[i]);
            float r = orbRadius * sparkleRadiusFrac[i];
            float x = cx + (float) (Math.cos(angle) * r);
            float y = cy + (float) (Math.sin(angle) * r);
            float twinkle = (float) (0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 3 + i));
            sparklePaint.setAlpha((int) (200 * twinkle) + 30);
            canvas.drawCircle(x, y, sparkleSize[i], sparklePaint);
        }
    }

    private static int withAlpha(int color, int alpha) {
        return Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color));
    }
}
