#!/usr/bin/env python3
"""Aureon v9 app patch (run from repo root): many photos per message + old-chat 'Failed to fetch' fix.
Edits www/app.js and appends to www/style.css. Idempotent; writes .bak-before-v9 copies."""
import os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
APP, CSS = 'www/app.js', 'www/style.css'
if not os.path.exists(APP): sys.exit('ERROR: www/app.js not found — run this from the repo root')
s = open(APP, encoding='utf8').read()
if 'migrateOldChats' in s: print('ok, already done: www/app.js'); sys.exit(0)
orig = s
BLOCK = open(os.path.join(HERE, 'photos.js'), encoding='utf8').read()
problems = []
def sub(old, new, label):
    global s
    if s.count(old) != 1: problems.append(label); return
    s = s.replace(old, new)

sub("state.pendingImage = null; // { mimeType, data } — for images sent to vision",
    "state.pendingImage = null; // { mimeType, data } — for images sent to vision\nstate.pendingImages = []; // v9: any number of photos for one message", 'init')
# helper block (function declarations + a one-time cleanup of old chats), placed before the chat-persistence code
sub("// ---------- Recent chats (local only, MVP) ----------\nfunction saveChatSnapshot() {", BLOCK + "\n// ---------- Recent chats (local only, MVP) ----------\nfunction saveChatSnapshot() {", 'block')
# messagesForBackend: keep the original as the text-attachment pass
sub("function messagesForBackend(messages) {\n  let last = -1;", "function messagesForBackendText(messages) {\n  let last = -1;", 'rename original')
# multi-select
sub("$('image-input')?.addEventListener('change', (e) => {\n  const file = e.target.files && e.target.files[0];\n  if (!file) return;\n",
    "if ($('image-input')) $('image-input').multiple = true;\n$('image-input')?.addEventListener('change', (e) => {\n  const picked = Array.from(e.target.files || []);\n  if (picked.length && picked.every((f) => f.type.startsWith('image/'))) { e.target.value = ''; handleImagePick(picked); return; }\n  const file = picked[0];\n  if (!file) return;\n  state.pendingImages = []; renderImageStrip();\n", 'change handler')
sub("$('btn-remove-image')?.addEventListener('click', () => {\n  state.pendingImage = null;", "$('btn-remove-image')?.addEventListener('click', () => {\n  state.pendingImages = []; renderImageStrip();\n  state.pendingImage = null;", 'remove btn')
sub("  if (editingImage) {\n    state.pendingImage = null;", "  if (editingImage) {\n    state.pendingImages = []; renderImageStrip();\n    state.pendingImage = null;", 'edit image')
# send
sub("  input.value = '';\n  state.pendingImage = null;\n  state.pendingFileText = null;\n  state.pendingFileName = null;\n  $('image-preview-bar').classList.add('hidden');\n\n  let effectiveText = text;",
    "  input.value = '';\n  const sentImages = (state.pendingImages || []).slice();\n  state.pendingImages = []; renderImageStrip();\n  state.pendingImage = null;\n  state.pendingFileText = null;\n  state.pendingFileName = null;\n  $('image-preview-bar').classList.add('hidden');\n\n  let effectiveText = text;", 'send reset')
sub("  if (text || image) addMessage('user', text || '(sent an image)');\n  if (fileName) addAttachmentChip(fileName);\n  const userMessage = { role: 'user', content: effectiveText, display: text || (image ? '(sent an image)' : ''), file: fileName || null };\n  if (image) userMessage.image = image;\n",
    "  if (sentImages.length) addUserPhotosMessage(text, sentImages);\n  else if (text || image) addMessage('user', text || '(sent an image)');\n  if (fileName) addAttachmentChip(fileName);\n  const userMessage = { role: 'user', content: effectiveText, display: text || (sentImages.length > 1 ? `(sent ${sentImages.length} photos)` : image ? '(sent an image)' : ''), file: fileName || null };\n  if (sentImages.length) {\n    userMessage.images = sentImages.map((x) => ({ mimeType: x.mimeType, data: x.data }));\n    userMessage.image = userMessage.images[0]; // older backends still see the first photo\n    userMessage.thumbs = sentImages.map((x) => x.thumb);\n  } else if (image) userMessage.image = image;\n  // lets Ava (the floating assistant) react to what you type / share\n  try { window.dispatchEvent(new CustomEvent('aureon:user-message', { detail: { text, count: sentImages.length, thumb: (sentImages[0] && sentImages[0].thumb) || '' } })); } catch (e) { /* optional */ }\n", 'send message')
# saving / loading chats
sub("const snapshot = { id: state.activeChatId || `${Date.now()}`, title, messages: state.currentMessages };", "const snapshot = { id: state.activeChatId || `${Date.now()}`, title, messages: slimForStorage(state.currentMessages) };", 'snapshot')
sub("  localStorage.setItem('aureon_chats', JSON.stringify(state.chats));\n  saveChatToCloud(snapshot);\n}",
    "  try { localStorage.setItem('aureon_chats', JSON.stringify(state.chats)); }\n  catch (e) { try { state.chats = state.chats.slice(0, 10); localStorage.setItem('aureon_chats', JSON.stringify(state.chats)); } catch (e2) { console.warn('chat cache is full:', e2.message); } }\n  saveChatToCloud(snapshot);\n}", 'storage try/catch')
sub("state.chats = snap.docs.map(d => ({ id: d.id, ...d.data() }));", "state.chats = snap.docs.map(d => { const c = { id: d.id, ...d.data() }; return { ...c, messages: slimForStorage(c.messages) }; });", 'cloud load')
# request: say WHY it failed (size / offline) instead of a bare "Failed to fetch"
m = re.search(r"  const res = await fetch\(`\$\{state\.backendUrl\.replace\(/\\/\$/, ''\)\}/api/chat`, \{\n    method: 'POST',\n    headers: await authHeaders\(\),\n    body: JSON\.stringify\(\{(.*?)\n    \}\)\n  \}\);\n  if \(!res\.ok\) \{", s, re.S)
if not m: problems.append('callBackend')
else:
    new = ("  const _payload = JSON.stringify({" + m.group(1) + "\n    });\n  let res;\n  try {\n    res = await fetch(`${state.backendUrl.replace(/\\/$/, '')}/api/chat`, { method: 'POST', headers: await authHeaders(), body: _payload });\n"
           "  } catch (e) {\n    const mb = (_payload.length / 1048576).toFixed(1);\n    throw new Error(`${e.message || 'Failed to fetch'} — request ${mb} MB${navigator.onLine === false ? ', phone offline hai' : ''}${_payload.length > 12 * 1048576 ? ' (bahut bada: purani photos/files hata ke naya chat try karo)' : ''}. Backend check: ${state.backendUrl.replace(/\\/$/, '')}/health`);\n  }\n  if (!res.ok) {")
    s = s[:m.start()] + new + s[m.end():]
if problems: sys.exit('ANCHORS NOT FOUND (send me www/app.js so I can adapt the patch): ' + ', '.join(problems))
open(APP + '.bak-before-v9', 'w', encoding='utf8').write(orig); open(APP, 'w', encoding='utf8').write(s)
css = open(CSS, encoding='utf8').read() if os.path.exists(CSS) else ''
if 'strip-item' not in css:
    open(CSS, 'a', encoding='utf8').write("""
/* v9: many photos per message */
.image-preview-strip{display:flex;gap:8px;overflow-x:auto;max-width:100%;padding:6px 4px 2px;align-items:center;-webkit-overflow-scrolling:touch}
.strip-item{position:relative;flex:none}
.strip-item img{width:58px;height:58px;object-fit:cover;border-radius:12px;display:block}
.strip-x{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:0;background:rgba(0,0,0,.78);color:#fff;font-size:11px;line-height:20px;padding:0;cursor:pointer}
.strip-add{flex:none;width:58px;height:58px;border-radius:12px;border:1.5px dashed rgba(127,127,127,.65);background:transparent;color:inherit;font-size:22px;cursor:pointer}
.msg-photos .photo-grid{display:grid;gap:4px;max-width:260px;border-radius:14px;overflow:hidden}
.photo-grid.n1{grid-template-columns:1fr}.photo-grid.n2,.photo-grid.n3,.photo-grid.n4{grid-template-columns:1fr 1fr}
.photo-grid img{width:100%;height:120px;object-fit:cover;display:block}.photo-grid.n1 img{height:auto;max-height:260px}
""")
print('patched www/app.js (+ style.css): many photos, lean chat storage, clearer backend errors')
