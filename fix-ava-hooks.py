#!/usr/bin/env python3
"""Adds the two small hooks that AvaOverlayService needs (idempotent, .bak backups):
  1. AureonVoiceInteractionService.showFromOverlay()   <- fixes "cannot find symbol showFromOverlay"
  2. MainActivity: restart the Ava overlay on app launch
Run from the repo root:  python3 fix-ava-hooks.py
"""
import os

JAVA = 'android/app/src/main/java/com/aureon/ai/'

FIELD = '''    // Set while Aureon is the active Default Assistant; lets the floating Ava
    // overlay (AvaOverlayService) open the same voice session on tap.
    private static AureonVoiceInteractionService instance;

'''
METHOD = '''    /**
     * Called when the floating Ava orb is tapped. Returns false when Aureon is
     * not the Default Assistant (so the caller can just open the app instead).
     */
    public static boolean showFromOverlay() {
        final AureonVoiceInteractionService s = instance;
        if (s == null) return false;
        s.handler.post(() -> {
            try {
                s.stopWakeWordListening();
                s.showSession(new Bundle(), VoiceInteractionSession.SHOW_WITH_ASSIST);
                s.listeningEnabled = true;
                s.waitForSessionEndThenResume();
            } catch (Exception e) {
                Log.w(TAG, "Could not show session from Ava overlay: " + e.getMessage());
            }
        });
        return true;
    }

'''


def edit(path, marker, anchor, new, label):
    if not os.path.exists(path):
        print('NOT FOUND  :', path); return False
    s = open(path, encoding='utf8').read()
    if marker in s:
        print('already OK :', label); return True
    if anchor not in s:
        print('ANCHOR MISSING:', label, '- send me this file'); return False
    if not os.path.exists(path + '.bak-before-hooks'):
        open(path + '.bak-before-hooks', 'w', encoding='utf8').write(s)
    open(path, 'w', encoding='utf8').write(s.replace(anchor, new, 1))
    print('patched    :', label); return True


V = JAVA + 'AureonVoiceInteractionService.java'
edit(V, 'private static AureonVoiceInteractionService instance',
     '    private final Handler handler = new Handler(Looper.getMainLooper());',
     FIELD + '    private final Handler handler = new Handler(Looper.getMainLooper());', 'voice service: instance field')
edit(V, 'instance = this;', '        Log.d(TAG, "Aureon voice interaction service ready.");',
     '        Log.d(TAG, "Aureon voice interaction service ready.");\n        instance = this;', 'voice service: onReady')
edit(V, 'instance = null;', '        Log.d(TAG, "Aureon voice interaction service shutting down.");',
     '        Log.d(TAG, "Aureon voice interaction service shutting down.");\n        instance = null;', 'voice service: onShutdown')
edit(V, 'showFromOverlay()', '    private void createNotificationChannel() {',
     METHOD + '    private void createNotificationChannel() {', 'voice service: showFromOverlay()')
edit(JAVA + 'MainActivity.java', 'AvaOverlayService.startIfEnabled', '        startCallListenerService();\n',
     '        startCallListenerService();\n        AvaOverlayService.startIfEnabled(this);\n', 'MainActivity: restore overlay on launch')
print('\nDone.')
