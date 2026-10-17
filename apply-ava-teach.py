#!/usr/bin/env python3
"""Teach Ava (record what you do, replay on command): wires AvaTeach into the app.
Patches (idempotent, .bak-before-ava-teach): aureon_accessibility_config.xml, AureonAccessibilityService.java, AureonActionsPlugin.java
Run from repo root (after unzipping):  python3 apply-ava-teach.py"""
import os, sys
J = 'android/app/src/main/java/com/aureon/ai/'
ok = True

def edit(path, marker, anchor, new, label, mode='before'):
    global ok
    if not os.path.exists(path): print('❌ NOT FOUND:', path); ok = False; return
    s = open(path, encoding='utf8').read()
    if marker in s: print('ok    :', label, '(already there)'); return
    if anchor not in s: print('❌ ANCHOR MISSING:', label, '- send me', path); ok = False; return
    bk = path + '.bak-before-ava-teach'
    if '/res/' in path.replace(os.sep, '/'):   # Android's resource merger rejects any non-.xml file inside res/ -> keep the backup outside
        os.makedirs('.ava-backups', exist_ok=True); bk = os.path.join('.ava-backups', os.path.basename(path) + '.bak-before-ava-teach')
    if not os.path.exists(bk): open(bk, 'w', encoding='utf8').write(s)
    rep = {'before': new + anchor, 'after': anchor + new, 'replace': new}[mode]
    open(path, 'w', encoding='utf8').write(s.replace(anchor, rep, 1)); print('done  :', label)

import glob
for stray in glob.glob('android/app/src/main/res/**/*.bak*', recursive=True):   # leftovers from an earlier run break the Gradle build
    try: os.remove(stray); print('removed stray backup from res/:', stray)
    except OSError: pass

if not os.path.exists(J + 'AvaTeach.java'): print('❌ AvaTeach.java missing - unzip the zip first'); sys.exit(1)

edit('android/app/src/main/res/xml/aureon_accessibility_config.xml', 'flagReportViewIds',
     '    android:canPerformGestures="true"\n',
     '    android:accessibilityFlags="flagReportViewIds"\n', 'accessibility config: report view ids', 'after')

A = J + 'AureonAccessibilityService.java'
edit(A, 'AvaTeach.attach', '    @Override public void onServiceConnected() { instance = this; }',
     '    @Override public void onServiceConnected() { instance = this; AvaTeach.attach(this); }',
     'accessibility service: attach', 'replace')
edit(A, 'AvaTeach.onEvent', '    @Override public void onAccessibilityEvent(AccessibilityEvent event) {\n',
     '        try { AvaTeach.onEvent(this, event); } catch (Throwable ignored) { }\n',
     'accessibility service: forward events', 'after')

P = J + 'AureonActionsPlugin.java'
edit(P, 'getTeach', "    // ---- Ava's transparent chat screen (AvaPanelActivity) ----",
'''    // ---- Teach Ava: record what the user does, replay it on command ----
    @PluginMethod
    public void getTeach(PluginCall call) { call.resolve(AvaTeach.status(getContext())); }

    @PluginMethod
    public void teachStart(PluginCall call) { call.resolve(AvaTeach.start(call.getString("name", ""))); }

    @PluginMethod
    public void teachStop(PluginCall call) {
        Boolean save = call.getBoolean("save", true);
        call.resolve(AvaTeach.stop(getContext(), save == null || save));
    }

    @PluginMethod
    public void macroPlay(PluginCall call) { call.resolve(AvaTeach.play(getContext(), call.getString("name", ""))); }

    @PluginMethod
    public void macroStop(PluginCall call) { AvaTeach.stopPlay(); call.resolve(); }

    @PluginMethod
    public void macroDelete(PluginCall call) { call.resolve(AvaTeach.delete(getContext(), call.getString("name", ""))); }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
    }

''', 'plugin: teach methods')

print('\nAll good.' if ok else '\nNeeds attention (see ❌ above).'); sys.exit(0 if ok else 1)
