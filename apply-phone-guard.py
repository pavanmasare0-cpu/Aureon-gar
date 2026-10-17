#!/usr/bin/env python3
"""Adds the Phone Security Check to the Aureon app (idempotent). Run from the repo root:
     python3 apply-phone-guard.py
It (1) copies the native plugin + web helper, (2) registers the plugin in MainActivity,
(3) adds the QUERY_ALL_PACKAGES permission, (4) adds Settings -> "Phone Security" to www/index.html.
Then:  npx cap sync android  and rebuild the APK."""
import os, re, shutil, sys
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'android-phone-guard')
ROOT = os.getcwd()
done = []

def read(p): return open(p, encoding='utf8').read()
def write(p, s): open(p, 'w', encoding='utf8').write(s)

# 1. native plugin: same folder as the existing AureonActionsPlugin
java_dir = None
for dp, _, fs in os.walk(os.path.join(ROOT, 'android', 'app', 'src', 'main', 'java')):
    if 'AureonActionsPlugin.java' in fs: java_dir = dp
if not java_dir: sys.exit('ERROR: AureonActionsPlugin.java not found — run this from the repo root')
shutil.copy(os.path.join(SRC, 'java', 'AureonDeviceGuardPlugin.java'), os.path.join(java_dir, 'AureonDeviceGuardPlugin.java')); done.append('plugin java')

# 2. register in MainActivity
ma = os.path.join(java_dir, 'MainActivity.java'); s = read(ma)
if 'AureonDeviceGuardPlugin' not in s:
    m = re.search(r'(\s*)registerPlugin\(AureonActionsPlugin\.class\);', s)
    if not m: sys.exit('ERROR: registerPlugin(AureonActionsPlugin.class) not found in MainActivity')
    s = s[:m.end()] + m.group(1) + 'registerPlugin(AureonDeviceGuardPlugin.class);' + s[m.end():]; write(ma, s); done.append('MainActivity')

# 3. manifest permission
mf = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'); s = read(mf)
if 'QUERY_ALL_PACKAGES' not in s:
    m = re.search(r'<uses-permission[^>]*/>', s)
    if not m: sys.exit('ERROR: no <uses-permission> in manifest')
    s = s[:m.start()] + '<uses-permission android:name="android.permission.QUERY_ALL_PACKAGES" />\n    ' + s[m.start():]; write(mf, s); done.append('manifest')

# 4. web: helper + Settings row/pane
shutil.copy(os.path.join(SRC, 'www', 'device-guard.js'), os.path.join(ROOT, 'www', 'device-guard.js')); done.append('device-guard.js')
ix = os.path.join(ROOT, 'www', 'index.html'); s = read(ix)
chev = '<svg class="row-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>'
if 'data-pane="phoneguard"' not in s:
    row = ('          <div class="list-group">\n          <button class="list-row" data-open="phoneguard">\n'
           '            <svg class="row-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v5c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/></svg>\n'
           '            <span class="row-text"><span class="row-title">Phone Security</span><span class="row-sub" id="sub-phoneguard">Device key daalo</span></span>\n            ' + chev + '\n          </button>\n          </div>\n')
    m = re.search(r'<div id="settings-list">\n', s)
    if not m: sys.exit('ERROR: settings-list not found in index.html')
    s = s[:m.end()] + row + s[m.end():]
    pane = ('        <section class="settings-card settings-pane hidden" data-pane="phoneguard" data-title="Phone Security">\n'
            '          <p class="card-sub">Ye phone ki security settings (screen lock, root, USB debugging, patch) aur installed apps ki list tumhare <b>apne backend</b> ko bhejta hai — kisi aur ko nahi. Kuch badalta nahi, sirf padhta hai. Result: Security dashboard → My Phone. Ye antivirus nahi hai.</p>\n'
            '          <label style="display:block;font-size:12px;opacity:.7;margin:6px 0">Device key (dashboard → My Phone → Naya phone jodo)</label>\n'
            '          <input id="pg-key" type="password" autocomplete="off" placeholder="dk_..." style="width:100%;box-sizing:border-box;padding:12px;border-radius:12px;border:1px solid var(--border-gold);background:var(--cream);color:inherit;font-size:14px">\n'
            '          <div style="display:flex;gap:8px;margin:12px 0"><button class="primary-btn" id="pg-save" style="flex:1">Key save</button><button class="primary-btn" id="pg-run" style="flex:2">Abhi check karo</button></div>\n'
            '          <label style="display:flex;gap:10px;align-items:center;font-size:13px;margin:8px 0"><input type="checkbox" id="pg-auto" checked> Roz apne aap check (app khulne par)</label>\n'
            '          <div id="pg-result"></div>\n        </section>\n\n')
    m = re.search(r'        <section class="settings-card settings-pane hidden" data-pane="(theme|general)"', s)
    if not m: sys.exit('ERROR: could not find a settings pane to insert before')
    s = s[:m.start()] + pane + s[m.start():]; done.append('index.html pane')
if 'device-guard.js' not in s:
    m = re.search(r'<script src="app\.js"></script>', s)
    if not m: sys.exit('ERROR: app.js script tag not found')
    s = s[:m.end()] + '\n  <script src="device-guard.js"></script>' + s[m.end():]; done.append('script tag')
write(ix, s)
print('Phone Security installed:', ', '.join(done) if done else 'already installed — nothing to do')
print('Next: npx cap sync android   then rebuild the APK.')
