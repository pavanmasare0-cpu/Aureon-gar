#!/usr/bin/env python3
"""Ava overlay -> opens Ava's own transparent chat screen (not Aureon).
Patches (idempotent, .bak-before-ava-panel backups): AndroidManifest.xml, styles.xml, AureonActionsPlugin.java
Run from repo root:  python3 apply-ava-panel.py"""
import os, sys
ok = True
def edit(path, marker, anchor, new, label, before=True):
    global ok
    if not os.path.exists(path): print('❌ NOT FOUND:', path); ok = False; return
    s = open(path, encoding='utf8').read()
    if marker in s: print('ok    :', label, '(already there)'); return
    if anchor not in s: print('❌ ANCHOR MISSING:', label, '- send me', path); ok = False; return
    if not os.path.exists(path + '.bak-before-ava-panel'): open(path + '.bak-before-ava-panel', 'w', encoding='utf8').write(s)
    open(path, 'w', encoding='utf8').write(s.replace(anchor, (new + anchor) if before else (anchor + new), 1)); print('done  :', label)

M = 'android/app/src/main/AndroidManifest.xml'
edit(M, '.AvaPanelActivity', '        <provider\n            android:name="androidx.core.content.FileProvider"',
'''        <!-- Ava's own transparent chat screen (opened by tapping the floating Ava
             orb over other apps). Own task so Aureon's main screen is not pulled forward. -->
        <activity
            android:name=".AvaPanelActivity"
            android:theme="@style/AppTheme.AvaPanel"
            android:launchMode="singleTask"
            android:taskAffinity="com.aureon.ai.avapanel"
            android:excludeFromRecents="true"
            android:windowSoftInputMode="adjustResize"
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|screenLayout|uiMode|density|locale|layoutDirection|navigation|fontScale"
            android:exported="false" />

''', 'manifest: AvaPanelActivity')

S = 'android/app/src/main/res/values/styles.xml'
edit(S, 'AppTheme.AvaPanel', '</resources>',
'''    <!-- See-through theme for Ava's chat screen -->
    <style name="AppTheme.AvaPanel" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="android:windowIsTranslucent">true</item>
        <item name="android:windowBackground">@android:color/transparent</item>
        <item name="android:backgroundDimEnabled">false</item>
        <item name="android:windowNoTitle">true</item>
        <item name="android:windowAnimationStyle">@null</item>
    </style>

''', 'styles: AppTheme.AvaPanel')

P = 'android/app/src/main/java/com/aureon/ai/AureonActionsPlugin.java'
edit(P, 'avaPanelMode', '    // ---- Ava floating on the phone screen (over other apps) ----',
'''    // ---- Ava's transparent chat screen (AvaPanelActivity) ----
    @PluginMethod
    public void avaPanelMode(PluginCall call) {
        JSObject r = new JSObject();
        r.put("panel", getActivity() instanceof AvaPanelActivity);
        call.resolve(r);
    }

    @PluginMethod
    public void closeAvaPanel(PluginCall call) {
        final android.app.Activity a = getActivity();
        if (a instanceof AvaPanelActivity) a.runOnUiThread(a::finish);
        call.resolve();
    }

''', 'plugin: avaPanelMode / closeAvaPanel')

if not os.path.exists('android/app/src/main/java/com/aureon/ai/AvaPanelActivity.java'): print('❌ AvaPanelActivity.java missing (unzip the zip first)'); ok = False
print('\nAll good.' if ok else '\nSomething needs attention (see ❌ above).')
sys.exit(0 if ok else 1)
