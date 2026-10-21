// backend/llm-text.js — one plain-text LLM entry point for Ava Studio and APK Studio.
//
//   text(prompt, {system, maxTokens})  ->  string
//
// Order: Ava's Gemini (global.__avaSelf.llmText, set by ava.js; rotates its own keys)  ->  Groq directly (plain text, no JSON wrapping).
// A Gemini quota / invalid-key / overload error therefore never stops the work: it just moves to Groq.
// Groq keys: GROQ_API_KEY, GROQ_API_KEYS (comma list) and GROQ_API_KEY_1..9 — rotated on 429/401.
// Optional: AVA_GROQ_MODEL (default llama-3.3-70b-versatile), AVA_GROQ_MAX_TOKENS (default 16000).
const DEFAULT_SYSTEM = 'You are Ava, a principal engineer and world-class designer. Follow the requested output format exactly; output only what the format asks — no chat, no explanation, no markdown fences around the whole answer.';

function groqKeys() {
  const out = [];
  const add = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((k) => { if (!out.includes(k)) out.push(k); });
  add(process.env.GROQ_API_KEY); add(process.env.GROQ_API_KEYS);
  for (let i = 1; i <= 9; i++) add(process.env['GROQ_API_KEY_' + i]);
  return out;
}
let cursor = 0;
async function groqText(prompt, opts) {
  const keys = groqKeys();
  if (!keys.length) throw new Error('GROQ_API_KEY set nahi hai');
  const model = process.env.AVA_GROQ_MODEL || 'llama-3.3-70b-versatile';
  const maxTokens = Math.min(Number((opts && opts.maxTokens) || process.env.AVA_GROQ_MAX_TOKENS || 16000), 32000);
  let lastErr = 'groq fail';
  for (let n = 0; n < keys.length; n++) {
    const key = keys[(cursor + n) % keys.length];
    let r, d;
    try {
      r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, temperature: 0.35, max_tokens: maxTokens, messages: [{ role: 'system', content: (opts && opts.system) || DEFAULT_SYSTEM }, { role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(170000),
      });
      d = await r.json().catch(() => ({}));
    } catch (e) { lastErr = 'groq network: ' + (e && e.message); continue; }
    const t = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (t) { cursor = (cursor + n) % keys.length; return String(t); }
    lastErr = 'groq ' + r.status + ': ' + String((d && d.error && d.error.message) || '').slice(0, 160);
    if (r.status === 429 || r.status === 401 || r.status === 403) continue; // try the next key
    if (r.status >= 500) continue;
    break;
  }
  throw new Error(lastErr + (/429|rate|quota/i.test(lastErr) ? ' (rate limit)' : ''));
}

async function text(prompt, opts) {
  const h = global.__avaSelf || {};
  let gemErr = null;
  if (typeof h.llmText === 'function') {
    try { const t = await h.llmText(prompt); if (t && String(t).trim()) return String(t); gemErr = new Error('Gemini ne khaali jawab diya'); }
    catch (e) { gemErr = e; }
  }
  if (groqKeys().length) {
    try { return await groqText(prompt, opts); }
    catch (e) { throw new Error((gemErr ? 'Gemini: ' + String(gemErr.message).slice(0, 100) + ' | ' : '') + e.message); }
  }
  throw gemErr || new Error('Koi AI key set nahi (GEMINI_API_KEY ya GROQ_API_KEY)');
}
const available = () => !!((global.__avaSelf && global.__avaSelf.llmText) || groqKeys().length);
module.exports = { text, groqText, groqKeys, available };
