// backend/code-check.js
// Aureon Coding mode: every code block in an answer is SYNTAX-CHECKED on the server before the user sees it.
// Nothing is ever run: node --check, python ast.parse, bash -n and JSON.parse only read the code.
// Each check runs in a fresh temp folder with a stripped environment (no API keys) and a short timeout.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const LIMITS = { blocks: 12, bytes: 200000, ms: 5000 };
const CLEAN_ENV = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: os.tmpdir() };
const LANGS = { js: 'js', javascript: 'js', node: 'js', mjs: 'js', cjs: 'js', py: 'py', python: 'py', python3: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', json: 'json' };
const LABEL = { js: 'JavaScript', py: 'Python', sh: 'bash', json: 'JSON' };

const FENCE = '\u0060\u0060\u0060'; // three backticks, written this way so pasting this file never breaks a code block
function extractBlocks(text) {
  const out = []; const re = new RegExp('^[ \\t]*' + FENCE + '([^\\n\u0060]*)\\n([\\s\\S]*?)^[ \\t]*' + FENCE + '[ \\t]*$', 'gm'); let m;
  while ((m = re.exec(text))) out.push({ n: out.length + 1, tag: (m[1] || '').trim().toLowerCase().split(/\s+/)[0] || '', code: m[2].replace(/\n$/, '') });
  return out;
}

function run(cmd, args, dir) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: dir, env: CLEAN_ENV, timeout: LIMITS.ms, maxBuffer: 65536 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return resolve({ unavailable: true });
      if (err && err.killed) return resolve({ error: 'timeout', line: null });
      resolve({ ok: !err, stderr: String(stderr || '') });
    });
  });
}
async function inTemp(file, code, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
  try { fs.writeFileSync(path.join(dir, file), code, 'utf8'); return await fn(dir, path.join(dir, file)); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* tmp cleanup is best effort */ } }
}

async function checkJs(code) {
  const attempt = (name) => inTemp(name, code, async (dir, file) => {
    const r = await run(process.execPath, ['--check', file], dir);
    if (r.ok || r.unavailable || r.error) return r;
    const line = (r.stderr.match(/\.m?js:(\d+)/) || [])[1];
    const msg = (r.stderr.match(/^(?:SyntaxError|ReferenceError|Error):.*$/m) || [r.stderr.split('\n').find(Boolean) || 'syntax error'])[0];
    return { ok: false, line: line ? Number(line) : null, message: msg.slice(0, 160) };
  });
  let r = await attempt('c.js');
  if (!r.ok && /import statement|export|await is only valid|import\.meta/i.test(r.message || '')) r = await attempt('c.mjs'); // modern ES-module code
  return r;
}
const PY_CHECK = "import ast,sys\ntry:\n    ast.parse(open(sys.argv[1],encoding='utf-8').read(), sys.argv[1])\nexcept SyntaxError as e:\n    print('LINE', e.lineno or 0, e.msg, file=sys.stderr)\n    sys.exit(1)\n";
async function checkPy(code) {
  return inTemp('c.py', code, async (dir, file) => {
    for (const bin of ['python3', 'python']) {
      const r = await run(bin, ['-c', PY_CHECK, file], dir);
      if (r.unavailable) continue;
      if (r.ok || r.error) return r;
      const m = r.stderr.match(/LINE (\d+) (.*)/) || [];
      return { ok: false, line: m[1] ? Number(m[1]) : null, message: (m[2] || 'SyntaxError').slice(0, 160) };
    }
    return { unavailable: true };
  });
}
async function checkSh(code) {
  return inTemp('c.sh', code, async (dir, file) => {
    const r = await run('bash', ['-n', file], dir);
    if (r.ok || r.unavailable || r.error) return r;
    const line = (r.stderr.match(/line (\d+)/) || [])[1];
    const msg = (r.stderr.split('\n').find(Boolean) || 'syntax error').replace(/^.*?line \d+:\s*/, '');
    return { ok: false, line: line ? Number(line) : null, message: msg.slice(0, 160) };
  });
}
async function checkJson(code) {
  try { JSON.parse(code); return { ok: true }; }
  catch (e) { return { ok: false, line: null, message: String(e.message).slice(0, 160) }; }
}
const CHECKERS = { js: checkJs, py: checkPy, sh: checkSh, json: checkJson };

// python / node / files written with a heredoc inside a bash block are checked too (that is how patches get pasted)
function heredocs(code) {
  const out = []; const re = /^([^\n]*)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/gm; let m;
  while ((m = re.exec(code))) {
    const head = m[1]; let lang = null;
    if (/\bpython3?\s+-(\s|$)/.test(head) || />\s*\S+\.py\b/.test(head)) lang = 'py';
    else if (/\bnode\s+-(\s|$)/.test(head) || />\s*\S+\.(m|c)?js\b/.test(head)) lang = 'js';
    else if (/>\s*\S+\.json\b/.test(head)) lang = 'json';
    else if (/>\s*\S+\.sh\b/.test(head)) lang = 'sh';
    if (lang) out.push({ lang, code: m[4] });
  }
  return out;
}

async function checkAnswer(text) {
  const blocks = extractBlocks(text).slice(0, LIMITS.blocks);
  let bytes = 0; const results = [];
  for (const b of blocks) {
    const lang = LANGS[b.tag] || null; bytes += b.code.length;
    const lines = b.code.split('\n').length;
    if (!lang) { if (lines >= 6 && b.tag) results.push({ n: b.n, lang: b.tag, status: 'skipped', note: 'is language ka checker server par nahi hai' }); continue; }
    if (bytes > LIMITS.bytes) { results.push({ n: b.n, lang: LABEL[lang], status: 'skipped', note: 'code bahut bada hai' }); continue; }
    const hd = lang === 'sh' ? heredocs(b.code) : [];
    if (lang === 'sh' && lines < 3 && !hd.length) continue; // one-line commands: nothing worth reporting
    if (lang === 'sh' && /<[A-Za-z][\w-]*>/.test(b.code.replace(/<<-?\s*['"]?\w+['"]?[\s\S]*$/m, ''))) { results.push({ n: b.n, lang: LABEL[lang], status: 'skipped', note: 'placeholder (<...>) hai, bash check nahi hua' }); continue; }
    const parts = [{ lang, code: b.code, label: LABEL[lang] }].concat(hd.map((h) => ({ lang: h.lang, code: h.code, label: LABEL[h.lang] + ' (heredoc ke andar)' })));
    for (const p of parts) {
      const r = await CHECKERS[p.lang](p.code);
      if (r.unavailable) results.push({ n: b.n, lang: p.label, status: 'skipped', note: 'checker server par install nahi hai' });
      else if (r.error) results.push({ n: b.n, lang: p.label, status: 'skipped', note: 'check time-out ho gaya' });
      else if (r.ok) results.push({ n: b.n, lang: p.label, status: 'ok' });
      else results.push({ n: b.n, lang: p.label, status: 'error', line: r.line, message: r.message });
    }
  }
  return results;
}

function footer(results, fixed) {
  if (!results.length) return '';
  const L = results.map((r) => r.status === 'ok' ? `- Block ${r.n} (${r.lang}): OK`
    : r.status === 'error' ? `- Block ${r.n} (${r.lang}): ERROR${r.line ? ' line ' + r.line : ''}: ${r.message}`
    : `- Block ${r.n} (${r.lang}): check nahi hua (${r.note})`);
  const bad = results.some((r) => r.status === 'error');
  return `\n\nTest (server par syntax check, code chalaya nahi gaya):\n${L.join('\n')}\n` +
    (fixed && !bad ? 'Pehle version me galti mili thi, server ne ek baar theek karwaya.\n' : '') +
    (bad ? 'Abhi bhi error hai: ye code mat chalao, ye test result mujhe bhej do.\n' : 'Sirf syntax check hua. Logic aur asli phone/server par chalna test nahi hua; fail ho to error ka screenshot bhejo.\n');
}

function errorPrompt(results) {
  const errs = results.filter((r) => r.status === 'error').map((r) => `- Block ${r.n} (${r.lang})${r.line ? ' line ' + r.line : ''}: ${r.message}`).join('\n');
  return `Server ke syntax check ne ye errors pakde:\n${errs}\nSirf galat code theek karke poora jawab dobara likho (same format aur same bhasha). Naye errors mat laana. Khud ko "tested" mat batana, server test result alag se jodta hai.`;
}

// regenerate(errorPrompt, previousAnswer) must return the new full answer text ('' if it cannot)
async function verifyAndFix(answer, regenerate) {
  let text = answer, results = await checkAnswer(text), fixed = false;
  if (results.some((r) => r.status === 'error') && typeof regenerate === 'function') {
    const again = await regenerate(errorPrompt(results), text);
    if (again && typeof again === 'string' && again.includes(FENCE)) {
      const r2 = await checkAnswer(again);
      if (r2.filter((r) => r.status === 'error').length <= results.filter((r) => r.status === 'error').length) { text = again; results = r2; fixed = true; }
    }
  }
  return text.replace(/\s+$/, '') + footer(results, fixed);
}

// ---- Review rounds: after the syntax check, the model re-reads its own answer like a strict reviewer, up to N times. ----
const REVIEW_PROMPT = 'Now REVIEW your previous answer like a strict senior code reviewer. Look for REAL bugs only: wrong logic, off-by-one, undefined or missing variables/imports, wrong library/API usage, async/await mistakes, unhandled errors, edge cases (empty/null input), security holes. '
  + 'If you find NO real bugs, reply with exactly: NO_BUGS. '
  + 'If you find bugs, reply with the COMPLETE corrected answer (same format, every code block in full, no placeholders), and make the first line: "Fixed: <short list of what you fixed>".';
const errCount = (rs) => rs.filter((r) => r.status === 'error').length;
async function reviewRounds(answer, regenerate, rounds) {
  const max = rounds === undefined ? Number(process.env.AUREON_CODE_REVIEW_ROUNDS === undefined ? 2 : process.env.AUREON_CODE_REVIEW_ROUNDS) : rounds;
  let text = answer;
  if (!(max > 0) || typeof regenerate !== 'function' || typeof text !== 'string') return text;
  if (extractBlocks(text).reduce((n, b) => n + b.code.length, 0) < 300) return text;   // tiny snippets: not worth an extra AI call
  for (let i = 0; i < max; i++) {
    let out;
    try { out = await regenerate(REVIEW_PROMPT, text); } catch (e) { break; }
    if (!out || typeof out !== 'string' || /^\s*NO_BUGS\b/i.test(out) || !out.includes(FENCE)) break;
    try { if (errCount(await checkAnswer(out)) > errCount(await checkAnswer(text))) break; } catch (e) { break; }   // never accept a version with more syntax errors
    text = out;
  }
  return text;
}

module.exports = { verifyAndFix, reviewRounds, checkAnswer, extractBlocks, footer, _cleanEnv: CLEAN_ENV };
