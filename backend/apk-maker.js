// backend/apk-maker.js — "APK Studio": describe any app in words -> AI writes it -> GitHub Actions builds a real APK.
//
// Flow (nothing is built on Render itself — it has no Android SDK):
//   1. POST /api/apk/generate {prompt, name?, whatsapp?}  -> Gemini writes a complete mobile app (single index.html)
//   2. the files are committed to a SEPARATE branch (default "apk-apps") of APK_GH_REPO  -> Render does NOT redeploy
//   3. the workflow .github/workflows/build-generated-apk.yml is dispatched (Capacitor wrapper + gradle assembleDebug)
//   4. GET /api/apk/jobs shows live status; GET /api/apk/jobs/:id/download streams the finished .apk
//   Also: POST /api/apk/aureon builds Aureon's own APK (existing build-apk.yml), POST /api/apk/jobs/:id/revise changes an app.
// Everything sits behind the same owner lock as the Sentinel dashboard (dash-auth.js).
//
// Env on Render:  GITHUB_TOKEN (fine-grained: Contents RW + Actions RW on the repo)   APK_GH_REPO=owner/repo
//                 optional: APK_APPS_BRANCH (default apk-apps)
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = path.join(__dirname, 'sentinel-data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* read-only disk is fine */ }
const JOBS_FILE = path.join(DATA_DIR, 'apk-jobs.json');

const GEN_WORKFLOW = 'build-generated-apk.yml';
const AUREON_WORKFLOW = 'build-apk.yml';
const MAX_JOBS = 40;

// ------------------------------------------------------------------ pure helpers (unit-tested)
function slugify(s) {
  const t = String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28);
  return t || 'app';
}
// every package segment must start with a letter and must not be a Java keyword -> always prefix with "a"
function appIdFor(slug) { return 'com.aureon.gen.a' + String(slug).replace(/[^a-z0-9]/g, '').slice(0, 30); }
const isHex = (c) => /^#[0-9a-f]{6}$/i.test(String(c || ''));

// Gemini answers in a delimited format (a JSON-wrapped 40 KB HTML file breaks far too often):
//   ===META===\nname: ..\ncolor: #rrggbb\n===FILE index.html===\n<html>..\n===END===
function parseGenerated(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const meta = {}; const files = {};
  let mode = null, cur = null, buf = [];
  const flush = () => {
    if (cur) {
      let body = buf.join('\n').replace(/^\s*```[a-z]*\n/i, '').replace(/\n```\s*$/i, '');
      files[cur] = body.trim() + '\n';
    }
    cur = null; buf = [];
  };
  for (const line of lines) {
    const f = line.match(/^===FILE\s+([^=\n]+?)\s*===\s*$/);
    if (/^===META===\s*$/.test(line)) { flush(); mode = 'meta'; continue; }
    if (f) { flush(); mode = 'file'; cur = f[1].trim(); continue; }
    if (/^===END===\s*$/.test(line)) { flush(); mode = null; continue; }
    if (mode === 'meta') { const m = line.match(/^(\w+):\s*(.+)$/); if (m) meta[m[1].toLowerCase()] = m[2].trim(); }
    else if (mode === 'file') buf.push(line);
  }
  flush();
  return { meta, files };
}
const SAFE_FILE = /^[a-z0-9_\-]+(\/[a-z0-9_\-]+)*\.(html|css|js|json|svg)$/i;
function validateFiles(files) {
  const names = Object.keys(files || {});
  if (!files['index.html']) return 'index.html missing';
  if (names.length > 8) return 'too many files';
  for (const n of names) if (!SAFE_FILE.test(n) || n.includes('..')) return 'bad file name: ' + n;
  const html = files['index.html'];
  if (html.length < 800) return 'index.html too short';
  if (!/<\/html>/i.test(html)) return 'index.html was cut off (no </html>)';
  if (!/viewport/i.test(html)) return 'no viewport meta';
  return null;
}

// ---- minimal ZIP reader (GitHub artifacts are plain zips) — no extra dependency
function unzipFirst(buf, pred) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    if (pred(name)) {
      const ln = buf.readUInt16LE(lho + 26), le = buf.readUInt16LE(lho + 28);
      const data = buf.slice(lho + 30 + ln + le, lho + 30 + ln + le + csize);
      return { name, data: method === 0 ? data : zlib.inflateRawSync(data) };
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}

// ------------------------------------------------------------------ the AI prompt
const SYSTEM = [
  'You are a senior mobile product designer + front-end engineer. You build COMPLETE, polished, fully working mobile apps as ONE self-contained web file that is wrapped into an Android APK (Capacitor WebView).',
  'Style rules: output ONLY the delimited format at the bottom — no chat, no explanation, no markdown fences.',
  '',
  'QUALITY BAR (this is what makes the app feel real, not a demo):',
  '- Single file index.html with inline <style> and <script>. NO build step, NO external CDN, NO external images/fonts (app must work offline). Use inline SVG, emoji, CSS gradients and a refined colour palette for visuals. System font stack.',
  '- <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">. Mobile-first (360–430 px), safe-area padding with env(safe-area-inset-*), touch targets >= 44 px, smooth transitions, ripple/press feedback, skeleton/empty states, toasts (never alert()).',
  '- Respect prefers-color-scheme (light + dark) via CSS variables. One strong accent colour; consistent spacing, rounded cards, subtle shadows, clear typography hierarchy.',
  '- EVERYTHING must actually work: navigation, search, filters, forms with validation, add/edit/delete, counters, totals. No dead buttons, no lorem ipsum, no "coming soon".',
  '- Persist data in localStorage (wrap every access in try/catch). Seed realistic sample data (catalogs: at least 12 items with names, prices, ratings, categories, emoji or SVG art).',
  '- Multi-screen apps: bottom tab bar or clean top-level navigation; handle the Android BACK button with history.pushState + popstate so back goes to the previous screen instead of closing the app.',
  '- E-commerce apps include: home with banner + categories, product grid with search/sort/filter, product detail with quantity, wishlist, cart with quantity/remove/coupon, checkout form (name, phone, address), order summary, order history, profile. If a WhatsApp number is provided, "Place order" must open https://wa.me/<number>?text=<url-encoded order summary>; otherwise store the order locally and show a success screen. Never pretend to take real card payments.',
  '- Currency: use the one the user asks for; default ₹ for Indian users. UI language: the language the user asks for (default English; Hinglish labels are fine if they ask in Hinglish).',
  '- Accessible: labels, contrast, focus states. No console errors. No eval, no document.write.',
  '- Keep the file complete but compact (aim for 25–60 KB). It MUST end with </html>.',
  '',
  'OUTPUT FORMAT (exactly):',
  '===META===',
  'name: <short app name, 1-3 words>',
  'color: <#RRGGBB main accent colour>',
  '===FILE index.html===',
  '<!DOCTYPE html> ... </html>',
  '===END===',
].join('\n');

function buildUserPrompt({ prompt, name, whatsapp, existing, instruction }) {
  const wa = String(whatsapp || '').replace(/[^0-9]/g, '');
  if (existing) {
    return 'Here is the current app (index.html). Apply the requested change and return the FULL updated file in the exact output format. Keep everything that already works.\n\nREQUESTED CHANGE:\n' +
      String(instruction || '').slice(0, 2000) + '\n\nCURRENT index.html:\n' + existing.slice(0, 120000);
  }
  return 'Build this app:\n' + String(prompt || '').slice(0, 3000) +
    (name ? '\n\nApp name: ' + name : '') + (wa ? '\n\nWhatsApp number for orders/contact (digits, with country code): ' + wa : '');
}

// ------------------------------------------------------------------ factory
let current = null;
function factory(opts) {
  const o = opts || {};
  const auth = o.auth, store = o.store, callGemini = o.callGemini;
  const doFetch = o.fetchImpl || ((...a) => fetch(...a));
  const GH = o.ghBase || 'https://api.github.com';
  let notify = o.notify;
  if (!notify) { try { const n = require('./security/notify'); notify = (s, t) => n.sendAlert(s, t, { urgent: true }); } catch (e) { notify = async () => false; } }

  const repo = () => process.env.APK_GH_REPO || '';
  const token = () => process.env.GITHUB_TOKEN || '';
  const appsBranch = () => process.env.APK_APPS_BRANCH || 'apk-apps';
  const configured = () => !!(repo() && token());

  let jobs = [];
  const ready = (async () => {
    try { if (store && store.whenFirestore) await store.whenFirestore(20000); } catch (e) { /* ignore */ }
    try {
      const r = store && await store.load('apk_jobs', JOBS_FILE);
      if (r && Array.isArray(r.value)) jobs = r.value;
    } catch (e) { console.error('[apk] load failed:', e.message); }
  })();
  const save = () => { ready.then(() => store && store.save('apk_jobs', jobs.slice(0, MAX_JOBS), JOBS_FILE)).catch(() => {}); };
  const touch = (j, patch) => { Object.assign(j, patch, { updatedAt: new Date().toISOString() }); save(); };

  // ---------------- GitHub
  async function gh(p, init) {
    if (!configured()) throw new Error('APK Studio setup baaki hai: Render me GITHUB_TOKEN aur APK_GH_REPO=owner/repo set karo');
    const res = await doFetch(GH + '/repos/' + repo() + p, Object.assign({}, init, {
      headers: Object.assign({ Authorization: 'Bearer ' + token(), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'aureon-apk-studio' }, init && init.headers),
    }));
    if (res.status === 204) return null;
    if (!res.ok) throw new Error('GitHub ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 220));
    const ct = String(res.headers.get('content-type') || '');
    return ct.includes('json') ? res.json() : res;
  }
  let defaultBranchCache = null;
  async function defaultBranch() {
    if (defaultBranchCache) return defaultBranchCache;
    const info = await gh('');
    defaultBranchCache = info.default_branch || 'main';
    return defaultBranchCache;
  }
  async function ensureAppsBranch() {
    const b = appsBranch();
    try { await gh('/git/ref/heads/' + encodeURIComponent(b)); return; } catch (e) { if (!/GitHub 404/.test(e.message)) throw e; }
    const base = await defaultBranch();
    const ref = await gh('/git/ref/heads/' + encodeURIComponent(base));
    await gh('/git/refs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'refs/heads/' + b, sha: ref.object.sha }) });
  }
  async function putFile(filePath, content, message) {
    const b = appsBranch();
    let sha;
    try { const cur = await gh('/contents/' + filePath + '?ref=' + encodeURIComponent(b)); sha = cur.sha; } catch (e) { if (!/GitHub 404/.test(e.message)) throw e; }
    await gh('/contents/' + filePath, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, content: Buffer.from(content, 'utf8').toString('base64'), branch: b, ...(sha ? { sha } : {}) }) });
  }
  async function readAppFile(slug, file) {
    const r = await gh('/contents/apps/' + slug + '/www/' + file + '?ref=' + encodeURIComponent(appsBranch()));
    return Buffer.from(r.content || '', 'base64').toString('utf8');
  }
  async function dispatch(workflow, inputs) {
    await gh('/actions/workflows/' + workflow + '/dispatches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: await defaultBranch(), inputs }) });
  }

  // ---------------- AI generation
  // Gemini first; when it is out of quota / key invalid / overloaded -> Groq (plain text) so a build never dies on one provider.
  const RATE = /quota|rate.?limit|429|resource_exhausted|too many requests|overloaded|unavailable|503|timeout|api key not valid|all \d+ keys failed/i;
  async function askAI(user) {
    let gemErr = null;
    try { const out = await callGemini([{ role: 'user', content: user }], SYSTEM, false); if (typeof out === 'string' && out.trim()) return out; gemErr = new Error('Gemini ne khaali jawab diya'); }
    catch (e) { gemErr = e; }
    try { return await require('./llm-text').groqText(user, { system: SYSTEM, maxTokens: 24000 }); }
    catch (e) { throw new Error('Gemini: ' + String(gemErr && gemErr.message || '').slice(0, 110) + ' | Groq: ' + String(e.message).slice(0, 110)); }
  }
  const REVIEW = 'You are now a senior mobile engineer + product designer doing a final review of the app below. Silently find the 8 weakest points (broken or dead interactions, missing validation, edge cases, empty/loading/error states, back-button handling, spacing/contrast/hierarchy, perceived polish, performance) and FIX them all. Return the COMPLETE improved app in the exact same output format (===META=== ... ===FILE index.html=== ... ===END===). Keep everything that works, keep it offline-capable and compact, and make sure it ends with </html>.\n\nCURRENT APP:\n';
  async function generate(args, tries, onStep) {
    const user = buildUserPrompt(args);
    let lastErr = 'AI se app nahi bana';
    let draft = null;
    for (let i = 0; i < (tries || 2) && !draft; i++) {
      const extra = i ? '\n\nIMPORTANT: your previous answer was invalid (' + lastErr + '). Return the complete file in the exact format and make sure it ends with </html>. Make it more compact if needed.' : '';
      const text = await askAI(user + extra);
      const parsed = parseGenerated(text);
      const bad = validateFiles(parsed.files);
      if (!bad) draft = parsed; else lastErr = bad;
    }
    if (!draft) throw new Error('AI ka jawab sahi format me nahi aaya (' + lastErr + '). Dobara try karo.');
    if (args.existing) return draft;                       // revisions are already a focused edit
    try {                                                  // quality pass (new apps only); keep the draft if the review is not valid / not better
      if (onStep) onStep('Ava apna kaam review karke polish kar rahi hai…');
      const rv = parseGenerated(await askAI(REVIEW + Object.entries(draft.files).map(([n, c]) => '===FILE ' + n + '===\n' + c).join('\n').slice(0, 90000)));
      if (!validateFiles(rv.files) && rv.files['index.html'].length >= draft.files['index.html'].length * 0.85) return { meta: Object.assign({}, draft.meta, rv.meta), files: rv.files };
    } catch (e) { /* keep the draft */ }
    return draft;
  }

  // ---------------- job pipeline
  const newId = () => crypto.randomBytes(4).toString('hex');
  const active = (j) => ['generating', 'committing', 'queued', 'building'].includes(j.status);
  function uniqueSlug(base) {
    let s = base, n = 2;
    while (jobs.some((j) => j.kind === 'generated' && j.slug === s)) { s = base + '-' + n++; }
    return s;
  }
  const fail = (j, e) => { touch(j, { status: 'failed', error: String(e && e.message || e).slice(0, 300) }); notifySafe(j); };
  function notifySafe(j) {
    const ok = j.status === 'done';
    Promise.resolve(notify(ok ? 'Aureon APK ready: ' + j.name : 'Aureon APK build failed: ' + j.name,
      ok ? j.name + ' ki APK tayyar hai. APK Studio kholo aur download karo.' : j.name + ' — ' + (j.error || 'build fail') + (j.runUrl ? '\nLogs: ' + j.runUrl : ''))).catch(() => {});
  }

  async function dispatchBuild(j) {
    touch(j, { status: 'queued', step: 'GitHub Actions ko bheja' });
    const when = Date.now();
    if (j.kind === 'aureon') await dispatch(AUREON_WORKFLOW, { jobId: j.id });
    else await dispatch(GEN_WORKFLOW, { slug: j.slug, appName: j.name, appId: j.appId, color: j.color || '#0E7C66', jobId: j.id, appsBranch: appsBranch() });
    touch(j, { dispatchedAt: when });
  }

  async function runGenerated(j, args, isRevision) {
    try {
      touch(j, { status: 'generating', step: 'AI app likh raha hai…' });
      let g = null;
      for (let attempt = 0; !g; attempt++) {          // patient: if every AI is out of quota, wait and retry (background) instead of failing
        try { g = await generate(args, 2, (step) => touch(j, { step })); }
        catch (e) {
          if (RATE.test(String(e.message)) && attempt < 6) { const wait = Math.min(60000 * 2 ** attempt, 900000); touch(j, { step: '⏳ AI quota/limit — ' + Math.round(wait / 60000) + ' min baad dobara (' + (attempt + 1) + '/6)' }); await new Promise((r) => setTimeout(r, wait)); touch(j, { step: 'AI app likh raha hai…' }); }
          else throw e;
        }
      }
      const name = String((args.name || g.meta.name || j.name || 'My App')).slice(0, 40);
      const color = isHex(g.meta.color) ? g.meta.color : (j.color || '#0E7C66');
      touch(j, { name, color, status: 'committing', step: 'Code GitHub me save ho raha hai…' });
      await ensureAppsBranch();
      for (const f of Object.keys(g.files)) await putFile('apps/' + j.slug + '/www/' + f, g.files[f], 'APK Studio: ' + j.slug + (isRevision ? ' (revise)' : ''));
      await putFile('apps/' + j.slug + '/app.json', JSON.stringify({ name, color, appId: j.appId, slug: j.slug, prompt: String(args.prompt || args.instruction || '').slice(0, 600), updatedAt: new Date().toISOString() }, null, 2) + '\n', 'APK Studio: ' + j.slug + ' meta');
      await dispatchBuild(j);
    } catch (e) { fail(j, e); }
  }

  // ---------------- status refresh
  async function findRun(j) {
    const wf = j.kind === 'aureon' ? AUREON_WORKFLOW : GEN_WORKFLOW;
    const r = await gh('/actions/workflows/' + wf + '/runs?event=workflow_dispatch&per_page=20');
    const runs = (r && r.workflow_runs) || [];
    return runs.find((x) => String(x.display_title || x.name || '').includes('APK ' + j.id)) || null;
  }
  async function refresh(j) {
    if (!['queued', 'building'].includes(j.status)) return;
    try {
      if (!j.runId) {
        const run = await findRun(j);
        if (!run) {
          if (Date.now() - (j.dispatchedAt || 0) > 4 * 60000) fail(j, 'GitHub Actions me run nahi mila — kya build-generated-apk.yml / build-apk.yml main branch par push hai?');
          return;
        }
        touch(j, { runId: run.id, runUrl: run.html_url });
      }
      const run = await gh('/actions/runs/' + j.runId);
      if (run.status === 'completed') {
        if (run.conclusion === 'success') { touch(j, { status: 'done', step: 'APK tayyar ✅' }); notifySafe(j); }
        else fail(j, 'Build fail hua (' + run.conclusion + ')');
      } else touch(j, { status: run.status === 'queued' ? 'queued' : 'building', step: run.status === 'queued' ? 'Line me hai…' : 'APK ban rahi hai (3–6 min)…' });
    } catch (e) { /* transient (rate limit / network): keep status, try again next tick */ }
  }
  async function refreshAll() { for (const j of jobs.filter(active)) await refresh(j); }
  const timer = setInterval(() => { refreshAll().catch(() => {}); }, 20000);
  if (timer.unref) timer.unref();

  async function fetchApk(j) {
    const arts = await gh('/actions/runs/' + j.runId + '/artifacts');
    const list = (arts && arts.artifacts) || [];
    const art = list.find((a) => !a.expired) || null;
    if (!art) throw new Error('APK artifact nahi mila (expire ho gaya ho sakta hai — dobara build karo)');
    const res = await doFetch(art.archive_download_url, { headers: { Authorization: 'Bearer ' + token(), Accept: 'application/vnd.github+json', 'User-Agent': 'aureon-apk-studio' } });
    if (!res.ok) throw new Error('artifact download ' + res.status);
    const zip = Buffer.from(await res.arrayBuffer());
    const apk = unzipFirst(zip, (n) => /\.apk$/i.test(n));
    if (!apk) throw new Error('zip me .apk nahi mili');
    return apk.data;
  }

  // ---------------- routes
  const router = express.Router();
  // Ava Code lives ONLY inside Ava Desktop: opened as a normal page it bounces to the desk (iframe loads carry Sec-Fetch-Dest: iframe).
  router.get('/studio', (req, res) => {
    if (String(req.headers['sec-fetch-dest'] || '') === 'document') return res.redirect(302, '/api/sentinel/ava-desk');
    auth.dashboard(req, res, () => res.type('html').send(STUDIO_HTML));
  });
  router.use(auth.apiGate);
  router.use((req, res, next) => (req.method === 'GET' || req.method === 'HEAD') ? next() : (auth.requireRole ? auth.requireRole('admin')(req, res, next) : next()));   // v9 operators: only admin may change things

  const pub = (j) => ({ id: j.id, kind: j.kind, name: j.name, slug: j.slug, status: j.status, step: j.step || '', error: j.error || '', runUrl: j.runUrl || '', createdAt: j.createdAt, updatedAt: j.updatedAt, color: j.color || '' });
  router.get('/status', (req, res) => res.json({ configured: configured(), repo: repo() ? repo().replace(/^[^/]+\//, '…/') : '', tokenSet: !!token(), branch: appsBranch() }));
  router.get('/jobs', async (req, res) => { await ready; await refreshAll().catch(() => {}); res.json(jobs.slice(0, MAX_JOBS).map(pub)); });

  function guard(req, res) {
    if (!auth.stepUp(req, res)) return false;
    if (!configured()) { res.status(400).json({ error: 'Setup baaki hai: Render → Environment me GITHUB_TOKEN aur APK_GH_REPO=owner/repo daalo' }); return false; }
    if (jobs.filter(active).length >= 3) { res.status(429).json({ error: 'Pehle se 3 builds chal rahe hain — thoda ruko' }); return false; }
    return true;
  }

  router.post('/generate', async (req, res) => {
    await ready;
    if (!guard(req, res)) return;
    const b = req.body || {};
    const prompt = String(b.prompt || '').trim();
    if (prompt.length < 8) return res.status(400).json({ error: 'App ke baare me thoda detail me likho (kam se kam 8 akshar)' });
    if (typeof callGemini !== 'function') return res.status(500).json({ error: 'AI not wired' });
    const name = String(b.name || '').trim().slice(0, 40);
    const slug = uniqueSlug(slugify(name || prompt.split(/\s+/).slice(0, 3).join(' ')));
    const j = { id: newId(), kind: 'generated', slug, origin: slug, appId: appIdFor(slug), name: name || 'New app', status: 'generating', step: 'Shuru…', createdAt: new Date().toISOString() };
    jobs.unshift(j); save(); auth.action(req, 'apk generate ' + slug);
    res.json(pub(j));
    runGenerated(j, { prompt, name, whatsapp: b.whatsapp }, false);   // runs in the background
  });

  router.post('/aureon', async (req, res) => {
    await ready;
    if (!guard(req, res)) return;
    const j = { id: newId(), kind: 'aureon', slug: 'aureon', appId: 'com.aureon.ai', name: 'Aureon', status: 'queued', step: 'Shuru…', createdAt: new Date().toISOString() };
    jobs.unshift(j); save(); auth.action(req, 'apk build aureon');
    res.json(pub(j));
    dispatchBuild(j).catch((e) => fail(j, e));
  });

  router.post('/jobs/:id/revise', async (req, res) => {
    await ready;
    const old = jobs.find((x) => x.id === req.params.id);
    if (!old || old.kind !== 'generated') return res.status(404).json({ error: 'app nahi mila' });
    if (!guard(req, res)) return;
    const instruction = String((req.body && req.body.instruction) || '').trim();
    if (instruction.length < 4) return res.status(400).json({ error: 'Kya badalna hai wo likho' });
    const j = { id: newId(), kind: 'generated', slug: old.slug, origin: old.slug, appId: old.appId, name: old.name, color: old.color, status: 'generating', step: 'Purana code padh raha hai…', createdAt: new Date().toISOString() };
    jobs.unshift(j); save(); auth.action(req, 'apk revise ' + old.slug);
    res.json(pub(j));
    (async () => {
      try { const existing = await readAppFile(old.slug, 'index.html'); await runGenerated(j, { existing, instruction, name: old.name }, true); }
      catch (e) { fail(j, e); }
    })();
  });

  router.get('/jobs/:id/source', async (req, res) => {
    try {
      const j = jobs.find((x) => x.id === req.params.id);
      if (!j || j.kind !== 'generated') return res.status(404).json({ error: 'app nahi mila' });
      res.setHeader('Content-Disposition', 'attachment; filename="' + j.slug + '-index.html"');
      res.type('text/plain').send(await readAppFile(j.slug, 'index.html'));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/jobs/:id/download', async (req, res) => {
    try {
      const j = jobs.find((x) => x.id === req.params.id);
      if (!j || j.status !== 'done' || !j.runId) return res.status(404).json({ error: 'APK abhi tayyar nahi hai' });
      auth.action(req, 'apk download ' + j.slug);
      const apk = await fetchApk(j);
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="' + (j.slug || 'app') + '-debug.apk"');
      res.setHeader('Content-Length', apk.length);
      res.end(apk);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.summary = () => {
    const act = jobs.filter(active);
    const done = jobs.find((x) => x.status === 'done');
    const bad = jobs.find((x) => x.status === 'failed');
    return { configured: configured(), building: act.map((x) => x.name), lastDone: done ? { name: done.name, at: done.updatedAt } : null, lastFailed: bad ? { name: bad.name, error: bad.error, at: bad.updatedAt } : null };
  };
  router._t = { jobs: () => jobs, refreshAll, ready };
  current = router;
  return router;
}

// ------------------------------------------------------------------ the studio page
const STUDIO_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Ava Code</title>
<style>
:root{--bg:#070914;--card:rgba(18,22,52,.62);--line:rgba(120,110,255,.30);--tx:#eef0ff;--mu:#9aa0c8;--gold:#8b7bff;--ok:#3ee0a0;--bad:#ff6b8b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:max(14px,env(safe-area-inset-top)) 14px 40px}
h1{font-size:19px;margin:6px 0 2px;background:linear-gradient(90deg,#c9b8ff,#7fe3ff);-webkit-background-clip:text;background-clip:text;color:transparent}body{background:radial-gradient(900px 520px at 6% -6%,rgba(139,92,246,.38),transparent 60%),radial-gradient(800px 520px at 104% 30%,rgba(34,211,238,.2),transparent 60%),#070914 fixed}.card{backdrop-filter:blur(14px);box-shadow:0 10px 34px rgba(8,5,38,.55),inset 0 0 26px rgba(139,123,255,.07)}.sub{color:var(--mu);font-size:12px;margin-bottom:14px}a{color:var(--gold)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:14px}
label{display:block;font-size:12px;color:var(--mu);margin:10px 0 4px}
textarea,input{width:100%;background:#101014;border:1px solid var(--line);color:var(--tx);border-radius:10px;padding:11px;font-size:15px;font-family:inherit}
textarea{min-height:110px;resize:vertical}
button{background:linear-gradient(135deg,#7c5cff,#3aa8ff);color:#fff;box-shadow:0 0 14px rgba(110,120,255,.35);border:0;border-radius:10px;padding:12px 14px;font-weight:700;font-size:14px;cursor:pointer}
button.ghost{background:#1d1d26;color:var(--tx);border:1px solid var(--line);font-weight:600;padding:9px 11px;font-size:13px}
button:disabled{opacity:.5}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.warn{background:#2a1c1c;border:1px solid #5a2c2c;color:#ffb3b3;border-radius:10px;padding:10px;font-size:13px;margin-bottom:14px}
.job{border-top:1px solid var(--line);padding:12px 0}.job:first-child{border-top:0}.top{display:flex;justify-content:space-between;gap:8px;align-items:center}
.nm{font-weight:700}.pill{font-size:11px;padding:3px 8px;border-radius:99px;background:#22222c;color:var(--mu)}.pill.done{background:#12301f;color:var(--ok)}.pill.failed{background:#331616;color:var(--bad)}
.st{font-size:12px;color:var(--mu);margin-top:4px;word-break:break-word}.err{color:var(--bad)}
</style></head><body>
<h1>💻 Ava Code</h1><div class="sub">Jo app bolo, Ava likhegi aur wahi APK ban ke aayegi.</div>
<div id="warn" class="warn" style="display:none"></div>
<div class="card"><b>Naya app</b>
<label>App kaisa chahiye? (jitna detail utna accha)</label>
<textarea id="p" placeholder="Jaise: Aureon jaisa ecommerce app — kapdon ka store, categories, product detail, cart, wishlist, checkout, order WhatsApp pe jaye, dark premium look"></textarea>
<label>App ka naam (optional)</label><input id="n" maxlength="40" placeholder="Jaise: StyleKart">
<label>WhatsApp number orders ke liye (optional, country code ke saath)</label><input id="w" inputmode="numeric" placeholder="919876543210">
<div class="row"><button id="go">🚀 App banao + APK</button></div></div>
<div class="card"><b>Aureon ki apni APK</b><div class="sub" style="margin:4px 0 0">Repo ka latest code build hoga.</div><div class="row"><button class="ghost" id="au">🔨 Build Aureon APK</button></div></div>
<div class="card"><b>Builds</b><div id="jobs"><div class="st">Loading…</div></div></div>
<script>
function $(i){return document.getElementById(i);}
async function api(url,opt,totp){
  opt=opt||{};opt.headers=Object.assign({'Content-Type':'application/json','x-csrf':'1'},opt.headers||{});
  if(totp)opt.headers['x-totp']=totp;
  var r=await fetch(url,opt);var j=await r.json().catch(function(){return{};});
  if(r.status===403&&j.needTotp&&!totp){var c=prompt('2FA code daalo:');if(c)return api(url,opt,c.trim());}
  if(r.status===401||r.status===404)throw new Error('Session khatam — dashboard link dobara kholo');
  if(!r.ok)throw new Error(j.error||('Error '+r.status));return j;
}
function esc(t){var d=document.createElement('div');d.textContent=t==null?'':String(t);return d.innerHTML;}
async function load(){
  try{
    var s=await api('/api/apk/status');
    var w=$('warn');if(!s.configured){w.style.display='block';w.textContent='Setup baaki hai: Render → Environment me GITHUB_TOKEN aur APK_GH_REPO=owner/repo daalo, phir redeploy.';}else w.style.display='none';
    var jobs=await api('/api/apk/jobs');var h='';
    jobs.forEach(function(j){
      var cls=j.status==='done'?'done':(j.status==='failed'?'failed':'');
      h+='<div class="job"><div class="top"><span class="nm">'+(j.kind==='aureon'?'🟡 ':'📱 ')+esc(j.name)+'</span><span class="pill '+cls+'">'+esc(j.status)+'</span></div>';
      h+='<div class="st">'+esc(j.step)+(j.error?' <span class="err">'+esc(j.error)+'</span>':'')+'</div><div class="row" style="margin-top:8px">';
      if(j.status==='done')h+='<a href="/api/apk/jobs/'+j.id+'/download"><button class="ghost">⬇️ APK download</button></a>';
      if(j.kind==='generated'&&j.status!=='generating')h+='<a href="/api/apk/jobs/'+j.id+'/source"><button class="ghost">📄 Source</button></a><button class="ghost" onclick="rev(\\''+j.id+'\\')">✏️ Badlao</button>';
      if(j.runUrl)h+='<a href="'+esc(j.runUrl)+'" target="_blank" rel="noopener"><button class="ghost">Logs</button></a>';
      h+='</div></div>';
    });
    $('jobs').innerHTML=h||'<div class="st">Abhi koi build nahi.</div>';
  }catch(e){$('jobs').innerHTML='<div class="st err">'+esc(e.message)+'</div>';}
}
$('go').onclick=async function(){
  var b=$('go');b.disabled=true;
  try{await api('/api/apk/generate',{method:'POST',body:JSON.stringify({prompt:$('p').value,name:$('n').value,whatsapp:$('w').value})});$('p').value='';load();}
  catch(e){alert(e.message);}b.disabled=false;
};
$('au').onclick=async function(){try{await api('/api/apk/aureon',{method:'POST',body:'{}'});load();}catch(e){alert(e.message);}};
async function rev(id){var t=prompt('Kya badalna hai?');if(!t)return;try{await api('/api/apk/jobs/'+id+'/revise',{method:'POST',body:JSON.stringify({instruction:t})});load();}catch(e){alert(e.message);}}
load();setInterval(load,6000);
</script></body></html>`;

module.exports = factory;
module.exports.summary = () => (current ? current.summary() : null);
module.exports._t = { slugify, appIdFor, parseGenerated, validateFiles, unzipFirst, SYSTEM, buildUserPrompt };
