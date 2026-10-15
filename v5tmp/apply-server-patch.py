#!/usr/bin/env python3
"""Adds the Security module wiring to backend/server.js IN PLACE (idempotent).
Your server.js is NOT replaced — only 5 small lines are inserted, so all your
newer changes (Love Camera, watchdog, ...) stay exactly as they are."""
import sys, re
p = sys.argv[1] if len(sys.argv) > 1 else 'backend/server.js'
s = open(p, encoding='utf8').read()
orig = s
changes = []

if "require('./security')" not in s:
    m = re.search(r"const sentinelDashboard = require\('\./sentinel-dashboard'\);\n", s)
    if not m: sys.exit("ERROR: could not find the sentinel-dashboard require line")
    s = s[:m.end()] + "const security = require('./security');\n" + s[m.end():]
    changes.append('require')

if 'security.guard' not in s:
    m = re.search(r"const app = express\(\);\n", s)
    if not m: sys.exit("ERROR: could not find 'const app = express();'")
    tail = s[m.end():]
    ins = ""
    if "app.set('trust proxy'" not in s:
        ins += "// Render sits behind one proxy hop: trust exactly that, so req.ip is the real client address.\napp.set('trust proxy', 1);\n"
    # guard must run BEFORE express.json so floods/probes are cut before big bodies are parsed
    mj = re.search(r"app\.use\(express\.json\([^\n]*\)\);\n", tail)
    if not mj: sys.exit("ERROR: could not find app.use(express.json(...))")
    pre, body_line, post = tail[:mj.start()], mj.group(0), tail[mj.end():]
    s = (s[:m.end()] + ins + pre + "app.use(security.guard);      // IP block-list, rate-limit, URL signatures\n"
         + body_line + "app.use(security.bodyGuard);  // payload patterns (flagged by default)\n" + post)
    changes.append('guard+trust proxy')

if "github-webhook" not in s:
    m = re.search(r"app\.use\(security\.guard\);[^\n]*\n", s)
    if not m: sys.exit("ERROR: security.guard line not found — run the full patch first")
    s = s[:m.end()] + "// GitHub webhook needs the RAW body for signature checking, so it is mounted before express.json()\napp.post('/api/security/github-webhook', express.raw({ type: '*/*', limit: '5mb' }), security.githubWebhook);\n" + s[m.end():]
    changes.append('github webhook')

if "'/api/security'" not in s:
    m = re.search(r"app\.use\('/api/sentinel', sentinelDashboard\);\n", s)
    if not m: sys.exit("ERROR: could not find the /api/sentinel mount")
    s = s[:m.end()] + "app.use('/api/security', security.router);\n" + s[m.end():]
    changes.append('router mount')

if s != orig:
    open(p + '.bak-before-security', 'w', encoding='utf8').write(orig)
    open(p, 'w', encoding='utf8').write(s)
    print('server.js patched:', ', '.join(changes), '(backup: ' + p + '.bak-before-security)')
else:
    print('server.js already has the security wiring — nothing to do')
