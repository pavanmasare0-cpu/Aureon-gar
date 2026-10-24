function loadKeys(prefix) {
  const list = [];
  const bulk = process.env[prefix + "_KEYS"];
  if (bulk) list.push(...bulk.split(","));
  for (const [name, val] of Object.entries(process.env)) {
    if (name === prefix + "_API_KEY" || name.startsWith(prefix + "_API_KEY_")) list.push(val);
  }
  return [...new Set(list.map(k => (k || "").trim()).filter(Boolean))];
}

function makePool(prefix) {
  const cooldown = new Map();
  let i = 0;

  function nextKey(keys) {
    for (let n = 0; n < keys.length; n++) {
      const k = keys[i++ % keys.length];
      if ((cooldown.get(k) || 0) < Date.now()) return k;
    }
    return null;
  }

  return async function call(fn) {
    const keys = loadKeys(prefix);
    if (!keys.length) throw new Error(prefix + ": koi key nahi mili (Render env check karo)");
    for (let n = 0; n < keys.length; n++) {
      const key = nextKey(keys);
      if (!key) break;
      try {
        return await fn(key);
      } catch (e) {
        if ([401, 403, 429].includes(e.status) || e.status >= 500) {
          console.error(`[${prefix}] key ...${key.slice(-4)} status ${e.status}, 60s rest`);
          cooldown.set(key, Date.now() + 60000);
          continue;
        }
        throw e;
      }
    }
    throw new Error(prefix + ": saari keys busy/band hain");
  };
}

module.exports = { callGroq: makePool("GROQ"), callGemini: makePool("GEMINI"), loadKeys };
