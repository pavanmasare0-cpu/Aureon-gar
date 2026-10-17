// security/device.js — analyses the "phone security report" sent by the Aureon Android app.
//
// The app (native plugin DeviceGuard) only READS settings and the list of installed apps and
// sends them to YOUR backend, authenticated with a per-phone device key that can do nothing
// except submit reports. This is a posture check, not an antivirus: it cannot see inside other
// apps or scan files on the phone (use the Link/File checker for those).
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const store = require('../persist');

const DATA_DIR = path.join(__dirname, '..', 'security-data');
const DEV_FILE = path.join(DATA_DIR, 'devices.json');
const REP_FILE = path.join(DATA_DIR, 'device-reports.json');
let devices = [];          // { id, name, keyHash, createdAt, lastSeen }
let reports = {};          // id -> [ { t, score, level, findings, flagged, pkgs, device, health } ]  (last 10)

const ready = (async () => {
  await store.whenFirestore(20000);
  const d = await store.load('sec_devices', DEV_FILE); if (Array.isArray(d.value)) devices = d.value;
  const r = await store.load('sec_device_reports', REP_FILE); if (r.value && typeof r.value === 'object') reports = r.value;
})().catch((e) => console.error('[device] hydrate failed:', e.message));
const saveDev = () => ready.then(() => store.save('sec_devices', devices, DEV_FILE)).catch(() => {});
const saveRep = () => ready.then(() => store.save('sec_device_reports', reports, REP_FILE)).catch(() => {});
const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');

function createDevice(name) {
  const key = 'dk_' + crypto.randomBytes(24).toString('base64url');
  const dev = { id: crypto.randomBytes(5).toString('hex'), name: String(name || 'My phone').slice(0, 40), keyHash: hashKey(key), createdAt: new Date().toISOString(), lastSeen: null };
  devices.push(dev); saveDev();
  return { id: dev.id, name: dev.name, key };            // the key is shown ONCE, only its hash is stored
}
function verifyKey(key) {
  if (typeof key !== 'string' || key.length < 20) return null;
  const h = hashKey(key);
  return devices.find((d) => crypto.timingSafeEqual(Buffer.from(d.keyHash), Buffer.from(h))) || null;
}
function removeDevice(id) { const n = devices.length; devices = devices.filter((d) => d.id !== id); delete reports[id]; saveDev(); saveRep(); return devices.length !== n; }
const list = () => devices.map((d) => { const last = (reports[d.id] || []).slice(-1)[0]; return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, last: last ? { t: last.t, score: last.score, level: last.level, findings: last.findings.length } : null }; });
const history = (id) => (reports[id] || []).map((r) => ({ t: r.t, score: r.score, level: r.level })).slice(-10);
const latest = (id) => { const r = (reports[id] || []).slice(-1)[0]; return r ? { t: r.t, score: r.score, level: r.level, findings: r.findings, flagged: r.flagged, newApps: r.newApps, device: r.device, health: r.health, appCount: r.appCount } : null; };

// ---------------------------------------------------------------- the rules
const STORES = new Set(['com.android.vending', 'com.sec.android.app.samsungapps', 'com.xiaomi.mipicks', 'com.xiaomi.market', 'com.heytap.market', 'com.oppo.market', 'com.vivo.appstore', 'com.huawei.appmarket', 'com.amazon.venezia', 'org.fdroid.fdroid', 'com.google.android.packageinstaller_playstore']);
const SIDELOAD = new Set(['com.google.android.packageinstaller', 'com.android.packageinstaller', 'com.miui.packageinstaller', 'com.samsung.android.packageinstaller', 'com.oplus.packageinstaller', 'com.coloros.packageinstaller', 'com.google.android.apps.nbu.files', 'com.android.chrome', 'com.UCMobile.intl', 'org.telegram.messenger', 'com.whatsapp', null, '', 'unknown']);
const STALKER = ['mspy', 'flexispy', 'cocospy', 'hoverwatch', 'spyic', 'thetruthspy', 'spyera', 'xnspy', 'eyezy', 'clevguard', 'kidsguard', 'umobix', 'spyzie', 'mobistealth', 'spyfone', 'retinax', 'webwatcher', 'phonesheriff', 'highstermobile', 'ikeymonitor', 'trackview', 'mobile-tracker-free', 'cerberus'];
const REMOTE = ['com.anydesk', 'com.teamviewer', 'com.rustdesk', 'com.sand.airdroid', 'com.sand.airmirror', 'com.quicksupport', 'com.carriez.flutter_hbb'];
const A11Y_OK = ['com.google.android.marvin.talkback', 'com.google.android.accessibility.', 'com.samsung.android.accessibility', 'com.android.talkback', 'com.aureon.ai'];
const SENSITIVE = { READ_SMS: 'SMS padhna', RECEIVE_SMS: 'SMS receive', SEND_SMS: 'SMS bhejna', READ_CALL_LOG: 'call log', RECORD_AUDIO: 'mic', CAMERA: 'camera', READ_CONTACTS: 'contacts', ACCESS_FINE_LOCATION: 'location', READ_PHONE_STATE: 'phone state' };
const daysSince = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null; };
const short = (s) => String(s || '').slice(0, 80);

function analyze(raw, prevPkgs) {
  const f = []; const add = (sev, text, fix, key) => f.push({ sev, text, fix: fix || '', key: key || text.slice(0, 40) });
  const dev = raw.device || {}, sec = raw.security || {}, apps = Array.isArray(raw.apps) ? raw.apps.slice(0, 600) : [];

  // --- the phone itself
  if (sec.screenLock === false) add('HIGH', 'Screen lock (PIN / pattern / fingerprint) set nahi hai', 'Settings → Security → Screen lock mein PIN ya fingerprint lagao');
  if (sec.rootSigns && sec.rootSigns.length) add('HIGH', `Phone root / modified lagta hai (${sec.rootSigns.slice(0, 3).join(', ')})`, 'Rooted phone par banking apps aur data surakshit nahi — official ROM par wapas jao');
  else if (sec.testKeys) add('MEDIUM', 'Phone custom (test-keys) ROM par hai', 'Official firmware use karo');
  if (sec.adb) add('MEDIUM', 'USB debugging (ADB) chalu hai', 'Settings → Developer options → USB debugging band karo (jab tak zaroorat na ho)');
  if (sec.devOptions && !sec.adb) add('LOW', 'Developer options chalu hain', 'Zaroorat nahi to band kar do');
  const patchAge = dev.securityPatch ? daysSince(dev.securityPatch) : null;
  if (patchAge !== null) { if (patchAge > 365) add('HIGH', `Security patch ${Math.floor(patchAge / 30)} mahine purana hai (${dev.securityPatch})`, 'Settings → System update check karo — purane patch mein jaane-pehchane exploits khule hote hain'); else if (patchAge > 120) add('MEDIUM', `Security patch ${Math.floor(patchAge / 30)} mahine purana hai (${dev.securityPatch})`, 'System update install karo'); }
  if (dev.sdk && dev.sdk <= 28) add('HIGH', `Android ${dev.release || ''} ab security updates nahi paata`, 'Naya phone / OS update soch lo; tab tak banking / UPI kam use karo');
  else if (dev.sdk && dev.sdk <= 30) add('LOW', `Android ${dev.release || ''} purana ho raha hai`, '');

  // --- powers that scam / spy apps abuse
  const a11y = (raw.accessibility || []).filter((p) => !A11Y_OK.some((ok) => p.startsWith(ok)));
  for (const p of a11y.slice(0, 6)) add('HIGH', `"${short(p)}" ko Accessibility permission mili hui hai`, 'Settings → Accessibility → is app ko band karo — agar pehchante nahi to app hi uninstall karo', 'a11y:' + p);
  for (const p of (raw.deviceAdmins || []).filter((x) => !String(x).startsWith('com.google.android.gms') && !String(x).startsWith('com.aureon')).slice(0, 5)) add('HIGH', `"${short(p)}" Device Admin hai (hatana mushkil hota hai)`, 'Settings → Security → Device admin apps mein band karo, phir uninstall', 'admin:' + p);
  for (const p of (raw.notificationListeners || []).filter((x) => !String(x).startsWith('com.google.') && !String(x).startsWith('com.android.') && !String(x).startsWith('com.aureon')).slice(0, 6)) add('MEDIUM', `"${short(p)}" tumhare saare notifications (OTP samet) padh sakta hai`, 'Settings → Notifications → Device & app notifications mein sirf bharose wale apps rakho', 'notif:' + p);

  // --- installed apps
  const flagged = [];
  for (const a of apps) {
    const pkg = String(a.pkg || ''), label = String(a.label || ''), hay = (pkg + ' ' + label).toLowerCase().replace(/[\s_.\-]/g, '');
    const perms = a.perms || [];
    const sideloaded = !STORES.has(a.installer) && (SIDELOAD.has(a.installer) || !a.installer);
    const bad = perms.filter((p) => SENSITIVE[p]);
    const why = [];
    if (STALKER.some((s) => hay.includes(s.replace(/[\s_.\-]/g, '')))) { add('HIGH', `"${short(label || pkg)}" stalkerware / spy app jaisa naam hai`, 'Agar tumne install nahi kiya to turant uninstall karo — koi tumhe track kar sakta hai', 'stalk:' + pkg); why.push('stalkerware jaisa naam'); }
    if (REMOTE.some((r) => pkg.startsWith(r))) { add('MEDIUM', `Remote-control app installed: "${short(label || pkg)}"`, 'Scam calls mein yahi install karwate hain. Use nahi karte to uninstall karo', 'remote:' + pkg); why.push('remote access'); }
    if (sideloaded && (perms.includes('READ_SMS') || perms.includes('RECEIVE_SMS'))) { add('HIGH', `"${short(label || pkg)}" Play Store ke bahar se aaya hai aur SMS (OTP) padh sakta hai`, 'Pehchante nahi to uninstall karo', 'sideSMS:' + pkg); why.push('sideload + SMS'); }
    else if (sideloaded && bad.length >= 2) { add('MEDIUM', `"${short(label || pkg)}" Play Store ke bahar se aaya hai aur ye permissions li hain: ${bad.map((p) => SENSITIVE[p]).join(', ')}`, 'Sirf tab rakho jab bharose ka ho', 'sideperm:' + pkg); why.push('sideload + permissions'); }
    else if (!sideloaded && (perms.includes('READ_SMS') || perms.includes('RECEIVE_SMS')) && !/message|sms|mms|truecaller|phone|dialer/i.test(hay)) { add('LOW', `"${short(label || pkg)}" SMS padh sakta hai`, 'Zaroorat na ho to permission hata do', 'sms:' + pkg); why.push('SMS access'); }
    if (why.length) flagged.push({ pkg, label: short(label || pkg), installer: a.installer || 'unknown', why });
  }
  const sideloadedCount = apps.filter((a) => !STORES.has(a.installer) && (SIDELOAD.has(a.installer) || !a.installer)).length;
  if (sideloadedCount >= 8) add('LOW', `${sideloadedCount} apps Play Store ke bahar se install hue hain`, 'Jo use nahi karte unhe hata do', 'sideCount');
  const newApps = prevPkgs ? apps.filter((a) => !prevPkgs.includes(a.pkg)).map((a) => ({ pkg: a.pkg, label: short(a.label || a.pkg), installer: a.installer || 'unknown' })).slice(0, 20) : [];

  // --- phone health ("bugs")
  const h = raw.health || {};
  if (typeof h.storageFreePct === 'number' && h.storageFreePct < 8) add('MEDIUM', `Storage lagbhag bhar gaya hai (${h.storageFreePct}% khali)`, 'Phone slow / apps crash ho sakte hain — kuch files hatao', 'storage');
  if (typeof h.batteryTempC === 'number' && h.batteryTempC >= 43) add('MEDIUM', `Battery bahut garam hai (${h.batteryTempC}°C)`, 'Charging band karo aur phone ko thanda hone do; kaun sa app zyada chal raha hai dekho', 'batt-temp');
  if (typeof h.uptimeH === 'number' && h.uptimeH > 24 * 21) add('LOW', `Phone ${Math.floor(h.uptimeH / 24)} din se restart nahi hua`, 'Ek baar restart karo — kai updates / fixes restart ke baad hi lagte hain', 'uptime');
  if (raw.appVersion && raw.appVersion.crashes24h > 0) add('MEDIUM', `Aureon app aaj ${raw.appVersion.crashes24h} baar crash hui`, 'Crash report dekho (Sentinel / crash reporter)', 'crash');

  const pen = { HIGH: 20, MEDIUM: 8, LOW: 3 };
  const seen = new Set(); const uniq = f.filter((x) => (seen.has(x.key) ? false : seen.add(x.key)));
  const score = Math.max(0, 100 - uniq.reduce((s, x) => s + pen[x.sev], 0));
  const level = score >= 80 ? 'GOOD' : score >= 50 ? 'ATTENTION' : 'RISK';
  return { score, level, findings: uniq.sort((a, b) => 'HIGH MEDIUM LOW'.indexOf(a.sev) - 'HIGH MEDIUM LOW'.indexOf(b.sev)), flagged: flagged.slice(0, 30), newApps, pkgs: apps.map((a) => a.pkg).slice(0, 600), appCount: apps.length };
}

// store + compare with the previous report; report new HIGH findings through `hooks`
function ingest(dev, raw, hooks) {
  if (!raw || typeof raw !== 'object') throw new Error('bad report');
  const prev = (reports[dev.id] || []).slice(-1)[0];
  const a = analyze(raw, prev && prev.pkgs);
  const rec = { t: new Date().toISOString(), score: a.score, level: a.level, findings: a.findings, flagged: a.flagged, newApps: a.newApps, pkgs: a.pkgs, appCount: a.appCount,
    device: { model: short((raw.device || {}).manufacturer + ' ' + (raw.device || {}).model), release: (raw.device || {}).release, patch: (raw.device || {}).securityPatch }, health: raw.health || null };
  reports[dev.id] = (reports[dev.id] || []).concat(rec).slice(-10);
  dev.lastSeen = rec.t; saveDev(); saveRep();
  const prevKeys = new Set(prev ? prev.findings.map((x) => x.key) : []);
  const fresh = a.findings.filter((x) => x.sev === 'HIGH' && !prevKeys.has(x.key));
  for (const x of fresh.slice(0, 5)) hooks && hooks.record({ app: `phone:${dev.name}`, ip: '-', method: 'DEVICE', path: dev.name, rule: 'PHONE_RISK', severity: 'HIGH', action: 'ALERT', detail: x.text });
  if (fresh.length && hooks) hooks.alert(`Aureon Security: "${dev.name}" mein naya khatra`, fresh.map((x) => `• ${x.text}\n  → ${x.fix}`).join('\n\n'));
  const risky = a.newApps.filter((n) => a.flagged.some((fl) => fl.pkg === n.pkg));
  if (risky.length && hooks) hooks.alert(`Aureon Security: "${dev.name}" par naya shak wala app`, risky.map((n) => `• ${n.label} (${n.pkg})`).join('\n'));
  return a;
}

module.exports = { createDevice, verifyKey, removeDevice, list, history, latest, ingest, analyze, ready };
