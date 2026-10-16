// backend/sentinel-lib.js — helpers for Sentinel (no network, no side effects)
//   * makeDiff      real line diff with line numbers (what the dashboard shows)
//   * applyEdits    applies the AI's small "find -> replace" edits to a file
//   * validateNew   refuses obviously broken results before they become proposals
//   * file discovery for ANY stack (Python, Node, PHP, Go, Java, Ruby, HTML sites, ...)
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------- diff
function splitLines(t) { return String(t).replace(/\r\n/g, '\n').split('\n'); }

function lineOps(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let ea = a.length, eb = b.length;
  while (ea > start && eb > start && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(start, ea), B = b.slice(start, eb);
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ t: ' ', s: a[i] });
  if (A.length * B.length <= 4000000) {
    const n = A.length, m = B.length, w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push({ t: ' ', s: A[i] }); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) ops.push({ t: '-', s: A[i++] });
      else ops.push({ t: '+', s: B[j++] });
    }
    while (i < n) ops.push({ t: '-', s: A[i++] });
    while (j < m) ops.push({ t: '+', s: B[j++] });
  } else { // huge rewrite: don't burn CPU, show it as one replaced block
    A.forEach((s) => ops.push({ t: '-', s }));
    B.forEach((s) => ops.push({ t: '+', s }));
  }
  for (let i = ea; i < a.length; i++) ops.push({ t: ' ', s: a[i] });
  return ops;
}

// -> { added, removed, truncated, hunks:[{oldStart,oldLines,newStart,newLines,rows:[[sign,oldNo,newNo,text]]}] }
function makeDiff(oldText, newText, opts) {
  const context = (opts && opts.context) || 3;
  const maxRows = (opts && opts.maxRows) || 400;
  const ops = lineOps(splitLines(oldText), splitLines(newText));
  let o = 0, n = 0, added = 0, removed = 0;
  const rows = ops.map((op) => {
    if (op.t === ' ') { o++; n++; return [' ', o, n, op.s.slice(0, 300)]; }
    if (op.t === '-') { o++; removed++; return ['-', o, null, op.s.slice(0, 300)]; }
    n++; added++; return ['+', null, n, op.s.slice(0, 300)];
  });
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => { if (r[0] !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true; });
  const hunks = []; let cur = null, total = 0, truncated = false;
  for (let i = 0; i < rows.length; i++) {
    if (!keep[i]) { cur = null; continue; }
    if (total >= maxRows) { truncated = true; break; }
    if (!cur) { cur = { oldStart: rows[i][1] || (rows[i][2] ? 0 : 0), newStart: rows[i][2] || 0, oldLines: 0, newLines: 0, rows: [] }; hunks.push(cur); }
    const r = rows[i];
    if (!cur.rows.length) { // anchor hunk header to real line numbers
      let oi = 0, ni = 0; for (let k = 0; k < i; k++) { if (rows[k][0] !== '+') oi++; if (rows[k][0] !== '-') ni++; }
      cur.oldStart = oi + 1; cur.newStart = ni + 1;
    }
    cur.rows.push(r); total++;
    if (r[0] !== '+') cur.oldLines++;
    if (r[0] !== '-') cur.newLines++;
  }
  return { added, removed, truncated, hunks };
}

// ---------------------------------------------------------------- edits
// edits: [{ find, replace }]  — `find` must match EXACTLY ONE place in the file.
function applyEdits(content, edits) {
  if (!Array.isArray(edits) || !edits.length) return { ok: false, error: 'no edits' };
  if (edits.length > 6) return { ok: false, error: 'too many edits' };
  let out = content;
  const crlf = content.includes('\r\n');
  for (const e of edits) {
    if (!e || typeof e.find !== 'string' || typeof e.replace !== 'string' || !e.find.trim()) return { ok: false, error: 'bad edit' };
    let find = e.find, rep = e.replace;
    if (crlf) { find = find.replace(/\r?\n/g, '\r\n'); rep = rep.replace(/\r?\n/g, '\r\n'); }
    const first = out.indexOf(find);
    if (first === -1) return { ok: false, error: 'snippet not found in file' };
    if (out.indexOf(find, first + 1) !== -1) return { ok: false, error: 'snippet is not unique' };
    out = out.slice(0, first) + rep + out.slice(first + find.length);
  }
  return { ok: true, content: out };
}

function validateNew(name, oldC, newC) {
  if (newC === oldC) return 'no change';
  if (newC.length < oldC.length * 0.6 && oldC.length > 400) return 'file shrank too much';
  if (newC.length > oldC.length * 3 + 2000) return 'file grew too much';
  const ext = path.extname(name).toLowerCase();
  if (ext === '.json') { try { JSON.parse(newC); } catch (e) { return 'invalid JSON'; } }
  if (ext === '.js' || ext === '.cjs') {
    if (!/^\s*(import|export)\s/m.test(newC)) {
      try { new vm.Script(newC.replace(/^#!.*/, ''), { filename: name }); } catch (e) { return 'JS syntax error: ' + String(e.message).slice(0, 80); }
    }
  }
  if (ext === '.py') {
    const r = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: newC, timeout: 5000 });
    if (!r.error && r.status !== 0) return 'Python syntax error';   // if python3 isn't installed we simply skip this check
  }
  return null;
}

// ---------------------------------------------------------------- file discovery (any stack)
const SOURCE_EXT = new Set(['.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.html', '.htm', '.php', '.rb', '.go', '.java', '.kt', '.cs', '.rs', '.sh']);
const SKIP_DIR = /(^|\/)(node_modules|\.git|\.github|dist|build|out|coverage|vendor|venv|\.venv|env|__pycache__|\.next|\.nuxt|site-packages|migrations|static\/vendor|public\/vendor|assets\/vendor|bower_components)(\/|$)/i;
const SKIP_FILE = /(\.min\.(js|css)|\.bundle\.js|\.map|package-lock\.json|yarn\.lock)$/i;
const MAX_FILE_BYTES = 200 * 1024;

function isSourceFile(rel, size) {
  if (SKIP_DIR.test(rel) || SKIP_FILE.test(rel)) return false;
  if (size && size > MAX_FILE_BYTES) return false;
  return SOURCE_EXT.has(path.extname(rel).toLowerCase());
}

function walkLocal(root) {
  const out = [];
  (function walk(dir, depth) {
    if (depth > 6 || out.length >= 400) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) { if (!SKIP_DIR.test(rel + '/')) walk(full, depth + 1); }
      else {
        let size = 0; try { size = fs.statSync(full).size; } catch (er) { continue; }
        if (isSourceFile(rel, size)) out.push({ name: rel, size });
      }
    }
  })(root, 0);
  return out;
}

const ENTRY = /(^|\/)(main|app|server|index|wsgi|asgi|manage|run|api|routes?|views|urls|settings|config|auth|login|db|database|models?)\.[a-z]+$/i;
// most important first: files named in the error / traceback, then entry points, then smaller files
function rankFiles(files, hintText) {
  const hint = String(hintText || '').toLowerCase();
  const score = (f) => {
    const base = path.basename(f.name).toLowerCase();
    let s = 0;
    if (hint && (hint.includes(f.name.toLowerCase()) || (base.length > 3 && hint.includes(base)))) s -= 100;
    if (ENTRY.test(f.name)) s -= 20;
    if (/(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\./i.test(f.name)) s += 30;
    return s + Math.min(f.size || 0, 100000) / 20000;
  };
  return files.slice().sort((a, b) => score(a) - score(b));
}

function chunkFiles(files, budget, perFileCap) {
  const batches = []; let cur = [], used = 0;
  for (const f of files) {
    const cost = Math.min(f.size || 2000, perFileCap) + 60;
    if (cur.length && used + cost > budget) { batches.push(cur); cur = []; used = 0; }
    cur.push(f); used += cost;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// ---------------------------------------------------------------- stack hints for the AI
const HINTS = {
  python: 'Python: bare `except:` hiding errors, mutable default arguments, SQL built with f-strings/format/%, eval/exec/pickle.loads/yaml.load on untrusted data, subprocess with shell=True, debug=True in production, missing None checks, missing `await`, file/connection not closed, hardcoded SECRET_KEY/tokens.',
  node: 'Node.js: unhandled promise rejections, missing await, null/undefined access, callbacks that never respond, eval/child_process with user input, NoSQL injection, missing auth middleware, memory leaks (listeners/intervals).',
  php: 'PHP: SQL built by string concatenation, unescaped output (XSS), include/require with user input, missing CSRF/auth checks, file upload without validation, display_errors on.',
  web: 'Website front-end: innerHTML/document.write with user data (XSS), API keys/secrets in client JS, target=_blank without rel=noopener, http:// (mixed content), missing form validation, broken script/link references, eval().',
  go: 'Go: ignored errors, goroutine leaks, nil pointer dereference, missing defer Close(), SQL string concatenation.',
  java: 'Java/Kotlin: NullPointerException paths, unclosed resources, SQL string concatenation, missing auth checks, unsafe deserialization.',
  ruby: 'Ruby: SQL interpolation, mass-assignment, missing auth filters, eval/send with user input.',
};
function detectStack(names) {
  const ext = new Set(names.map((n) => path.extname(n).toLowerCase()));
  const set = [];
  if (ext.has('.py')) set.push('python');
  if (ext.has('.js') || ext.has('.mjs') || ext.has('.cjs') || ext.has('.ts')) set.push('node');
  if (ext.has('.php')) set.push('php');
  if (ext.has('.html') || ext.has('.htm') || ext.has('.jsx') || ext.has('.tsx') || ext.has('.vue') || ext.has('.svelte')) set.push('web');
  if (ext.has('.go')) set.push('go');
  if (ext.has('.java') || ext.has('.kt')) set.push('java');
  if (ext.has('.rb')) set.push('ruby');
  return { stacks: set, hints: set.map((s) => HINTS[s]).join('\n') };
}

// ---------------------------------------------------------------- website: SSL expiry
function sslDaysLeft(host) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const sock = tls.connect({ host, port: 443, servername: host, timeout: 6000 }, () => {
        const cert = sock.getPeerCertificate();
        sock.end();
        finish(cert && cert.valid_to ? Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86400000) : null);
      });
      sock.on('error', () => finish(null));
      sock.on('timeout', () => { sock.destroy(); finish(null); });
    } catch (e) { finish(null); }
  });
}

module.exports = { makeDiff, applyEdits, validateNew, isSourceFile, walkLocal, rankFiles, chunkFiles, detectStack, sslDaysLeft, MAX_FILE_BYTES };
