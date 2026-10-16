#!/usr/bin/env python3
"""Wires Ava into the app UI: loads ava-bot.js and adds the 2 Settings toggles.
Idempotent, .bak-before-ava-ui backup.  Run from repo root:  python3 fix-ava-ui.py"""
import os, re, sys
P = 'www/index.html'
if not os.path.exists('www/ava-bot.js'): print('❌ www/ava-bot.js missing - unzip Aureon-ava-v2.zip first'); sys.exit(1)
s = open(P, encoding='utf8').read(); o = s
ROWS = ('          <div class="setting-row">\n'
        '            <span>Ava (udta hua bot)</span>\n'
        '            <label class="switch"><input type="checkbox" id="toggle-ava" checked><span class="slider"></span></label>\n'
        '          </div>\n'
        '          <div class="setting-row">\n'
        '            <span>Ava phone screen par (doosre apps ke upar)</span>\n'
        '            <label class="switch"><input type="checkbox" id="toggle-ava-overlay"><span class="slider"></span></label>\n'
        '          </div>\n')
if 'id="toggle-ava"' in s: print('ok   : settings toggles already there')
else:
    a = '          <div class="setting-row">\n            <span>Auto language detect</span>'
    if a in s: s = s.replace(a, ROWS + a, 1); print('done : settings toggles added')
    else:
        m = re.search(r'id="toggle-stream"[^\n]*\n\s*</div>\n', s)
        if m: s = s[:m.end()] + ROWS + s[m.end():]; print('done : settings toggles added (after streaming row)')
        else: print('⚠️  could not find a Settings spot - toggles NOT added (Ava still loads)')
if 'ava-bot.js' in s: print('ok   : ava-bot.js script tag already there')
else:
    if '</body>' not in s: print('❌ no </body> in index.html'); sys.exit(1)
    s = s.replace('</body>', '  <script src="ava-bot.js"></script>\n</body>', 1); print('done : <script src="ava-bot.js"> added')
if s != o:
    open(P + '.bak-before-ava-ui', 'w', encoding='utf8').write(o); open(P, 'w', encoding='utf8').write(s)
