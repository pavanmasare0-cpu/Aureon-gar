#!/usr/bin/env python3
"""Aureon Upgrade 7 - ONE zip, ONE command (run from the repo root):
    unzip -o Upgrade-7.zip && python3 apply-upgrade-7.py

What it fixes (every step is idempotent; backups go to .upgrade7-backups/, never into res/):
 1. FULL SCREEN (black strip at the top): AppCompat's decor root (action_bar_root) has fitsSystemWindows=true, so it keeps
    padding the page by the status-bar / camera-notch height even though the bars are hidden. We switch that padding off.
    + OEM "notch support" flags in the manifest (ColorOS / MIUI / EMUI).
 2. AVA OVER OTHER APPS:
    - orb tap now also works on Android 14+ (explicit background-start opt-in) and DETECTS a blocked launch
      (some phones refuse to open a screen from the background) -> tells you exactly which switch to turn on.
    - after you grant "Display over other apps" the orb now starts by itself when you come back (before, you had to
      toggle again and many people never did).
    - Ava's panel (AvaPanelActivity) and the plugin are brought to ONE consistent version
      (avaPanelReady / markReady must exist on both sides, otherwise the panel stays invisible or the build breaks).
"""
import os, re, shutil, sys

J = 'android/app/src/main/java/com/aureon/ai/'
HERE = os.path.dirname(os.path.abspath(__file__))
BK = '.upgrade7-backups'
rows, bad = [], []


def need(path):
    if not os.path.exists(path):
        sys.exit('ERROR: %s not found - run this from the repo root (the folder with android/ and www/)' % path)


def backup(path):
    os.makedirs(BK, exist_ok=True)
    dst = os.path.join(BK, path.replace('/', '__'))
    if not os.path.exists(dst):
        shutil.copyfile(path, dst)


def rd(p):
    with open(p, encoding='utf8') as f:
        return f.read()


def wr(p, s):
    with open(p, 'w', encoding='utf8') as f:
        f.write(s)


def result(name, state, note=''):
    rows.append((name, state, note))
    if state == 'FAILED':
        bad.append(name)


need(J + 'MainActivity.java')

# ---------------------------------------------------------------- 1. Ava panel activity (whole file, it is Ava-only)
src = os.path.join(HERE, 'fix7', 'AvaPanelActivity.java')
dst = J + 'AvaPanelActivity.java'
if os.path.exists(dst) and rd(dst) == rd(src):
    result('AvaPanelActivity', 'ok', 'already the fixed version')
else:
    if os.path.exists(dst):
        backup(dst)
    shutil.copyfile(src, dst)
    result('AvaPanelActivity', 'updated', 'translucent theme kept, markReady(), resumeCount, no inset padding')

# ---------------------------------------------------------------- 2. plugin: avaPanelReady + remember the overlay switch
P = J + 'AureonActionsPlugin.java'
if not os.path.exists(P):
    result('AureonActionsPlugin', 'FAILED', 'file not found')
else:
    s = o = rd(P)
    notes = []
    if 'avaPanelReady' not in s:
        a = '    @PluginMethod\n    public void closeAvaPanel(PluginCall call) {'
        if a not in s:
            result('AureonActionsPlugin', 'FAILED', 'anchor closeAvaPanel missing - send me AureonActionsPlugin.java')
            a = None
        else:
            s = s.replace(a, '''    @PluginMethod
    public void avaPanelReady(PluginCall call) {
        final android.app.Activity a = getActivity();
        if (a instanceof AvaPanelActivity) {
            final AvaPanelActivity pa = (AvaPanelActivity) a;
            a.runOnUiThread(new Runnable() { @Override public void run() { pa.markReady(); } });
        }
        call.resolve();
    }

''' + a, 1)
            notes.append('avaPanelReady added')
    if 'remembered: MainActivity.onResume' not in s:
        b = '            r.put("enabled", false);\n            r.put("needsPermission", true);\n'
        if s.count(b) == 1:
            s = s.replace(b, '            AvaOverlayService.setEnabled(ctx, true); // remembered: MainActivity.onResume starts Ava as soon as the permission is granted\n' + b, 1)
            notes.append('overlay switch remembered')
        else:
            result('AureonActionsPlugin (overlay)', 'FAILED', 'anchor in setAvaOverlay missing - send me AureonActionsPlugin.java')
    if s != o:
        backup(P)
        wr(P, s)
        result('AureonActionsPlugin', 'updated', ', '.join(notes))
    elif 'AureonActionsPlugin' not in bad:
        result('AureonActionsPlugin', 'ok', 'already patched')

# ---------------------------------------------------------------- 3. overlay service: tap that works + detects a blocked launch
S = J + 'AvaOverlayService.java'
NEW_TAP = '''    private long lastBlockedHint = 0;

    private void onTapped() {
        orb.hop();
        // Open Ava's own transparent chat screen right over whatever app is on screen (AvaPanelActivity).
        final int before = AvaPanelActivity.resumeCount;
        boolean launched = launchPanel();
        // Some phones (ColorOS/Realme/Oppo, MIUI, Funtouch...) silently refuse to open a screen from the background
        // unless a "pop-up while running in background" switch is on. If the panel did not come forward, say so.
        handler.postDelayed(new Runnable() {
            @Override public void run() {
                if (AvaPanelActivity.resumeCount == before) showPanelBlockedHint();
            }
        }, launched ? 1800 : 300);
    }

    private boolean launchPanel() {
        Intent i = new Intent(this, AvaPanelActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_NO_ANIMATION);
        if (Build.VERSION.SDK_INT >= 34) {
            try { // Android 14+: starting from the background needs the sender to opt in explicitly
                android.app.PendingIntent pi = android.app.PendingIntent.getActivity(this, 0, i,
                        android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
                android.app.ActivityOptions ao = android.app.ActivityOptions.makeBasic();
                ao.setPendingIntentBackgroundActivityStartMode(android.app.ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
                pi.send(this, 0, null, null, null, null, ao.toBundle());
                return true;
            } catch (Throwable ignored) { /* fall through to the plain start */ }
        }
        try {
            startActivity(i);
            return true;
        } catch (Throwable e) {
            return false;
        }
    }

    private void showPanelBlockedHint() {
        long now = System.currentTimeMillis();
        if (now - lastBlockedHint < 20000) return;
        lastBlockedHint = now;
        try {
            android.widget.Toast.makeText(this,
                    "Ava khul nahi paayi. Settings me Aureon ke liye \\"Display pop-up windows while running in the background\\" ON karo (aur Battery: Unrestricted).",
                    android.widget.Toast.LENGTH_LONG).show();
        } catch (Throwable ignored) { }
        try {
            Intent s = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + getPackageName()));
            s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(s);
        } catch (Throwable ignored) { }
    }

'''
if not os.path.exists(S):
    result('AvaOverlayService', 'FAILED', 'file not found')
else:
    s = rd(S)
    if 'showPanelBlockedHint' in s:
        result('AvaOverlayService', 'ok', 'already patched')
    else:
        m = re.search(r'    private void onTapped\(\) \{.*?\n    \}\n\n(?=    private void pickTarget\(\))', s, re.S)
        if not m:
            result('AvaOverlayService', 'FAILED', 'onTapped()/pickTarget() anchors missing - send me AvaOverlayService.java')
        else:
            backup(S)
            wr(S, s[:m.start()] + NEW_TAP + s[m.end():])
            result('AvaOverlayService', 'updated', 'tap works on Android 14+, blocked launch is detected and explained')

# ---------------------------------------------------------------- 4. MainActivity: remove AppCompat's inset padding + start Ava after permission
M = J + 'MainActivity.java'
s = o = rd(M)
notes = []
if 'aureonClearFitPadding' not in s:
    a = '    private void aureonFullscreen() {\n        try {\n'
    b = '    @Override\n    public void onWindowFocusChanged(boolean hasFocus) {'
    if a in s and b in s:
        s = s.replace(a, a + '            aureonClearFitPadding();\n', 1)
        s = s.replace(b, '''    // ROOT CAUSE of the black strip at the top: AppCompat's decor root (action_bar_root) has fitsSystemWindows=true, so it keeps
    // padding the page by the status-bar / camera-notch height even though the bars are hidden. Switch that padding off.
    private void aureonClearFitPadding() {
        try {
            final android.view.View content = findViewById(android.R.id.content);
            if (content == null) return;
            android.view.ViewParent p = content.getParent();
            while (p instanceof android.view.View) {
                android.view.View v = (android.view.View) p;
                if (v == getWindow().getDecorView()) break;
                v.setFitsSystemWindows(false);
                v.setPadding(0, 0, 0, 0);
                p = v.getParent();
            }
        } catch (Throwable ignored) { /* never break startup over cosmetics */ }
    }

''' + b, 1)
        notes.append('black-strip fix')
    else:
        result('MainActivity (full screen)', 'FAILED', 'aureonFullscreen()/onWindowFocusChanged anchors missing - send me MainActivity.java')
if 'AvaOverlayService.startIfEnabled(this); // after the user grants' not in s:
    if re.search(r'\n    (public|protected) void onResume\(\)', s):
        result('MainActivity (overlay)', 'FAILED', 'MainActivity already has onResume() - send me MainActivity.java')
    else:
        b = '    @Override\n    public void onWindowFocusChanged(boolean hasFocus) {'
        if b in s:
            s = s.replace(b, '''    @Override
    public void onResume() {
        super.onResume();
        aureonClearFitPadding();
        AvaOverlayService.startIfEnabled(this); // after the user grants "Display over other apps" and comes back, Ava appears by herself
    }

''' + b, 1)
            notes.append('Ava starts after permission')
if s != o:
    backup(M)
    wr(M, s)
    result('MainActivity', 'updated', ', '.join(notes))
elif 'MainActivity (full screen)' not in bad and 'MainActivity (overlay)' not in bad:
    result('MainActivity', 'ok', 'already patched')

# ---------------------------------------------------------------- 5. manifest: OEM notch flags
MF = 'android/app/src/main/AndroidManifest.xml'
if not os.path.exists(MF):
    result('AndroidManifest', 'FAILED', 'file not found')
else:
    s = rd(MF)
    if 'android.notch_support' in s:
        result('AndroidManifest', 'ok', 'notch flags already there')
    else:
        m = re.search(r'<application\b[^>]*>', s)
        if not m:
            result('AndroidManifest', 'FAILED', '<application> tag not found')
        else:
            backup(MF)
            meta = '''
        <!-- OEM "full screen / camera notch" opt-in flags (ColorOS/Realme/Oppo, Xiaomi/MIUI, Huawei). Harmless elsewhere. -->
        <meta-data android:name="android.notch_support" android:value="true" />
        <meta-data android:name="notch.config" android:value="portrait|landscape" />
        <meta-data android:name="android.max_aspect" android:value="2.4" />
'''
            wr(MF, s[:m.end()] + meta + s[m.end():])
            result('AndroidManifest', 'updated', 'notch support flags added')

# ---------------------------------------------------------------- 6. ava-bot.js must be the version that calls avaPanelReady
for dst in ('www/ava-bot.js', 'backend/public/ava-bot.js'):
    if not os.path.exists(os.path.dirname(dst)):
        continue
    cur = rd(dst) if os.path.exists(dst) else ''
    if 'avaPanelReady' in cur and 'x-csrf' in cur:
        result(dst, 'ok', 'already calls avaPanelReady')
    else:
        if cur:
            backup(dst)
        shutil.copyfile(os.path.join(HERE, 'fix7', 'ava-bot.js'), dst)
        result(dst, 'updated', 'panel-ready handshake + teach + csrf')

# ---------------------------------------------------------------- keep the backups out of git
try:
    gi = rd('.gitignore') if os.path.exists('.gitignore') else ''
    if '.upgrade7-backups' not in gi:
        wr('.gitignore', gi.rstrip('\n') + ('\n' if gi else '') + '.upgrade7-backups/\n')
except Exception:
    pass

# ---------------------------------------------------------------- report
print('\nUpgrade 7 report')
print('-' * 72)
for n, st, note in rows:
    print('%-34s %-8s %s' % (n, st.upper(), note))
print('-' * 72)
if bad:
    print('STOPPED WITH PROBLEMS in: ' + ', '.join(bad) + '\n-> send me this whole output (and the file named above).')
    sys.exit(1)
print('All done. Next:  npx cap sync android   then build the APK (gradlew clean assembleDebug) and REINSTALL it.')
