// backend/ava-studio.js — Ava Studio: Ava builds REAL, professional, multi-file projects (thousands of lines) and picks the best UI herself.
//
// Mounted by sentinel-dashboard.js at /api/sentinel/ava-studio (owner login + fresh 2FA for writes).
//
//   kind "project": 1) Ava PLANS the architecture (files, purposes, dependencies)  2) writes it FILE BY FILE (one AI call per file, each call
//                   sees the plan + the API outline of what is already written)  3) every file is validated (syntax, no stubs/TODOs, minimum
//                   size, no eval) and repaired once if weak  4) cross-checks require() links  5) README + ZIP.
//   kind "ui":      UI TOURNAMENT — Ava designs 3 different top-level screens, JUDGES them herself (scores + reasons), picks the winner,
//                   then rewrites the winner with the judge's fixes. Only the best one is kept.
//
// Safety (same spirit as the Jail): everything lands in Ava's gallery only. NOTHING here writes to a real file, commits or deploys. The owner
// downloads the zip / html and decides. One job at a time, hourly budgets, hard caps on files and size. Honest limit: the model decides how
// much it really writes — the plan targets ~targetLines and the per-file minimums enforce it, but quality is checked, not guaranteed.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const crypto = require('crypto');
const express = require('express');

const MAX_FILES = 30;
const MIN_FILES = 4;
const DEFAULT_TARGET = 8000;
const MAX_TARGET = 12000;
const MAX_FILE_CHARS = 90000;
const KEEP_CONTENT = 3;          // newest N entries keep their code across a restart
const ENTRY_CAP = 12;
const PROJECT_PER_HOUR = 2;
const UI_PER_HOUR = 3;
const CALL_TIMEOUT_MS = 180000;
const FAKE = /\b(TODO|FIXME|XXX|HACK)\b|placeholder (code|logic|implementation)|lorem ipsum|your (code|logic) (goes )?here|not (yet )?implemented|implement (me|this|later)|coming soon|for demo purposes|\bdummy\b|\.\.\. ?(rest|more) (of|code)/i;
const DANGER = /(\beval\s*\(|new\s+Function\s*\()/;
const SAFE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,4}$/;
const OK_EXT = /\.(js|json|md|html|css|txt)$/i;

// ---------------------------------------------------------------- minimal store-only ZIP writer (no dependency)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makeZip(files) { // files: [{path, content}]
  const parts = []; const central = []; let offset = 0;
  const d = new Date(); const dosT = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1); const dosD = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = Buffer.from(f.path, 'utf8'); const raw = Buffer.from(f.content, 'utf8'); const comp = zlib.deflateRawSync(raw); const useDef = comp.length < raw.length;
    const body = useDef ? comp : raw; const crc = crc32(raw);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(useDef ? 8 : 0, 8); h.writeUInt16LE(dosT, 10); h.writeUInt16LE(dosD, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    parts.push(h, name, body);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(useDef ? 8 : 0, 10); c.writeUInt16LE(dosT, 12); c.writeUInt16LE(dosD, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name); offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---------------------------------------------------------------- parsing + validation helpers
const stripFence = (s) => String(s || '').replace(/^\s*```[a-zA-Z]*\n/, '').replace(/\n```\s*$/, '').trim();
function between(text, a, b) { const t = String(text || '').replace(/\r/g, ''); const i = t.indexOf(a); if (i < 0) return ''; const s = i + a.length; const j = b ? t.indexOf(b, s) : -1; return (j < 0 ? t.slice(s) : t.slice(s, j)).replace(/^\n/, ''); }
const lineCount = (s) => String(s).split('\n').length;
function jsSyntax(code) { try { new vm.Script(code, { filename: 'check.js' }); return null; } catch (e) { return String(e.message).slice(0, 160); } }
function outline(code) { // compact API view of a written file, so later files import it correctly
  const L = String(code).split('\n'); const keep = [];
  for (let i = 0; i < L.length && keep.length < 70; i++) {
    if (i < 6 || /^\s*(async\s+)?function\s|^\s*class\s|^\s*module\.exports|^\s*exports\.|^\s*const\s+\w+\s*=\s*require|^\s*static\s|^\s{2}(async\s+)?[A-Za-z_]\w*\s*\([^)]*\)\s*\{\s*$|^\s*\/\*\*|^\s*\* @(param|returns)/.test(L[i])) keep.push(L[i].slice(0, 160));
  }
  return keep.join('\n');
}
function checkFile(rel, code, minLines) {
  const why = [];
  if (!code || code.length < 40) return ['file khaali/chhoti hai'];
  if (code.length > MAX_FILE_CHARS) why.push('file bahut badi hai (>' + MAX_FILE_CHARS + ' chars) — split karo');
  const ext = path.extname(rel).toLowerCase();
  if (FAKE.test(code)) why.push('stub/TODO/placeholder mila — poora real code likho');
  if (DANGER.test(code)) why.push('eval/new Function allowed nahi');
  if (ext === '.js') { const s = jsSyntax(code); if (s) why.push('JS syntax error: ' + s); if (/^\s*(import\s.+from|export\s+(default|const|function|class))/m.test(code)) why.push('CommonJS (require/module.exports) use karo, ES modules nahi'); }
  if (ext === '.json') { try { JSON.parse(code); } catch (e) { why.push('JSON invalid'); } }
  if (ext === '.html') { if (!/<\/html>/i.test(code)) why.push('</html> missing'); if (/(<script[^>]+src=["']https?:|<link[^>]+href=["']https?:|src=["']https?:)/i.test(code)) why.push('external resource — standalone rakho'); }
  if (['.js', '.html', '.css'].includes(ext) && lineCount(code) < minLines) why.push('bahut chhota: ' + lineCount(code) + ' lines, kam se kam ' + minLines + ' chahiye — aur depth, error handling aur edge cases jodo');
  return why;
}
function checkDesign(html) {
  const why = [];
  if (!/<\/html>/i.test(html) || html.length < 4000) why.push('file adhoori/chhoti (</html> nahi ya 4000 chars se kam)');
  if (!/viewport/i.test(html)) why.push('viewport meta nahi');
  if (/(<script[^>]+src=|<link[^>]+href=["']https?:|src=["']https?:|url\(\s*["']?https?:|@import|\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon)/i.test(html)) why.push('external resource / network call mila');
  if (FAKE.test(html)) why.push('placeholder text mila');
  for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) if (m[1].trim()) { const s = jsSyntax(m[1]); if (s) { why.push('script syntax: ' + s); break; } }
  return why;
}

module.exports = function createAvaStudio({ auth, DATA_DIR, callLLM, logEvent }) {
  const router = express.Router();
  const json = express.json({ limit: '20kb' });
  const FILE = path.join(DATA_DIR, 'ava-studio.json');
  let entries = [];
  try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (Array.isArray(d.entries)) entries = d.entries; } catch (e) { /* first run */ }
  function save() {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const out = entries.slice(0, ENTRY_CAP).map((e, i) => (i < KEEP_CONTENT ? e : (({ contents, html, ...r }) => r)(e)));
      const t = FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify({ entries: out }), { mode: 0o600 }); fs.renameSync(t, FILE);
    } catch (e) { /* read-only disk: memory only */ }
  }

  const nid = () => crypto.randomBytes(6).toString('hex');
  const hookOf = () => global.__avaSelf || {};
  const haveLLM = () => !!(hookOf().llmText || hookOf().llm || process.env.GROQ_API_KEY);
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('AI ne ' + Math.round(ms / 1000) + 's me jawab nahi diya')), ms))]);
  async function askText(prompt) {
    const h = hookOf();
    if (typeof h.llmText === 'function') return String(await withTimeout(h.llmText(prompt), CALL_TIMEOUT_MS) || '');
    if (typeof h.llm === 'function') return String(await withTimeout(h.llm(prompt), CALL_TIMEOUT_MS) || '');
    const j = await withTimeout(callLLM(prompt + '\n\nReturn ONLY JSON: {"raw":"<your complete answer in the exact format above>"}'), CALL_TIMEOUT_MS);
    return String((j && (j.raw || j.code)) || '');
  }
  async function askJson(prompt) {
    const raw = stripFence(await askText(prompt + '\n\nReturn ONLY valid JSON, no markdown fences, no commentary.'));
    try { return JSON.parse(raw); } catch (e) { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* fall through */ } } return null; }
  }

  // ---------------------------------------------------------------- job state (one at a time)
  const job = { running: false, id: null, kind: null, brief: '', step: '', done: 0, total: 0, calls: 0, log: [], error: null, entryId: null, startedAt: 0, cancel: false };
  const hits = { project: [], ui: [] };
  const say = (m) => { job.log.push({ t: Date.now(), m: String(m).slice(0, 200) }); if (job.log.length > 60) job.log.shift(); job.step = String(m).slice(0, 120); };
  const ask = async (p) => { if (job.cancel) throw new Error('owner ne cancel kiya'); job.calls++; return askText(p); };
  const askJ = async (p) => { if (job.cancel) throw new Error('owner ne cancel kiya'); job.calls++; return askJson(p); };

  // ---------------------------------------------------------------- PROJECT builder
  const ENGINEER = 'You are Ava, a staff-level software engineer. Your code must look like it came from a top engineering team: clear module boundaries, small focused functions, JSDoc on every exported function/class, input validation, defensive error handling with meaningful messages, no global mutable state without reason, consistent naming, constants instead of magic numbers, logging hooks, and no dead code. NEVER write stubs, TODOs, placeholders, "..." or pseudo-code: every function is fully implemented and really works. Node.js CommonJS (require / module.exports), no external npm packages unless the brief demands one, no eval, no network calls unless the brief demands them.';

  async function planProject(brief, target) {
    const p = await askJ(ENGINEER + '\n\nOWNER BRIEF: ' + (brief || 'Choose the most valuable, impressive production-grade tool for the Aureon ecosystem yourself (for example a log analysis & anomaly engine, a rules/workflow engine, a task scheduler with persistence, a security audit toolkit, a CLI + library) and plan it.') +
      '\n\nDesign the ARCHITECTURE of a complete, professional project totalling about ' + target + ' lines of real code across ' + Math.min(MAX_FILES, Math.max(MIN_FILES, Math.round(target / 350))) + ' files (each file 150-600 lines; a few small config/docs files are fine). Include: an entry point, core modules, utilities, a test file that runs with plain `node` (assertions via the built-in assert module and a tiny runner), and a README.md. Order files so dependencies come BEFORE the files that use them.' +
      '\nReturn JSON: {"title":"short name","description":"2 sentences, Hinglish: what it is","architecture":"5-8 sentences: layers, data flow, key design decisions","files":[{"path":"src/core/engine.js","purpose":"what this file does and what it exports (names + signatures)","approx_lines":350,"depends_on":["src/utils/log.js"]}]}');
    if (!p || !Array.isArray(p.files)) throw new Error('Ava ka plan sahi format me nahi aaya — dobara try karo');
    const seen = new Set(); const files = [];
    for (const f of p.files) {
      const rel = String(f && f.path || '').replace(/^\.?\//, '');
      if (!SAFE_PATH.test(rel) || !OK_EXT.test(rel) || seen.has(rel) || rel.toLowerCase() === 'readme.md') continue;
      seen.add(rel); files.push({ path: rel, purpose: String(f.purpose || '').slice(0, 400), approx: Math.max(40, Math.min(Number(f.approx_lines) || 200, 700)), deps: Array.isArray(f.depends_on) ? f.depends_on.map(String).slice(0, 8) : [] });
      if (files.length >= MAX_FILES - 1) break;
    }
    if (files.length < MIN_FILES) throw new Error('Plan me ' + files.length + ' hi files aayi — itne se project nahi banta, dobara try karo');
    return { title: String(p.title || 'Ava Project').slice(0, 80), description: String(p.description || '').slice(0, 400), architecture: String(p.architecture || '').slice(0, 1500), files };
  }

  async function writeFile(brief, plan, f, written, extra) {
    const planTxt = plan.files.map((x) => '- ' + x.path + ' (~' + x.approx + ' lines): ' + x.purpose).join('\n');
    const have = written.map((w) => '### ' + w.path + '\n' + outline(w.code)).join('\n\n') || '(abhi koi file nahi likhi)';
    const minLines = Math.max(30, Math.round(f.approx * 0.6));
    return parseCode(await ask(ENGINEER + '\n\nPROJECT: ' + plan.title + ' — ' + plan.description + '\nOWNER BRIEF: ' + (brief || '(Ava ne khud chuna)') + '\nARCHITECTURE:\n' + plan.architecture + '\n\nALL FILES IN THE PLAN:\n' + planTxt +
      '\n\nALREADY WRITTEN (API outlines — import these EXACTLY as exported, never invent names that are not here):\n' + have +
      '\n\nNOW WRITE THE COMPLETE FILE: ' + f.path + '\nPurpose: ' + f.purpose + '\nTarget size: about ' + f.approx + ' lines (minimum ' + minLines + '). Relative require() paths must match the plan.' + (extra ? '\n\nFIX THESE PROBLEMS FROM YOUR LAST ATTEMPT: ' + extra : '') +
      '\n\nOUTPUT FORMAT (exactly, nothing else):\n===CODE===\n<the COMPLETE file content>\n===END===', f));
  }
  const parseCode = (txt) => stripFence(between(txt, '===CODE===', '===END==='));

  async function buildProject(brief, target) {
    say('Ava architecture plan kar rahi hai…');
    const plan = await planProject(brief, target);
    job.total = plan.files.length + 1; job.done = 0;
    say('Plan ready: ' + plan.title + ' — ' + plan.files.length + ' files');
    const written = []; const warnings = [];
    for (const f of plan.files) {
      say('Likh rahi hai: ' + f.path + ' (' + (job.done + 1) + '/' + plan.files.length + ')');
      const minLines = Math.max(30, Math.round(f.approx * 0.6));
      let code = await writeFile(brief, plan, f, written, '');
      let why = checkFile(f.path, code, minLines);
      if (why.length) {
        say('Repair: ' + f.path + ' — ' + why[0]);
        const retry = await writeFile(brief, plan, f, written, why.join('; ') + (code ? '\n\nYOUR PREVIOUS ATTEMPT (improve it, keep what is good):\n' + code.slice(0, 30000) : ''));
        const why2 = checkFile(f.path, retry, minLines);
        if (retry && why2.length <= why.length && !why2.some((w) => /syntax|invalid|khaali/.test(w))) { code = retry; why = why2; }
        else if (retry && !why2.length) { code = retry; why = []; }
      }
      if (!code || why.some((w) => /syntax|invalid|khaali/.test(w))) { warnings.push(f.path + ': ' + (why[0] || 'khaali') + ' — file skip hui'); job.done++; continue; }
      if (why.length) warnings.push(f.path + ': ' + why[0]);
      written.push({ path: f.path, code, lines: lineCount(code), warn: why[0] || null }); job.done++;
    }
    if (written.length < MIN_FILES) throw new Error('Sirf ' + written.length + ' file valid bani — project reject (' + warnings.slice(0, 2).join(' | ') + ')');
    // cross-check relative requires
    const have = new Set(written.map((w) => w.path));
    for (const w of written) if (/\.js$/.test(w.path)) {
      for (const m of w.code.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
        const r = path.posix.normalize(path.posix.join(path.posix.dirname(w.path), m[1]));
        if (![r, r + '.js', r + '/index.js', r + '.json'].some((x) => have.has(x))) warnings.push(w.path + ': require("' + m[1] + '") ki file project me nahi hai');
      }
    }
    say('README likh rahi hai…');
    let readme = '';
    try {
      readme = stripFence(between(await ask('You are Ava, a staff engineer writing documentation. Write a professional README.md (Markdown) for this project: what it is, architecture overview, install/run, how to run the tests, folder layout, usage examples, limits. Be accurate to the files listed.\n\nPROJECT: ' + plan.title + ' — ' + plan.description + '\nARCHITECTURE:\n' + plan.architecture + '\nFILES:\n' + written.map((w) => '- ' + w.path + ' (' + w.lines + ' lines)').join('\n') + '\n\nOUTPUT FORMAT (exactly):\n===CODE===\n<README.md content>\n===END==='), '===CODE===', '===END==='));
    } catch (e) { /* README is optional */ }
    if (!readme) readme = '# ' + plan.title + '\n\n' + plan.description + '\n\n## Architecture\n\n' + plan.architecture + '\n';
    written.push({ path: 'README.md', code: readme, lines: lineCount(readme), warn: null });
    const total = written.reduce((n, w) => n + w.lines, 0);
    return { kind: 'project', category: 'utility', title: plan.title, description: plan.description, contents: Object.fromEntries(written.map((w) => [w.path, w.code])),
      files: written.map((w) => ({ path: w.path, lines: w.lines, warn: w.warn })), notes: warnings.slice(0, 20), stats: { files: written.length, lines: total, calls: job.calls } };
  }

  // ---------------------------------------------------------------- UI TOURNAMENT
  const UI_RULES = 'You are Ava and a world-class product/UI designer. Design ONE complete top-level screen for the Aureon app / Sentinel dashboard as a single standalone HTML file: inline CSS + JS only, NO external files/fonts/images/CDN/network calls (inline SVG, emoji, CSS gradients only). Mobile-first (360-430px) AND excellent on desktop (sidebar layout). Realistic Hinglish sample content, real interactions (tabs, toggles, working buttons, animated live elements), strong visual hierarchy, consistent spacing scale, accessible contrast, smooth but light animation (no heavy blur filters). Premium, not template-looking. At least 400 lines.';
  const DIRECTIONS = ['futuristic dark glassmorphism: deep navy, violet/cyan/pink neon, glowing orb avatar for Ava', 'refined editorial minimal: calm dark neutral palette, one accent colour, big typography, generous whitespace, elegant data-viz', 'bold energetic: vivid gradients, large rounded cards, playful but professional micro-interactions, strong colour blocking'];
  const FORMAT_UI = '\n\nOUTPUT FORMAT (exactly, nothing else):\n===META===\ntitle: <short creative name>\ndescription: <1-2 sentences Hinglish: what this screen is and what makes it special>\n===HTML===\n<!DOCTYPE html> ... </html>\n===END===';
  function parseUi(text) {
    const meta = {}; between(text, '===META===', '===HTML===').split('\n').forEach((l) => { const k = l.match(/^(\w+):\s*(.+)$/); if (k) meta[k[1].toLowerCase()] = k[2].trim(); });
    return { meta, html: stripFence(between(text, '===HTML===', '===END===')) };
  }
  async function buildUi(brief) {
    const b = brief ? 'Owner brief: ' + brief : 'No brief — YOU choose which top-level screen adds the most value and make it exceptional.';
    job.total = DIRECTIONS.length + 2; job.done = 0;
    const cands = [];
    for (let i = 0; i < DIRECTIONS.length; i++) {
      say('Design #' + (i + 1) + ' bana rahi hai (' + DIRECTIONS[i].split(':')[0] + ')…');
      try {
        const d = parseUi(await ask(UI_RULES + '\n\n' + b + '\nDIRECTION #' + (i + 1) + ': ' + DIRECTIONS[i] + FORMAT_UI));
        const why = d.html ? checkDesign(d.html) : ['format galat'];
        if (!why.length) cands.push({ n: i + 1, dir: DIRECTIONS[i], ...d }); else say('Design #' + (i + 1) + ' reject: ' + why[0]);
      } catch (e) { if (job.cancel) throw e; say('Design #' + (i + 1) + ' fail: ' + e.message); }
      job.done++;
    }
    if (!cands.length) throw new Error('Koi bhi design validation pass nahi hua — dobara try karo');
    let win = cands[0]; let verdict = 'sirf ek design valid tha';
    let fixes = '';
    if (cands.length > 1) {
      say('Ava khud judge kar rahi hai — best UI chun rahi hai…');
      const j = await askJ('You are Ava acting as a strict, fair art director. Score each candidate UI 1-10 on: visual hierarchy, polish, originality, usability, mobile + desktop fit, interaction quality. Pick the single BEST one.\n' + cands.map((c) => '\n=== CANDIDATE ' + c.n + ' (' + c.dir.split(':')[0] + ') ===\n' + c.html.slice(0, 26000)).join('\n') + '\n\nReturn JSON: {"scores":[{"n":1,"score":8,"why":"one sentence"}],"winner":1,"fixes":["the 6 most valuable concrete improvements to the winner"]}');
      const wn = j && Number(j.winner); const hit = cands.find((c) => c.n === wn);
      if (hit) win = hit;
      if (j && Array.isArray(j.scores)) verdict = j.scores.map((s) => '#' + s.n + ': ' + s.score + '/10').join(', ') + ' → winner #' + win.n;
      if (j && Array.isArray(j.fixes)) fixes = j.fixes.slice(0, 8).map((x, i) => (i + 1) + '. ' + String(x)).join('\n');
    }
    job.done++;
    say('Winner #' + win.n + ' ko refine kar rahi hai…');
    let best = win;
    try {
      const r = parseUi(await ask(UI_RULES + '\n\n' + b + '\n\nBelow is the winning draft. Apply ALL of these fixes and your own critique (spacing, hierarchy, contrast, mobile fit, missing interactions) and output the COMPLETE improved file — more premium, still standalone, same format.' + (fixes ? '\nFIXES:\n' + fixes : '') + '\n\nWINNING DRAFT:\n' + win.html.slice(0, 60000) + FORMAT_UI));
      if (r.html && !checkDesign(r.html).length) best = { ...r, meta: Object.assign({}, win.meta, r.meta), n: win.n, dir: win.dir };
    } catch (e) { if (job.cancel) throw e; /* keep the winner */ }
    job.done++;
    return { kind: 'design', category: 'ui', title: String(best.meta.title || 'Ava Best UI').slice(0, 90), description: String(best.meta.description || '').slice(0, 400), html: best.html,
      files: [{ path: 'index.html', lines: lineCount(best.html) }], notes: ['Tournament: ' + verdict, 'Direction: ' + best.dir], stats: { files: 1, lines: lineCount(best.html), calls: job.calls } };
  }

  // ---------------------------------------------------------------- run a job in the background
  async function run(kind, brief, target) {
    Object.assign(job, { running: true, id: nid(), kind, brief, step: 'start', done: 0, total: 0, calls: 0, log: [], error: null, entryId: null, startedAt: Date.now(), cancel: false });
    try {
      const out = kind === 'project' ? await buildProject(brief, target) : await buildUi(brief);
      const entry = { id: nid(), createdAt: new Date().toISOString(), brief: String(brief || '(Ava ne khud chuna)').slice(0, 300), sandbox: { ok: true, log: out.stats.files + ' file(s), ' + out.stats.lines + ' lines, ' + out.stats.calls + ' AI calls' + (out.notes && out.notes.length ? ' | ' + out.notes.length + ' note(s)' : '') }, studio: true, ...out };
      entries = [entry, ...entries].slice(0, ENTRY_CAP); save(); job.entryId = entry.id;
      say('Ho gaya: ' + entry.title + ' (' + entry.stats.lines + ' lines)');
      if (logEvent) { try { logEvent('proposal', { name: 'Ava' }, 'Ava Studio: "' + entry.title + '" ban gaya (' + entry.stats.lines + ' lines, sirf gallery me, kahin apply nahi hua)'); } catch (e) { /* ignore */ } }
    } catch (e) { job.error = String(e && e.message || e).slice(0, 300); say('❌ ' + job.error); }
    finally { job.running = false; }
  }

  // ---------------------------------------------------------------- routes
  const budget = (kind, limit) => { const now = Date.now(); const a = hits[kind]; while (a.length && now - a[0] > 3600000) a.shift(); return a.length < limit; };
  router.post('/start', json, (req, res) => {
    if (!auth.stepUp(req, res)) return;
    const b = req.body || {}; const kind = b.kind === 'ui' ? 'ui' : 'project';
    if (job.running) return res.status(409).json({ error: 'Ava abhi ek ' + job.kind + ' bana rahi hai (' + job.step + ')' });
    if (!haveLLM()) return res.status(503).json({ error: 'Ava ka AI (Gemini) ya GROQ_API_KEY set nahi hai' });
    if (!budget(kind, kind === 'ui' ? UI_PER_HOUR : PROJECT_PER_HOUR)) return res.status(429).json({ error: 'Ghante me ' + (kind === 'ui' ? UI_PER_HOUR : PROJECT_PER_HOUR) + ' ' + kind + ' builds ki limit' });
    auth.action(req, 'ava-studio ' + kind);
    hits[kind].push(Date.now());
    const target = Math.max(2000, Math.min(Number(b.targetLines) || DEFAULT_TARGET, MAX_TARGET));
    run(kind, String(b.brief || '').slice(0, 400), target).catch(() => {});
    res.status(202).json({ ok: true, started: kind, targetLines: kind === 'project' ? target : undefined });
  });
  router.post('/cancel', (req, res) => { if (!auth.stepUp(req, res)) return; job.cancel = true; res.json({ ok: true }); });
  router.get('/status', (req, res) => res.json({ running: job.running, kind: job.kind, step: job.step, done: job.done, total: job.total, calls: job.calls, error: job.error, entryId: job.entryId, startedAt: job.startedAt, log: job.log.slice(-25) }));
  router.get('/list', (req, res) => res.json(entries.map(({ contents, html, ...r }) => ({ ...r, hasCode: !!(contents || html) }))));
  const find = (id) => entries.find((e) => e.id === id);
  router.get('/:id/file', (req, res) => {
    const e = find(req.params.id); if (!e) return res.status(404).type('text/plain').send('nahi mila');
    if (e.kind === 'design') return e.html ? res.type('text/plain').send(e.html) : res.status(404).type('text/plain').send('code ab store me nahi hai');
    const c = e.contents && e.contents[String(req.query.path || '')]; if (c == null) return res.status(404).type('text/plain').send('file nahi mili / restart ke baad purane project ka code nahi bachta');
    res.type('text/plain').send(c);
  });
  router.get('/:id/code', (req, res) => {
    const e = find(req.params.id); if (!e) return res.status(404).type('text/plain').send('nahi mila');
    if (e.kind === 'design') { if (!e.html) return res.status(404).type('text/plain').send('code ab store me nahi hai — dobara generate karo'); return res.type('text/html').set('Content-Disposition', 'attachment; filename="ava-ui-' + e.id + '.html"').send(e.html); }
    if (!e.contents) return res.status(404).type('text/plain').send('Ye project ka code ab nahi bacha (sirf newest ' + KEEP_CONTENT + ' restart ke baad bachte hain) — dobara generate karo.');
    const slug = String(e.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ava-project';
    res.type('application/zip').set('Content-Disposition', 'attachment; filename="' + slug + '.zip"').send(makeZip(Object.entries(e.contents).map(([p, content]) => ({ path: slug + '/' + p, content }))));
  });
  router.delete('/:id', (req, res) => { auth.action(req, 'ava-studio delete ' + req.params.id); entries = entries.filter((e) => e.id !== req.params.id); save(); res.json({ ok: true }); });

  return { router, _test: { makeZip, checkFile, checkDesign, outline, job } };
};
