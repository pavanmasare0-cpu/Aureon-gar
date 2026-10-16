package com.aureon.ai;

import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

/**
 * Transparent "Ava only" screen, opened when the floating Ava orb (drawn over
 * other apps) is tapped. It hosts the same web app, but www/ava-bot.js detects
 * it (AureonActions.avaPanelMode) and shows ONLY Ava's chat panel on a see-through
 * background — so Aureon itself never opens in front of the app you were using.
 * Tapping outside the panel (or the X / back) closes it and returns you there.
 */
public class AvaPanelActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Same native plugins as MainActivity (chat tools, speech, phone actions).
        registerPlugin(AureonSpeechPlugin.class);
        registerPlugin(AureonActionsPlugin.class);
        super.onCreate(savedInstanceState);

        getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        makeWebViewTransparent();
    }

    @Override
    public void onResume() {
        super.onResume();
        makeWebViewTransparent();
    }

    private void makeWebViewTransparent() {
        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                View wv = getBridge().getWebView();
                wv.setBackgroundColor(Color.TRANSPARENT);
            }
        } catch (Exception ignored) { }
    }

    @Override
    public void onBackPressed() {
        finish();
        overridePendingTransition(0, 0);
    }
}
