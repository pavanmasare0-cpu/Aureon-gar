// backend/ava-desk.js — "Ava Desktop": the full-screen desktop dashboard (live orb, Live Moment, FutureStick, chat).
//
// Mounted by sentinel-dashboard.js:
//   GET  /api/sentinel/ava-desk            the page (same owner login / stealth lock as the other dashboards)
//   GET  /api/sentinel/ava-desk/data       live status for the page (Sentinel summary + latest events)
//   GET  /api/sentinel/ava-desk/world      weather for 5 cities + BTC / gold(PAXG) price, cached 5 min (the page's CSP only
//                                          allows talking to this server, so the server fetches these for it)
//   POST /api/sentinel/ava-desk/chat       chat with Ava (Groq, Gemini as fallback)
//   POST /api/sentinel/ava-desk/forecast   "View full forecast" for FutureStick
//
// Nothing here changes code or deploys anything. It only reads status and talks.
const fs = require('fs');
const path = require('path');
const express = require('express');

const PAGE = fs.readFileSync(path.join(__dirname, 'ava-desk.html'), 'utf8');

// Ava Guard (v17): same file the browser uses; here it re-checks every chat message on the server (the browser copy is only a seat-belt).
// Optional: if public/ava-guard.js is not deployed, chat simply runs without it.
const GUARD_FILE = path.join(__dirname, 'public', 'ava-guard.js');
let guard = null;
try { guard = require(GUARD_FILE); } catch (e) { guard = null; }

const CITIES = [
  { id: 'surat', name: 'Surat', lat: 21.17, lon: 72.83 },
  { id: 'newyork', name: 'New York', lat: 40.71, lon: -74.01 },
  { id: 'london', name: 'London', lat: 51.51, lon: -0.13 },
  { id: 'dubai', name: 'Dubai', lat: 25.2, lon: 55.27 },
  { id: 'tokyo', name: 'Tokyo', lat: 35.68, lon: 139.69 },
];
const WMO = {
  0: 'Clear Sky', 1: 'Mostly Clear', 2: 'Partly Cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog', 51: 'Light Drizzle', 53: 'Drizzle', 55: 'Heavy Drizzle',
  61: 'Light Rain', 63: 'Rain', 65: 'Heavy Rain', 71: 'Light Snow', 73: 'Snow', 75: 'Heavy Snow', 80: 'Rain Showers', 81: 'Rain Showers', 82: 'Violent Showers',
  95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm',
};

const PERSONAS = {
  kiddo: 'Ava-Kiddo: playful, warm and friendly, like a close buddy. A light emoji now and then is fine.',
  classic: 'Ava-Classic: professional, calm and precise. No emojis.',
  shadow: 'Ava-Shadow: focused, silent, hacker-like. Very short, to the point, no small talk.',
  pro: 'Ava-Pro: visionary and strategic. Think big picture, long term, trade-offs.',
};

module.exports = function createAvaDesk({ auth, getSummary, getEvents }) {
  const router = express.Router();
  const json = express.json({ limit: '100kb' });

  // ---- tiny in-memory rate limit for the two LLM routes (per IP, 30 / minute)
  const hits = new Map();
  function limited(req) {
    const ip = String(req.ip || '');
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
    arr.push(now);
    hits.set(ip, arr);
    if (hits.size > 200) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 60000) hits.delete(k);
    return arr.length > 30;
  }

  const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

  // ---- LLM (Groq first, Gemini as a fallback). Returns plain text.
  async function llm(system, messages) {
    const errs = [];
    const groqKey = String(process.env.GROQ_API_KEY || '').split(',')[0].trim();
    if (groqKey) {
      try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + groqKey },
          body: JSON.stringify({ model: 'llama-3.3-70b-versatile', temperature: 0.7, max_tokens: 700, messages: [{ role: 'system', content: system }].concat(messages) }),
          signal: AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined,
        });
        const d = await r.json();
        const t = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
        if (t) return String(t).trim();
        errs.push('groq: ' + clip((d && d.error && d.error.message) || r.status, 120));
      } catch (e) { errs.push('groq: ' + e.message); }
    }
    const gKey = String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').split(',')[0].trim();
    if (gKey) {
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(gKey), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
            generationConfig: { temperature: 0.7, maxOutputTokens: 700 },
          }),
          signal: AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined,
        });
        const d = await r.json();
        const t = d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts.map((p) => p.text || '').join('');
        if (t) return String(t).trim();
        errs.push('gemini: ' + clip((d && d.error && d.error.message) || r.status, 120));
      } catch (e) { errs.push('gemini: ' + e.message); }
    }
    const err = new Error(errs.length ? errs.join(' | ') : 'GROQ_API_KEY / GEMINI_API_KEY Render environment mein set nahi hai');
    throw err;
  }

  function statusLine() {
    try {
      const s = getSummary();
      return 'Live system status: health score ' + s.score + '/100, ' + s.total + ' server(s), ' +
        (s.downCount ? s.downCount + ' DOWN (' + s.down.join(', ') + ')' : 'all up') +
        (s.avgUptime24 != null ? ', 24h uptime ' + s.avgUptime24 + '%' : '') + ', ' + s.pending + ' fix proposal(s) pending.';
    } catch (e) { return ''; }
  }

  // ---------------------------------------------------------------- page + data
  router.get('/ava-desk', (req, res) => auth.dashboard(req, res, () => {
    res.type('html').send(PAGE);
  }));

  // the page loads the guard from here (its CSP only allows scripts from this origin; this route sits behind the same login)
  router.get('/ava-desk/guard.js', (req, res) => {
    if (!guard) return res.status(404).type('text/plain').send('guard not installed');
    res.type('application/javascript').send(fs.readFileSync(GUARD_FILE, 'utf8'));
  });

  router.get('/ava-desk/data', (req, res) => {
    let summary = null;
    let events = [];
    try { summary = getSummary(); } catch (e) { /* page shows "—" */ }
    try { events = (getEvents() || []).slice(0, 12); } catch (e) { /* ignore */ }
    res.json({ ok: true, now: Date.now(), summary, events });
  });

  // ---------------------------------------------------------------- world (weather + prices), cached
  let worldCache = { t: 0, data: null };
  async function fetchJson(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(9000) : undefined, headers: { 'User-Agent': 'aureon-ava-desk' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function buildWorld() {
    const out = { cities: {}, markets: {}, at: Date.now() };
    await Promise.all([
      (async () => {
        const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + CITIES.map((c) => c.lat).join(',') + '&longitude=' + CITIES.map((c) => c.lon).join(',') +
          '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day&timezone=auto';
        let arr = await fetchJson(u);
        if (!Array.isArray(arr)) arr = [arr];
        arr.forEach((w, i) => {
          const c = CITIES[i];
          if (!c || !w || !w.current) return;
          const cur = w.current;
          out.cities[c.id] = {
            name: c.name, temp: Math.round(cur.temperature_2m), feels: Math.round(cur.apparent_temperature), humidity: Math.round(cur.relative_humidity_2m),
            code: cur.weather_code, text: WMO[cur.weather_code] || 'Clear', day: !!cur.is_day, tz: w.timezone,
          };
        });
      })().catch((e) => { out.weatherError = e.message; }),
      (async () => {
        const d = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,pax-gold&vs_currencies=usd&include_24hr_change=true');
        if (d.bitcoin) out.markets.btc = { price: d.bitcoin.usd, change: d.bitcoin.usd_24h_change };
        if (d['pax-gold']) out.markets.gold = { price: d['pax-gold'].usd, change: d['pax-gold'].usd_24h_change };   // PAXG tracks 1 oz of gold
      })().catch((e) => { out.marketError = e.message; }),
    ]);
    return out;
  }
  router.get('/ava-desk/world', async (req, res) => {
    try {
      if (!worldCache.data || Date.now() - worldCache.t > 5 * 60000) {
        const fresh = await buildWorld();
        // keep the old good value if the refresh came back completely empty
        if (Object.keys(fresh.cities).length || Object.keys(fresh.markets).length || !worldCache.data) { worldCache = { t: Date.now(), data: fresh }; }
        else worldCache.t = Date.now() - 4 * 60000;   // retry in a minute
      }
      res.json({ ok: true, ...worldCache.data });
    } catch (e) {
      res.json({ ok: false, error: e.message, cities: {}, markets: {} });
    }
  });

  // ---------------------------------------------------------------- chat
  router.post('/ava-desk/chat', json, async (req, res) => {
    if (limited(req)) return res.status(429).json({ error: 'Thoda ruko, bahut zyada messages — 1 minute baad try karo.' });
    const b = req.body || {};
    const persona = PERSONAS[b.persona] ? b.persona : 'kiddo';
    const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-14)
      .map((m) => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', content: clip(m && m.content, 1500) }))
      .filter((m) => m.content.trim());
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: 'message missing' });
    let guarded = false;
    if (guard) {
      const last = msgs[msgs.length - 1];
      const g = guard.inspect(last.content);
      if (g.verdict === 'block' && !b.guardOverride) {
        auth.action(req, 'ava-desk guard block');
        return res.status(400).json({ error: 'Ava Guard ne rok diya (' + clip((g.findings && g.findings[0] && g.findings[0].desc) || 'risky pattern', 100) + '). Agar tum sach me ye bhejna chahte ho to wahi message dobara Send karo.' });
      }
      if (g.hasSecret) last.content = g.redacted;   // never send secrets / card numbers to the model
      guarded = true;
    }
    const system = [
      'You are Ava, the personal AI companion of Pavan (the owner) inside his Aureon desktop dashboard.',
      'Persona: ' + PERSONAS[persona],
      'Reply in the same language style the user writes in (Hinglish is fine). Keep answers short and useful (under ~120 words) unless asked for more. Use plain text, at most light **bold** and "- " bullets.',
      'You can only see what is written here; you cannot see market charts or news. If asked for live data you do not have, say so instead of guessing.',
      statusLine(),
      b.goals ? 'Pavan\'s FutureStick goals (progress): ' + clip(b.goals, 600) : '',
      'Local time for Pavan: ' + clip(b.localTime, 60) + '.',
    ].filter(Boolean).join('\n');
    try {
      auth.action(req, 'ava-desk chat');
      const reply = await llm(system, msgs);
      res.json({ reply, guarded });
    } catch (e) {
      res.status(502).json({ error: 'Ava abhi jawab nahi de pa rahi: ' + clip(e.message, 200) });
    }
  });

  router.post('/ava-desk/forecast', json, async (req, res) => {
    if (limited(req)) return res.status(429).json({ error: 'Thoda ruko, 1 minute baad try karo.' });
    const b = req.body || {};
    const goals = (Array.isArray(b.goals) ? b.goals : []).slice(0, 12)
      .map((g) => '- ' + clip(g.cat, 30) + ': ' + clip(g.title, 80) + ' (' + Math.max(0, Math.min(100, Number(g.pct) || 0)) + '%, ' + clip(g.horizon, 8) + ')').join('\n');
    if (!goals) return res.status(400).json({ error: 'goals missing' });
    const system = 'You are Ava, a planning coach. Given Pavan\'s goals and progress, write a short realistic forecast: where he stands, what is most likely in the next 7 days / 30 days, the 3 highest-impact next steps, and one risk to watch. Be honest — this is a projection from the numbers given, not a promise. Hinglish is fine. Max ~170 words. Plain text with "- " bullets.';
    try {
      auth.action(req, 'ava-desk forecast');
      const reply = await llm(system, [{ role: 'user', content: 'Goals:\n' + goals + '\n\n' + statusLine() + '\nToday: ' + clip(b.localTime, 60) }]);
      res.json({ reply });
    } catch (e) {
      res.status(502).json({ error: 'Forecast nahi ban paya: ' + clip(e.message, 200) });
    }
  });

  return { router, page: PAGE };
};
