const { callGroq, callGemini } = require("./keyPool");

const TEXT_BIG  = [["groq", "llama-3.3-70b-versatile"], ["gemini", "gemini-2.5-flash"]];
const TEXT_FAST = [["groq", "llama-3.1-8b-instant"],    ["gemini", "gemini-2.5-flash"]];

const MODES = {
  coding: TEXT_BIG, coder: TEXT_BIG, lab: TEXT_BIG,
  ava: TEXT_FAST, aureon: TEXT_FAST, automation: TEXT_FAST, general: TEXT_FAST,
  photo_edit: [["gemini", "gemini-2.5-flash-image"]],
  image_gen:  [["gemini", "gemini-2.5-flash-image"]],
  video_gen:  [["gemini", "veo-3.0-generate-001"]],
};
MODES["ava-lab"] = TEXT_BIG;
MODES["ava_lab"] = TEXT_BIG;
MODES["avalab"]  = TEXT_BIG;

const askGroq = (model, prompt) => callGroq(async key => {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) { const e = new Error("groq " + r.status); e.status = r.status; throw e; }
  return (await r.json()).choices[0].message.content;
});

const askGemini = (model, prompt) => callGemini(async key => {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
  if (!r.ok) { const e = new Error("gemini " + r.status); e.status = r.status; throw e; }
  const parts = (await r.json()).candidates?.[0]?.content?.parts || [];
  if (model.includes("image")) return parts;
  return parts.map(p => p.text || "").join("");
});

async function ask(mode, prompt) {
  const chain = MODES[mode] || MODES.coding;
  for (const [provider, model] of chain) {
    try {
      return provider === "groq" ? await askGroq(model, prompt) : await askGemini(model, prompt);
    } catch (e) {
      console.error("FAIL", mode, provider, model, e.status, e.message);
    }
  }
  throw new Error(mode + ": sab providers fail");
}

module.exports = { ask, MODES };
