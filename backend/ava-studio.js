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
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const express = require('express');

const MAX_FILES = 4000;          // whole project (all modules)
const MODULE_FILES = 40;         // files planned per module
const BIG_AT = 12000;            // above this many target lines Ava plans in two levels: modules first, then each module's files
const MAX_MODULES = 80;
const AUTO_PROJECT_LINES = 30000; // size of projects Ava starts by herself
const MAX_CALLS = 9000;          // hard stop for one job
const MIN_FILES = 4;
const DEFAULT_TARGET = 8000;
const MAX_TARGET = 1000000;
const MAX_FILE_CHARS = 90000;
const KEEP_CONTENT = 3;          // newest N entries keep their code across a restart
const ENTRY_CAP = 12;
const PROJECT_PER_HOUR = 2;
const UI_PER_HOUR = 3;
const CALL_TIMEOUT_MS = 180000;
const FAKE = /\b(TODO|FIXME|XXX|HACK)\b|placeholder (code|logic|implementation)|lorem ipsum|your (code|logic) (goes )?here|not (yet )?implemented|implement (me|this|later)|coming soon|for demo purposes|\bdummy\b|\.\.\. ?(rest|more) (of|code)/i;
const DANGER = /(\beval\s*\(|new\s+Function\s*\()/;
const NO_RUN = /require\(\s*['"](child_process|net|http|https|http2|dgram|tls|worker_threads|cluster|vm)['"]\s*\)|\bfetch\s*\(|process\.binding|process\.dlopen/; // such files are never executed by the test runner
const RATE = /quota|rate limit|429|resource_exhausted|too many requests|overloaded|unavailable|503|timeout|aya nahi|jawab nahi/i;
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
  if (ext === '.js' && lineCount(code) >= 80 && !/(^|\/)(test|tests|__tests__)\//.test(rel) && !/\.(test|spec)\.js$/.test(rel)) {
    const fns = (code.match(/^\s*(?:async\s+)?function\s+\w+|^\s*(?:static\s+|async\s+|get\s+|set\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|function\b|return\b)[A-Za-z_]\w*\s*\([^)]*\)\s*\{/gm) || []).length;
    const docs = (code.match(/\/\*\*/g) || []).length;
    if (fns >= 4 && docs < Math.ceil(fns * 0.5)) why.push('JSDoc kam hai (' + docs + ' docs / ' + fns + ' functions) — har exported function/class par JSDoc (@param, @returns) likho');
    if ((code.match(/console\.log\(/g) || []).length > 4) why.push('console.log bahut hain — ek chhota logger use karo');
    if (fns >= 3 && !/\b(throw|catch|reject|Error)\b/.test(code)) why.push('error handling nahi dikhi — input validation + meaningful errors (throw/try-catch) jodo');
  }
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
  const DIR = path.join(DATA_DIR, 'ava-studio');
  const INDEX = path.join(DIR, 'index.json');
  let entries = [];
  let settings = { autoUi: false, uiHours: 12, lastAutoUi: 0, autoProject: false, projectHours: 24, lastAutoProject: 0 };
  try { const d = JSON.parse(fs.readFileSync(INDEX, 'utf8')); if (Array.isArray(d.entries)) entries = d.entries; if (d.settings) settings = Object.assign(settings, d.settings); } catch (e) { /* first run */ }
  let saveT = null;
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      try { fs.mkdirSync(DIR, { recursive: true }); const t = INDEX + '.tmp'; fs.writeFileSync(t, JSON.stringify({ entries, settings }), { mode: 0o600 }); fs.renameSync(t, INDEX); } catch (e) { /* read-only disk: memory only */ }
    }, 1500);
  }
  const nid = () => crypto.randomBytes(6).toString('hex');
  const pdir = (id) => path.join(DIR, id, 'files');
  const find = (id) => entries.find((e) => e.id === id);
  function putFile(id, rel, content) { const f = path.join(pdir(id), rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content, { mode: 0o600 }); }
  function getFile(id, rel) { if (!SAFE_PATH.test(String(rel || ''))) return null; try { return fs.readFileSync(path.join(pdir(id), rel), 'utf8'); } catch (e) { return null; } }
  function rmProject(id) { try { fs.rmSync(path.join(DIR, id), { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  const ckFile = (id) => path.join(DIR, id, 'job.json');
  function saveCk(id, ck) { try { fs.mkdirSync(path.join(DIR, id), { recursive: true }); fs.writeFileSync(ckFile(id), JSON.stringify(ck), { mode: 0o600 }); } catch (e) { /* ignore */ } }
  function trimEntries() { while (entries.length > ENTRY_CAP) { const d = entries.pop(); if (d && d.status !== 'building') rmProject(d.id); } }

  // ---------------------------------------------------------------- LLM access (with patient quota handling)
  const hookOf = () => global.__avaSelf || {};
  const haveLLM = () => !!(require('./llm-text').available() || hookOf().llm || process.env.GROQ_API_KEY);
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('AI ne ' + Math.round(ms / 1000) + 's me jawab nahi diya (timeout)')), ms))]);
  const llm = require('./llm-text');
  async function askRaw(prompt) {
    const h = hookOf();
    if (llm.available()) return String(await withTimeout(llm.text(prompt), CALL_TIMEOUT_MS) || ''); // Gemini first, Groq (plain text) when Gemini is out of quota / key invalid
    if (typeof h.llm === 'function') return String(await withTimeout(h.llm(prompt), CALL_TIMEOUT_MS) || '');
    const j = await withTimeout(callLLM(prompt + '\n\nReturn ONLY JSON: {"raw":"<your complete answer in the exact format above>"}'), CALL_TIMEOUT_MS);
    return String((j && (j.raw || j.code)) || '');
  }
  const job = { running: false, id: null, entryId: null, kind: null, brief: '', step: '', done: 0, total: 0, calls: 0, lines: 0, target: 0, lastPath: null, log: [], error: null, startedAt: 0, cancel: false, waiting: 0 };
  const say = (m) => { job.log.push({ t: Date.now(), m: String(m).slice(0, 220) }); if (job.log.length > 80) job.log.shift(); job.step = String(m).slice(0, 140); };
  const sleep = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (job.cancel) throw new Error('owner ne roka'); await new Promise((r) => setTimeout(r, Math.min(2000, end - Date.now()))); } };
  async function ask(prompt) {
    for (let attempt = 0; ; attempt++) {
      if (job.cancel) throw new Error('owner ne roka');
      if (job.calls >= MAX_CALLS) throw new Error('is job ki ' + MAX_CALLS + ' AI-calls ki hard limit poori hui');
      job.calls++;
      try { return await askRaw(prompt); }
      catch (e) {
        if (RATE.test(String(e && e.message)) && attempt < 14) { const wait = Math.min((process.env.AVA_STUDIO_TEST ? 500 : 30000) * 2 ** Math.min(attempt, 5), 900000); job.waiting = Date.now() + wait; say('⏳ AI quota/limit — ' + Math.round(wait / 1000) + 's ruk ke dobara try (kaam background me jaari rahega)'); await sleep(wait); job.waiting = 0; continue; }
        throw e;
      }
    }
  }
  async function askJ(prompt) {
    const raw = stripFence(await ask(prompt + '\n\nReturn ONLY valid JSON, no markdown fences, no commentary.'));
    try { return JSON.parse(raw); } catch (e) { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch (e2) { /* fall through */ } } return null; }
  }

  // ---------------------------------------------------------------- test runner (isolated: no env, no write, no child processes, 25s)
  let permFlag;
  function permissionFlag() {
    if (permFlag !== undefined) return permFlag;
    permFlag = null;
    for (const f of ['--permission', '--experimental-permission']) { try { const r = spawnSync(process.execPath, [f, '-e', '0'], { timeout: 5000 }); if (r.status === 0) { permFlag = f; break; } } catch (e) { /* try next */ } }
    return permFlag;
  }
  function runTest(id, rel) {
    const root = pdir(id); const pf = permissionFlag();
    const args = [...(pf ? [pf, '--allow-fs-read=' + root + '*'] : []), '--max-old-space-size=192', path.join(root, rel)];
    try {
      const r = spawnSync(process.execPath, args, { cwd: root, env: { NODE_ENV: 'test', PATH: '' }, timeout: 25000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
      const out = String((r.stdout || '') + '\n' + (r.stderr || '')).trim().slice(-2500);
      if (r.error && r.error.code === 'ETIMEDOUT') return { ok: false, log: 'test 25s me khatam nahi hua (infinite loop?)\n' + out };
      return { ok: r.status === 0, log: out, sandboxed: !!pf };
    } catch (e) { return { ok: false, log: 'test run error: ' + e.message }; }
  }
  const isTest = (rel) => /(^|\/)(test|tests|__tests__)\/[^/]+\.js$|\.(test|spec)\.js$/.test(rel);

  // ---------------------------------------------------------------- planning
  const ENGINEER = 'You are Ava, a principal-level software engineer. Your code must look like it came from a top engineering team: clear module boundaries, small focused functions (under ~60 lines), JSDoc on every exported function/class (@param, @returns, @throws), strict input validation, defensive error handling with meaningful custom errors, immutable data where sensible, no hidden global state, consistent naming, named constants instead of magic numbers, injectable dependencies (easy to test), small structured logging hooks, and no dead code. NEVER write stubs, TODOs, placeholders, "..." or pseudo-code: every function is fully implemented and really works. Node.js CommonJS (require / module.exports), no external npm packages unless the brief demands one, no eval. Tests must use only the built-in assert module, must NOT write to disk, use the network or spawn processes, and must exit with a non-zero code when an assertion fails.';
  const safeFiles = (arr, seen, dirPrefix) => {
    const out = [];
    for (const f of arr || []) {
      let rel = String(f && f.path || '').replace(/^\.?\//, '');
      if (dirPrefix && !rel.startsWith(dirPrefix + '/') && !/^(package\.json|README\.md)$/i.test(rel)) rel = dirPrefix + '/' + rel;
      if (!SAFE_PATH.test(rel) || !OK_EXT.test(rel) || seen.has(rel) || rel.toLowerCase() === 'readme.md') continue;
      seen.add(rel);
      out.push({ path: rel, purpose: String(f.purpose || '').slice(0, 400), approx: Math.max(40, Math.min(Number(f.approx_lines) || 200, 700)), deps: Array.isArray(f.depends_on) ? f.depends_on.map(String).slice(0, 10) : [] });
      if (out.length >= MODULE_FILES) break;
    }
    return out;
  };
  const BRIEF_DEFAULT = 'Choose the most valuable, impressive production-grade system for the Aureon ecosystem yourself (for example a log analysis & anomaly engine, a rules/workflow engine, a task scheduler with persistence, a security audit toolkit) and plan it.';
  async function planProject(brief, target) {
    if (target <= BIG_AT) {
      const p = await askJ(ENGINEER + '\n\nOWNER BRIEF: ' + (brief || BRIEF_DEFAULT) + '\n\nDesign the ARCHITECTURE of a complete, professional project totalling about ' + target + ' lines of real code across ' + Math.min(MODULE_FILES, Math.max(MIN_FILES, Math.round(target / 350))) + ' files (each 150-600 lines; a few small config files are fine). Include an entry point, core modules, utilities and a test file. Order files so dependencies come BEFORE the files that use them.\nReturn JSON: {"title":"short name","description":"2 sentences, Hinglish: what it is","architecture":"5-8 sentences: layers, data flow, key decisions","files":[{"path":"src/core/engine.js","purpose":"what it does + exported names/signatures","approx_lines":350,"depends_on":["src/utils/log.js"]}]}');
      if (!p || !Array.isArray(p.files)) throw new Error('Ava ka plan sahi format me nahi aaya');
      const files = safeFiles(p.files, new Set(), '');
      if (files.length < MIN_FILES) throw new Error('Plan me sirf ' + files.length + ' files aayi — dobara try karo');
      return { title: String(p.title || 'Ava Project').slice(0, 80), description: String(p.description || '').slice(0, 400), architecture: String(p.architecture || '').slice(0, 1500), modules: [{ name: 'project', dir: '', purpose: 'whole project', approx: target, files }] };
    }
    const nm = Math.min(MAX_MODULES, Math.max(6, Math.round(target / 15000)));
    const p = await askJ(ENGINEER + '\n\nOWNER BRIEF: ' + (brief || BRIEF_DEFAULT) + '\n\nThis is a LARGE system of about ' + target + ' lines. Design the top-level ARCHITECTURE as ' + nm + ' cohesive modules (each its own folder, ~' + Math.round(target / nm) + ' lines, 10-40 files). Order modules so foundations come first. Return JSON: {"title":"short name","description":"2 sentences, Hinglish","architecture":"8-12 sentences: layers, boundaries, data flow, public APIs between modules, key design decisions","modules":[{"name":"core","dir":"src/core","purpose":"what the module owns and what it exports to others","approx_lines":' + Math.round(target / nm) + ',"depends_on_modules":[]}]}');
    if (!p || !Array.isArray(p.modules) || p.modules.length < 2) throw new Error('Ava ka module-plan sahi format me nahi aaya');
    const used = new Set(); const modules = [];
    for (const m of p.modules) {
      const dir = String(m.dir || m.name || '').replace(/^\.?\//, '').replace(/\/+$/, '');
      if (!SAFE_PATH.test(dir) || used.has(dir)) continue; used.add(dir);
      modules.push({ name: String(m.name || dir).slice(0, 40), dir, purpose: String(m.purpose || '').slice(0, 500), approx: Math.max(1000, Math.min(Number(m.approx_lines) || Math.round(target / nm), 40000)), files: null });
      if (modules.length >= MAX_MODULES) break;
    }
    if (modules.length < 2) throw new Error('Module plan me 2 se kam valid modules');
    return { title: String(p.title || 'Ava System').slice(0, 80), description: String(p.description || '').slice(0, 400), architecture: String(p.architecture || '').slice(0, 2500), modules };
  }
  async function planModule(brief, plan, m, mi) {
    const prior = plan.modules.slice(0, mi).map((x) => '- ' + x.dir + ': ' + x.purpose.slice(0, 120)).join('\n') || '(pehla module)';
    const p = await askJ(ENGINEER + '\n\nPROJECT: ' + plan.title + ' — ' + plan.description + '\nOWNER BRIEF: ' + (brief || '(Ava ne khud chuna)') + '\nARCHITECTURE:\n' + plan.architecture + '\n\nEARLIER MODULES (already written, you may import them):\n' + prior + '\n\nPlan the FILES of module "' + m.name + '" in folder ' + m.dir + '/ — purpose: ' + m.purpose + '. About ' + m.approx + ' lines total in ' + Math.min(MODULE_FILES, Math.max(4, Math.round(m.approx / 350))) + ' files (150-600 lines each), plus ONE test file ' + m.dir + '/test/' + m.name.replace(/\W+/g, '_') + '.test.js that exercises the module (plain node + assert). Dependencies before dependents. All paths must start with ' + m.dir + '/.\nReturn JSON: {"files":[{"path":"' + m.dir + '/x.js","purpose":"what + exported names/signatures","approx_lines":300,"depends_on":["' + m.dir + '/y.js"]}]}');
    const files = safeFiles(p && p.files, new Set(), m.dir);
    if (files.length < 2) throw new Error('Module "' + m.name + '" ki file-plan nahi bani');
    return files;
  }

  // ---------------------------------------------------------------- writing one file
  const parseCode = (txt) => stripFence(between(txt, '===CODE===', '===END==='));
  function ctxFor(id, plan, m, f, writtenInModule) {
    const parts = [];
    const seen = new Set();
    const add = (rel) => { if (seen.has(rel) || seen.size >= 14) return; const c = getFile(id, rel); if (c) { seen.add(rel); parts.push('### ' + rel + '\n' + outline(c)); } };
    (f.deps || []).forEach((d) => { add(d); add(d + '.js'); });
    writtenInModule.slice(-6).forEach(add);
    const mods = plan.modules.filter((x) => x !== m && x.entry).map((x) => '- ' + x.dir + ' (' + x.purpose.slice(0, 90) + ') entry: ' + x.entry).slice(-40).join('\n');
    return (parts.join('\n\n') || '(abhi koi file nahi)') + (mods ? '\n\nOTHER MODULES (require them via their entry / public files):\n' + mods : '');
  }
  async function writeOne(id, brief, plan, m, f, writtenInModule, extra) {
    const modFiles = m.files.map((x) => '- ' + x.path + ' (~' + x.approx + ' lines): ' + x.purpose).join('\n');
    const minLines = Math.max(30, Math.round(f.approx * 0.6));
    return parseCode(await ask(ENGINEER + '\n\nPROJECT: ' + plan.title + ' — ' + plan.description + '\nOWNER BRIEF: ' + (brief || '(Ava ne khud chuna)') + '\nARCHITECTURE:\n' + plan.architecture + '\n\nFILES OF THIS MODULE (' + m.dir + '):\n' + modFiles +
      '\n\nALREADY WRITTEN — API outlines (import EXACTLY what is exported there; never invent names that are not shown):\n' + ctxFor(id, plan, m, f, writtenInModule) +
      '\n\nNOW WRITE THE COMPLETE FILE: ' + f.path + '\nPurpose: ' + f.purpose + '\nTarget size: about ' + f.approx + ' lines (minimum ' + minLines + '). Relative require() paths must be correct from this file\'s folder.' + (extra ? '\n\nFIX THESE PROBLEMS FROM YOUR LAST ATTEMPT: ' + extra : '') +
      '\n\nOUTPUT FORMAT (exactly, nothing else):\n===CODE===\n<the COMPLETE file content>\n===END==='));
  }

  // ---------------------------------------------------------------- PROJECT job (resumable)
  function entryFiles(e) { return e.files || (e.files = []); }
  function recordFile(e, rel, lines, warn) {
    const arr = entryFiles(e); const i = arr.findIndex((x) => x.path === rel); const rec = { path: rel, lines, warn: warn || null };
    if (i >= 0) arr[i] = rec; else arr.push(rec);
    e.stats = { files: arr.length, lines: arr.reduce((n, x) => n + x.lines, 0), calls: job.calls }; e.sandbox = { ok: true, log: e.stats.files + ' file(s), ' + e.stats.lines + ' lines, ' + job.calls + ' AI calls' };
    job.lines = e.stats.lines; job.lastPath = rel; save();
  }
  async function buildProject(e, ck) {
    const id = e.id, brief = ck.brief;
    if (!ck.plan) {
      say('Ava architecture plan kar rahi hai…');
      ck.plan = await planProject(brief, ck.target); ck.mi = 0; e.title = ck.plan.title; e.description = ck.plan.description; saveCk(id, ck); save();
      say('Plan ready: ' + ck.plan.title + ' — ' + ck.plan.modules.length + ' module(s)');
    }
    const plan = ck.plan; job.target = ck.target; job.total = plan.modules.length;
    for (; ck.mi < plan.modules.length; ck.mi++) {
      const m = plan.modules[ck.mi]; job.done = ck.mi;
      if (!m.files) { say('Module plan: ' + m.name + ' (' + (ck.mi + 1) + '/' + plan.modules.length + ')'); m.files = await planModule(brief, plan, m, ck.mi); saveCk(id, ck); }
      const writtenInModule = [];
      for (const f of m.files) {
        if (job.cancel) throw new Error('owner ne roka');
        if (getFile(id, f.path) != null) { writtenInModule.push(f.path); continue; } // resume: already on disk
        say('Likh rahi hai: ' + f.path + (plan.modules.length > 1 ? ' [' + m.name + ' ' + (ck.mi + 1) + '/' + plan.modules.length + ']' : ''));
        const minLines = Math.max(30, Math.round(f.approx * 0.6));
        let code = '', why = [];
        try {
          code = await writeOne(id, brief, plan, m, f, writtenInModule, '');
          why = checkFile(f.path, code, minLines);
          if (why.length) {
            say('Repair: ' + f.path + ' — ' + why[0].slice(0, 80));
            const retry = await writeOne(id, brief, plan, m, f, writtenInModule, why.join('; ') + (code ? '\n\nYOUR PREVIOUS ATTEMPT (improve it, keep what is good):\n' + code.slice(0, 30000) : ''));
            const why2 = checkFile(f.path, retry, minLines);
            if (retry && (why2.length < why.length || (!why2.length))) { code = retry; why = why2; }
          }
        } catch (err) { if (job.cancel || /hard limit/.test(err.message)) throw err; say('⚠ ' + f.path + ' skip: ' + err.message.slice(0, 80)); e.notes.push(f.path + ': skip (' + err.message.slice(0, 60) + ')'); continue; }
        if (!code || why.some((w) => /syntax|invalid|khaali/.test(w))) { e.notes.push(f.path + ': ' + (why[0] || 'khaali') + ' — file skip'); continue; }
        putFile(id, f.path, code); writtenInModule.push(f.path); recordFile(e, f.path, lineCount(code), why[0] ? why[0].slice(0, 120) : null);
        if (why.length) e.notes.push(f.path + ': ' + why[0].slice(0, 120));
        if (!m.entry && /\.js$/.test(f.path) && !isTest(f.path) && (/index\.js$/.test(f.path) || writtenInModule.length === 1)) m.entry = f.path;
        saveCk(id, ck);
      }
      await testModule(e, ck, m, writtenInModule);
      saveCk(id, ck);
    }
    // cross-check relative requires
    const have = new Set(entryFiles(e).map((x) => x.path));
    for (const rec of entryFiles(e)) if (/\.js$/.test(rec.path)) {
      const code = getFile(id, rec.path) || '';
      for (const mm of code.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
        const r = path.posix.normalize(path.posix.join(path.posix.dirname(rec.path), mm[1]));
        if (![r, r + '.js', r + '/index.js', r + '.json'].some((x) => have.has(x))) e.notes.push(rec.path + ': require("' + mm[1] + '") ki file project me nahi hai');
      }
    }
    say('README likh rahi hai…');
    let readme = '';
    try { readme = stripFence(between(await ask('You are Ava, a principal engineer writing documentation. Write a professional README.md (Markdown): what it is, architecture overview, modules, how to run the tests, usage examples, limits. Be accurate to the modules listed.\n\nPROJECT: ' + plan.title + ' — ' + plan.description + '\nARCHITECTURE:\n' + plan.architecture + '\nMODULES:\n' + plan.modules.map((x) => '- ' + (x.dir || '.') + ': ' + x.purpose).join('\n') + '\n\nOUTPUT FORMAT (exactly):\n===CODE===\n<README.md content>\n===END==='), '===CODE===', '===END===')); } catch (err) { if (job.cancel) throw err; }
    if (!readme) readme = '# ' + plan.title + '\n\n' + plan.description + '\n\n## Architecture\n\n' + plan.architecture + '\n';
    putFile(id, 'README.md', readme); recordFile(e, 'README.md', lineCount(readme), null);
    if (entryFiles(e).filter((x) => x.lines > 0).length < MIN_FILES) throw new Error('Sirf kuch hi file valid bani — project reject');
  }
  async function testModule(e, ck, m, written) {
    const tests = written.filter(isTest);
    if (!tests.length) return;
    const all = entryFiles(e).map((x) => getFile(e.id, x.path) || '').join('\n');
    if (NO_RUN.test(all)) { e.notes.push(m.name + ': tests chalaye nahi gaye (network/process APIs mili)'); return; }
    for (const t of tests) {
      for (let round = 0; round < 3; round++) {
        say('Test chala rahi hai: ' + t + (round ? ' (repair ' + round + ')' : ''));
        const r = runTest(e.id, t);
        if (r.ok) { e.notes.push('✅ test pass: ' + t + (r.sandboxed ? ' (isolated)' : '')); break; }
        if (round === 2) { e.notes.push('❌ test fail: ' + t + ' — ' + r.log.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 160)); break; }
        // repair the first non-test project file named in the failure output, else the test itself
        const named = [...r.log.matchAll(/([A-Za-z0-9_./-]+\.js)(?::\d+)/g)].map((x) => x[1].replace(pdir(e.id) + '/', '')).filter((p) => !isTest(p) && getFile(e.id, p) != null)[0];
        const target = named || t; const f = m.files.find((x) => x.path === target) || { path: target, purpose: 'fix', approx: 200, deps: [] };
        say('Test fail → repair: ' + target);
        try {
          const cur = getFile(e.id, target) || '';
          const fixed = await writeOne(e.id, ck.brief, ck.plan, m, f, written, 'The test ' + t + ' FAILED. Fix the real cause (in this file; if the test itself is wrong fix the test logic). Test output:\n' + r.log + '\n\nCURRENT FILE:\n' + cur.slice(0, 30000));
          if (fixed && !checkFile(target, fixed, 20).some((w) => /syntax|invalid|khaali/.test(w))) { putFile(e.id, target, fixed); recordFile(e, target, lineCount(fixed), null); }
        } catch (err) { if (job.cancel) throw err; break; }
      }
    }
  }

  // ---------------------------------------------------------------- UI TOURNAMENT (Ava designs 3, judges herself, refines the winner)
  const UI_RULES = 'You are Ava and a world-class product/UI designer. Design ONE complete top-level screen for the Aureon app / Sentinel dashboard as a single standalone HTML file: inline CSS + JS only, NO external files/fonts/images/CDN/network calls (inline SVG, emoji, CSS gradients only). Mobile-first (360-430px) AND excellent on desktop (sidebar layout). Realistic Hinglish sample content, real interactions (tabs, toggles, working buttons, animated live elements), strong visual hierarchy, a consistent spacing scale and design tokens (CSS variables), accessible contrast, smooth but light animation (no heavy blur filters), clean semantic HTML, well-structured readable CSS and JS with comments. Premium, not template-looking. At least 500 lines.';
  const DIRECTIONS = ['futuristic dark glassmorphism: deep navy, violet/cyan/pink neon, glowing orb avatar for Ava', 'refined editorial minimal: calm dark neutral palette, one accent colour, big typography, generous whitespace, elegant data-viz', 'bold energetic: vivid gradients, large rounded cards, playful but professional micro-interactions, strong colour blocking'];
  const FORMAT_UI = '\n\nOUTPUT FORMAT (exactly, nothing else):\n===META===\ntitle: <short creative name>\ndescription: <1-2 sentences Hinglish: what this screen is and what makes it special>\n===HTML===\n<!DOCTYPE html> ... </html>\n===END===';
  function parseUi(text) {
    const meta = {}; between(text, '===META===', '===HTML===').split('\n').forEach((l) => { const k = l.match(/^(\w+):\s*(.+)$/); if (k) meta[k[1].toLowerCase()] = k[2].trim(); });
    return { meta, html: stripFence(between(text, '===HTML===', '===END===')) };
  }
  async function buildUi(e, brief) {
    const b = brief ? 'Owner brief: ' + brief : 'No brief — YOU choose which top-level screen adds the most value and make it exceptional.';
    job.total = DIRECTIONS.length + 2; job.done = 0; const cands = [];
    for (let i = 0; i < DIRECTIONS.length; i++) {
      say('Design #' + (i + 1) + ' bana rahi hai (' + DIRECTIONS[i].split(':')[0] + ')…');
      try {
        const d = parseUi(await ask(UI_RULES + '\n\n' + b + '\nDIRECTION #' + (i + 1) + ': ' + DIRECTIONS[i] + FORMAT_UI));
        const why = d.html ? checkDesign(d.html) : ['format galat'];
        if (!why.length) cands.push({ n: i + 1, dir: DIRECTIONS[i], ...d }); else say('Design #' + (i + 1) + ' reject: ' + why[0]);
      } catch (err) { if (job.cancel) throw err; say('Design #' + (i + 1) + ' fail: ' + err.message.slice(0, 80)); }
      job.done++;
      if (cands.length) { putFile(e.id, 'index.html', cands[cands.length - 1].html); recordFile(e, 'index.html', lineCount(cands[cands.length - 1].html), 'draft'); }
    }
    if (!cands.length) throw new Error('Koi bhi design validation pass nahi hua — dobara try karo');
    let win = cands[0]; let verdict = 'sirf ek design valid tha'; let fixes = '';
    if (cands.length > 1) {
      say('Ava khud judge kar rahi hai — best UI chun rahi hai…');
      const j = await askJ('You are Ava acting as a strict, fair art director. Score each candidate UI 1-10 on: visual hierarchy, polish, originality, usability, mobile + desktop fit, interaction quality, code cleanliness. Pick the single BEST one.\n' + cands.map((c) => '\n=== CANDIDATE ' + c.n + ' (' + c.dir.split(':')[0] + ') ===\n' + c.html.slice(0, 26000)).join('\n') + '\n\nReturn JSON: {"scores":[{"n":1,"score":8,"why":"one sentence"}],"winner":1,"fixes":["the 6 most valuable concrete improvements to the winner"]}');
      const hit = cands.find((c) => c.n === (j && Number(j.winner))); if (hit) win = hit;
      if (j && Array.isArray(j.scores)) verdict = j.scores.map((s) => '#' + s.n + ': ' + s.score + '/10').join(', ') + ' → winner #' + win.n;
      if (j && Array.isArray(j.fixes)) fixes = j.fixes.slice(0, 8).map((x, i) => (i + 1) + '. ' + String(x)).join('\n');
    }
    job.done++; say('Winner #' + win.n + ' ko refine kar rahi hai…'); let best = win;
    try {
      const r = parseUi(await ask(UI_RULES + '\n\n' + b + '\n\nBelow is the winning draft. Apply ALL of these fixes and your own critique (spacing, hierarchy, contrast, mobile fit, missing interactions, code cleanliness) and output the COMPLETE improved file — more premium, still standalone, same format.' + (fixes ? '\nFIXES:\n' + fixes : '') + '\n\nWINNING DRAFT:\n' + win.html.slice(0, 60000) + FORMAT_UI));
      if (r.html && !checkDesign(r.html).length) best = { ...r, meta: Object.assign({}, win.meta, r.meta), n: win.n, dir: win.dir };
    } catch (err) { if (job.cancel) throw err; /* keep the winner */ }
    job.done++;
    putFile(e.id, 'index.html', best.html); recordFile(e, 'index.html', lineCount(best.html), null);
    e.title = String(best.meta.title || 'Ava Best UI').slice(0, 90); e.description = String(best.meta.description || '').slice(0, 400);
    e.notes.push('Tournament: ' + verdict); e.notes.push('Direction: ' + best.dir);
  }

  // ---------------------------------------------------------------- run a job in the background (survives closing the browser; projects resume after a restart)
  async function run(kind, brief, target, resumeEntry) {
    let e = resumeEntry; let ck = null;
    if (e) { try { ck = JSON.parse(fs.readFileSync(ckFile(e.id), 'utf8')); } catch (err) { ck = null; } }
    if (!e) {
      e = { id: nid(), createdAt: new Date().toISOString(), kind: kind === 'ui' ? 'design' : 'project', category: kind === 'ui' ? 'ui' : 'utility', title: kind === 'ui' ? 'Ava UI (ban raha hai…)' : 'Ava Project (ban raha hai…)', description: '', brief: String(brief || '(Ava ne khud chuna)').slice(0, 300), studio: true, status: 'building', target: kind === 'project' ? target : 0, files: [], notes: [], stats: { files: 0, lines: 0, calls: 0 }, sandbox: { ok: true, log: 'ban raha hai' } };
      entries = [e, ...entries]; trimEntries(); ck = { kind, brief: e.brief === '(Ava ne khud chuna)' ? '' : e.brief, target }; saveCk(e.id, ck); save();
    }
    Object.assign(job, { running: true, id: nid(), entryId: e.id, kind, brief: ck ? ck.brief : '', step: 'start', done: 0, total: 0, calls: e.stats ? e.stats.calls : 0, lines: e.stats ? e.stats.lines : 0, target: ck ? ck.target : 0, lastPath: null, log: [], error: null, startedAt: Date.now(), cancel: false, waiting: 0 });
    if (resumeEntry) say('Restart ke baad kaam wahin se dobara shuru');
    try {
      if (kind === 'ui') await buildUi(e, ck.brief); else await buildProject(e, ck);
      e.status = 'done'; e.sandbox = { ok: true, log: e.stats.files + ' file(s), ' + e.stats.lines + ' lines, ' + job.calls + ' AI calls' }; e.stats.calls = job.calls; e.notes = e.notes.slice(-40);
      try { fs.rmSync(ckFile(e.id), { force: true }); } catch (err) { /* ignore */ }
      say('✅ Ho gaya: ' + e.title + ' (' + e.stats.lines + ' lines)'); save();
      if (logEvent) { try { logEvent('proposal', { name: 'Ava' }, 'Ava Studio: "' + e.title + '" ban gaya (' + e.stats.lines + ' lines, sirf gallery me, kahin apply nahi hua)'); } catch (err) { /* ignore */ } }
    } catch (err) {
      job.error = String(err && err.message || err).slice(0, 300); say('❌ ' + job.error);
      const stopped = /owner ne roka/.test(job.error);
      e.status = e.stats.files >= (kind === 'ui' ? 1 : MIN_FILES) ? (stopped ? 'stopped' : 'partial') : 'failed';
      e.notes.push((stopped ? 'Roka gaya' : 'Ruka: ') + (stopped ? '' : job.error.slice(0, 120)));
      if (e.status === 'failed') { rmProject(e.id); entries = entries.filter((x) => x.id !== e.id); } else e.title = e.title.replace(/ \(ban raha hai…\)/, ' (adhoora)');
      save();
    } finally { job.running = false; }
  }

  // ---------------------------------------------------------------- routes
  const hits = { project: [], ui: [] };
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
  router.post('/settings', json, (req, res) => {
    if (!auth.stepUp(req, res)) return; const b = req.body || {};
    if (typeof b.autoUi === 'boolean') settings.autoUi = b.autoUi;
    if (b.uiHours != null) settings.uiHours = Math.min(168, Math.max(1, parseInt(b.uiHours, 10) || 12));
    if (typeof b.autoProject === 'boolean') settings.autoProject = b.autoProject;
    if (b.projectHours != null) settings.projectHours = Math.min(720, Math.max(2, parseInt(b.projectHours, 10) || 24));
    save(); res.json({ ok: true, settings });
  });
  router.get('/status', (req, res) => res.json({ running: job.running, kind: job.kind, step: job.step, done: job.done, total: job.total, calls: job.calls, lines: job.lines, target: job.target, lastPath: job.lastPath, error: job.error, entryId: job.entryId, startedAt: job.startedAt, waitingUntil: job.waiting || 0, settings: { autoUi: settings.autoUi, uiHours: settings.uiHours, autoProject: settings.autoProject, projectHours: settings.projectHours }, log: job.log.slice(-30) }));
  router.get('/list', (req, res) => res.json(entries.map((e) => ({ ...e, fileCount: (e.files || []).length, files: (e.files || []).slice(-14), hasCode: (e.files || []).length > 0 }))));
  router.get('/:id/files', (req, res) => { const e = find(req.params.id); if (!e) return res.status(404).json({ error: 'nahi mila' }); res.json({ files: e.files || [] }); });
  router.get('/:id/file', (req, res) => {
    const e = find(req.params.id); if (!e) return res.status(404).type('text/plain').send('nahi mila');
    const rel = e.kind === 'design' ? 'index.html' : String(req.query.path || '');
    const c = getFile(e.id, rel); if (c == null) return res.status(404).type('text/plain').send('file nahi mili / server reset ke baad purana code nahi bachta');
    res.type('text/plain').send(c);
  });
  router.get('/:id/code', (req, res) => {
    const e = find(req.params.id); if (!e) return res.status(404).type('text/plain').send('nahi mila');
    if (e.kind === 'design') { const h = getFile(e.id, 'index.html'); if (h == null) return res.status(404).type('text/plain').send('code ab store me nahi hai — dobara generate karo'); return res.type('text/html').set('Content-Disposition', 'attachment; filename="ava-ui-' + e.id + '.html"').send(h); }
    const slug = String(e.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ava-project';
    const files = (e.files || []).map((x) => ({ path: slug + '/' + x.path, content: getFile(e.id, x.path) })).filter((x) => x.content != null);
    if (!files.length) return res.status(404).type('text/plain').send('Ye project ka code ab nahi bacha (server reset) — dobara generate karo.');
    res.type('application/zip').set('Content-Disposition', 'attachment; filename="' + slug + '.zip"').send(makeZip(files));
  });
  router.delete('/:id', (req, res) => {
    auth.action(req, 'ava-studio delete ' + req.params.id);
    if (job.running && job.entryId === req.params.id) job.cancel = true;
    entries = entries.filter((e) => e.id !== req.params.id); rmProject(req.params.id); save(); res.json({ ok: true });
  });

  // ---------------------------------------------------------------- background: auto UI + resume after restart
  const tick = setInterval(() => {
    try {
      if (job.running || !haveLLM()) return;
      const now = Date.now();
      if (settings.autoProject && now - (settings.lastAutoProject || 0) >= settings.projectHours * 3600000) { // Ava starts a project on her own (size capped: ~30k lines, quota-friendly)
        settings.lastAutoProject = now; save(); run('project', '', AUTO_PROJECT_LINES).catch(() => {}); return;
      }
      if (settings.autoUi && now - (settings.lastAutoUi || 0) >= settings.uiHours * 3600000) { settings.lastAutoUi = now; save(); run('ui', '', 0).catch(() => {}); }
    } catch (err) { /* never crash the server */ }
  }, 10 * 60000);
  if (tick.unref) tick.unref();
  setTimeout(() => {
    try {
      const e = entries.find((x) => x.status === 'building');
      if (!e) return;
      if (e.kind === 'project' && fs.existsSync(ckFile(e.id)) && haveLLM()) run('project', '', 0, e).catch(() => {});
      else { e.status = (e.files || []).length ? 'partial' : 'failed'; if (e.status === 'failed') { entries = entries.filter((x) => x.id !== e.id); rmProject(e.id); } save(); }
    } catch (err) { /* ignore */ }
  }, 20000);

  return { router, _test: { makeZip, checkFile, checkDesign, outline, job, run: (k, b, t) => run(k, b, t), entries: () => entries, pdir } };
};
