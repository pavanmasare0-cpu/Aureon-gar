// security/linkscan.js — "is this link a scam / phishing / malware download?"
//
// Combines (1) what the URL itself looks like, (2) what the server really answers when
// it is visited by US (never by your phone), (3) who owns the domain and how old it is,
// (4) the TLS certificate, and optionally (5) Google Safe Browsing / VirusTotal when you
// add GOOGLE_SAFE_BROWSING_KEY / VT_API_KEY on Render.
//
// It is a risk estimator, not a guarantee: "LOW RISK" never means "100% safe".
// SSRF-safe: every hop is resolved first, private / internal addresses are refused, and the
// connection is pinned to the address that was checked.
const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const tls = require('tls');

const allowPrivate = () => process.env.LINKSCAN_ALLOW_PRIVATE === '1';   // for automated tests only

// ---------------------------------------------------------------- knowledge
const BRANDS = [
  ['paytm', ['paytm.com', 'paytm.in']], ['phonepe', ['phonepe.com']], ['gpay', ['pay.google.com']], ['googlepay', ['pay.google.com']],
  ['sbi', ['sbi.co.in', 'onlinesbi.sbi', 'onlinesbi.com', 'sbicard.com']], ['hdfc', ['hdfcbank.com', 'hdfc.com']], ['hdfcbank', ['hdfcbank.com']],
  ['icici', ['icicibank.com']], ['icicibank', ['icicibank.com']], ['axisbank', ['axisbank.com']], ['kotak', ['kotak.com']], ['pnb', ['pnbindia.in']],
  ['google', ['google.com', 'google.co.in', 'gmail.com']], ['gmail', ['gmail.com', 'google.com']], ['amazon', ['amazon.in', 'amazon.com']], ['flipkart', ['flipkart.com']],
  ['whatsapp', ['whatsapp.com', 'wa.me']], ['instagram', ['instagram.com']], ['facebook', ['facebook.com', 'fb.com']], ['netflix', ['netflix.com']],
  ['microsoft', ['microsoft.com', 'live.com', 'office.com']], ['apple', ['apple.com', 'icloud.com']], ['paypal', ['paypal.com']], ['irctc', ['irctc.co.in']],
  ['incometax', ['incometax.gov.in', 'incometaxindia.gov.in']], ['uidai', ['uidai.gov.in']], ['aadhaar', ['uidai.gov.in']], ['jio', ['jio.com']], ['airtel', ['airtel.in']],
  ['github', ['github.com']], ['telegram', ['telegram.org', 't.me']], ['binance', ['binance.com']], ['coinbase', ['coinbase.com']], ['meesho', ['meesho.com']], ['myntra', ['myntra.com']],
];
const OFFICIAL = new Set(BRANDS.flatMap(([, d]) => d));
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'rb.gy', 'shorturl.at', 'ow.ly', 'bit.do', 'tiny.cc', 'rebrand.ly', 'tinyurl.is', 'v.gd', 'shorte.st', 'adf.ly']);
const RISKY_TLD = new Set(['zip', 'mov', 'tk', 'ml', 'ga', 'cf', 'gq', 'xyz', 'top', 'click', 'link', 'work', 'support', 'rest', 'country', 'buzz', 'cam', 'icu', 'monster', 'cyou', 'sbs', 'bond', 'vip', 'loan', 'win', 'bid', 'men', 'date', 'party']);
const KEYWORDS = ['login', 'signin', 'verify', 'verification', 'secure', 'update', 'account', 'kyc', 'otp', 'refund', 'claim', 'prize', 'lottery', 'reward', 'freegift', 'free', 'recharge', 'gift', 'bonus', 'helpdesk', 'suspend', 'unlock', 'wallet', 'bank', 'cashback', 'winner', 'offer', 'pan', 'aadhaar', 'electricity', 'bill'];
const BAD_EXT = ['apk', 'exe', 'scr', 'bat', 'cmd', 'msi', 'jar', 'vbs', 'ps1', 'hta', 'lnk', 'dmg', 'pkg', 'iso', 'dll', 'xapk', 'apks'];
const SLD2 = new Set(['co.in', 'gov.in', 'org.in', 'net.in', 'ac.in', 'co.uk', 'org.uk', 'com.au', 'co.jp', 'com.br', 'co.za', 'com.pk', 'com.bd']);

function registrable(host) {
  const p = host.toLowerCase().split('.').filter(Boolean);
  if (p.length <= 2 || net.isIP(host)) return host.toLowerCase();
  const last2 = p.slice(-2).join('.');
  return SLD2.has(last2) ? p.slice(-3).join('.') : last2;
}
function lev(a, b) {
  const m = a.length, n = b.length; if (Math.abs(m - n) > 2) return 3;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

// ---------------------------------------------------------------- safe networking
function isPrivateAddr(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0);
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return isPrivateAddr(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}
async function resolveSafe(host) {
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host, family: net.isIP(host) }];
  else addrs = await Promise.race([dns.lookup(host, { all: true }), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('dns timeout'), { code: 'ENOTFOUND' })), 5000))]);
  if (!addrs.length) throw new Error('no address');
  if (!allowPrivate() && addrs.some((a) => isPrivateAddr(a.address))) { const e = new Error('private'); e.private = true; throw e; }
  return addrs[0];
}
function fetchPinned(u, addr, maxBytes) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET', servername: u.hostname,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36', Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Encoding': 'identity' },
      lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)),
      rejectUnauthorized: false, timeout: 8000,
    }, (res) => {
      const chunks = []; let n = 0, truncated = false;
      res.on('data', (c) => { n += c.length; if (n <= maxBytes) chunks.push(c); else if (!truncated) { truncated = true; req.destroy(); } });
      const done = () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated, tlsOk: res.socket && res.socket.authorized, tlsError: res.socket && res.socket.authorizationError ? String(res.socket.authorizationError) : null });
      res.on('end', done); res.on('close', done);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
async function follow(startUrl, maxHops) {
  const chain = []; let cur = new URL(startUrl);
  for (let i = 0; i <= maxHops; i++) {
    if (!['http:', 'https:'].includes(cur.protocol)) throw new Error('unsupported protocol on redirect');
    const port = parseInt(cur.port, 10);
    if (port && !(port === 80 || port === 443 || (port >= 8000 && port <= 8999))) throw new Error('port not allowed');
    const addr = await resolveSafe(cur.hostname);
    const r = await fetchPinned(cur, addr, 200 * 1024);
    chain.push({ url: cur.href, status: r.status });
    const loc = r.headers.location;
    if (r.status >= 300 && r.status < 400 && loc) { cur = new URL(loc, cur); continue; }
    return { chain, final: Object.assign({ url: cur.href }, r) };
  }
  return { chain, final: null, tooManyRedirects: true };
}
function certInfo(host) {
  return new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      resolveSafe(host).then((addr) => {
        const s = tls.connect({ host: addr.address, port: 443, servername: host, rejectUnauthorized: false, timeout: 6000 }, () => {
          const c = s.getPeerCertificate(); s.end();
          if (!c || !c.valid_from) return fin(null);
          const from = Date.parse(c.valid_from), to = Date.parse(c.valid_to);
          fin({ issuer: (c.issuer && (c.issuer.O || c.issuer.CN)) || '?', subject: (c.subject && c.subject.CN) || '?', ageDays: Math.floor((Date.now() - from) / 86400000), daysLeft: Math.floor((to - Date.now()) / 86400000), selfSigned: !!(c.issuer && c.subject && c.issuer.CN === c.subject.CN && c.issuer.O === c.subject.O), authorized: s.authorized });
        });
        s.on('error', () => fin(null)); s.on('timeout', () => { s.destroy(); fin(null); });
      }).catch(() => fin(null));
    } catch (e) { fin(null); }
  });
}
async function domainAgeDays(host) {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 6000);
    const r = await fetch(`https://rdap.org/domain/${encodeURIComponent(registrable(host))}`, { signal: c.signal, headers: { Accept: 'application/rdap+json' } });
    clearTimeout(t); if (!r.ok) return null;
    const j = await r.json(); const ev = (j.events || []).find((e) => e.eventAction === 'registration');
    return ev ? Math.floor((Date.now() - Date.parse(ev.eventDate)) / 86400000) : null;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- analysis
const LEVELS = [[60, 'DANGEROUS'], [25, 'SUSPICIOUS'], [0, 'LOW RISK']];
const levelOf = (score) => LEVELS.find(([min]) => score >= min)[1];

function staticChecks(u, add, info) {
  const host = u.hostname.toLowerCase(), reg = registrable(host), labels = host.split('.');
  const tld = labels[labels.length - 1], pathq = (u.pathname + u.search).toLowerCase();
  info.domain = reg;
  if (u.protocol === 'javascript:' || u.protocol === 'data:' || u.protocol === 'file:') add(80, 'HIGH', `"${u.protocol}" link — ye website nahi, seedha code/file hai`);
  if (u.protocol === 'http:') add(12, 'MEDIUM', 'HTTPS nahi hai (http) — data raste mein padha ja sakta hai');
  if (net.isIP(host)) add(25, 'HIGH', 'Website ka naam nahi, seedha IP address hai — scam links mein aam hai');
  if (u.username || u.password || /@/.test(u.href.split('?')[0].replace(/^https?:\/\//, '').split('/')[0])) add(25, 'HIGH', 'Link mein "@" hai — asli jagah alag hoti hai jo dikhta hai usse');
  if (host.includes('xn--')) add(25, 'HIGH', 'Punycode (xn--) domain — dikhne mein asli jaisa nakli naam (homograph) ho sakta hai');
  if (/[^\x00-\x7f]/.test(u.hostname)) add(20, 'HIGH', 'Domain mein non-English akshar hain');
  if (RISKY_TLD.has(tld)) add(12, 'MEDIUM', `".${tld}" extension aksar scam / free domains mein dikhta hai`);
  if (SHORTENERS.has(reg)) add(10, 'MEDIUM', 'Short link hai — asli destination chhupa hota hai (neeche expand kiya gaya hai)');
  if (labels.length > 4) add(10, 'MEDIUM', 'Bahut saare subdomains — asli domain chhupane ki chaal');
  if ((host.match(/-/g) || []).length >= 3) add(8, 'MEDIUM', 'Domain mein bahut "-" hain');
  if (/https?[-.]/.test(host)) add(15, 'HIGH', 'Domain ke naam mein "http/https" likha hai — bharosa dilane ki chaal');
  if (u.port && !['80', '443'].includes(u.port)) add(8, 'MEDIUM', `Alag port (${u.port}) use ho raha hai`);
  if (u.href.length > 120) add(6, 'LOW', 'Bahut lamba URL');
  const kw = KEYWORDS.filter((k) => host.includes(k) || pathq.includes(k));
  if (kw.length) add(Math.min(24, kw.length * 8), kw.length >= 2 ? 'MEDIUM' : 'LOW', `Shabd jo scam links mein aam hain: ${kw.slice(0, 5).join(', ')}`);
  const ext = (u.pathname.split('.').pop() || '').toLowerCase();
  if (BAD_EXT.includes(ext)) add(40, 'HIGH', `Link seedha ".${ext}" file download karwata hai`);
  if (/\.(pdf|jpg|jpeg|png|doc|docx|xls|xlsx|mp4)\.(apk|exe|scr|bat|js|vbs|msi|jar)$/i.test(u.pathname)) add(30, 'HIGH', 'Double extension (jaise .pdf.apk) — file ka asli roop chhupane ki chaal');
  // brand impersonation
  const tokens = host.split(/[.\-]/);
  for (const [brand, official] of BRANDS) {
    if (official.includes(reg)) { info.officialBrand = brand; break; }
    const exact = tokens.includes(brand);
    const norm = (t) => t.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/1/g, 'l');   // look-alike letters: rn->m, 0->o ...
    const typo = brand.length >= 5 && tokens.some((t) => t.length >= 5 && t !== brand && (norm(t) === brand || lev(t, brand) === 1));
    if (exact || typo) { add(exact ? 35 : 30, 'HIGH', `"${brand}" jaisa naam hai par ye uski asli site nahi (${reg}) — nakli ho sakti hai`); break; }
  }
  if (!info.officialBrand) for (const [brand, official] of BRANDS) if (brand.length >= 5 && pathq.includes(brand) && !official.includes(reg)) { add(10, 'MEDIUM', `Path mein "${brand}" likha hai par site doosri hai`); break; }
  if (/(^|\.)(t\.me|wa\.me|chat\.whatsapp\.com|telegram\.me|discord\.gg)$/.test(host)) add(10, 'MEDIUM', 'Chat/group invite link — scammers log ko yahin bulate hain; kisi anjaan ko paise/OTP mat do');
}

async function pageChecks(fin, startReg, add, info) {
  const h = fin.headers || {};
  const ct = String(h['content-type'] || '').toLowerCase(), cd = String(h['content-disposition'] || '').toLowerCase();
  info.status = fin.status; info.contentType = ct.split(';')[0]; info.finalUrl = fin.url;
  if (/vnd\.android\.package-archive/.test(ct)) add(60, 'HIGH', 'Ye link Android app (APK) utarwata hai — Play Store ke bahar se install karna khatarnaak hai');
  else if (/application\/(x-msdownload|x-dosexec|x-msi|java-archive|x-sh|x-bat)/.test(ct)) add(45, 'HIGH', 'Ye link chalane wali file (executable) utarwata hai');
  else if (/attachment/.test(cd) || /application\/(octet-stream|zip|x-rar|x-7z)/.test(ct)) add(25, 'MEDIUM', 'Page ki jagah seedha file download hoti hai');
  if (/text\/html/.test(ct) && fin.body && fin.body.length) {
    const html = fin.body.toString('utf8');
    const title = (html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1]; info.title = title ? title.replace(/\s+/g, ' ').trim().slice(0, 120) : null;
    const lower = html.toLowerCase();
    const hasPw = /<input[^>]+type\s*=\s*["']?password/i.test(html);
    const formHosts = [...html.matchAll(/<form[^>]+action\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)].map((m) => { try { return registrable(new URL(m[1]).hostname); } catch (e) { return null; } }).filter(Boolean);
    const finReg = registrable(new URL(fin.url).hostname);
    if (hasPw) add(info.officialBrand ? 0 : 20, 'MEDIUM', 'Page par password / login box hai' + (info.officialBrand ? '' : ' — kisi anjaan site par password mat daalo'));
    if (formHosts.some((d) => d !== finReg)) add(25, 'HIGH', 'Form ka data kisi doosri site par bheja jaata hai — credentials churane ka pakka tareeka');
    const brandInTitle = BRANDS.find(([b, o]) => (info.title || '').toLowerCase().includes(b) && !o.includes(finReg));
    if (brandInTitle) add(25, 'HIGH', `Page ka title "${brandInTitle[0]}" jaisa hai par site uski nahi hai`);
    if (/<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(html)) add(8, 'MEDIUM', 'Page apne aap kahin aur bhej deta hai (meta refresh)');
    if (/eval\s*\(\s*(atob|unescape)|document\.write\s*\(\s*unescape|fromcharcode(\s*\.\s*apply)?\s*\(/i.test(lower) || (lower.match(/\\x[0-9a-f]{2}/g) || []).length > 40) add(15, 'HIGH', 'Page ka code jaanbujhkar uljha (obfuscated) hai — aam sites aisa nahi karti');
    if (/<iframe[^>]+(width|height)\s*=\s*["']?[01]["'\s>]/i.test(html)) add(15, 'HIGH', 'Chhupa hua (0-size) iframe mila');
    const urgent = ['account suspended', 'account blocked', 'verify your account', 'verify immediately', 'kyc', 'your otp', 'congratulations', 'you have won', 'claim your', 'limited time', 'refund', 'आपका खाता', 'blocked', 'urgent'].filter((w) => lower.includes(w));
    if (urgent.length >= 2) add(12, 'MEDIUM', `Dara-dhamka / lalach wali bhasha: ${urgent.slice(0, 4).join(', ')}`);
    if (/href\s*=\s*["'][^"']+\.apk(\?|["'])/i.test(html)) add(25, 'HIGH', 'Page par APK download ka link hai');
  }
}

async function analyzeUrl(raw, opts) {
  opts = opts || {};
  const reasons = []; let score = 0; const info = {};
  const add = (w, sev, text) => { if (w > 0 || sev === 'INFO') { score += w; } reasons.push({ sev, text, w }); };
  let input = String(raw || '').trim().slice(0, 2000);
  if (!input) return { error: 'Link khali hai' };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(input)) input = 'https://' + input;
  let u; try { u = new URL(input); } catch (e) { return { error: 'Ye valid link nahi lagta' }; }
  info.input = u.href;
  if (/^(intent|market|tel|sms|mailto):$/i.test(u.protocol)) add(15, 'MEDIUM', `"${u.protocol}" link kisi app/action ko seedha chalata hai`);
  staticChecks(u, add, info);

  if (!opts.offline && /^https?:$/.test(u.protocol)) {
    try {
      const startReg = registrable(u.hostname);
      const r = await follow(u.href, 5);
      info.redirects = r.chain.map((c) => `${c.status} ${c.url}`.slice(0, 160));
      if (r.chain.length >= 3) add(10, 'MEDIUM', `${r.chain.length - 1} baar redirect hota hai (link ghumaya jaata hai)`);
      if (r.tooManyRedirects) add(15, 'HIGH', 'Redirect ka loop / bahut zyada hops');
      if (r.final) {
        const finReg = registrable(new URL(r.final.url).hostname);
        if (finReg !== startReg && !SHORTENERS.has(startReg)) add(8, 'MEDIUM', `Link kholte hi alag site (${finReg}) par pahunchata hai`);
        if (finReg !== startReg && SHORTENERS.has(startReg)) {   // judge the REAL destination too
          const u2 = new URL(r.final.url); const inner = []; const addInner = (w, sev, t) => { inner.push({ w, sev, t }); };
          const tmp = { officialBrand: undefined }; staticChecks(u2, addInner, tmp); Object.assign(info, { officialBrand: tmp.officialBrand });
          inner.forEach((x) => add(x.w, x.sev, `[asli destination ${finReg}] ${x.t}`));
        }
        await pageChecks(r.final, startReg, add, info);
        if (r.final.tlsError && /^https:/.test(r.final.url)) add(r.final.tlsError.includes('SELF') ? 30 : 18, 'HIGH', `SSL certificate theek nahi: ${r.final.tlsError.slice(0, 60)}`);
        if (r.final.status >= 400) add(0, 'INFO', `Site ne ${r.final.status} diya (page abhi nahi khula)`);
        info.finalDomain = finReg;
        const targetHost = new URL(r.final.url).hostname;
        const [age, cert] = await Promise.all([net.isIP(targetHost) ? null : domainAgeDays(targetHost), /^https:/.test(r.final.url) ? certInfo(targetHost) : null]);
        if (age !== null) { info.domainAgeDays = age; if (age < 7) add(40, 'HIGH', `Domain sirf ${age} din purana hai — naye domains par scam sabse zyada hote hain`); else if (age < 30) add(30, 'HIGH', `Domain sirf ${age} din purana hai`); else if (age < 90) add(12, 'MEDIUM', `Domain 3 mahine se bhi naya hai (${age} din)`); else if (age > 730 && score < 25) add(0, 'INFO', `Domain ${Math.floor(age / 365)} saal purana hai`); }
        else add(0, 'INFO', 'Domain kitna purana hai ye pata nahi chal paya');
        if (cert) { info.cert = { issuer: cert.issuer, ageDays: cert.ageDays, daysLeft: cert.daysLeft }; if (cert.selfSigned) add(25, 'HIGH', 'Self-signed certificate (kisi trusted authority ka nahi)'); else if (cert.ageDays < 7) add(10, 'MEDIUM', `SSL certificate sirf ${cert.ageDays} din purana hai`); }
      }
    } catch (e) {
      if (e.private) add(0, 'INFO', 'Ye link kisi private/internal address par jaata hai — scan nahi kiya (suraksha ke liye)');
      else if (e.code === 'ENOTFOUND') add(15, 'MEDIUM', 'Ye domain exist hi nahi karta / abhi band hai');
      else add(0, 'INFO', `Site khol kar nahi dekh paye (${String(e.message).slice(0, 60)}) — sirf link ki shakal se andaza hai`);
    }
    // optional external reputation
    const gsb = process.env.GOOGLE_SAFE_BROWSING_KEY, vt = process.env.VT_API_KEY;
    if (gsb) { try { const r = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${gsb}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: { clientId: 'aureon', clientVersion: '1' }, threatInfo: { threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'], platformTypes: ['ANY_PLATFORM'], threatEntryTypes: ['URL'], threatEntries: [{ url: u.href }] } }) }); const j = await r.json(); if (j.matches && j.matches.length) add(80, 'HIGH', `Google Safe Browsing ne ise ${j.matches[0].threatType} bataya hai`); else add(0, 'INFO', 'Google Safe Browsing mein ye link flagged nahi hai'); } catch (e) { /* skip */ } }
    if (vt) { try { const id = Buffer.from(u.href).toString('base64url'); const r = await fetch(`https://www.virustotal.com/api/v3/urls/${id}`, { headers: { 'x-apikey': vt } }); if (r.ok) { const j = await r.json(); const st = j.data && j.data.attributes && j.data.attributes.last_analysis_stats; if (st && (st.malicious || st.suspicious)) add(Math.min(80, 25 + st.malicious * 10), 'HIGH', `VirusTotal: ${st.malicious} engines malicious, ${st.suspicious} suspicious bol rahe hain`); else if (st) add(0, 'INFO', 'VirusTotal par koi engine isse flag nahi karta'); } } catch (e) { /* skip */ } }
  }

  if (info.officialBrand && !reasons.some((r) => r.sev === 'HIGH')) score = Math.min(score, 10);
  score = Math.max(0, Math.min(100, score));
  const verdict = levelOf(score);
  const actions = verdict === 'DANGEROUS'
    ? ['Is link ko KHOLO mat. Agar khola ho to koi password / OTP / UPI PIN mat daalo.', 'Agar kuch download hua ho to install mat karo, delete karo.', 'Jisne bheja use bhi pehle kisi aur raaste (call) se confirm karo.']
    : verdict === 'SUSPICIOUS' ? ['Jab tak pakka na ho, is link par kuch bhi daalo mat (password, OTP, card, UPI PIN).', 'Bank/company ki asli app ya website khud type karke kholo, is link se nahi.']
      : ['Koi bada red flag nahi mila, par phir bhi: OTP / UPI PIN kisi ko mat do, aur payment se pehle site ka naam dhyaan se dekho.'];
  return { verdict, score, reasons: reasons.sort((a, b) => b.w - a.w), info, actions, note: 'Ye ek andaza hai, guarantee nahi.' };
}

module.exports = { analyzeUrl, registrable, isPrivateAddr, _t: { lev, staticChecks } };
