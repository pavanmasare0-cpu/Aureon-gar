#!/usr/bin/env python3
"""Run once from the repo root AFTER copying this zip's files in:
     python3 apply-ava-v2.py
Idempotent, makes .bak copies. Two tiny patches to files NOT in this zip:
  1. backend/watchdog.js  -> export sendEmailAlert (so Ava can email great finds)
  2. backend/security/index.js -> don't body-scan /api/ava (screen frames are big base64 blobs)
"""
import os, re
def patch(path, fn, label):
    if not os.path.exists(path): print('skip (not found):', path); return
    s = open(path, encoding='utf8').read(); n = fn(s)
    if n == s: print('ok, already done:', label); return
    open(path + '.bak-before-ava-v2', 'w', encoding='utf8').write(s); open(path, 'w', encoding='utf8').write(n); print('patched:', label)
def wd(s):
    if re.search(r'module\.exports\s*=\s*\{[^}]*sendEmailAlert', s): return s
    return re.sub(r'module\.exports\s*=\s*\{', 'module.exports = { sendEmailAlert, ', s, 1)
def sec(s):
    if "/api/ava" in s.split("BODY_SKIP",1)[-1].split("\n",1)[0]: return s
    return s.replace("'/api/chat,/chat,/api/sentinel,", "'/api/chat,/chat,/api/ava,/api/sentinel,", 1)
patch('backend/watchdog.js', wd, 'watchdog exports sendEmailAlert')
patch('backend/security/index.js', sec, 'security BODY_SKIP includes /api/ava')
