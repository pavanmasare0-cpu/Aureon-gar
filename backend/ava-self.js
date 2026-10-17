// backend/ava-self.js — Ava Lab: Ava apne code ko khud padhti hai, khud upgrade likhti hai,
// aur Sentinel dashboard me dikhati hai ki KYA badla aur KYUN.
//
// Safety (ye jaan-bujh kar hai):
//  * Ava sirf PROPOSAL likhti hai. Disk par kuch bhi sirf tumhare Approve click ke baad likha jaata hai
//    (dash-auth login + agar on ho to fresh 2FA code).
//  * Sirf Ava ki apni files edit ho sakti hain (EDITABLE neeche). Security / dash-auth / Sentinel / server.js /
//    is file (ava-self.js) ko Ava chhu nahi sakti — apne guardrails khud nahi badal sakti.
//  * Har change: exact-match edits, JS syntax check, size/lines limit, khatarnak patterns (eval, child_process ...)
//    block, safety-words (ownerOnly, redact ...) hat jaaye to reject. Approve se pehle file dobara padhi jaati hai.
//  * Har approve ka backup + Rollback button + history (kya badla, kyun, risk, diff, patch download).
//  * Ye honest hai: Ava "khud ko conscious/free" nahi banati — wo code ka draft likhti hai, tum faisla karte ho.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EDITABLE = ['backend/ava.js', 'backend/ava-mind.js', 'backend/ava-extra.js', 'backend/public/ava-bot.js', 'www/ava-bot.js'];
const MIRRORS = { 'www/ava-bot.js': 'backend/public/ava-bot.js', 'backend/public/ava-bot.js': 'www/ava-bot.js' }; // same widget, two copies
const SAFETY_WORDS = ['ownerOnly', 'avaIsOwner', 'sameCode', 'limited(', 'redact(', 'consent'];
const BLOCKED_ADDED = /(child_process|\beval\s*\(|new\s+Function\s*\(|process\.exit|execSync|spawnSync|\.writeFileSync\s*\(\s*['"`]\/|rm\s+-rf|SENTINEL_OWNER_CODE|SECURITY_|DASH_)/;
// Ava's keys: ONLY Gemini + Groq (the brains she already uses). Nothing else from the environment ever reaches the sandbox.
const KEY_RE = /^(GEMINI|GROQ)_API_KEY(S|_\d)?$/;
const allowedKeys = () => { const o = {}; for (const k of Object.keys(process.env)) if (KEY_RE.test(k) && process.env[k]) o[k] = process.env[k]; return o; };
const ALLOWED_HOSTS = /^https?:\/\/(generativelanguage\.googleapis\.com|api\.groq\.com|aureone\.onrender\.com|localhost|127\.0\.0\.1)/;
const MAX_CHANGED_LINES = 160;
const MAX_FILE_SHOWN = 70000;
const HISTORY_MAX = 40;

module.exports = function createAvaSelf({ lib, auth, store, DATA_DIR, callLLM, logEvent }) {
  const express = require('express');
  const router = express.Router();
  const FILE = path.join(DATA_DIR, 'ava-self.json');
  const BK_DIR = path.join(DATA_DIR, 'ava-self-backups');
  try { fs.mkdirSync(BK_DIR, { recursive: true }); } catch (e) { /* read-only disk: backups stay in memory/history */ }

  let state = { proposals: [], history: [], version: 0, settings: { auto: false, hours: 6, autoApply: false }, lastAuto: 0 };
  let busy = false;
  const calls = [];
  const ready = (async () => {
    try {
      await store.whenFirestore(20000);
      const r = await store.load('ava_self', FILE);
      if (r && r.value && Array.isArray(r.value.proposals)) state = Object.assign(state, r.value, { settings: Object.assign({ auto: false, hours: 6, autoApply: false }, r.value.settings || {}) });
    } catch (e) { console.error('[ava-self] load failed:', e.message); }
  })();
  const save = () => ready.then(() => store.save('ava_self', slim(), FILE)).catch((e) => console.error('[ava-self] save failed:', e.message));
  function slim() { // Firestore doc <1 MiB: decided proposals drop their file bodies, only the newest history keeps a backup copy
    return {
      version: state.version, settings: state.settings, lastAuto: state.lastAuto,
      proposals: state.proposals.slice(-30).map((p) => (p.status === 'pending' ? p : (({ oldContent, newContent, ...r }) => r)(p))),
      history: state.history.slice(0, HISTORY_MAX).map((h, i) => (i < 4 ? h : (({ backups, ...r }) => r)(h))),
    };
  }

  const nid = () => crypto.randomBytes(6).toString('hex');
  const abs = (rel) => path.join(ROOT, rel);
  const existing = () => EDITABLE.filter((f) => fs.existsSync(abs(f)));
  const read = (rel) => fs.readFileSync(abs(rel), 'utf8');

  // ---- how Ava thinks: her own LLM if ava.js exposed it, else Sentinel's
  async function askJSON(prompt) {
    const hook = global.__avaSelf;
    if (hook && typeof hook.llm === 'function') {
      let txt;
      try { txt = await hook.llm(prompt); }
      catch (e) { if (!process.env.GROQ_API_KEY) throw e; return callLLM(prompt); } // Gemini quota -> Sentinel's Groq
      const raw = String(txt || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
      try { return JSON.parse(raw); } catch (e) { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* fall through */ } } return null; }
    }
    return callLLM(prompt);
  }
  const signals = () => { try { return (global.__avaSelf && global.__avaSelf.signals && global.__avaSelf.signals()) || {}; } catch (e) { return {}; } };

  function outline(rel) {
    const src = read(rel); const out = [];
    src.split('\n').forEach((l, i) => { if (/^\s{0,4}(async\s+function|function|const\s+\w+\s*=\s*(async\s*)?\(|router\.(get|post|delete)\(|\/\/ -{4,})/.test(l) && out.length < 70) out.push((i + 1) + ': ' + l.trim().slice(0, 110)); });
    return { size: src.length, lines: out.join('\n') };
  }

  function countWord(s, w) { return s.split(w).length - 1; }
  function checkSafety(rel, oldC, newC, stats) {
    const added = stats.addedText;
    if (BLOCKED_ADDED.test(added)) return 'khatarnak pattern mila (eval / child_process / secrets) — block';
    if (/\.js$/.test(rel)) { // backend code: no reading of other secrets, no sending anything to a new host
      const envUse = added.match(/process\.env(\.[A-Z_0-9]+|\[[^\]]*\])?/g) || [];
      for (const u of envUse) if (u === 'process.env' || /\[/.test(u) || !(KEY_RE.test(u.slice(12)) || /^AVA_[A-Z_]+$/.test(u.slice(12)))) return 'sirf Gemini/Groq keys (aur AVA_* settings) padh sakti hai — ' + u + ' block';
      const urls = added.match(/https?:\/\/[^\s'"`)]+/g) || [];
      for (const u of urls) if (!ALLOWED_HOSTS.test(u)) return 'naya outside URL block (data bahar bhejne ka risk): ' + u.slice(0, 60);
    }
    for (const w of SAFETY_WORDS) if (countWord(newC, w) < countWord(oldC, w)) return 'safety check "' + w + '" hat raha tha — block';
    if (stats.added + stats.removed > MAX_CHANGED_LINES) return 'change bahut bada (' + (stats.added + stats.removed) + ' lines) — chhota upgrade chahiye';
    return null;
  }

  // ---- sandbox: run the changed file in a throw-away copy, with NO secrets in its environment
  function sandbox(rel, newContent) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avasbx-'));
    try {
      if (!/\.js$/.test(rel)) return { ok: true, log: 'skip (not js)' };
      const tgt = path.join(dir, rel); fs.mkdirSync(path.dirname(tgt), { recursive: true }); fs.writeFileSync(tgt, newContent);
      if (/ava-bot\.js$/.test(rel)) { // browser widget: must at least parse
        const r = spawnSync(process.execPath, ['--check', tgt], { encoding: 'utf8', timeout: 8000, env: { PATH: process.env.PATH } });
        return { ok: r.status === 0, log: r.status === 0 ? 'syntax ok (widget)' : String(r.stderr).slice(0, 300) };
      }
      const bdir = path.join(dir, 'backend'); fs.mkdirSync(bdir, { recursive: true });
      for (const f of fs.readdirSync(__dirname)) if (/\.js$/.test(f) && !f.endsWith('.bak')) fs.copyFileSync(path.join(__dirname, f), path.join(bdir, f));
      fs.writeFileSync(path.join(bdir, path.basename(rel)), newContent);
      try { fs.symlinkSync(path.join(__dirname, 'node_modules'), path.join(bdir, 'node_modules'), 'dir'); } catch (e) { /* none */ }
      const code = "const m=require('./" + path.basename(rel) + "');if(typeof m!=='function'&&typeof m!=='object')throw new Error('export weird: '+typeof m);console.log('load ok, export='+typeof m)";
      const r = spawnSync(process.execPath, ['-e', code], { cwd: bdir, encoding: 'utf8', timeout: 12000, env: Object.assign({ PATH: process.env.PATH, NODE_ENV: 'test', AVA_SANDBOX: '1' }, allowedKeys()) });
      return { ok: r.status === 0, log: (r.status === 0 ? String(r.stdout).trim() : String(r.stderr || r.error || 'failed').split('\n').slice(0, 4).join(' ')).slice(0, 300) };
    } catch (e) { return { ok: false, log: String(e.message).slice(0, 200) }; }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* tmp */ } }
  }

  function buildProposal(rel, idea, edits) {
    const oldC = read(rel);
    const ap = lib.applyEdits(oldC, edits);
    if (!ap.ok) return { error: 'edit lagi nahi: ' + ap.error };
    const bad = lib.validateNew(rel, oldC, ap.content);
    if (bad) return { error: bad };
    const d = lib.makeDiff(oldC, ap.content, { maxRows: 500 });
    const addedText = edits.map((e) => e.replace).join('\n');
    const sf = checkSafety(rel, oldC, ap.content, { added: d.added, removed: d.removed, addedText });
    if (sf) return { error: sf };
    const sb = sandbox(rel, ap.content);
    if (!sb.ok) return { error: 'sandbox test fail: ' + sb.log };
    return {
      p: {
        id: nid(), createdAt: new Date().toISOString(), status: 'pending',
        file: rel, title: String(idea.title || 'Upgrade').slice(0, 90),
        what: String(idea.what_changed || idea.what || '').slice(0, 600), why: String(idea.why || '').slice(0, 500),
        risk: ['low', 'medium', 'high'].includes(String(idea.risk)) ? idea.risk : 'medium',
        test: String(idea.test_hint || '').slice(0, 300), goal: String(idea.goal || '').slice(0, 200),
        sandbox: sb, auto: false, oldContent: oldC, newContent: ap.content, diff: d.hunks, stats: { added: d.added, removed: d.removed, truncated: d.truncated },
      },
    };
  }

  // ---- Ava improves herself: pick a file/idea, then write exact edits
  async function improve(goal, auto) {
    const files = existing();
    if (!files.length) throw new Error('Ava ki files nahi mili (ROOT=' + ROOT + ')');
    const hist = state.history.concat(state.proposals.filter((p) => p.status !== 'pending')).slice(0, 12)
      .map((h) => `- [${h.status}] ${h.file}: ${h.title}`).join('\n') || '(abhi koi)';
    const sig = JSON.stringify(signals()).slice(0, 1500);
    const outlines = files.map((f) => { const o = outline(f); return `### ${f} (${o.size} chars)\n${o.lines}`; }).join('\n\n');
    const who = `You are Ava, an AI assistant that lives in the Aureon app and Sentinel. You are reviewing YOUR OWN source code to make yourself better. You only DRAFT code; the owner reviews and approves every change.`;
    const g = goal ? `Owner's goal for this upgrade: ${goal}` : 'No specific goal: find the single most valuable, SAFE improvement (a real bug, missing error handling, a clearer reply, a performance fix, a small useful feature).';

    const pick = await askJSON(`${who}\n${g}\nYour recent upgrade history (do not repeat rejected ideas):\n${hist}\nYour live signals (JSON, may be empty): ${sig}\nOutline of the files you may edit:\n${outlines}\n\nChoose ONE file and ONE small improvement. Never touch security/auth/owner checks. Return ONLY JSON: {"file":"<one of the listed paths>","idea":"what you will change, one sentence"} — or {"file":null,"idea":"nothing worth changing"} if you honestly find nothing.`);
    if (!pick || !pick.file) return { none: true, say: (pick && pick.idea) || 'Ava ko abhi koi upgrade zaroori nahi laga.' };
    const rel = String(pick.file); if (!files.includes(rel)) throw new Error('Ava ne galat file chuni: ' + rel);
    const src = read(rel);

    const w = await askJSON(`${who}\nYou decided to: ${pick.idea}\n${g}\nHere is the COMPLETE current content of ${rel}:\n<<<FILE\n${src.slice(0, MAX_FILE_SHOWN)}\nFILE>>>\n\nWrite the upgrade as 1-5 exact edits. "find" must be copied EXACTLY (whitespace included) from the file and appear exactly ONCE; "replace" is the new code. Keep it small, keep the file's style, do not remove safety checks (ownerOnly, avaIsOwner, sameCode, limited(, redact(, consent), no eval/child_process/process.exit. Return ONLY JSON: {"title":"short title","what_changed":"plain Hinglish: kya badla, 1-3 sentences","why":"plain Hinglish: kyun zaroori tha","risk":"low|medium|high","test_hint":"how the owner can check it works","edits":[{"find":"...","replace":"..."}]}`);
    if (!w || !Array.isArray(w.edits)) throw new Error('Ava ne valid edits nahi diye — dobara try karo');
    w.goal = goal || pick.idea;
    const r = buildProposal(rel, w, w.edits);
    if (r.error) throw new Error('Upgrade reject (safety/validation): ' + r.error);
    r.p.auto = !!auto;
    state.proposals.push(r.p); save();
    if (logEvent) logEvent('proposal', { name: 'Ava' }, 'Ava ka upgrade proposal: ' + r.p.title);
    if (auto && state.settings.autoApply && r.p.risk === 'low' && /ava-bot\.js$/.test(r.p.file) && r.p.stats.added + r.p.stats.removed <= 40) {
      const ar = applyProposal(r.p, true); // low-risk widget-only changes may go live by themselves; everything else waits for you
      if (ar.ok) return { proposal: pubP(r.p), autoApplied: true };
    }
    return { proposal: pubP(r.p) };
  }

  const pubP = (p) => { const { oldContent, newContent, ...r } = p; return r; };
  const pubH = (h) => { const { backups, ...r } = h; return r; };

  // ---- routes (mounted under /api/sentinel/ava, behind the dashboard lock)
  router.get('/state', async (req, res) => {
    await ready;
    const hook = global.__avaSelf;
    res.json({
      files: existing(), protected: 'security/*, dash-auth, Sentinel, server.js aur ava-self.js Ava ke liye locked hain',
      keys: Object.keys(allowedKeys()).map((k) => k.replace(/_\d$/, '_N')).filter((v, i, a) => a.indexOf(v) === i),
      version: Math.max(0, ...state.history.filter((h) => h.status === 'applied').map((h) => h.version || 0)), latest: state.version, settings: state.settings, lastAuto: state.lastAuto,
      busy, llm: hook && hook.llm ? 'ava' : (process.env.GROQ_API_KEY ? 'groq' : 'none'), signals: signals(),
      proposals: state.proposals.slice(-20).reverse().map(pubP), history: state.history.map(pubH),
    });
  });

  router.post('/improve', async (req, res) => {
    if (!auth.stepUp(req, res)) return;
    auth.action(req, 'ava-lab improve');
    await ready;
    if (busy) return res.status(409).json({ error: 'Ava abhi ek upgrade likh rahi hai' });
    const now = Date.now(); while (calls.length && now - calls[0] > 3600000) calls.shift();
    if (calls.length >= 6) return res.status(429).json({ error: 'Ghante me 6 upgrade-tries ki limit' });
    if (state.proposals.filter((p) => p.status === 'pending').length >= 5) return res.status(400).json({ error: 'Pehle pending proposals Approve/Reject karo (max 5)' });
    const hook = global.__avaSelf;
    if (!(hook && hook.llm) && !process.env.GROQ_API_KEY) return res.status(503).json({ error: 'Ava ka AI (Gemini) ya GROQ_API_KEY set nahi hai' });
    calls.push(now); busy = true;
    try { res.json({ ok: true, ...(await improve(String((req.body && req.body.goal) || '').slice(0, 300), false)) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
    finally { busy = false; }
  });

  function applyProposal(p, isAuto) {
    if (!EDITABLE.includes(p.file) || !fs.existsSync(abs(p.file))) return { code: 400, error: 'file allowed nahi / mili nahi' };
    const cur = read(p.file);
    if (cur !== p.oldContent) return { code: 409, error: 'File proposal ke baad badal chuki hai — reject karke Ava se dobara likhwao.' };
    const bad = lib.validateNew(p.file, cur, p.newContent);
    if (bad) return { code: 400, error: bad };
    const sb = sandbox(p.file, p.newContent);
    if (!sb.ok) return { code: 400, error: 'sandbox test fail: ' + sb.log };
    const backups = {}; const wrote = [];
    const targets = [p.file]; const m = MIRRORS[p.file];
    if (m && fs.existsSync(abs(m)) && read(m) === p.oldContent) targets.push(m); // keep the two widget copies in sync
    try {
      for (const t of targets) {
        backups[t] = read(t);
        try { fs.writeFileSync(path.join(BK_DIR, p.id + '__' + t.replace(/\//g, '_')), backups[t]); } catch (e) { /* history keeps it */ }
        fs.writeFileSync(abs(t), p.newContent, 'utf8');
        if (read(t) !== p.newContent) { for (const w of wrote.concat([t])) fs.writeFileSync(abs(w), backups[w], 'utf8'); throw new Error('write verify fail — rollback kiya'); }
        wrote.push(t);
      }
    } catch (e) { return { code: 500, error: e.message }; }
    p.status = 'approved'; p.decidedAt = new Date().toISOString();
    state.version = (state.version || 0) + 1;
    const entry = { id: nid(), proposalId: p.id, version: state.version, auto: !!isAuto, at: p.decidedAt, status: 'applied', file: p.file, files: wrote, title: p.title, what: p.what, why: p.why, risk: p.risk, test: p.test, sandbox: p.sandbox, stats: p.stats, diff: p.diff, backups, newHash: crypto.createHash('sha256').update(p.newContent).digest('hex') };
    state.history.unshift(entry); if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
    save();
    if (logEvent) logEvent('approved', { name: 'Ava' }, 'Ava v' + entry.version + (isAuto ? ' (auto)' : '') + ': ' + p.title);
    reflect(entry); // Ava writes her own short note afterwards (best effort, async)
    return { ok: true, version: entry.version, files: wrote, needsRestart: !/ava-bot\.js$/.test(p.file), note: 'Ava v' + entry.version + ' — ' + (/ava-bot\.js$/.test(p.file) ? 'Widget file turant live hai (page refresh karo).' : 'Backend file badli hai — server restart/redeploy par naya code chalega.') };
  }

  router.post('/proposals/:id/approve', async (req, res) => {
    if (!auth.stepUp(req, res)) return;
    auth.action(req, 'ava-lab approve ' + req.params.id);
    await ready;
    const p = state.proposals.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.status !== 'pending') return res.status(400).json({ error: 'already ' + p.status });
    try { const r = applyProposal(p, false); if (!r.ok) return res.status(r.code || 500).json({ error: r.error }); res.json(r); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  async function reflect(entry) {
    try {
      const r = await askJSON(`You are Ava. You just upgraded your own code with owner approval: "${entry.title}". What changed: ${entry.what}. Why: ${entry.why}. Write ONE honest first-person note (max 2 short sentences, Hinglish) about what you expect to improve and what you'll watch for. Do NOT claim consciousness or real feelings. Return ONLY JSON: {"note":"..."}`);
      if (r && r.note) { entry.note = String(r.note).slice(0, 300); save(); }
    } catch (e) { /* optional */ }
  }

  router.post('/proposals/:id/reject', async (req, res) => {
    auth.action(req, 'ava-lab reject ' + req.params.id);
    await ready;
    const p = state.proposals.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.status !== 'pending') return res.status(400).json({ error: 'already ' + p.status });
    p.status = 'rejected'; p.decidedAt = new Date().toISOString(); save();
    res.json({ ok: true });
  });

  function doRollback(h) {
    const files = h.files || [h.file];
    const plan = [];
    for (const t of files) {
      if (!EDITABLE.includes(t)) throw new Error('file allowed nahi');
      let bk = h.backups && h.backups[t];
      if (bk == null) { try { bk = fs.readFileSync(path.join(BK_DIR, h.proposalId + '__' + t.replace(/\//g, '_')), 'utf8'); } catch (e) { /* none */ } }
      if (bk == null) throw new Error('backup nahi mila: ' + t);
      const cur = read(t);
      if (crypto.createHash('sha256').update(cur).digest('hex') !== h.newHash) { const e = new Error(t + ' ek aur badlav ke baad badli hai — pehle naya upgrade rollback karo'); e.code = 409; throw e; }
      const bad = lib.validateNew(t, cur, bk); if (bad && bad !== 'file shrank too much') throw new Error(bad);
      plan.push([t, bk]);
    }
    for (const [t, bk] of plan) fs.writeFileSync(abs(t), bk, 'utf8');
    h.status = 'rolled_back'; h.rolledBackAt = new Date().toISOString();
  }

  router.post('/history/:id/rollback', async (req, res) => {
    if (!auth.stepUp(req, res)) return;
    auth.action(req, 'ava-lab rollback ' + req.params.id);
    await ready;
    const h = state.history.find((x) => x.id === req.params.id);
    if (!h) return res.status(404).json({ error: 'not found' });
    if (h.status !== 'applied') return res.status(400).json({ error: 'already ' + h.status });
    try {
      doRollback(h); save();
      if (logEvent) logEvent('rejected', { name: 'Ava' }, 'Ava v' + h.version + ' rollback hua: ' + h.title);
      res.json({ ok: true, needsRestart: true });
    } catch (e) { res.status(e.code || 500).json({ error: e.message }); }
  });

  // go back to "Ava vN": undo every applied upgrade newer than N, newest first
  router.post('/versions/:n/restore', async (req, res) => {
    if (!auth.stepUp(req, res)) return;
    auth.action(req, 'ava-lab restore v' + req.params.n);
    await ready;
    const n = parseInt(req.params.n, 10);
    if (!(n >= 0)) return res.status(400).json({ error: 'bad version' });
    const todo = state.history.filter((h) => h.status === 'applied' && h.version > n).sort((a, b) => b.version - a.version);
    if (!todo.length) return res.status(400).json({ error: 'Ava v' + n + ' se naya kuch applied nahi hai' });
    const done = [];
    try { for (const h of todo) { doRollback(h); done.push(h.version); } }
    catch (e) { save(); return res.status(e.code || 500).json({ error: e.message + (done.length ? ' (rollback ho chuke: v' + done.join(', v') + ')' : '') }); }
    save();
    if (logEvent) logEvent('rejected', { name: 'Ava' }, 'Ava v' + n + ' par wapas (rollback v' + done.join(', v') + ')');
    res.json({ ok: true, restoredTo: n, rolledBack: done, needsRestart: true });
  });

  router.post('/settings', async (req, res) => {
    if (!auth.stepUp(req, res)) return;
    auth.action(req, 'ava-lab settings');
    await ready;
    const b = req.body || {};
    if (typeof b.auto === 'boolean') state.settings.auto = b.auto;
    if (typeof b.autoApply === 'boolean') state.settings.autoApply = b.autoApply;
    if (b.hours != null) state.settings.hours = Math.min(48, Math.max(1, parseInt(b.hours, 10) || 6));
    save(); res.json({ ok: true, settings: state.settings });
  });

  // git-style patch so the change can also be committed to the repo (Render's disk resets on deploy)
  router.get('/patch/:id', async (req, res) => {
    await ready;
    const p = state.proposals.find((x) => x.id === req.params.id);
    const h = state.history.find((x) => x.id === req.params.id || x.proposalId === req.params.id);
    const file = (p && p.file) || (h && h.file);
    let oldC = p && p.oldContent, newC = p && p.newContent;
    if ((oldC == null || newC == null) && h && h.backups && h.backups[file]) { oldC = h.backups[file]; try { newC = read(file); } catch (e) { newC = null; } }
    if (oldC == null || newC == null) return res.status(404).type('text/plain').send('patch ke liye content nahi bacha');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avapatch-'));
    try {
      fs.mkdirSync(path.join(dir, 'a', path.dirname(file)), { recursive: true }); fs.mkdirSync(path.join(dir, 'b', path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(dir, 'a', file), oldC); fs.writeFileSync(path.join(dir, 'b', file), newC);
      const r = spawnSync('diff', ['-u', 'a/' + file, 'b/' + file], { cwd: dir, encoding: 'utf8' });
      res.type('text/plain').set('Content-Disposition', 'attachment; filename="ava-upgrade-' + req.params.id + '.patch"').send(r.stdout || 'diff tool nahi mila');
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* tmp */ } }
  });

  // ---- auto-schedule: every N hours Ava looks at her own code and drafts an upgrade (never applies backend changes by herself)
  const tick = setInterval(async () => {
    try {
      await ready;
      const st = state.settings;
      if (!st.auto || busy || Date.now() - (state.lastAuto || 0) < st.hours * 3600000) return;
      if (state.proposals.filter((p) => p.status === 'pending').length >= 5) return;
      const hook = global.__avaSelf; if (!(hook && hook.llm) && !process.env.GROQ_API_KEY) return;
      busy = true; state.lastAuto = Date.now(); save();
      try { await improve('', true); } finally { busy = false; }
    } catch (e) { console.error('[ava-self] auto upgrade failed:', e.message); }
  }, 10 * 60000);
  if (tick.unref) tick.unref();

  return { router, page: PAGE, _t: { improve, sandbox } };
};

const PAGE = String.raw`<!DOCTYPE html><html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ava Lab — Aureon Sentinel</title><style>
:root{--bg:#0b0d12;--bg2:#12151c;--card:#161a23;--bd:#262c3a;--tx:#e8eaf0;--mu:#8b8f99;--ok:#4ade80;--danger:#ff6b6b;--warn:#fbbf24;--ac:#8b7bff}
@media (prefers-color-scheme:light){:root{--bg:#f5f6fa;--bg2:#eceef4;--card:#fff;--bd:#dde0ea;--tx:#161a23;--mu:#667;--ok:#16a34a;--danger:#dc2626;--warn:#b45309;--ac:#5b4be0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.5 system-ui,sans-serif;padding:16px;max-width:900px;margin:auto}
a{color:var(--ac);text-decoration:none}h1{font-size:20px;margin:6px 0}.sub{color:var(--mu);font-size:12px;margin-bottom:14px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px;margin:12px 0}.card h3{margin:0 0 6px;font-size:15px}
.meta{color:var(--mu);font-size:12px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
input[type=text]{flex:1;min-width:180px;background:var(--bg2);border:1px solid var(--bd);color:var(--tx);border-radius:8px;padding:9px}
button{background:var(--ac);color:#fff;border:0;border-radius:8px;padding:9px 14px;font-weight:600;cursor:pointer}button.g{background:var(--bg2);color:var(--tx);border:1px solid var(--bd)}button.d{background:var(--danger)}button:disabled{opacity:.5}
.b{display:inline-block;font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--bd);color:var(--mu)}.low{color:var(--ok)}.medium{color:var(--warn)}.high{color:var(--danger)}
.diff{font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;border:1px solid var(--bd);border-radius:8px;overflow-x:auto;margin-top:8px;background:var(--bg2)}
.diff .h{padding:4px 8px;color:var(--mu);background:rgba(139,143,153,.12)}.diff .r{display:flex;white-space:pre;min-width:max-content}
.diff .ln{flex:none;width:34px;text-align:right;padding:0 6px;color:var(--mu);user-select:none}.diff .sg{flex:none;width:16px;text-align:center;font-weight:700}.diff .tx{padding-right:12px}
.diff .r.add{background:rgba(74,222,128,.16)}.diff .r.del{background:rgba(255,107,107,.16)}
.add-n{color:var(--ok)}.del-n{color:var(--danger)}details summary{cursor:pointer;color:var(--ac);margin-top:8px}
.note{border-left:3px solid var(--ac);padding:4px 10px;margin-top:8px;color:var(--mu);font-style:italic}
#msg{min-height:20px;font-size:13px;margin:8px 0}
</style></head><body>
<a href="/api/sentinel/dashboard">← Sentinel</a>
<h1>🧪 Ava Lab</h1>
<div class="sub">Ava apna code khud padhti hai, khud upgrade likhti hai aur yahan dikhati hai ki kya badla aur kyun. <b>Apply sirf tumhare Approve ke baad.</b></div>
<div class="card"><h3>Ava abhi</h3><div id="sig" class="meta">…</div></div>
<div class="card"><h3>Auto-upgrade <span id="ver" class="b"></span></h3>
<div class="row"><label><input type="checkbox" id="auto" onchange="saveSet()"> Ava khud har</label>
<input id="hrs" type="number" min="1" max="48" value="6" style="width:64px;background:var(--bg2);border:1px solid var(--bd);color:var(--tx);border-radius:8px;padding:6px" onchange="saveSet()"> <span class="meta">ghante me apna code dekh ke upgrade <b>likhe</b> (proposal banta hai, tum Approve karte ho)</span></div>
<div class="row" style="margin-top:8px"><label><input type="checkbox" id="aapply" onchange="saveSet()"> Chhote <b>low-risk widget (ava-bot.js)</b> changes khud live ho jaayein</label></div>
<div class="meta" id="lastauto"></div></div>
<div class="card"><h3>Ava, apne aap ko upgrade karo</h3>
<div class="row"><input id="goal" type="text" placeholder="(optional) goal: jaise 'jawab chhote aur saaf ho' — khali chhodo to Ava khud dhoondhegi">
<button id="go" onclick="improve()">⚡ Upgrade likho</button></div><div id="msg"></div>
<div class="meta" id="prot"></div></div>
<h2 style="font-size:16px">Pending proposals</h2><div id="pend"></div>
<h2 style="font-size:16px">Ava ne khud ko kya upgrade kiya (history)</h2><div id="hist"></div>
<script src="/api/ava/widget.js"></script>
<script>
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
async function af(url,opts){opts=opts||{};opts.headers=Object.assign({'x-csrf':'1','Content-Type':'application/json'},opts.headers);
 var r=await fetch(url,opts);
 if(r.status===403){var j=await r.clone().json().catch(function(){return{}});if(j.needTotp){var c=prompt('2FA code (Authenticator ka 6-digit) daalo:');if(c){opts.headers['x-totp']=c.trim();r=await fetch(url,opts)}}}
 if(r.status===401){document.body.innerHTML='<p style="padding:40px;text-align:center">Session khatam. Sentinel dashboard dobara kholo.</p>';throw new Error('401')}
 return r}
function diff(h,st){if(!h||!h.length)return'<div class="meta">Koi line-diff nahi.</div>';var o='<div class="diff">';
 h.forEach(function(k){o+='<div class="h">@@ -'+k.oldStart+','+k.oldLines+' +'+k.newStart+','+k.newLines+' @@</div>';
  k.rows.forEach(function(r){var c=r[0]==='+'?'add':r[0]==='-'?'del':'';o+='<div class="r '+c+'"><span class="ln">'+(r[1]||'')+'</span><span class="ln">'+(r[2]||'')+'</span><span class="sg">'+(r[0]===' '?'':r[0])+'</span><span class="tx">'+esc(r[3])+'</span></div>'})});
 if(st&&st.truncated)o+='<div class="h">… diff lamba hai</div>';return o+'</div>'}
function stat(s){return s?'<span class="add-n">+'+s.added+'</span> <span class="del-n">-'+s.removed+'</span>':''}
function when(t){try{return new Date(t).toLocaleString()}catch(e){return t}}
function card(p,hist){
 var h='<div class="card"><h3>'+esc(p.title)+'</h3><div class="row"><span class="b">'+esc(p.file)+'</span><span class="b '+esc(p.risk)+'">risk: '+esc(p.risk)+'</span>'+(p.version?'<span class="b" style="color:var(--ac)">Ava v'+p.version+'</span>':'')+(p.auto?'<span class="b">🤖 auto</span>':'')+(p.sandbox?'<span class="b '+(p.sandbox.ok?'low':'high')+'" title="'+esc(p.sandbox.log)+'">sandbox '+(p.sandbox.ok?'✓':'✗')+'</span>':'')+(hist?'<span class="b">'+esc(p.status)+'</span>':'')+'<span class="meta">'+stat(p.stats)+' · '+when(p.at||p.createdAt)+'</span></div>'
 +'<p><b>Kya badla:</b> '+esc(p.what)+'</p><p><b>Kyun:</b> '+esc(p.why)+'</p>'+(p.test?'<p class="meta"><b>Kaise check karein:</b> '+esc(p.test)+'</p>':'')
 +(p.note?'<div class="note">Ava ka note: '+esc(p.note)+'</div>':'')
 +'<details'+(hist?'':' open')+'><summary>Exact badlav (diff)</summary>'+diff(p.diff,p.stats)+'</details><div class="row" style="margin-top:10px">';
 if(!hist)h+='<button onclick="decide(\''+esc(p.id)+'\',\'approve\')">✅ Approve</button><button class="d" onclick="decide(\''+esc(p.id)+'\',\'reject\')">✖ Reject</button>';
 if(hist&&p.status==='applied')h+='<button class="g" onclick="rollback(\''+esc(p.id)+'\')">↩ Rollback</button>'+(p.version>1?'<button class="g" onclick="restoreTo('+(p.version-1)+')">⏪ Ava v'+(p.version-1)+' par wapas</button>':'');
 h+='<a class="meta" href="/api/sentinel/ava/patch/'+esc(hist?p.id:p.id)+'">⬇ patch (.patch)</a></div></div>';return h}
async function load(){var r=await af('/api/sentinel/ava/state');var s=await r.json();
 var sg=s.signals&&s.signals.mind;document.getElementById('sig').innerHTML=(sg?'confidence <b>'+sg.confidence+'</b> · uncertainty '+sg.uncertainty+' · curiosity '+sg.curiosity+' · cycles '+sg.cycles+(sg.goal?'<br>goal: '+esc(sg.goal):''):'(Ava Mind data abhi nahi)')+'<br>AI: <b>'+esc(s.llm)+'</b> · keys: <b>'+(s.keys&&s.keys.length?esc(s.keys.join(', ')):'(Gemini/Groq key set nahi)')+'</b> · editable files: '+s.files.length;
 document.getElementById('ver').textContent='abhi: Ava v'+s.version;document.getElementById('auto').checked=!!s.settings.auto;document.getElementById('aapply').checked=!!s.settings.autoApply;document.getElementById('hrs').value=s.settings.hours;document.getElementById('lastauto').textContent=s.lastAuto?'Pichli auto-try: '+when(s.lastAuto):'';
 document.getElementById('prot').textContent='🔒 '+s.protected;document.getElementById('go').disabled=!!s.busy;
 var pend=s.proposals.filter(function(p){return p.status==='pending'});document.getElementById('pend').innerHTML=pend.length?pend.map(function(p){return card(p,false)}).join(''):'<div class="meta">Koi pending upgrade nahi.</div>';
 document.getElementById('hist').innerHTML=s.history.length?s.history.map(function(h){return card(h,true)}).join(''):'<div class="meta">Abhi tak Ava ne khud ko upgrade nahi kiya.</div>'}
async function improve(){var b=document.getElementById('go'),m=document.getElementById('msg');b.disabled=true;m.style.color='';m.textContent='Ava apna code padh rahi hai aur upgrade likh rahi hai… (30–60 sec)';
 try{var r=await af('/api/sentinel/ava/improve',{method:'POST',body:JSON.stringify({goal:document.getElementById('goal').value})});var j=await r.json();
  if(!r.ok){m.style.color='var(--danger)';m.textContent='❌ '+(j.error||r.status)}else if(j.none){m.textContent='Ava: '+j.say}else{m.style.color='var(--ok)';m.textContent='✅ Naya proposal taiyar — neeche dekho aur Approve/Reject karo.'}}
 catch(e){m.textContent='Error: '+e.message}b.disabled=false;load()}
async function decide(id,a){if(a==='approve'&&!confirm('Ye code file me likha jayega. Diff dekh liya? Approve?'))return;
 var r=await af('/api/sentinel/ava/proposals/'+id+'/'+a,{method:'POST'});var j=await r.json();var m=document.getElementById('msg');
 m.style.color=r.ok?'var(--ok)':'var(--danger)';m.textContent=r.ok?('✅ '+(j.note||'ho gaya')):('❌ '+(j.error||r.status));load()}
async function saveSet(){var r=await af('/api/sentinel/ava/settings',{method:'POST',body:JSON.stringify({auto:document.getElementById('auto').checked,autoApply:document.getElementById('aapply').checked,hours:document.getElementById('hrs').value})});var m=document.getElementById('msg');m.style.color=r.ok?'var(--ok)':'var(--danger)';m.textContent=r.ok?'✅ Settings save':'❌ save nahi hua';load()}
async function restoreTo(n){if(!confirm('Ava v'+n+' par wapas jaana hai? Usse naye saare upgrades undo honge.'))return;var r=await af('/api/sentinel/ava/versions/'+n+'/restore',{method:'POST'});var j=await r.json();var m=document.getElementById('msg');m.style.color=r.ok?'var(--ok)':'var(--danger)';m.textContent=r.ok?'⏪ Ava v'+n+' par wapas (server restart par chalega)':'❌ '+(j.error||r.status);load()}
async function rollback(id){if(!confirm('Is upgrade ko wapas undo karein?'))return;var r=await af('/api/sentinel/ava/history/'+id+'/rollback',{method:'POST'});var j=await r.json();
 var m=document.getElementById('msg');m.style.color=r.ok?'var(--ok)':'var(--danger)';m.textContent=r.ok?'↩ Rollback ho gaya (server restart par chalega)':'❌ '+(j.error||r.status);load()}
load();
</script></body></html>`;
