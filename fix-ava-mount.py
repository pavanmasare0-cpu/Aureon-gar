#!/usr/bin/env python3
"""Mounts /api/ava in backend/server.js (idempotent, .bak-before-ava-mount backup).
Run from repo root:  python3 fix-ava-mount.py"""
import re, sys
P = 'backend/server.js'
s = open(P, encoding='utf8').read()
if "require('./ava')" in s:
    print('already mounted'); sys.exit(0)
MOUNT = ("// ---------- Ava: flying assistant (chat for Sentinel, self-learning brain) ----------\n"
         "app.use('/api/ava', require('./ava')({\n  getDb: () => db,\n  admin,\n  callGemini,\n  callGroq,\n}));\n\n")
missing = [n for n in ('db', 'admin', 'callGemini', 'callGroq') if not re.search(r'\b(const|let|var|function|async function)\s+' + n + r'\b', s)]
if missing:
    print('WARNING: server.js has no definition of', missing, '- send me server.js'); sys.exit(1)
m = re.search(r'^app\.listen\(', s, re.M)
if not m:
    print('ANCHOR app.listen( not found - send me server.js'); sys.exit(1)
open(P + '.bak-before-ava-mount', 'w', encoding='utf8').write(s)
open(P, 'w', encoding='utf8').write(s[:m.start()] + MOUNT + s[m.start():])
print('patched: /api/ava mounted in', P)
