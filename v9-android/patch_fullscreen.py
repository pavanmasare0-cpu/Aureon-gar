#!/usr/bin/env python3
"""Aureon v9 Android patch (run from repo root): true full screen — status bar and navigation bar are hidden,
the app also draws into the notch area. Swipe from the top/bottom edge shows the bars for a moment.
Edits MainActivity.java. Idempotent; writes a .bak-before-v9 copy.
To turn it off again: delete the aureonFullscreen() call in onCreate (or tell Claude)."""
import os, sys
P = 'android/app/src/main/java/com/aureon/ai/MainActivity.java'
if not os.path.exists(P): sys.exit('ERROR: ' + P + ' not found — run from the repo root')
s = open(P, encoding='utf8').read()
if 'aureonFullscreen' in s: print('ok, already done: MainActivity full screen'); sys.exit(0)
orig = s
if s.count('super.onCreate(savedInstanceState);') != 1: sys.exit('ANCHOR NOT FOUND: super.onCreate(savedInstanceState); — send me MainActivity.java')
s = s.replace('super.onCreate(savedInstanceState);', 'super.onCreate(savedInstanceState);\n        aureonFullscreen(); // v9: hide status + navigation bars (immersive)', 1)
methods = '''
    // ---- v9: full screen (immersive). Swipe from an edge to peek at the system bars. ----
    private void aureonFullscreen() {
        try {
            android.view.Window w = getWindow();
            if (Build.VERSION.SDK_INT >= 28) { // also use the area around a camera notch (CSS safe-area keeps the header clear of it)
                android.view.WindowManager.LayoutParams lp = w.getAttributes();
                lp.layoutInDisplayCutoutMode = android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                w.setAttributes(lp);
            }
            androidx.core.view.WindowInsetsControllerCompat c = androidx.core.view.WindowCompat.getInsetsController(w, w.getDecorView());
            if (c != null) {
                c.setSystemBarsBehavior(androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars());
            }
        } catch (Throwable ignored) { /* never break startup over cosmetics */ }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) aureonFullscreen(); // bars come back after the keyboard / a dialog — hide them again
    }
'''
if 'onWindowFocusChanged' in orig: sys.exit('MainActivity already overrides onWindowFocusChanged — send me the file')
k = s.rstrip().rfind('}')
s = s[:k].rstrip('\n') + '\n' + methods + '}\n'
open(P + '.bak-before-v9', 'w', encoding='utf8').write(orig); open(P, 'w', encoding='utf8').write(s)
print('patched MainActivity.java: full screen')
