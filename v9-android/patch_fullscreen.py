#!/usr/bin/env python3
"""Aureon v9 Android patch (run from repo root): true full screen - status/navigation bars hidden, app draws
edge-to-edge (also behind the camera notch, so there is no black strip at the top). Swipe from an edge shows the bars.
Edits MainActivity.java. Idempotent (also upgrades an already-patched file). Backup: .bak-before-v9 (next to the .java, NOT in res/)."""
import os, sys
P = 'android/app/src/main/java/com/aureon/ai/MainActivity.java'
if not os.path.exists(P): sys.exit('ERROR: ' + P + ' not found - run from the repo root')
s = open(P, encoding='utf8').read(); orig = s; did = []

if 'aureonFullscreen' not in s:
    if s.count('super.onCreate(savedInstanceState);') != 1: sys.exit('ANCHOR NOT FOUND: super.onCreate(savedInstanceState); - send me MainActivity.java')
    s = s.replace('super.onCreate(savedInstanceState);', 'super.onCreate(savedInstanceState);\n        aureonFullscreen(); // v9: hide status + navigation bars (immersive)', 1)
    methods = '''
    // ---- v9: full screen (immersive, edge-to-edge). Swipe from an edge to peek at the system bars. ----
    private void aureonFullscreen() {
        try {
            android.view.Window w = getWindow();
            androidx.core.view.WindowCompat.setDecorFitsSystemWindows(w, false); // draw behind bars + notch (no black strip)
            w.setStatusBarColor(android.graphics.Color.TRANSPARENT);
            w.setNavigationBarColor(android.graphics.Color.TRANSPARENT);
            if (Build.VERSION.SDK_INT >= 28) {
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
        if (hasFocus) aureonFullscreen(); // bars come back after the keyboard / a dialog - hide them again
    }
'''
    if 'onWindowFocusChanged' in orig: sys.exit('MainActivity already overrides onWindowFocusChanged - send me the file')
    k = s.rstrip().rfind('}'); s = s[:k].rstrip('\n') + '\n' + methods + '}\n'; did.append('full screen')
elif 'setDecorFitsSystemWindows' not in s:   # already patched by the first v9: add the edge-to-edge part
    a = 'android.view.Window w = getWindow();\n'
    i = s.find(a, s.find('private void aureonFullscreen'))
    if i < 0: sys.exit('ANCHOR NOT FOUND inside aureonFullscreen() - send me MainActivity.java')
    ins = a + '            androidx.core.view.WindowCompat.setDecorFitsSystemWindows(w, false); // draw behind bars + notch (no black strip)\n            w.setStatusBarColor(android.graphics.Color.TRANSPARENT);\n            w.setNavigationBarColor(android.graphics.Color.TRANSPARENT);\n'
    s = s[:i] + ins + s[i + len(a):]; did.append('edge-to-edge (black strip fix)')

if s != orig:
    if not os.path.exists(P + '.bak-before-v9'): open(P + '.bak-before-v9', 'w', encoding='utf8').write(orig)
    open(P, 'w', encoding='utf8').write(s); print('patched MainActivity.java:', ', '.join(did))
else: print('ok, already done: MainActivity full screen')
