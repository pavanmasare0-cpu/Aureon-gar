// backend/keys.js — ek jagah se saari API keys. GEMINI_API_KEY, GEMINI_API_KEY_2 ... _99, GEMINI_API_KEYS (comma list). Same GROQ ke liye.
function collect(base) {
  const out = []; const add = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((k) => { if (!out.includes(k)) out.push(k); });
  add(process.env[base]);
  Object.keys(process.env)
    .map((n) => { const m = n.match(new RegExp('^' + base + '_(\\d+)$')); return m ? [parseInt(m[1], 10), n] : null; })
    .filter(Boolean).sort((a, b) => a[0] - b[0]).forEach(([, n]) => add(process.env[n]));
  add(process.env[base + 'S']);
  return out;
}
const geminiKeys = () => collect('GEMINI_API_KEY');
const groqKeys = () => collect('GROQ_API_KEY');

// Keys ek ek karke try karta hai; jo chala wo agli baar pehle try hota hai. fn(key) fail ho to agli key.
const sticky = {};
async function tryKeys(name, keys, fn) {
  if (!keys.length) throw new Error(name + ': koi API key set nahi hai');
  const start = (sticky[name] || 0) % keys.length;
  let lastErr;
  for (let n = 0; n < keys.length; n++) {
    const idx = (start + n) % keys.length;
    try { const r = await fn(keys[idx], idx); sticky[name] = idx; return r; }
    catch (e) { lastErr = e; console.warn(`[${name}] key #${idx + 1} fail: ${String((e && e.message) || e).slice(0, 120)}`); }
  }
  throw lastErr;
}
module.exports = { collect, geminiKeys, groqKeys, tryKeys };
