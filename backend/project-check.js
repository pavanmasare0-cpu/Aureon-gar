// backend/project-check.js — project ka "code health check": ZIP ko sirf PADHTA hai (kuch run/extract nahi hota).
// Syntax (compile-only), JSON, package.json main/start, missing ./require, hardcoded secrets (value kabhi report me nahi aati).
'use strict';
const vm = require('vm');
const path = require('path');
const attach = require('./attach');

const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|__pycache__|\.gradle|vendor|coverage|target|android\/app\/build)(\/|$)/;
const TEXT = /\.(js|cjs|mjs|json|html|htm|css|env|md|txt|yml|yaml|xml|properties|gradle)$/i;
const SECRETS = [
  ['Google/Gemini API key', /AIza[0-9A-Za-z_\-]{30,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_\-]{20,}/],
  ['Groq key', /\bgsk_[A-Za-z0-9]{20,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['Slack token', /\bxox[abp]-[A-Za-z0-9\-]{10,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['Hardcoded secret/password', /(?:api[_-]?key|secret|passwd|password|token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i],
];
const cap = (a, n) => a.slice(0, n);

function checkFiles(files) {
  const have = new Set(files.map((f) => f.path));
  const rep = { files: files.length, js: { checked: 0, ok: 0, esmSkipped: 0, bad: [] }, json: { bad: [] }, pkg: { found: false, issues: [] }, missingRequires: [], secrets: [], envFiles: [] };
  for (const f of files) {
    const src = String(f.content || '');
    if (/(^|\/)\.env(\.(?!example|sample|template)[\w.-]+)?$/i.test(f.path)) rep.envFiles.push(f.path);
    if (/\.(js|cjs)$/i.test(f.path)) {
      if (/^\s*(import\s[^('"]*from\s|import\s*['"]|export\s+(default|const|function|class|\{))/m.test(src)) rep.js.esmSkipped++;
      else {
        rep.js.checked++;
        try { new vm.Script('(function(exports,require,module,__filename,__dirname){' + src.replace(/^#!.*/, '') + '\n})', { filename: f.path }); rep.js.ok++; }
        catch (e) { const m = String((e.stack || '').split('\n')[0] || '').match(/:(\d+)\s*$/); rep.js.bad.push({ path: f.path, error: String(e.message).slice(0, 140), line: m ? +m[1] : undefined }); }
        const dir = path.posix.dirname(f.path); let m; const re = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
        while ((m = re.exec(src))) {
          const r = path.posix.normalize(path.posix.join(dir, m[1]));
          if (![r, r + '.js', r + '.cjs', r + '.json', r + '/index.js'].some((x) => have.has(x))) rep.missingRequires.push(f.path + ' -> ' + m[1]);
        }
      }
    }
    if (/\.json$/i.test(f.path)) { try { JSON.parse(src); } catch (e) { rep.json.bad.push({ path: f.path, error: String(e.message).slice(0, 120) }); } }
    const lines = src.split('\n');
    for (let i = 0; i < lines.length && rep.secrets.length < 60; i++) {
      if (lines[i].length > 600) continue;
      for (const [kind, re] of SECRETS) if (re.test(lines[i])) { rep.secrets.push({ path: f.path, line: i + 1, kind }); break; }
    }
  }
  const pk = files.find((f) => f.path === 'package.json');
  if (pk) {
    rep.pkg.found = true;
    try {
      const j = JSON.parse(pk.content); rep.pkg.name = j.name;
      if (j.main && !have.has(path.posix.normalize(j.main))) rep.pkg.issues.push('main file nahi mili: ' + j.main);
      const st = j.scripts && j.scripts.start, mm = st && String(st).match(/node\s+([^\s&|;]+\.c?js)/);
      if (mm && !have.has(path.posix.normalize(mm[1]))) rep.pkg.issues.push('npm start ki file nahi mili: ' + mm[1]);
      if (!j.main && !st) rep.pkg.issues.push('package.json me na main hai na start script');
    } catch (e) { rep.pkg.issues.push('package.json parse nahi hota'); }
  }
  const bad = rep.js.bad.length || rep.json.bad.length || rep.pkg.issues.length || rep.missingRequires.length;
  rep.verdict = bad ? 'BAD' : (rep.secrets.length || rep.envFiles.length ? 'RISK' : 'GOOD');
  rep.js.bad = cap(rep.js.bad, 25); rep.json.bad = cap(rep.json.bad, 15); rep.missingRequires = cap(rep.missingRequires, 25); rep.secrets = cap(rep.secrets, 25);
  return rep;
}

function checkZip(buf) {
  const ents = attach.zipEntries(buf).filter((x) => x.name && !x.name.endsWith('/') && !/(^|\/)\.\.(\/|$)/.test(x.name) && !x.name.startsWith('/') && !SKIP.test(x.name) && !/(^|\/)__MACOSX\//.test(x.name) && TEXT.test(x.name) && x.usize <= 400 * 1024);
  const roots = new Set(ents.map((x) => x.name.split('/')[0])); const strip = roots.size === 1 && ents.every((x) => x.name.includes('/')) ? [...roots][0] + '/' : '';
  const files = [];
  for (const en of ents.slice(0, 1500)) { const b = attach.readEntry(buf, en); if (b) files.push({ path: strip ? en.name.slice(strip.length) : en.name, content: b.toString('utf8') }); }
  if (!files.length) throw new Error('zip me padhne layak code file nahi mili');
  return checkFiles(files);
}

module.exports = { checkFiles, checkZip };
