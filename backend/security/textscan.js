// security/textscan.js — pasted SMS / WhatsApp / e-mail text -> scam check (+ every link inside it)
const { analyzeUrl } = require('./linkscan');

const RULES = [   // [regex, weight, why]
  [/\botp\b[^.\n]{0,40}(bata|share|send|de|dedo|bhej|batao|do)|share (the |your )?otp|otp (share|batao|bhejo)|(send|forward|bhej\w*|de\b|dedo|bata\w*)\s+(me\s+|mujhe\s+)?(the\s+|your\s+|apna\s+)?otp/i, 40, 'OTP maang raha hai — asli bank / company kabhi OTP nahi maangti'],
  [/(upi|atm|card)\s*(pin|cvv)|\bcvv\b|\bpin\b[^.\n]{0,20}(bata|share|daal|enter)/i, 40, 'PIN / CVV maang raha hai — ye kisi ko mat do'],
  [/(kyc|pan|aadhaa?r)[^.\n]{0,40}(update|expire|verify|block|band|suspend)|(update|verify)[^.\n]{0,25}(kyc|pan card|aadhaa?r)/i, 30, 'KYC / PAN / Aadhaar "update" ka bahana — bahut aam scam'],
  [/(account|khata|card|sim|wallet)[^.\n]{0,30}(block|band|suspend|freeze|deactivate|expire)/i, 25, 'Account band hone ka darr dikhaya ja raha hai'],
  [/(lottery|lucky draw|jackpot|kbc|you (have )?won|congratulations[^.\n]{0,60}(won|prize|winner|selected|lucky|reward)|badhai ho[^.\n]{0,40}(jeet|inaam)|inaam|prize|winner)/i, 30, 'Inaam / lottery ka lalach'],
  [/(work from home|ghar baithe|part[- ]?time job|earn (rs|₹|\$)?\s?\d|daily (income|earning)|task[- ]based)/i, 25, 'Ghar baithe kamai / task job ka offer — task-scam ka aam tareeka'],
  [/(double|2x|guaranteed)[^.\n]{0,30}(return|profit|money|paisa)|crypto[^.\n]{0,30}(invest|profit)|trading[^.\n]{0,30}(group|signal|vip)/i, 25, 'Paisa double / pakka munafa — investment scam'],
  [/(arrest|digital arrest|cbi|police|narcotics|ed\b)[^.\n]{0,60}(parcel|courier|aadhaa?r|case|warrant|money laundering)|parcel[^.\n]{0,40}(seized|drugs|held at customs|pakda)|customs[^.\n]{0,50}(duty|fee|charge|penalty|fine)[^.\n]{0,50}(pay|bhej|send|transfer|avoid)/i, 35, 'Police / CBI / courier ke naam par dara kar paisa maangna ("digital arrest" scam)'],
  [/digital\s+arrest|(cbi|police|ed|customs|narcotics)\s+(officer|inspector|se\s+baat)|video\s+call\s+par\s+(aao|rahe|rahiye)/i, 35, '"Digital arrest" — police / CBI ke naam par video call par rok kar paisa maangna (poora scam; asli agency aisa nahi karti)'],
  [/(bijli|electricity|power)[^.\n]{0,30}(bill|connection)[^.\n]{0,40}(cut|disconnect|kat|band)|(bijli|electricity|power)\s+(will\s+be\s+|aaj\s+raat\s+)?(cut|disconnect|kat|band)/i, 30, 'Bijli connection kat jaane ka darr — bill scam'],
  [/(refund|cashback|reward)[^.\n]{0,40}(click|link|claim|receive)|collect request|request money|pay (re\.?|rs\.?|₹)\s?1\b|send (re\.?|rs\.?|₹)\s?\d+ to (verify|receive)/i, 30, 'Refund ke naam par link / "paisa lene ke liye paisa bhejo" — UPI collect scam'],
  [/(anydesk|teamviewer|quicksupport|airdroid|rustdesk)/i, 40, 'Remote-access app install karwa raha hai — ye screen aur bank dono khol deta hai'],
  [/\.apk\b|install (this |the )?app|app download kar/i, 25, 'APK / app install karne ko bol raha hai'],
  [/(urgent|immediately|turant|abhi|within \d+ (hour|hr|min)|24 ghante|last chance|limited time)/i, 12, 'Jaldbaazi ka dabaav'],
  [/(don'?t|mat|nahi)\s+(tell|share|batana|bolna)[^.\n]{0,30}(anyone|kisi|family|ghar)|kisi ko mat batana|keep (this )?(secret|confidential)/i, 12, 'Kisi ko batane se mana kar raha hai (akela ye kuch nahi, par doosre signals ke saath scammer ki pehchaan)'],
];

function extractUrls(text) {
  const found = new Set();
  for (const m of String(text).matchAll(/\b((?:https?:\/\/|www\.)[^\s<>"')]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|in|net|org|xyz|top|click|link|info|co|me|app|site|online|live|club|vip|icu|cc|ly|gl|is)(?:\/[^\s<>"')]*)?)/gi)) {
    let u = m[1].replace(/[.,;:!?]+$/, ''); if (u.length > 3) found.add(u);
    if (found.size >= 5) break;
  }
  return [...found];
}

async function aiOpinion(text, summary) {
  const key = process.env.GROQ_API_KEY; if (!key) return null;
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', temperature: 0.2, max_tokens: 220, messages: [{ role: 'user', content: `Neeche ek message hai jo kisi ko mila. Batao ki ye scam lagta hai ya nahi, 3 chhoti Hinglish lines mein (kyun, aur kya karna chahiye). Automatic checker ne ye bataya: ${summary}\n\nMESSAGE:\n${String(text).slice(0, 1500)}` }] }) });
    const j = await r.json(); return (j.choices && j.choices[0] && j.choices[0].message.content || '').trim().slice(0, 700) || null;
  } catch (e) { return null; }
}

async function analyzeText(text, opts) {
  opts = opts || {};
  const t = String(text || '').slice(0, 5000); if (t.trim().length < 3) return { error: 'Message khali hai' };
  const reasons = []; let score = 0;
  // "Do not share your OTP / PIN" is a WARNING that real banks send — don't treat it as a request
  const NEG = /(do\s*not|don'?t|never|kabhi\s+nahi|mat|nahi)\s+(share|send|tell|disclose|give|bata\w*|bhej\w*|de\b|do\b)[^.\n]{0,40}/gi;
  const negated = t.replace(NEG, ' ');
  RULES.forEach(([re, w, why], i) => { if (re.test(i <= 1 ? negated : t)) { score += w; reasons.push({ sev: w >= 30 ? 'HIGH' : 'MEDIUM', text: why, w }); } });
  const links = [];
  for (const u of extractUrls(t).slice(0, 3)) {
    const r = await analyzeUrl(u, { offline: opts.offline });
    if (r.error) continue;
    links.push({ url: u, verdict: r.verdict, score: r.score, top: r.reasons.slice(0, 3).map((x) => x.text) });
    if (r.score >= 25) { const w = Math.round(r.score * 0.8); score += w; reasons.push({ sev: r.score >= 60 ? 'HIGH' : 'MEDIUM', text: `Message ke link "${u.slice(0, 50)}" ko ${r.verdict} laga (${r.score}/100)`, w }); }
  }
  if (reasons.filter((x) => x.sev === 'HIGH').length >= 2) score += 10;   // several strong signals together
  score = Math.min(100, score);
  const verdict = score >= 60 ? 'DANGEROUS' : score >= 25 ? 'SUSPICIOUS' : 'LOW RISK';
  const out = { verdict, score, reasons: reasons.sort((a, b) => b.w - a.w), links,
    actions: verdict === 'LOW RISK' ? ['Koi bada scam-signal nahi mila, par OTP / PIN / paise phir bhi kisi ko mat do.'] : ['Reply mat do, link mat kholo, OTP / PIN / paise mat bhejo.', 'Bank / company ko unke ASLI number ya app se khud call karke poochho.', 'Bharat mein cyber fraud ho gaya ho to turant 1930 par call karo ya cybercrime.gov.in par report karo.'],
    note: 'Ye ek andaza hai, guarantee nahi.' };
  if (!opts.noAI && score >= 10) out.aiOpinion = await aiOpinion(t, `${verdict} ${score}/100: ${out.reasons.slice(0, 4).map((x) => x.text).join('; ')}`);
  return out;
}
module.exports = { analyzeText, extractUrls };
