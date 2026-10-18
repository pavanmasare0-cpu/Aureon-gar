package com.aureon.ai;

import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

/**
 * Transparent "Ava only" screen, opened when the floating Ava orb (drawn over
 * other apps) is tapped. It hosts the same web app, but www/ava-bot.js detects
 * it and shows ONLY Ava's chat panel on a see-through background - so Aureon
 * itself never opens in front of the app you were using, and that app stays
 * visible behind Ava.
 *
 * Why this class is a bit special: Capacitor's BridgeActivity.onCreate() calls
 * setTheme(AppTheme.NoActionBar) which REPLACES our translucent theme and makes the
 * window opaque (you saw black/white/Aureon behind Ava). So we (1) keep our own theme
 * in setTheme(), (2) ask for a translucent window format, and (3) re-apply a
 * transparent WebView background (Capacitor config also sets #FFFFFF).
 *
 * The window stays invisible (alpha 0) until Ava's page reports "ready"
 * (AureonActions.avaPanelReady) so the Aureon UI never flashes for a moment.
 */
public class AvaPanelActivity extends BridgeActivity {

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean ready = false;

    @Override
    public void setTheme(int resid) {
        int ours = 0;
        try { ours = getResources().getIdentifier("AppTheme_AvaPanel", "style", getPackageName()); } catch (Exception ignored) { }
        super.setTheme(ours != 0 ? ours : resid);
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Translucent window surface (alpha is honoured) + transparent window background.
        getWindow().setFormat(PixelFormat.TRANSLUCENT);
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));

        // Same native plugins as MainActivity (chat tools, speech, phone actions).
        registerPlugin(AureonSpeechPlugin.class);
        registerPlugin(AureonActionsPlugin.class);
        super.onCreate(savedInstanceState);

        getWindow().setFormat(PixelFormat.TRANSLUCENT);
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        makeWebViewTransparent();
        setWebViewAlpha(0f); // hidden until Ava's panel is ready

        // Tell the page "you are the Ava-only screen" and keep the WebView see-through
        // (repeated: the page may still be loading and Capacitor may re-apply its colour).
        final Runnable flag = new Runnable() {
            @Override public void run() {
                makeWebViewTransparent();
                try {
                    if (getBridge() != null) getBridge().eval("window.__AVA_PANEL=true;", null);
                } catch (Exception ignored) { }
            }
        };
        int[] delays = {300, 800, 1500, 2500, 4000, 6000};
        for (int dl : delays) handler.postDelayed(flag, dl);

        // Failsafe: never leave the user with an invisible window.
        handler.postDelayed(new Runnable() {
            @Override public void run() { markReady(); }
        }, 7000);
    }

    /** Called (via the plugin) when the page has switched to Ava-only mode. */
    public void markReady() {
        if (ready) return;
        ready = true;
        makeWebViewTransparent();
        setWebViewAlpha(1f);
    }

    private void setWebViewAlpha(float a) {
        try {
            if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().setAlpha(a);
        } catch (Exception ignored) { }
    }

    @Override
    public void onResume() {
        super.onResume();
        makeWebViewTransparent();
    }

    private void makeWebViewTransparent() {
        try {
            getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            if (getBridge() != null && getBridge().getWebView() != null) {
                View wv = getBridge().getWebView();
                wv.setBackgroundColor(Color.TRANSPARENT);
            }
        } catch (Exception ignored) { }
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        finish();
        overridePendingTransition(0, 0);
    }
}
