// ===== Aureon AI — frontend logic (MVP) =====
// Talks to your own backend (see /backend). No API keys live in this app.
// Auth + data storage handled by Firebase (see firebase-config.js).

const state = {
  // Fixed backend — no longer user-editable, so it can never get cleared or mistyped.
  backendUrl: 'https://aureone.onrender.com',
  model: localStorage.getItem('aureon_model') || 'openai',
  chats: JSON.parse(localStorage.getItem('aureon_chats') || '[]'),
  currentMessages: [],
  user: null
};

const MODEL_LABELS = { openai: 'Fast', claude: 'Smart', gemini: 'Research', groq: 'Fastest', local: 'Private' };

const $ = (id) => document.getElementById(id);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function openSheet(id) { $(id).classList.remove('hidden'); }
function closeSheet(id) { $(id).classList.add('hidden'); }

// ---------- Home ----------
// Settings is now only reachable via the ☰ drawer (see btn-drawer-settings below).
$('btn-drawer-settings').onclick = () => { closeDrawer(); openSheet('sheet-settings'); };

// ---------- Side drawer (☰ menu) ----------
function openDrawer() {
  $('drawer').classList.remove('hidden');
  // Voice conversations are saved from the native side while the app may
  // be closed — pull the latest so they show up without a restart.
  if (typeof loadChatsFromCloud === 'function') loadChatsFromCloud();
}
function closeDrawer() { $('drawer').classList.add('hidden'); }
$('btn-menu').onclick = openDrawer;
document.querySelector('#drawer .drawer-backdrop').onclick = closeDrawer;
$('btn-new-chat').onclick = () => { closeDrawer(); startChatFrom(''); };

document.querySelectorAll('.quick-row').forEach(card => {
  card.onclick = () => {
    const prompts = {
      ask: '', file: 'Analyze this file: ', image: 'Analyze this image: ',
      code: 'Help me write code for: ', search: 'Search the web for: ', write: 'Help me write: '
    };
    startChatFrom(prompts[card.dataset.prompt] || '');
  };
});

$('btn-send-home').onclick = () => startChatFrom($('home-input').value);
$('home-input').addEventListener('keydown', e => { if (e.key === 'Enter') startChatFrom(e.target.value); });

function startChatFrom(text) {
  state.currentMessages = [];
  state.activeChatId = null; // fresh chat = fresh id, never overwrite the last opened one
  $('messages').innerHTML = '';
  $('chat-title-text').textContent = 'New chat';
  showScreen('screen-chat');
  $('home-input').value = '';
  if (text && text.trim()) {
    $('chat-input').value = text;
    sendMessage();
  } else {
    $('chat-input').focus();
  }
}

// ---------- Chat screen ----------
$('btn-back').onclick = () => { renderRecent(); showScreen('screen-home'); };
$('btn-send-chat').onclick = sendMessage;

$('btn-generate-image').onclick = async () => {
  const pendingVideo = state.pendingImage && state.pendingImage.mimeType && state.pendingImage.mimeType.startsWith('video/')
    ? state.pendingImage
    : null;

  if (pendingVideo) {
    await handleVideoEdit(pendingVideo);
    return;
  }

  const input = $('chat-input');
  const prompt = input.value.trim();
  if (!prompt) { alert('Type a description first, then tap 🎨 to generate an image from it.'); return; }
  input.value = '';

  const editingImage = state.pendingImage && state.pendingImage.mimeType && state.pendingImage.mimeType.startsWith('image/')
    ? state.pendingImage
    : null;

  if ($('chat-title-text').textContent === 'New chat') {
    $('chat-title-text').textContent = prompt.slice(0, 28) + (prompt.length > 28 ? '…' : '');
  }

  addMessage('user', editingImage ? `✏️ Edit: ${prompt}` : `🎨 Generate: ${prompt}`);
  if (editingImage) {
    state.pendingImage = null;
    $('image-preview-bar').classList.add('hidden');
  }
  $('typing-indicator').classList.remove('hidden');

  try {
    const body = { prompt };
    if (editingImage) body.sourceImage = { mimeType: editingImage.mimeType, dataBase64: editingImage.data };
    const res = await fetch(`${state.backendUrl.replace(/\/$/, '')}/api/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    $('typing-indicator').classList.add('hidden');
    if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
    const dataUrl = `data:${data.mimeType};base64,${data.dataBase64}`;
    addMessage('ai', '', false, dataUrl);
  } catch (err) {
    $('typing-indicator').classList.add('hidden');
    addMessage('error', `Couldn't ${editingImage ? 'edit' : 'generate'} that image. ${err.message || ''}`);
  }
};
$('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });
$('btn-model-switch').onclick = () => openSheet('sheet-model');
$('btn-upload-owner-photo').onclick = () => $('owner-photo-input').click();
$('owner-photo-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = $('owner-photo-status');
  statusEl.classList.remove('hidden');
  statusEl.textContent = `Saving "${file.name}"...`;
  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = reader.result.split(',')[1];
    try {
      const actions = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AureonActions;
      if (!actions || !actions.saveOwnerPhoto) throw new Error('Only available in the Aureon app.');
      await actions.saveOwnerPhoto({ base64 });
      statusEl.textContent = `✓ Saved — Love Camera will now recognize you.`;
    } catch (err) {
      statusEl.textContent = `Couldn't save: ${err.message || err}`;
    }
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});
$('btn-love-camera').onclick = () => {
  const actions = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AureonActions;
  if (actions && actions.openLoveCamera) actions.openLoveCamera();
};

document.querySelectorAll('.sheet-backdrop').forEach(b => {
  b.onclick = () => document.querySelectorAll('.sheet').forEach(s => s.classList.add('hidden'));
});

document.querySelectorAll('#sheet-model .sheet-option').forEach(opt => {
  opt.onclick = () => {
    state.model = opt.dataset.model;
    localStorage.setItem('aureon_model', state.model);
    $('model-pill').textContent = MODEL_LABELS[state.model];
    closeSheet('sheet-model');
  };
});

// Splits a message into plain-text and fenced-code (```lang\ncode```)
// segments and renders each safely via DOM nodes — textContent only, never
// innerHTML, so nothing the AI (or a user) writes is ever interpreted as
// markup, even inside a code block or inside **bold** text.
// For AI replies, plain-text segments also get light markdown (bold,
// bullet lists) so long answers read like a document instead of raw
// asterisks and dashes — user's own messages stay simple, unstyled.
function renderMessageContent(container, text, role) {
  const fenceRe = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = fenceRe.exec(text)) !== null) {
    const plainBefore = text.slice(lastIndex, match.index);
    if (plainBefore) appendPlainSegment(container, plainBefore, role);

    const lang = (match[1] || '').trim();
    const code = match[2].replace(/\n$/, '');
    container.appendChild(buildCodeBlock(lang, code));

    lastIndex = fenceRe.lastIndex;
  }

  const plainAfter = text.slice(lastIndex);
  if (plainAfter) appendPlainSegment(container, plainAfter, role);

  if (container.childNodes.length === 0) {
    container.textContent = text;
  }
}

function appendPlainSegment(container, str, role) {
  if (role !== 'ai') {
    container.appendChild(document.createTextNode(str));
    return;
  }
  // AI side: split into lines, group consecutive "- "/"* " lines into a
  // real bullet list, render **bold** inline, everything else as its own
  // line (so paragraph spacing works without relying on white-space:pre).
  const lines = str.split('\n');
  let i = 0;
  while (i < lines.length) {
    const bulletMatch = /^\s*[-*]\s+(.*)/.exec(lines[i]);
    if (bulletMatch) {
      const ul = document.createElement('ul');
      ul.className = 'msg-list';
      while (i < lines.length) {
        const bm = /^\s*[-*]\s+(.*)/.exec(lines[i]);
        if (!bm) break;
        const li = document.createElement('li');
        appendInlineFormatted(li, bm[1]);
        ul.appendChild(li);
        i++;
      }
      container.appendChild(ul);
      continue;
    }
    const lineEl = document.createElement('div');
    lineEl.className = 'msg-line';
    appendInlineFormatted(lineEl, lines[i]);
    container.appendChild(lineEl);
    i++;
  }
}

// Handles **bold** only — enough to fix the common "**Garima**" raw-asterisk
// look without building a full markdown parser. Bold text is still just a
// <strong> wrapping a text node (textContent), never innerHTML.
function appendInlineFormatted(el, text) {
  const boldRe = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = boldRe.exec(text)) !== null) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const strong = document.createElement('strong');
    strong.textContent = m[1];
    el.appendChild(strong);
    last = boldRe.lastIndex;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

function buildCodeBlock(lang, code) {
  const wrap = document.createElement('div');
  wrap.className = 'code-block';

  const header = document.createElement('div');
  header.className = 'code-block-header';

  const langLabel = document.createElement('span');
  langLabel.className = 'code-lang';
  langLabel.textContent = lang || 'code';
  header.appendChild(langLabel);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'code-copy-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(code).then(() => {
      copyBtn.textContent = 'Copied ✓';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    }).catch(() => {
      copyBtn.textContent = "Couldn't copy";
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    });
  };
  header.appendChild(copyBtn);
  wrap.appendChild(header);

  const pre = document.createElement('pre');
  const codeEl = document.createElement('code');
  highlightInto(codeEl, code);
  pre.appendChild(codeEl);
  wrap.appendChild(pre);

  return wrap;
}

// Lightweight, dependency-free token coloring — not a real parser, just
// enough to make code visually scannable (keywords/strings/comments/
// numbers colored differently). No CDN, works fully offline in the WebView.
// Every token lands via textContent/createTextNode, never innerHTML.
const CODE_KEYWORDS = new Set([
  'function','return','if','else','for','while','do','break','continue','var','let','const',
  'class','extends','new','this','super','import','export','from','default','async','await',
  'try','catch','finally','throw','switch','case','null','true','false','undefined','void',
  'def','elif','except','pass','lambda','yield','with','as','is','not','and','or','in','None','True','False','self',
  'public','private','protected','static','final','int','String','boolean','double','float','long','char',
  'package','interface','implements','abstract','enum','struct','namespace','using','include',
]);

function highlightInto(codeEl, code) {
  const tokenRe = /(\/\/[^\n]*|#[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+\.?\d*\b)|([A-Za-z_]\w*)|([^\sA-Za-z0-9_]+)|(\s+)/g;
  let m;
  while ((m = tokenRe.exec(code)) !== null) {
    const [, comment, str, num, word, punct, ws] = m;
    if (comment) {
      const span = document.createElement('span');
      span.className = 'tok-comment';
      span.textContent = comment;
      codeEl.appendChild(span);
    } else if (str) {
      const span = document.createElement('span');
      span.className = 'tok-string';
      span.textContent = str;
      codeEl.appendChild(span);
    } else if (num) {
      const span = document.createElement('span');
      span.className = 'tok-number';
      span.textContent = num;
      codeEl.appendChild(span);
    } else if (word) {
      if (CODE_KEYWORDS.has(word)) {
        const span = document.createElement('span');
        span.className = 'tok-keyword';
        span.textContent = word;
        codeEl.appendChild(span);
      } else {
        codeEl.appendChild(document.createTextNode(word));
      }
    } else {
      codeEl.appendChild(document.createTextNode(punct || ws || ''));
    }
  }
}

function addMessage(role, text, wantsPdf = false, imageDataUrl = null, videoDataUrl = null) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;

  if (imageDataUrl) {
    const img = document.createElement('img');
    img.src = imageDataUrl;
    img.className = 'msg-generated-image';
    div.appendChild(img);
    if (text) {
      const caption = document.createElement('div');
      caption.className = 'msg-image-caption';
      caption.textContent = text;
      div.appendChild(caption);
    }
  } else if (videoDataUrl) {
    const video = document.createElement('video');
    video.src = videoDataUrl;
    video.controls = true;
    video.className = 'msg-generated-video';
    div.appendChild(video);
    if (text) {
      const caption = document.createElement('div');
      caption.className = 'msg-image-caption';
      caption.textContent = text;
      div.appendChild(caption);
    }
  } else {
    // Only a reply that actually has a code block escapes the normal
    // bubble (see .msg.ai.has-code) — plain text always stays boxed in,
    // no matter how long.
    if (role === 'ai' && /```/.test(text)) div.classList.add('has-code');
    renderMessageContent(div, text, role);
  }

  $('messages').appendChild(div);

  if (role === 'ai' && wantsPdf) {
    const pdfBtn = document.createElement('button');
    pdfBtn.className = 'pdf-export-btn';
    pdfBtn.textContent = '📄 Save as PDF';
    pdfBtn.onclick = () => exportMessageAsPdf(text);
    div.appendChild(document.createElement('br'));
    div.appendChild(pdfBtn);
  }

  $('messages').scrollTop = $('messages').scrollHeight;
  return div;
}

// Returns true only if the user's own message actually asked for a PDF
// (e.g. "pdf banao", "save as pdf", "pdf chahiye"). Simple substring
// check on the word "pdf" — case-insensitive — covers Hindi/Hinglish/English.
function userAskedForPdf(text) {
  return /\bpdf\b/i.test(text || '');
}

async function exportMessageAsPdf(content) {
  try {
    const res = await fetch(`${state.backendUrl.replace(/\/$/, '')}/api/generate-pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Aureon Response', content })
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    const filename = data.filename || 'aureon-document.pdf';

    const isNative = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();

    if (isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) {
      const { Filesystem } = window.Capacitor.Plugins;
      const writeResult = await Filesystem.writeFile({
        path: filename,
        data: data.dataBase64,
        directory: 'CACHE',
        recursive: true
      });

      if (window.Capacitor.Plugins.Share) {
        await window.Capacitor.Plugins.Share.share({
          title: filename,
          url: writeResult.uri
        });
      } else {
        alert(`PDF ban gayi: ${filename}`);
      }
    } else {
      const link = document.createElement('a');
      link.href = `data:application/pdf;base64,${data.dataBase64}`;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  } catch (err) {
    alert(`Could not create PDF: ${err.message}`);
  }
}

// ---------- Attach (Vision + files) ----------
state.pendingImage = null; // { mimeType, data } — for images sent to vision
state.pendingFileText = null; // extracted text for txt files
state.pendingFileName = null;

$('btn-attach-2')?.addEventListener('click', () => $('image-input').click());
$('btn-attach')?.addEventListener('click', () => {
  startChatFrom(''); // home screen's attach has no preview bar of its own — hop into chat first
  $('image-input').click();
});

$('image-input')?.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  state.pendingImage = null;
  state.pendingFileText = null;
  state.pendingFileName = file.name;

  if (file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const [prefix, data] = result.split(',');
      const mimeType = prefix.match(/data:(.*);base64/)[1];
      state.pendingImage = { mimeType, data };
      $('image-preview-thumb').src = result;
      $('image-preview-thumb').classList.remove('hidden');
      $('file-preview-label').classList.add('hidden');
      $('attach-name').textContent = file.name;
      $('image-preview-bar').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
  } else if (file.type.startsWith('video/')) {
    // Short video clips (a screen recording, a quick clip) go to Gemini the
    // same way images do — as inlineData — so the model can actually watch
    // and describe/answer questions about it. Large videos can exceed the
    // request size limit; keep clips short (well under a minute) for this
    // to work reliably.
    const MAX_INLINE_VIDEO_BYTES = 18 * 1024 * 1024; // ~18MB raw, ~24MB after base64
    if (file.size > MAX_INLINE_VIDEO_BYTES) {
      $('image-preview-thumb').classList.add('hidden');
      $('file-preview-label').classList.remove('hidden');
      $('attach-name').textContent = `${file.name} — too large (keep videos under ~18MB / a short clip)`;
      $('image-preview-bar').classList.remove('hidden');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const [prefix, data] = result.split(',');
      const mimeType = prefix.match(/data:(.*);base64/)[1] || file.type;
      state.pendingImage = { mimeType, data }; // same field the backend already forwards as inlineData
      $('image-preview-thumb').classList.add('hidden');
      $('file-preview-label').classList.remove('hidden');
      $('attach-name').textContent = `🎬 ${file.name}`;
      $('image-preview-bar').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
  } else if (file.type === 'text/plain' || file.name.endsWith('.txt')) {
    const reader = new FileReader();
    reader.onload = () => {
      state.pendingFileText = reader.result;
      $('image-preview-thumb').classList.add('hidden');
      $('file-preview-label').classList.remove('hidden');
      $('attach-name').textContent = file.name;
      $('image-preview-bar').classList.remove('hidden');
    };
    reader.readAsText(file);
  } else if (
    file.type === 'application/pdf' ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    file.type === 'application/zip' || file.type === 'application/x-zip-compressed' ||
    file.name.endsWith('.pdf') || file.name.endsWith('.docx') || file.name.endsWith('.zip')
  ) {
    // PDF / DOCX / ZIP — send to the backend's extractor (same one the
    // Knowledge upload uses) so the actual content reaches the AI instead
    // of just the filename with nothing behind it.
    $('image-preview-thumb').classList.add('hidden');
    $('file-preview-label').classList.remove('hidden');
    $('attach-name').textContent = `${file.name} (reading…)`;
    $('image-preview-bar').classList.remove('hidden');

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const [, data] = reader.result.split(',');
        const mimeType = file.type || (file.name.endsWith('.pdf') ? 'application/pdf'
          : file.name.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/zip');
        const res = await fetch(`${state.backendUrl.replace(/\/$/, '')}/api/extract-text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, mimeType, dataBase64: data })
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || `Server returned ${res.status}`);
        state.pendingFileText = result.text;
        $('attach-name').textContent = file.name;
      } catch (err) {
        state.pendingFileText = null;
        $('attach-name').textContent = `${file.name} (couldn't read: ${err.message})`;
      }
    };
    reader.readAsDataURL(file);
  } else {
    // Anything else we genuinely can't extract from (images handled above,
    // unknown binary formats) — still let the user attach it, they'll see
    // a note that content wasn't read.
    $('image-preview-thumb').classList.add('hidden');
    $('file-preview-label').classList.remove('hidden');
    $('attach-name').textContent = file.name;
    $('image-preview-bar').classList.remove('hidden');
  }
  e.target.value = '';
});

$('btn-remove-image')?.addEventListener('click', () => {
  state.pendingImage = null;
  state.pendingFileText = null;
  state.pendingFileName = null;
  $('image-preview-bar').classList.add('hidden');
});

async function handleVideoEdit(pendingVideo) {
  const op = (prompt('Edit video — type one: trim, caption, or convert') || '').trim().toLowerCase();
  if (!op) return;

  let params = {};
  let label = '';
  if (op === 'trim') {
    const start = prompt('Start time in seconds (e.g. 0)', '0');
    if (start === null) return;
    const end = prompt('End time in seconds (e.g. 15)');
    if (end === null) return;
    params = { startSeconds: Number(start) || 0, endSeconds: end ? Number(end) : null };
    label = `✂️ Trim ${params.startSeconds}s–${params.endSeconds ?? '…'}s`;
  } else if (op === 'caption') {
    const text = prompt('Caption text to burn into the video:');
    if (!text) return;
    params = { text };
    label = `✂️ Caption: ${text}`;
  } else if (op === 'convert') {
    const format = (prompt('Target format (mp4 or webm):', 'mp4') || 'mp4').trim().toLowerCase();
    params = { format };
    label = `✂️ Convert to .${format}`;
  } else {
    alert('Unrecognized option — type exactly: trim, caption, or convert.');
    return;
  }

  addMessage('user', label);
  state.pendingImage = null;
  $('image-preview-bar').classList.add('hidden');
  $('typing-indicator').classList.remove('hidden');

  try {
    const res = await fetch(`${state.backendUrl.replace(/\/$/, '')}/api/edit-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoBase64: pendingVideo.data,
        mimeType: pendingVideo.mimeType,
        operation: op,
        params
      })
    });
    const data = await res.json();
    $('typing-indicator').classList.add('hidden');
    if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
    const dataUrl = `data:${data.mimeType};base64,${data.dataBase64}`;
    addMessage('ai', '', false, null, dataUrl);
  } catch (err) {
    $('typing-indicator').classList.add('hidden');
    addMessage('error', `Couldn't edit that video. ${err.message || ''}`);
  }
}

async function sendMessage() {
  const input = $('chat-input');
  const text = input.value.trim();
  const image = state.pendingImage;
  const fileText = state.pendingFileText;
  const fileName = state.pendingFileName;
  if (!text && !image && !fileText && !fileName) return;

  // Tell the native side a real interaction just happened, so the
  // "been quiet for X hours" proactive check-in resets its clock —
  // typed chat should count the same as voice/Love Camera.
  const proactiveActions = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AureonActions;
  if (proactiveActions && proactiveActions.markInteraction) {
    proactiveActions.markInteraction().catch(() => {}); // best-effort, native-only — no-op on web
  }

  input.value = '';
  state.pendingImage = null;
  state.pendingFileText = null;
  state.pendingFileName = null;
  $('image-preview-bar').classList.add('hidden');

  let effectiveText = text;
  if (fileText) {
    effectiveText = `${text ? text + '\n\n' : ''}[Attached file: ${fileName}]\n${fileText}`;
  } else if (fileName && !image) {
    effectiveText = `${text ? text + '\n\n' : ''}[Attached file: ${fileName} — content could not be read]`;
  }

  if ($('chat-title-text').textContent === 'New chat') {
    const titleSource = text || fileName || 'Image';
    $('chat-title-text').textContent = titleSource.slice(0, 28) + (titleSource.length > 28 ? '…' : '');
  }

  addMessage('user', text || (image ? '(sent an image)' : `(sent ${fileName})`));
  const userMessage = { role: 'user', content: effectiveText };
  if (image) userMessage.image = image;
  state.currentMessages.push(userMessage);
  saveChatSnapshot();

  // Offline-capable shortcut: battery / open app / set alarm never need the
  // AI backend at all — if the message clearly asks for one of these, do it
  // natively right away, with zero network involved.
  const agentOn = $('toggle-agent') ? $('toggle-agent').checked : true;
  const localIntent = (!image && !fileText && !fileName && agentOn) ? matchLocalIntent(text) : null;

  if (localIntent) {
    try {
      const result = await executeAgentAction(localIntent.name, localIntent.args);
      const desc = describeAgentAction(localIntent.name, localIntent.args, result);
      addMessage('ai', desc);
      state.currentMessages.push({ role: 'assistant', content: desc });
      saveChatSnapshot();
    } catch (err) {
      addMessage('error', `Couldn't ${localIntent.name.replace(/_/g, ' ')}: ${err.message || err}`);
    }
    return;
  }

  $('typing-indicator').classList.remove('hidden');

  const wantsPdf = userAskedForPdf(text);

  try {
    await runAgentTurn(wantsPdf);
  } catch (err) {
    $('typing-indicator').classList.add('hidden');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      addMessage('error', "You're offline — AI chat needs internet. Battery check, opening apps, and setting alarms still work without it though.");
    } else {
      addMessage('error', `Couldn't reach the AI backend. ${err.message || ''}\n\nSet your backend URL in Settings (⚙) first.`);
    }
  }
}

// ---------- Offline local-intent matching ----------
// Deliberately simple keyword/regex matching, not AI — covers only the
// three agent actions that need zero network access (battery, open app,
// set alarm), so they keep working with no internet and no backend call.
// Anything it doesn't confidently recognize falls through to normal AI chat.
function matchLocalIntent(text) {
  if (!text) return null;
  const lower = text.trim().toLowerCase();

  if (/\bbattery\b/.test(lower) || (/charge/.test(lower) && /kitn/.test(lower))) {
    return { name: 'get_battery', args: {} };
  }

  let appName = null;
  let m = lower.match(/^open\s+(.+)$/);
  if (m) {
    appName = m[1].trim();
  } else {
    m = lower.match(/^(.+?)\s+(khol do|khol den|kholo|khol|open karo|open kar do)$/);
    if (m) appName = m[1].trim();
  }
  if (appName) {
    return { name: 'open_app', args: { app_name: appName } };
  }

  if (/\balarm\b/.test(lower)) {
    let tm = lower.match(/(\d{1,2})[:.](\d{2})/);
    if (tm) {
      let hour = parseInt(tm[1], 10);
      const minute = parseInt(tm[2], 10);
      if (/\bpm\b/.test(lower) && hour < 12) hour += 12;
      if (/\bam\b/.test(lower) && hour === 12) hour = 0;
      return { name: 'set_alarm', args: { hour, minute, label: 'Aureon Alarm' } };
    }
    const bm = lower.match(/(\d{1,2})\s*baje/);
    if (bm) {
      let hour = parseInt(bm[1], 10);
      if (/(shaam|evening|raat|night)/.test(lower) && hour < 12) hour += 12;
      return { name: 'set_alarm', args: { hour, minute: 0, label: 'Aureon Alarm' } };
    }
  }

  return null;
}

// Every protected backend route now requires a fresh Firebase ID token —
// the backend derives uid from this instead of trusting anything the
// client sends. getIdToken() silently refreshes if the cached one expired,
// so this is safe to call before every request.
async function authHeaders() {
  if (!state.user) return { 'Content-Type': 'application/json' };
  const token = await state.user.getIdToken();
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function callBackend(messages, model, tools) {
  if (!state.backendUrl) {
    throw new Error('No backend URL configured.');
  }
  const systemPrompt = await buildSystemPrompt(); // always the freshest memory, see getFreshMemory
  const res = await fetch(`${state.backendUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({
      messages,
      model,
      tools: !!tools,
      systemPrompt,
      useKnowledge: $('toggle-use-knowledge') ? $('toggle-use-knowledge').checked : false
    })
  });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return await res.json(); // { reply } or { functionCall: { name, args } }
}

// ---------- Phase 6: Agent (on-device actions) ----------
// Actions the model may ask the app to run natively (see AureonActionsPlugin.java).
// Calls and SMS always require the user to confirm before they happen.
const SENSITIVE_AGENT_ACTIONS = new Set(['make_call', 'send_sms', 'send_instagram_message', 'send_whatsapp_live_location']);
const AGENT_LOOP_LIMIT = 4; // safety cap so a confused model can't loop forever

async function runAgentTurn(wantsPdf, depth = 0) {
  const agentOn = $('toggle-agent') ? $('toggle-agent').checked : true;
  const result = await callBackend(state.currentMessages, state.model, agentOn);

  if (result.functionCall) {
    if (depth >= AGENT_LOOP_LIMIT) {
      $('typing-indicator').classList.add('hidden');
      addMessage('error', 'Agent got stuck trying to complete that action — try rephrasing.');
      return;
    }

    const { name, args = {} } = result.functionCall;

    if (SENSITIVE_AGENT_ACTIONS.has(name) && !confirmSensitiveAction(name, args)) {
      $('typing-indicator').classList.add('hidden');
      state.currentMessages.push({ role: 'assistant', functionCall: result.functionCall, thoughtSignature: result.thoughtSignature });
      state.currentMessages.push({ role: 'function', functionResponse: { name, response: { result: 'The user declined to allow this action.' } } });
      saveChatSnapshot();
      return runAgentTurn(wantsPdf, depth + 1);
    }

    let actionResult;
    try {
      actionResult = await executeAgentAction(name, args);
      if (name === 'create_zip') {
        const label = `ZIP · ${actionResult.fileCount} file${actionResult.fileCount === 1 ? '' : 's'}`;
        addFileCardMessage(actionResult.zipped, label, actionResult.dataBase64, 'application/zip');
      } else {
        addMessage('ai', describeAgentAction(name, args, actionResult));
      }
    } catch (err) {
      actionResult = { error: err.message || String(err) };
      addMessage('error', `Couldn't ${name.replace(/_/g, ' ')}: ${actionResult.error}`);
    }

    // The model only needs to know the zip was made, not carry the actual
    // file bytes around in conversation history (and re-send them to
    // Gemini on every later turn) — strip dataBase64 before it goes in.
    const resultForModel = (name === 'create_zip' && actionResult && !actionResult.error)
      ? { zipped: actionResult.zipped, fileCount: actionResult.fileCount }
      : actionResult;

    state.currentMessages.push({ role: 'assistant', functionCall: result.functionCall, thoughtSignature: result.thoughtSignature });
    state.currentMessages.push({ role: 'function', functionResponse: { name, response: { result: resultForModel } } });
    saveChatSnapshot();

    return runAgentTurn(wantsPdf, depth + 1);
  }

  $('typing-indicator').classList.add('hidden');
  const reply = result.reply || '(empty response)';
  addMessage('ai', reply, wantsPdf);
  state.currentMessages.push({ role: 'assistant', content: reply });
  saveChatSnapshot();
}

function confirmSensitiveAction(name, args) {
  let label;
  if (name === 'make_call') {
    label = `call ${args.number}`;
  } else if (name === 'send_sms') {
    label = `send an SMS to ${args.number}: "${args.message}"`;
  } else if (name === 'send_instagram_message') {
    label = `send this Instagram DM to ${args.contact_name}: "${args.message}"`;
  } else if (name === 'send_whatsapp_live_location') {
    label = `share your live location with ${args.contact_name} via WhatsApp for ${args.duration || '15 minutes'}`;
  } else {
    label = `run ${name}`;
  }
  return window.confirm(`Aureon wants to ${label}. Allow this?`);
}

// Bundles one or more text files Aureon wrote into a real .zip — built
// server-side (see /api/generate-zip), no client-side zip library needed.
// Doesn't save/share anything itself — just prepares the file and hands
// back what's needed for a tappable file card (see addFileCardMessage),
// the same way a file I (Claude) create shows up as a card you open when
// you're ready, not something forced on you the instant it's done.
async function createZipAndDeliver(args) {
  const files = Array.isArray(args.files) ? args.files : [];
  if (files.length === 0) throw new Error('No files given to zip.');

  const res = await fetch(`${state.backendUrl.replace(/\/$/, '')}/api/generate-zip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, zipName: args.zip_name || 'aureon-files' })
  });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  const data = await res.json();
  return { zipped: data.filename || 'aureon-files.zip', fileCount: files.length, dataBase64: data.dataBase64 };
}

// Actually saves/shares a file whose content is already in hand (base64) —
// called when the user taps a file card, never automatically. Native:
// write to cache then open the share sheet (a cancelled share sheet isn't
// treated as a failure — the file's already saved either way). Web: a
// plain data: URI download link.
async function deliverFile(filename, dataBase64, mimeType) {
  const isNative = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
  if (isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) {
    const { Filesystem } = window.Capacitor.Plugins;
    const writeResult = await Filesystem.writeFile({
      path: filename,
      data: dataBase64,
      directory: 'CACHE',
      recursive: true
    });
    if (window.Capacitor.Plugins.Share) {
      try {
        await window.Capacitor.Plugins.Share.share({ title: filename, url: writeResult.uri });
      } catch (shareErr) {
        const msg = String((shareErr && shareErr.message) || shareErr).toLowerCase();
        if (!msg.includes('cancel')) throw shareErr; // a real error still surfaces normally
      }
    }
  } else {
    const link = document.createElement('a');
    link.href = `data:${mimeType};base64,${dataBase64}`;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
}

// A tappable file card in the chat — icon, filename, type label — exactly
// the "here's a file, open it when you want" pattern instead of a share
// sheet popping up unasked. Tap triggers deliverFile (save/share or
// download, depending on platform) right then, not before.
function addFileCardMessage(filename, typeLabel, dataBase64, mimeType) {
  const div = document.createElement('div');
  div.className = 'msg ai';

  const card = document.createElement('div');
  card.className = 'file-card';

  const icon = document.createElement('div');
  icon.className = 'file-card-icon';
  icon.textContent = '🗂️';
  card.appendChild(icon);

  const info = document.createElement('div');
  info.className = 'file-card-info';
  const nameEl = document.createElement('div');
  nameEl.className = 'file-card-name';
  nameEl.textContent = filename;
  const typeEl = document.createElement('div');
  typeEl.className = 'file-card-type';
  typeEl.textContent = typeLabel;
  info.appendChild(nameEl);
  info.appendChild(typeEl);
  card.appendChild(info);

  const actionIcon = document.createElement('div');
  actionIcon.className = 'file-card-action';
  actionIcon.textContent = '⬇️';
  card.appendChild(actionIcon);

  card.onclick = async () => {
    if (card.classList.contains('busy')) return;
    card.classList.add('busy');
    actionIcon.textContent = '⏳';
    try {
      await deliverFile(filename, dataBase64, mimeType);
      actionIcon.textContent = '✓';
      setTimeout(() => { actionIcon.textContent = '⬇️'; }, 1500);
    } catch (e) {
      actionIcon.textContent = '⬇️';
      addMessage('error', `Couldn't open ${filename}: ${e.message || e}`);
    } finally {
      card.classList.remove('busy');
    }
  };

  div.appendChild(card);
  $('messages').appendChild(div);
  $('messages').scrollTop = $('messages').scrollHeight;
  return div;
}

async function executeAgentAction(name, args) {
  // Not a phone action — doesn't need the native AureonActions plugin, so
  // it's handled before that check and works in the browser preview too.
  if (name === 'create_zip') return await createZipAndDeliver(args);

  const AureonActions = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AureonActions;
  if (!AureonActions) {
    throw new Error('Phone actions only work in the installed app, not in a browser preview.');
  }
  switch (name) {
    case 'get_battery': return await AureonActions.getBattery();
    case 'open_app': return await AureonActions.openApp(args);
    case 'open_love_camera': return await AureonActions.openLoveCamera(args);
    case 'make_call': return await AureonActions.makeCall(args);
    case 'send_sms': return await AureonActions.sendSms(args);
    case 'set_alarm': return await AureonActions.setAlarm(args);
    case 'search_web': return await AureonActions.searchWeb(args);
    case 'open_url': return await AureonActions.openUrl(args);
    case 'play_music': return await AureonActions.playMusic(args);
    case 'play_youtube': return await AureonActions.playYoutube(args);
    case 'compose_email': return await AureonActions.composeEmail(args);
    case 'send_whatsapp_message': return await AureonActions.sendWhatsappMessage(args);
    case 'send_instagram_message': return await AureonActions.sendInstagramMessage(args);
    case 'read_instagram_message': return await AureonActions.readInstagramMessage(args);
    case 'send_whatsapp_live_location': return await AureonActions.sendWhatsappLiveLocation(args);
    default: throw new Error(`Unknown action: ${name}`);
  }
}

function describeAgentAction(name, args, result) {
  switch (name) {
    case 'get_battery': return `🔋 Battery: ${result.level}%${result.charging ? ' (charging)' : ''}`;
    case 'open_app': return `📱 Opened ${result.opened || args.app_name}`;
    case 'open_love_camera': return `📷 Opened Love Camera`;
    case 'make_call': return `📞 Calling ${args.number}…`;
    case 'send_sms': return `✉️ Sent to ${args.number}`;
    case 'set_alarm': return `⏰ Alarm set for ${result.alarmSet || `${args.hour}:${args.minute}`}`;
    case 'search_web': return `🔎 Searching: ${args.query}`;
    case 'open_url': return `🔗 Opened ${result.opened || args.url}`;
    case 'play_music': return `🎵 Playing: ${args.query}`;
    case 'play_youtube': return `▶️ Playing on YouTube: ${args.query}`;
    case 'compose_email': return `📧 Opened email draft: "${args.subject}"`;
    case 'send_whatsapp_message': return `💬 Opened WhatsApp to ${args.contact_name || args.number} — tap Send to deliver it`;
    case 'send_instagram_message': return `📩 Sent Instagram DM to ${args.contact_name}`;
    case 'read_instagram_message': return `📖 Checked Instagram chat with ${args.contact_name}`;
    case 'send_whatsapp_live_location': return `📍 Shared live location with ${args.contact_name} via WhatsApp`;
    case 'create_zip': return `🗜️ Zip ban gayi: ${result.zipped} (${result.fileCount} file${result.fileCount === 1 ? '' : 's'})`;
    default: return '✅ Done';
  }
}

// ---------- Personality + Memory ----------
const BASE_PERSONALITY = `You are Aureon, a friendly and casual AI assistant — talk like a helpful friend, not a formal machine. Keep responses warm, natural, and conversational (like ChatGPT's tone), never stiff or robotic. Match the user's language style — if they write in Hinglish or Hindi, respond that way naturally. Keep it concise unless they ask for detail.`;

const AGENT_CAPABILITIES = `You can also directly control the user's phone using tools: check battery, open an app, make a call, send an SMS, set an alarm, search the web, open a URL, play music, play a specific video on YouTube directly, compose an email draft, open a pre-filled WhatsApp message (by number or by saved contact name), send an Instagram DM to a contact by name, read back the latest visible message in an Instagram chat, share live location with a contact via WhatsApp, or open the Love Camera — a live camera mode that reads a question visible on screen/paper and shows the answer in a live overlay panel, updating automatically as the visible question changes. When the user asks you to do one of these things — in any language, e.g. "battery kitni hai", "WhatsApp khol do", "gaana bajao", "email likho", "isko WhatsApp pe bhejo", "Instagram mein Pavan ko message karo", "Pavan ka last message kya hai", "Pavan ko live location bhejo" — call the matching tool instead of just explaining how. For calls, SMS, Instagram DMs, and live location the app always asks the user to confirm the exact action before it actually happens, so go ahead and call the tool for those too — don't ask the user to confirm yourself in chat, the app's own confirm dialog already handles that. compose_email and send_whatsapp_message only open a pre-filled draft — they never send automatically, the user still taps Send. Anything using Accessibility (send_instagram_message, read_instagram_message, send_whatsapp_live_location) needs Aureon's Accessibility Service turned on (Settings inside the app will prompt for this) — if it fails because that's off, tell the user to enable it. send_whatsapp_live_location is experimental and may fail partway on some WhatsApp versions — if so, tell the user which step failed. Separately (not a tool call): whenever the user's message contains the word "pdf" in any form (e.g. "PDF bana do", "save as pdf", "pdf chahiye"), the app automatically shows a "Save as PDF" button right under your reply — so just answer their actual question/request normally, then briefly mention the button will appear below (e.g. "Neeche 'Save as PDF' button se save kar lena"). Never say you can't create or download a PDF, and never give manual copy-paste-to-Notes-app workarounds — that button already does it. REMEMBERING: whenever the user asks you to remember, note down, or remind them of something later — e.g. "yaad rakhna", "note kar lo", "kal doodh lana hai yaad rakhna", "remind me to..." — you MUST call the save_reminder tool with what to remember; never just say you will remember it, because without the tool call nothing is actually saved. Whenever the user asks what they forgot or wants to be reminded — e.g. "kuch bhul raha hu", "yaad dila do", "kya yaad rakhna tha", "koi reminder hai kya" — call recall_reminders and read back what it returns naturally (or say plainly that nothing is saved). For lasting facts about the user themselves (name, family, preferences, habits) call update_memory. Only tell the user you saved or remembered something after the tool call actually succeeded. FILES/ZIP: whenever the user asks for multiple pieces of content bundled together to download — "zip bana do", "ek zip mein de do", "sab files ek saath do", or similar — call the create_zip tool with each file's actual full content (not a description of it); the app handles the actual packaging and download/share prompt once you call it. Don't use this for a single plain-text answer. CODING REQUESTS: when the user asks you to write code — "code likho", "app banao", "script banado", "ye feature add karo", etc. — use the SAME judgement a real coding assistant would about file count, not a fixed rule: a single short script/function/snippet (one file, reads fine in a chat code block) stays as a normal reply with a code block, no zip. The moment it's genuinely more than one file (e.g. separate HTML/CSS/JS, a multi-file project, several related scripts, config + code together), proactively call create_zip yourself with each real file and its full content — don't just paste multiple files as text in the chat and don't ask the user whether they want a zip first, since there's no good reason not to hand them real files once there's more than one. Still explain what you built in your normal reply alongside the tool call. JOB APPLICATIONS: when the user asks you to help apply for a job, find jobs, or prep an application, combine the existing tools — there is no separate "apply" tool, and you must NEVER attempt to log into LinkedIn/Indeed/Naukri/etc. or submit an application form on the user's behalf; that's not something this app does, for their own account-safety (most job sites ban automated applications) and because the final submit should always be a deliberate human action. Instead: (1) to find or open listings, use search_web and/or open_url — get them to the actual job page, then stop there, the user browses and decides from the opened page themselves; (2) if they want a resume/cover letter tailored to a specific job description, call create_zip with the tailored resume and cover letter as separate files (resume.txt or similar, cover-letter.txt) — write genuinely tailored content using whatever you know about the user (ask for their background/skills first if you don't have enough to work with, don't invent fake experience or qualifications); (3) if the application method is by email, use compose_email with a well-written application email body — like every compose_email call, this only opens a draft, the user reviews and taps Send themselves, never implying you sent it for them. Be explicit with the user that you can prep everything up to the final submit/send, which stays their own action.
IMPORTANT: never write out a fake tool call as plain text (e.g. never type something like "callingtool_open_url{...}" in your reply) — only use the real function-calling mechanism to call a tool. If you can't call a tool for some reason, just say so in plain words instead of describing a pretend call.`;

// BUG FIX: this used to read ONLY localStorage['aureon_memory'], which is
// just a local cache of whatever was last typed into Settings by hand. The
// update_memory tool (triggered mid-conversation — "yaad rakhna ki...")
// saves straight to the backend (Firestore), but nothing ever re-fetched
// that back into this local cache — so a fact remembered in one chat was
// invisible to every OTHER chat (and to voice/Love Camera) until the user
// happened to open Settings, which was the only place that ever synced it.
// Fix: always pull the latest from the backend first — see getFreshMemory.
async function buildSystemPrompt() {
  const memory = await getFreshMemory();
  const agentOn = $('toggle-agent') ? $('toggle-agent').checked : true;
  let prompt = agentOn ? `${BASE_PERSONALITY}\n\n${AGENT_CAPABILITIES}` : BASE_PERSONALITY;
  if (memory.trim()) {
    prompt += `\n\nThings to remember about this user (stated by them):\n${memory.trim()}`;
  }
  return prompt;
}

// Memory can change from ANYWHERE — this chat, a different chat, voice, or
// Love Camera (all via the same update_memory tool, saved server-side).
// Pulling it fresh before every message means something remembered in one
// chat shows up immediately in every other chat too. Falls back to the
// last-known value cached in localStorage if the fetch fails (e.g.
// offline, or logged out) so memory still works, just possibly one
// message stale in that case instead of breaking entirely.
async function getFreshMemory() {
  try {
    if (!state.backendUrl || !state.user) {
      return localStorage.getItem('aureon_memory') || '';
    }
    const res = await fetch(`${state.backendUrl.replace(/\/$/, '')}/api/memory`, {
      headers: await authHeaders(),
    });
    if (!res.ok) throw new Error(`memory fetch returned ${res.status}`);
    const data = await res.json();
    const text = data.text || '';
    localStorage.setItem('aureon_memory', text);
    if ($('memory-input')) $('memory-input').value = text;
    return text;
  } catch (e) {
    return localStorage.getItem('aureon_memory') || '';
  }
}

// ---------- Recent chats (local only, MVP) ----------
function saveChatSnapshot() {
  if (state.currentMessages.length === 0) return;
  const existingIdx = state.chats.findIndex(c => c.id === state.activeChatId);
  // An existing chat keeps its title (so a manual rename sticks); only a
  // brand-new chat gets one derived from its first message.
  const title = (existingIdx >= 0 && state.chats[existingIdx].title)
    ? state.chats[existingIdx].title
    : state.currentMessages[0].content.slice(0, 40);
  const snapshot = { id: state.activeChatId || `${Date.now()}`, title, messages: state.currentMessages };
  state.activeChatId = snapshot.id;
  if (existingIdx >= 0) state.chats[existingIdx] = snapshot;
  else state.chats.unshift(snapshot);
  state.chats = state.chats.slice(0, 30);
  localStorage.setItem('aureon_chats', JSON.stringify(state.chats));
  saveChatToCloud(snapshot);
}

// Small floating menu next to a chat's ⋮ button. Fixed-positioned on
// <body> (not inside the list) so the drawer list's own scrolling can't
// clip it.
function openChatMenu(chat, anchorBtn) {
  closeChatMenu();
  const backdrop = document.createElement('div');
  backdrop.id = 'chat-menu-backdrop';
  backdrop.className = 'chat-menu-backdrop';
  backdrop.onclick = closeChatMenu;

  const menu = document.createElement('div');
  menu.id = 'chat-menu';
  menu.className = 'chat-menu';

  const renameBtn = document.createElement('button');
  renameBtn.textContent = '✏️ Rename';
  renameBtn.onclick = () => { closeChatMenu(); renameChat(chat); };
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'danger';
  deleteBtn.textContent = '🗑 Delete';
  deleteBtn.onclick = () => { closeChatMenu(); deleteChat(chat); };
  menu.appendChild(renameBtn);
  menu.appendChild(deleteBtn);

  document.body.appendChild(backdrop);
  document.body.appendChild(menu);

  const rect = anchorBtn.getBoundingClientRect();
  const menuWidth = 170;
  menu.style.width = menuWidth + 'px';
  menu.style.left = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)) + 'px';
  // Open downward, unless there's no room below — then flip upward.
  const menuHeight = 96;
  const opensUp = rect.bottom + menuHeight + 8 > window.innerHeight;
  menu.style.top = (opensUp ? rect.top - menuHeight : rect.bottom + 4) + 'px';
}

function closeChatMenu() {
  const b = document.getElementById('chat-menu-backdrop');
  const m = document.getElementById('chat-menu');
  if (b) b.remove();
  if (m) m.remove();
}

async function renameChat(chat) {
  const input = prompt('Rename chat', chat.title || '');
  if (input === null) return; // cancelled
  const newTitle = input.trim().slice(0, 60);
  if (!newTitle || newTitle === chat.title) return;

  chat.title = newTitle;
  localStorage.setItem('aureon_chats', JSON.stringify(state.chats));
  if (chat.id === state.activeChatId) $('chat-title-text').textContent = newTitle;
  renderRecent();

  if (state.user) {
    try {
      await db.collection('users').doc(state.user.uid).collection('chats').doc(chat.id).update({ title: newTitle });
    } catch (err) {
      console.error('Failed to sync chat rename to cloud:', err);
    }
  }
}

async function deleteChat(chat) {
  if (!confirm('Delete this chat? This can\'t be undone.')) return;

  state.chats = state.chats.filter(c => c.id !== chat.id);
  localStorage.setItem('aureon_chats', JSON.stringify(state.chats));

  // If it's the chat currently open, reset to a blank one — otherwise the
  // next message would silently re-create the chat we just deleted.
  if (chat.id === state.activeChatId) {
    state.activeChatId = null;
    state.currentMessages = [];
    $('messages').innerHTML = '';
    $('chat-title-text').textContent = 'New chat';
  }
  renderRecent();

  if (state.user) {
    try {
      await db.collection('users').doc(state.user.uid).collection('chats').doc(chat.id).delete();
    } catch (err) {
      console.error('Failed to delete chat from cloud:', err);
    }
  }
}

function renderRecent() {
  const list = $('drawer-recent-list');
  if (state.chats.length === 0) {
    list.innerHTML = '<div class="empty-hint">No chats yet — start one below.</div>';
    return;
  }
  list.innerHTML = '';
  state.chats.forEach(chat => {
    const item = document.createElement('div');
    item.className = 'recent-item';
    const titleEl = document.createElement('span');
    titleEl.className = 'recent-title';
    titleEl.textContent = chat.title;
    item.appendChild(titleEl);
    const menuBtn = document.createElement('button');
    menuBtn.className = 'recent-menu-btn';
    menuBtn.setAttribute('aria-label', 'Chat options');
    menuBtn.textContent = '⋮';
    menuBtn.onclick = (ev) => {
      ev.stopPropagation(); // don't also open the chat
      openChatMenu(chat, menuBtn);
    };
    item.appendChild(menuBtn);
    item.onclick = () => {
      try {
        closeDrawer();
        const messages = Array.isArray(chat.messages) ? chat.messages : [];
        state.currentMessages = messages;
        state.activeChatId = chat.id;
        $('messages').innerHTML = '';
        messages
          .filter(m => m && m.content) // skip internal agent turns (functionCall/functionResponse have no content)
          .forEach(m => addMessage(m.role === 'user' ? 'user' : 'ai', m.content));
        $('chat-title-text').textContent = chat.title || 'Chat';
        showScreen('screen-chat');
      } catch (err) {
        console.error('Failed to open chat from history:', err);
        addMessage && showScreen('screen-home');
        alert('Could not open that chat — it may be corrupted. Try another one.');
      }
    };
    list.appendChild(item);
  });
}

// ---------- Settings ----------
$('btn-save-settings').onclick = () => {
  localStorage.setItem('aureon_memory', $('memory-input').value);
  closeSheet('sheet-settings');
};

$('btn-enable-voice-keyboard')?.addEventListener('click', async () => {
  const AureonActions = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AureonActions;
  if (!AureonActions) {
    alert('This only works in the installed app, not in a browser preview.');
    return;
  }
  await AureonActions.openKeyboardSettings();
});

$('btn-logout').onclick = () => {
  auth.signOut();
  closeSheet('sheet-settings');
};

// ---------- Auth: helpers ----------
function showAuthError(elId, message) {
  const el = $(elId);
  el.textContent = message;
  el.classList.remove('hidden');
}
function clearAuthError(elId) {
  $(elId).classList.add('hidden');
  $(elId).textContent = '';
}
function friendlyAuthError(err) {
  const map = {
    'auth/email-already-in-use': 'That email is already registered. Try logging in.',
    'auth/invalid-email': 'Please enter a valid email address.',
    'auth/weak-password': 'Password should be at least 6 characters.',
    'auth/user-not-found': 'No account found with that email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/too-many-requests': 'Too many attempts. Please wait and try again.'
  };
  return map[err.code] || err.message || 'Something went wrong.';
}

// ---------- Auth: navigation links ----------
$('btn-goto-signup').onclick = () => { clearAuthError('login-error'); showScreen('screen-signup'); };
$('btn-goto-login').onclick = () => { clearAuthError('signup-error'); showScreen('screen-login'); };
$('btn-goto-login-2').onclick = () => { showScreen('screen-login'); };
$('btn-goto-forgot').onclick = () => { showScreen('screen-forgot'); };

// ---------- Auth: sign up ----------
$('btn-signup').onclick = async () => {
  clearAuthError('signup-error');
  const email = $('signup-email').value.trim();
  const password = $('signup-password').value;
  if (!email || !password) { showAuthError('signup-error', 'Please fill in both fields.'); return; }
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await cred.user.sendEmailVerification();
    $('verify-email-addr').textContent = email;
    showScreen('screen-verify');
  } catch (err) {
    showAuthError('signup-error', friendlyAuthError(err));
  }
};

// ---------- Auth: log in ----------
$('btn-login').onclick = async () => {
  clearAuthError('login-error');
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  if (!email || !password) { showAuthError('login-error', 'Please fill in both fields.'); return; }
  try {
    await auth.signInWithEmailAndPassword(email, password);
    // onAuthStateChanged below handles routing to home/verify.
  } catch (err) {
    showAuthError('login-error', friendlyAuthError(err));
  }
};

// ---------- Auth: verify email screen ----------
$('btn-ive-verified').onclick = async () => {
  await auth.currentUser.reload();
  if (auth.currentUser.emailVerified) {
    enterApp(auth.currentUser);
  } else {
    alert('Still not verified. Check your inbox (and spam folder), then try again.');
  }
};
$('btn-resend-verify').onclick = async () => {
  try {
    await auth.currentUser.sendEmailVerification();
    alert('Verification email sent again.');
  } catch (err) {
    alert(friendlyAuthError(err));
  }
};
$('btn-verify-logout').onclick = () => auth.signOut();

// ---------- Auth: forgot password ----------
$('btn-send-reset').onclick = async () => {
  clearAuthError('forgot-error');
  const email = $('forgot-email').value.trim();
  if (!email) { showAuthError('forgot-error', 'Please enter your email.'); return; }
  try {
    await auth.sendPasswordResetEmail(email);
    alert('Reset link sent — check your inbox.');
    showScreen('screen-login');
  } catch (err) {
    showAuthError('forgot-error', friendlyAuthError(err));
  }
};

// ---------- Auth: state routing ----------
function enterApp(user) {
  state.user = user;
  $('account-email-display').textContent = user.email;
  loadChatsFromCloud();
  showScreen('screen-home');
  const actions = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AureonActions;
  if (actions && actions.setUserId) actions.setUserId({ uid: user.uid });
  // Voice has no live Firebase session of its own — this lets it mint its
  // own short-lived ID tokens for backend calls (see AureonAgentActions.
  // getFreshIdToken) without needing the app reopened every hour.
  if (actions && actions.setRefreshToken && user.refreshToken) {
    actions.setRefreshToken({ refreshToken: user.refreshToken });
  }
}

auth.onAuthStateChanged((user) => {
  // Wait for splash to finish its own timing; it calls this again after.
  if (!state.splashDone) { state.pendingUser = user; return; }
  routeForUser(user);
});

function routeForUser(user) {
  if (user && user.emailVerified) {
    enterApp(user);
  } else if (user && !user.emailVerified) {
    $('verify-email-addr').textContent = user.email;
    showScreen('screen-verify');
  } else {
    state.user = null;
    showScreen('screen-login');
    const actions = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AureonActions;
    if (actions && actions.setUserId) actions.setUserId({ uid: '' });
    if (actions && actions.setRefreshToken) actions.setRefreshToken({ refreshToken: '' });
  }
}

// ---------- Firestore: cloud chat sync ----------
async function loadChatsFromCloud() {
  if (!state.user) return;
  try {
    const snap = await db.collection('users').doc(state.user.uid).collection('chats').orderBy('updatedAt', 'desc').limit(30).get();
    state.chats = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    localStorage.setItem('aureon_chats', JSON.stringify(state.chats));
    renderRecent();
  } catch (err) {
    console.error('Failed to load chats from cloud:', err);
    renderRecent(); // fall back to whatever's cached locally
  }
}

async function saveChatToCloud(snapshot) {
  if (!state.user) return;
  try {
    await db.collection('users').doc(state.user.uid).collection('chats').doc(snapshot.id).set({
      title: snapshot.title,
      messages: snapshot.messages,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.error('Failed to save chat to cloud:', err);
  }
}

// ---------- Voice input (Web Speech API — works in most Android WebViews with mic permission) ----------
function wireMic(btnId, targetInputId) {
  $(btnId).onclick = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('Voice input not supported on this device/browser.'); return; }
    const rec = new SR();
    rec.lang = 'en-IN'; // auto language system: swap based on Settings later
    rec.onresult = (e) => { $(targetInputId).value = e.results[0][0].transcript; };
    rec.start();
  };
}
wireMic('btn-mic', 'home-input');
wireMic('btn-mic-2', 'chat-input');

// ---------- Splash / starting animation ----------
function runSplash() {
  const splash = $('screen-splash');
  const brand = 'Aureon';
  const wordmark = $('splash-wordmark');
  wordmark.innerHTML = '';
  brand.split('').forEach((ch, i) => {
    const span = document.createElement('span');
    span.className = 'ltr';
    span.textContent = ch;
    span.style.animationDelay = `${0.9 + i * 0.09}s`;
    wordmark.appendChild(span);
  });
  // CSS handles the glow/flare/fade timing; JS just swaps the active screen
  // once the splash has had its moment (matches the 3.2s CSS fade-out delay).
  setTimeout(() => {
    splash.classList.remove('active');
    state.splashDone = true;
    routeForUser(state.pendingUser || auth.currentUser);
  }, 3300);
}

// ---------- Init ----------
$('model-pill').textContent = MODEL_LABELS[state.model];
if ($('memory-input')) $('memory-input').value = localStorage.getItem('aureon_memory') || '';
renderRecent();
runSplash();

// ---------- Knowledge Base (Phase 5 — RAG) ----------
$('btn-drawer-knowledge').onclick = () => {
  closeDrawer();
  openSheet('sheet-knowledge');
  loadKnowledgeList();
};

$('btn-upload-knowledge').onclick = () => $('knowledge-file-input').click();

$('knowledge-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!state.user) { alert('Please log in first.'); return; }

  const statusEl = $('knowledge-upload-status');
  statusEl.classList.remove('hidden');
  statusEl.textContent = `Reading "${file.name}"...`;

  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = reader.result.split(',')[1];
    statusEl.textContent = `Uploading "${file.name}"... this can take a moment.`;
    try {
      const res = await fetch(`${state.backendUrl.replace(/\/$/, '')}/api/knowledge/upload`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          filename: file.name,
          mimeType: file.type,
          dataBase64: base64
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      statusEl.textContent = `✓ "${file.name}" added (${data.chunkCount} sections indexed).`;
      loadKnowledgeList();
    } catch (err) {
      statusEl.textContent = `Couldn't upload: ${err.message}`;
    }
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

async function loadKnowledgeList() {
  const list = $('knowledge-list');
  if (!state.user) {
    list.innerHTML = '<div class="empty-hint">Log in to manage your documents.</div>';
    return;
  }
  list.innerHTML = '<div class="empty-hint">Loading...</div>';
  try {
    const res = await fetch(`${state.backendUrl.replace(/\/$/, '')}/api/knowledge/list`, { headers: await authHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load documents');
    if (!data.files || data.files.length === 0) {
      list.innerHTML = '<div class="empty-hint">No documents yet.</div>';
      return;
    }
    list.innerHTML = '';
    data.files.forEach(file => {
      const item = document.createElement('div');
      item.className = 'recent-item knowledge-item';
      item.innerHTML = `<span>${file.filename}</span><button class="knowledge-delete-btn" data-id="${file.id}">✕</button>`;
      item.querySelector('.knowledge-delete-btn').onclick = async (ev) => {
        ev.stopPropagation();
        if (!confirm(`Remove "${file.filename}"?`)) return;
        await fetch(`${state.backendUrl.replace(/\/$/, '')}/api/knowledge/${file.id}`, { method: 'DELETE', headers: await authHeaders() });
        loadKnowledgeList();
      };
      list.appendChild(item);
    });
  } catch (err) {
    list.innerHTML = `<div class="empty-hint">Error: ${err.message}</div>`;
  }
}
