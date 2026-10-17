#!/usr/bin/env python3
"""Wires Ava Lab into backend/sentinel-dashboard.js (idempotent, .bak-before-ava-lab).
 - mounts backend/ava-self.js under /api/sentinel/ava (behind the dashboard lock)
 - serves the page at /api/sentinel/ava-lab (uses the same login / 2FA as the dashboard)
 - adds an "Ava Lab" link in the Sentinel header
Run from repo root:  python3 v9-sentinel/patch_ava_lab.py"""
import os, sys
P = 'backend/sentinel-dashboard.js'
if not os.path.exists(P): sys.exit('NOT FOUND: ' + P)
if not os.path.exists('backend/ava-self.js'): sys.exit('backend/ava-self.js missing - unzip Aureon-v9.zip first')
s = open(P, encoding='utf8').read(); orig = s; done = []

g1 = "  if (req.path === '/dashboard') return next(); // the page itself runs the login flow (auth.dashboard)\n"
g2 = "  if (req.path === '/dashboard' || req.path === '/ava-lab') return next(); // the pages themselves run the login flow (auth.dashboard)\n"
if "req.path === '/ava-lab'" not in s:
    if g1 not in s: sys.exit('ANCHOR MISSING: dashboard gate in sentinel-dashboard.js - send me that file')
    s = s.replace(g1, g2, 1); done.append('gate')

if "require('./ava-self')" not in s:
    a = "  return auth.apiGate(req, res, next);\n});\n"
    if a not in s: sys.exit('ANCHOR MISSING: apiGate block - send me sentinel-dashboard.js')
    mount = a + """
// ---------------- Ava Lab: Ava writes her own upgrades, you approve (see backend/ava-self.js, AVA-LAB.md) ----------------
try {
  const avaSelf = require('./ava-self')({ lib, auth, store, DATA_DIR, callLLM, logEvent });
  router.use('/ava', avaSelf.router);
  router.get('/ava-lab', (req, res) => auth.dashboard(req, res, () => res.type('html').send(avaSelf.page)));
} catch (e) { console.error('[sentinel] Ava Lab disabled:', e.message); }
"""
    s = s.replace(a, mount, 1); done.append('mount')

link = '    <a id="sec-link" class="sec-link" href="#">\U0001F510 Security Dashboard \u2192</a>\n'
if 'ava-lab"' not in s.split('<header>')[-1] if '<header>' in s else True:
    if link in s:
        s = s.replace(link, link + '    <a class="sec-link" href="/api/sentinel/ava-lab" style="margin-left:12px">\U0001F9EA Ava Lab \u2192</a>\n', 1); done.append('header link')
    else: print('note: header link anchor not found - open /api/sentinel/ava-lab directly')

if s != orig:
    if not os.path.exists(P + '.bak-before-ava-lab'): open(P + '.bak-before-ava-lab', 'w', encoding='utf8').write(orig)
    open(P, 'w', encoding='utf8').write(s); print('patched sentinel-dashboard.js:', ', '.join(done))
else: print('ok: Ava Lab already wired')
