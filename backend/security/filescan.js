// security/filescan.js — "is this file safe to open?"  (static analysis only)
// The file is analysed in memory and thrown away — it is never saved and never executed.
// Heuristic risk estimate, NOT an antivirus: a clean result is not a guarantee.
const crypto = require('crypto');
const zlib = require('zlib');
const path = require('path');

const MAX_BYTES = 15 * 1024 * 1024;
const EXEC_EXT = new Set(['exe', 'scr', 'bat', 'cmd', 'com', 'msi', 'jar', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'ps1', 'lnk', 'apk', 'xapk', 'hta', 'cpl', 'reg', 'dll', 'sh', 'iso', 'img', 'pif', 'dmg', 'pkg']);
const DOC_EXT = new Set(['pdf', 'jpg', 'jpeg', 'png', 'gif', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'mp3', 'mp4', 'csv']);

// ---- minimal ZIP reader (central directory), enough to look inside APK/DOCX/ZIP ----
function readZip(buf) {
  const out = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    out.push({ name: buf.toString('utf8', p + 46, p + 46 + nl), method, csize, usize, lho, encrypted: !!(flags & 1) });
    p += 46 + nl + el + cl;
  }
  return out;
}
function zipRead(buf, e, limit) {
  try {
    const nl = buf.readUInt16LE(e.lho + 26), el = buf.readUInt16LE(e.lho + 28), start = e.lho + 30 + nl + el;
    const raw = buf.subarray(start, start + e.csize);
    if (e.method === 0) return raw.subarray(0, limit);
    if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: limit || 4 * 1024 * 1024 });
  } catch (err) { /* corrupt entry */ }
  return null;
}

const PERMS = {   // permission -> [weight, why]
  READ_SMS: [15, 'SMS padh sakta hai (OTP churane wale apps yahi maangte hain)'], RECEIVE_SMS: [15, 'Aane wale SMS/OTP dekh sakta hai'], SEND_SMS: [15, 'Tumhare naam se SMS bhej sakta hai (paid SMS / phailane ke liye)'],
  BIND_ACCESSIBILITY_SERVICE: [20, 'Accessibility service — screen padh sakta aur khud tap kar sakta hai (banking trojans ka favourite)'],
  SYSTEM_ALERT_WINDOW: [12, 'Doosre apps ke upar nakli screen (overlay) dikha sakta hai'], REQUEST_INSTALL_PACKAGES: [15, 'Aur apps chupke se install karwa sakta hai (dropper)'],
  BIND_DEVICE_ADMIN: [20, 'Device admin banna chahta hai — hatana mushkil ho jata hai'], READ_CONTACTS: [6, 'Saare contacts padh sakta hai'], READ_CALL_LOG: [8, 'Call history padh sakta hai'],
  RECORD_AUDIO: [6, 'Mic use kar sakta hai'], CAMERA: [4, 'Camera use kar sakta hai'], QUERY_ALL_PACKAGES: [6, 'Tumhare phone ke saare apps ki list dekh sakta hai'],
  RECEIVE_BOOT_COMPLETED: [3, 'Phone chalu hote hi apne aap start hota hai'], READ_PHONE_STATE: [4, 'Phone number / device ID padh sakta hai'], BIND_NOTIFICATION_LISTENER_SERVICE: [15, 'Saare notifications (OTP samet) padh sakta hai'],
  MANAGE_EXTERNAL_STORAGE: [8, 'Phone ki saari files access kar sakta hai'], ACCESS_FINE_LOCATION: [4, 'Exact location jaan sakta hai'], CALL_PHONE: [4, 'Khud call laga sakta hai'],
};

function ascii(buf) { return buf.toString('latin1'); }
function findPermissions(manifest) {
  const found = new Set();
  const latin = manifest.toString('latin1'), utf16 = manifest.toString('utf16le');
  for (const txt of [latin, utf16]) for (const m of txt.matchAll(/android\.permission\.([A-Z_]{4,60})/g)) found.add(m[1]);
  return [...found];
}

function analyzeFile(buf, filename) {
  const reasons = []; let score = 0;
  const add = (w, sev, text) => { score += w; reasons.push({ sev, text, w }); };
  const name = String(filename || 'file').replace(/[\\/]/g, '_').slice(0, 200);
  const info = { name, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  if (buf.length > MAX_BYTES) return { error: `File ${Math.round(MAX_BYTES / 1048576)} MB se badi hai` };
  if (!buf.length) return { error: 'File khali hai' };

  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop() : '';
  const parts = lower.split('.');
  // ---- what is it REALLY (magic bytes) ----
  const b = buf;
  let type = 'unknown';
  if (b[0] === 0x4d && b[1] === 0x5a) type = 'windows-exe';
  else if (b.readUInt32BE(0) === 0x7f454c46) type = 'elf';
  else if (b.readUInt32BE(0) === 0x504b0304) type = 'zip';
  else if (ascii(b.subarray(0, 5)) === '%PDF-') type = 'pdf';
  else if (b.readUInt32BE(0) === 0xd0cf11e0) type = 'ole';
  else if (ascii(b.subarray(0, 4)) === 'dex\n') type = 'dex';
  else if (b[0] === 0xff && b[1] === 0xd8) type = 'jpeg'; else if (ascii(b.subarray(1, 4)) === 'PNG') type = 'png'; else if (ascii(b.subarray(0, 3)) === 'GIF') type = 'gif';
  else if (ascii(b.subarray(0, 4)) === 'Rar!' || (b[0] === 0x37 && b[1] === 0x7a)) type = 'archive';
  else if (b[0] === 0x23 && b[1] === 0x21) type = 'script';
  else if (!b.subarray(0, 2048).includes(0)) type = 'text';
  info.detectedType = type;

  // ---- name tricks ----
  if (/[\u202e\u202d\u2066-\u2069]/.test(name)) add(60, 'HIGH', 'File ke naam mein chhupa direction-control character hai — extension ulta dikhane ki chaal (jaise "photo‮gpj.exe")');
  if (parts.length >= 3 && DOC_EXT.has(parts[parts.length - 2]) && EXEC_EXT.has(ext)) add(50, 'HIGH', `Double extension: ".${parts[parts.length - 2]}.${ext}" — dikhne mein document, asal mein chalne wali file`);
  if (EXEC_EXT.has(ext)) add(ext === 'apk' || ext === 'xapk' ? 20 : 25, 'MEDIUM', `".${ext}" chalane wali file hoti hai, document nahi`);
  const isExecContent = ['windows-exe', 'elf', 'dex'].includes(type);
  if (isExecContent && DOC_EXT.has(ext)) add(70, 'HIGH', `File ka naam ".${ext}" hai par andar se ye chalne wali program (${type}) hai — pakka chhal`);
  else if (isExecContent) add(30, 'MEDIUM', `Andar se ye chalne wali program (${type}) hai`);

  // ---- zip family: APK / Office / archives ----
  if (type === 'zip') {
    const entries = readZip(b) || [];
    const names = entries.map((e) => e.name);
    info.entries = names.length;
    const isApk = names.includes('AndroidManifest.xml') && names.some((n) => /^classes\d*\.dex$/.test(n));
    const isOoxml = names.includes('[Content_Types].xml') && names.some((n) => /^(word|xl|ppt)\//.test(n));
    if (isApk) {
      info.detectedType = 'android-apk';
      const man = entries.find((e) => e.name === 'AndroidManifest.xml'); const mb = man && zipRead(b, man, 2 * 1024 * 1024);
      const perms = mb ? findPermissions(mb) : [];
      info.permissions = perms.filter((p) => PERMS[p]).map((p) => ({ name: p, why: PERMS[p][1] }));
      let pw = 0; for (const p of perms) if (PERMS[p]) pw += PERMS[p][0];
      if (pw) add(Math.min(pw, 60), pw >= 30 ? 'HIGH' : 'MEDIUM', `APK ye khatarnaak permissions maangta hai: ${info.permissions.slice(0, 6).map((p) => p.name).join(', ')}`);
      const sms = perms.some((p) => /READ_SMS|RECEIVE_SMS/.test(p)), access = perms.some((p) => /BIND_ACCESSIBILITY|SYSTEM_ALERT_WINDOW|BIND_NOTIFICATION/.test(p)), net = perms.includes('INTERNET');
      if ((sms || access) && net && perms.length) add(25, 'HIGH', 'SMS / accessibility / overlay + internet ek saath — banking-trojan jaisa combination');
      if (names.some((n) => /\.(apk|dex|jar)$/i.test(n) && !/^classes\d*\.dex$/.test(n))) add(25, 'HIGH', 'APK ke andar ek aur APK/DEX chhupa hai (dropper jaisa)');
      add(0, 'INFO', 'Play Store ke bahar ki APK hai — install karne se pehle pata karo ki kisne di aur kyun');
    } else if (isOoxml) {
      info.detectedType = 'office-document';
      if (names.some((n) => /vbaProject\.bin$/i.test(n))) add(45, 'HIGH', 'Document mein macro (VBA code) hai — malware phailane ka sabse aam tareeka. "Enable content" mat dabana');
      if (names.some((n) => /externalLinks|oleObject|embeddings\//i.test(n))) add(10, 'MEDIUM', 'Document mein bahari link / embedded object hai');
    } else {
      const exeInside = names.filter((n) => EXEC_EXT.has((n.split('.').pop() || '').toLowerCase()));
      if (exeInside.length) add(35, 'HIGH', `Zip ke andar chalne wali files: ${exeInside.slice(0, 4).join(', ')}`);
      if (entries.some((e) => e.encrypted)) add(15, 'MEDIUM', 'Password-protected zip — antivirus se bachne ke liye scammers yahi karte hain');
      if (entries.some((e) => e.usize > 0 && e.csize > 0 && e.usize / e.csize > 200)) add(15, 'MEDIUM', 'Bahut zyada compress (zip-bomb jaisa)');
    }
  }
  // ---- PDF ----
  if (type === 'pdf') {
    const t = b.toString('latin1', 0, Math.min(b.length, 3 * 1024 * 1024));
    const hits = ['/JavaScript', '/JS', '/OpenAction', '/Launch', '/EmbeddedFile', '/AA'].filter((k) => t.includes(k));
    if (hits.includes('/Launch') || hits.includes('/JavaScript') || hits.includes('/JS')) add(40, 'HIGH', `PDF ke andar active code hai (${hits.join(', ')})`);
    else if (hits.length) add(15, 'MEDIUM', `PDF mein auto-action / embedded file hai (${hits.join(', ')})`);
    const uris = (t.match(/\/URI\s*\(/g) || []).length; if (uris) add(Math.min(10, uris * 2), 'LOW', `PDF mein ${uris} link(s) hain — kholne se pehle dekh lo`);
  }
  // ---- old Office (OLE) ----
  if (type === 'ole') {
    const t = b.toString('latin1'), u = b.toString('utf16le');
    if (/VBA|_VBA_PROJECT|Macros/.test(t) || /VBA|Macros/.test(u)) add(40, 'HIGH', 'Purane Office file mein macro mile');
  }
  // ---- scripts / text ----
  if (type === 'text' || type === 'script') {
    const t = b.toString('utf8', 0, Math.min(b.length, 1024 * 1024));
    const pats = [[/powershell[^\n]{0,40}-(enc|encodedcommand)\b/i, 'PowerShell encoded command'], [/FromBase64String|\batob\s*\(/, 'Base64 se chhupa code'], [/\b(Invoke-Expression|IEX)\b/i, 'Invoke-Expression'], [/eval\s*\(\s*(atob|unescape|String\.fromCharCode)/i, 'eval(...) se chhupa code'], [/WScript\.Shell|Scripting\.FileSystemObject/i, 'Windows script host'], [/certutil\s+-(urlcache|decode)|bitsadmin\s+\/transfer/i, 'LOLBin download'], [/(curl|wget)[^\n|]{0,120}\|\s*(ba)?sh/i, 'curl | sh (internet se code chalana)'], [/\/dev\/tcp\/|nc\s+-e|bash\s+-i\s+>&/, 'Reverse shell'], [/rm\s+-rf\s+\/(\s|$)/, 'Poora system mitane wala command'], [/chmod\s+\+x[^\n]{0,60}(\/tmp|\.\/)/, 'Download karke chalana']];
    const hit = pats.filter(([re]) => re.test(t)).map(([, l]) => l);
    if (hit.length) add(Math.min(70, 25 * hit.length), 'HIGH', `Script mein khatarnaak pattern: ${hit.join(', ')}`);
    if (/<script/i.test(t) && /(eval|atob|unescape)\s*\(/i.test(t)) add(20, 'HIGH', 'HTML file mein uljha hua script');
  }
  if (type === 'unknown' && !EXEC_EXT.has(ext)) add(8, 'LOW', 'File ka type pehchana nahi gaya');

  score = Math.max(0, Math.min(100, score));
  const verdict = score >= 60 ? 'DANGEROUS' : score >= 25 ? 'SUSPICIOUS' : 'LOW RISK';
  info.virustotal = `https://www.virustotal.com/gui/file/${info.sha256}`;
  const actions = verdict === 'DANGEROUS' ? ['Is file ko KHOLO / INSTALL mat karo, delete kar do.', 'Jisne bheja use doosre raaste se pooch lo — aksar uska account hack hota hai.']
    : verdict === 'SUSPICIOUS' ? ['Jab tak bhejne wale se confirm na ho, mat kholo.', 'VirusTotal link par hash daalkar ek baar aur check kar lo.']
      : ['Koi bada red flag nahi mila, par ye antivirus nahi hai — anjaan source ki file phir bhi savdhani se kholo.'];
  return { verdict, score, reasons: reasons.sort((a, b) => b.w - a.w), info, actions, note: 'File sirf memory mein jaanchi gayi, save ya chalayi nahi gayi.' };
}

async function vtLookup(sha256) {
  const key = process.env.VT_API_KEY; if (!key) return null;
  try {
    const r = await fetch(`https://www.virustotal.com/api/v3/files/${sha256}`, { headers: { 'x-apikey': key } });
    if (r.status === 404) return { known: false };
    if (!r.ok) return null;
    const st = (await r.json()).data.attributes.last_analysis_stats;
    return { known: true, malicious: st.malicious, suspicious: st.suspicious, harmless: st.harmless };
  } catch (e) { return null; }
}

module.exports = { analyzeFile, vtLookup, MAX_BYTES, _t: { readZip, findPermissions } };
