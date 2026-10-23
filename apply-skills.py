#!/usr/bin/env python3
"""Adds the skill-install feature wiring to backend/server.js IN PLACE (idempotent).
4 small insertions, each guarded with count==1. Run:  python3 apply-skills.py backend/server.js"""
import sys
p = sys.argv[1] if len(sys.argv) > 1 else 'backend/server.js'
s = open(p, encoding='utf8').read()

def brace_balance(t):
    return t.count('{') - t.count('}'), t.count('(') - t.count(')')

before = brace_balance(s)
edits = [
  ("require",
   "const security = require('./security');\n",
   "const security = require('./security');\nconst skills = require('./skills');\n",
   "const skills = require('./skills');"),
  ("router",
   "app.use('/api/security', security.router);\n",
   "app.use('/api/security', security.router);\napp.use('/api/skills', skills.createRouter({ express, verifyAuth, getDb: () => db }));\n",
   "skills.createRouter("),
  ("install-in-chat",
   "    let finalSystemPrompt = systemPrompt || '';\n",
   "    let finalSystemPrompt = systemPrompt || '';\n\n"
   "    // Skill install: \"<github link> skill install karo\" is handled here without calling the AI.\n"
   "    try {\n"
   "      const skillReply = await skills.handleInstallMessage({ db, uid, messages });\n"
   "      if (skillReply) return res.json({ reply: skillReply });\n"
   "    } catch (skillErr) { console.warn('Skill install handler failed:', skillErr.message); }\n",
   "skills.handleInstallMessage("),
  ("context",
   "    const geminiAutoHealing = model === 'gemini' && watchdog.isDisabled('gemini_chat_fail');\n",
   "    // Installed skills that match this request are added to the prompt (max 2).\n"
   "    try { finalSystemPrompt += await skills.buildContext({ db, uid, messages }); }\n"
   "    catch (skillErr) { console.warn('Skills context failed:', skillErr.message); }\n\n"
   "    const geminiAutoHealing = model === 'gemini' && watchdog.isDisabled('gemini_chat_fail');\n",
   "skills.buildContext("),
]
done = []
for name, old, new, marker in edits:
    if marker in s:
        done.append(name + ': already applied'); continue
    if s.count(old) != 1:
        sys.exit('ERROR: anchor for "%s" found %d times (expected 1) - nothing written' % (name, s.count(old)))
    s = s.replace(old, new); done.append(name + ': applied')

after = brace_balance(s)
# the inserted code adds balanced { } and ( ) only, so the balance must not change
if before != after:
    sys.exit('ERROR: brace/paren balance changed %s -> %s - nothing written' % (before, after))
open(p, 'w', encoding='utf8').write(s)
print('\n'.join(done)); print('brace balance OK', after)
