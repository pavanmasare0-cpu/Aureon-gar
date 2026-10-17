#!/usr/bin/env python3
"""Aureon v9 backend patch (run from repo root): lets /api/chat accept MANY photos per message (m.images) and
only sends the newest photo-message to Gemini. Edits backend/server.js. Idempotent; writes a .bak-before-v9 copy."""
import sys, os
P = 'backend/server.js'
if not os.path.exists(P): sys.exit('ERROR: backend/server.js not found — run from the repo root')
s = open(P, encoding='utf8').read()
if 'lastImgIdx' in s: print('ok, already done: backend/server.js'); sys.exit(0)
orig = s; problems = []
def sub(old, new, label):
    global s
    if s.count(old) != 1: problems.append(label); return
    s = s.replace(old, new)

sub("async function callGeminiWithModel(modelName, messages, systemPrompt, useTools, key = firstGeminiKey()) {\n  const payload = {\n    contents: messages.map(m => {",
"""// v9: a message may carry several photos (m.images) — or the old single m.image. Only the NEWEST photo-message is
// sent to the model (older ones are dropped by the app already; this also protects against old app versions).
const MAX_INLINE_IMAGE_CHARS = 18 * 1024 * 1024; // Gemini's request limit is ~20 MB
function imagesOf(m) {
  if (!m) return [];
  if (Array.isArray(m.images) && m.images.length) return m.images;
  return m.image ? [m.image] : [];
}
function lastImageIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const x = messages[i];
    if (x && x.role === 'user' && imagesOf(x).some((im) => im && im.data)) return i;
  }
  return -1;
}

async function callGeminiWithModel(modelName, messages, systemPrompt, useTools, key = firstGeminiKey()) {
  const lastImgIdx = lastImageIndex(messages);
  const payload = {
    contents: messages.map((m, mi) => {""", 'callGeminiWithModel head')
sub("""      if (m.image && m.image.data && m.image.mimeType) {
        parts.push({ inlineData: { mimeType: m.image.mimeType, data: m.image.data } });
      }""", """      if (mi === lastImgIdx) {
        let used = 0, skipped = 0;
        for (const im of imagesOf(m)) {
          if (!im || !im.data || !im.mimeType) continue;
          if (used + im.data.length > MAX_INLINE_IMAGE_CHARS) { skipped++; continue; }
          used += im.data.length;
          parts.push({ inlineData: { mimeType: im.mimeType, data: im.data } });
        }
        if (skipped) parts[0].text += `\\n[${skipped} more photo(s) were too much to send at once and were left out]`;
      }""", 'image parts')
# Groq cannot see images: the screenshot reader must look at every photo of the newest message
sub("    if (m && m.role === 'user' && m.image && m.image.data) { idx = i; break; }", "    if (m && m.role === 'user' && imagesOf(m).some((im) => im && im.data)) { idx = i; break; }", 'shareScreenshot find')
sub("and anything highlighted. Do not guess.', image: messages[idx].image }],", "and anything highlighted. Do not guess. If there are several images, describe each one in order.', images: imagesOf(messages[idx]) }],", 'shareScreenshot call')
sub("(i === idx ? { ...x, image: undefined, content: (x.content || '') + note } : x)", "(i === idx ? { ...x, image: undefined, images: undefined, content: (x.content || '') + note } : x)", 'shareScreenshot strip')
if problems: sys.exit('ANCHORS NOT FOUND (send me backend/server.js): ' + ', '.join(problems))
open(P + '.bak-before-v9', 'w', encoding='utf8').write(orig); open(P, 'w', encoding='utf8').write(s)
print('patched backend/server.js: many photos per message')
