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

const MODEL_LABELS = { openai: 'Fast', claude: 'Smart', gemini: 'Research', local: 'Private' };

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
function openDrawer() { $('drawer').classList.remove('hidden'); }
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
    div.textContent = text;
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

async function callBackend(messages, model, tools) {
  if (!state.backendUrl) {
    throw new Error('No backend URL configured.');
  }
  const res = await fetch(`${state.backendUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      model,
      tools: !!tools,
      systemPrompt: buildSystemPrompt(),
      uid: state.user ? state.user.uid : null,
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
      addMessage('ai', describeAgentAction(name, args, actionResult));
    } catch (err) {
      actionResult = { error: err.message || String(err) };
      addMessage('error', `Couldn't ${name.replace(/_/g, ' ')}: ${actionResult.error}`);
    }

    state.currentMessages.push({ role: 'assistant', functionCall: result.functionCall, thoughtSignature: result.thoughtSignature });
    state.currentMessages.push({ role: 'function', functionResponse: { name, response: { result: actionResult } } });
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

async function executeAgentAction(name, args) {
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
    default: return '✅ Done';
  }
}

// ---------- Personality + Memory ----------
const BASE_PERSONALITY = `You are Aureon, a friendly and casual AI assistant — talk like a helpful friend, not a formal machine. Keep responses warm, natural, and conversational (like ChatGPT's tone), never stiff or robotic. Match the user's language style — if they write in Hinglish or Hindi, respond that way naturally. Keep it concise unless they ask for detail.`;

const AGENT_CAPABILITIES = `You can also directly control the user's phone using tools: check battery, open an app, make a call, send an SMS, set an alarm, search the web, open a URL, play music, play a specific video on YouTube directly, compose an email draft, open a pre-filled WhatsApp message (by number or by saved contact name), send an Instagram DM to a contact by name, read back the latest visible message in an Instagram chat, share live location with a contact via WhatsApp, or open the Love Camera — a live camera mode that reads a question visible on screen/paper and shows the answer in a live overlay panel, updating automatically as the visible question changes. When the user asks you to do one of these things — in any language, e.g. "battery kitni hai", "WhatsApp khol do", "gaana bajao", "email likho", "isko WhatsApp pe bhejo", "Instagram mein Pavan ko message karo", "Pavan ka last message kya hai", "Pavan ko live location bhejo" — call the matching tool instead of just explaining how. For calls, SMS, Instagram DMs, and live location the app always asks the user to confirm the exact action before it actually happens, so go ahead and call the tool for those too — don't ask the user to confirm yourself in chat, the app's own confirm dialog already handles that. compose_email and send_whatsapp_message only open a pre-filled draft — they never send automatically, the user still taps Send. Anything using Accessibility (send_instagram_message, read_instagram_message, send_whatsapp_live_location) needs Aureon's Accessibility Service turned on (Settings inside the app will prompt for this) — if it fails because that's off, tell the user to enable it. send_whatsapp_live_location is experimental and may fail partway on some WhatsApp versions — if so, tell the user which step failed. Separately (not a tool call): whenever the user's message contains the word "pdf" in any form (e.g. "PDF bana do", "save as pdf", "pdf chahiye"), the app automatically shows a "Save as PDF" button right under your reply — so just answer their actual question/request normally, then briefly mention the button will appear below (e.g. "Neeche 'Save as PDF' button se save kar lena"). Never say you can't create or download a PDF, and never give manual copy-paste-to-Notes-app workarounds — that button already does it. IMPORTANT: never write out a fake tool call as plain text (e.g. never type something like "callingtool_open_url{...}" in your reply) — only use the real function-calling mechanism to call a tool. If you can't call a tool for some reason, just say so in plain words instead of describing a pretend call.`;

function buildSystemPrompt() {
  const memory = localStorage.getItem('aureon_memory') || '';
  const agentOn = $('toggle-agent') ? $('toggle-agent').checked : true;
  let prompt = agentOn ? `${BASE_PERSONALITY}\n\n${AGENT_CAPABILITIES}` : BASE_PERSONALITY;
  if (memory.trim()) {
    prompt += `\n\nThings to remember about this user (stated by them):\n${memory.trim()}`;
  }
  return prompt;
}

// ---------- Recent chats (local only, MVP) ----------
function saveChatSnapshot() {
  if (state.currentMessages.length === 0) return;
  const title = state.currentMessages[0].content.slice(0, 40);
  const existingIdx = state.chats.findIndex(c => c.id === state.activeChatId);
  const snapshot = { id: state.activeChatId || `${Date.now()}`, title, messages: state.currentMessages };
  state.activeChatId = snapshot.id;
  if (existingIdx >= 0) state.chats[existingIdx] = snapshot;
  else state.chats.unshift(snapshot);
  state.chats = state.chats.slice(0, 30);
  localStorage.setItem('aureon_chats', JSON.stringify(state.chats));
  saveChatToCloud(snapshot);
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
    item.textContent = chat.title;
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: state.user.uid,
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
    const res = await fetch(`${state.backendUrl.replace(/\/$/, '')}/api/knowledge/list?uid=${state.user.uid}`);
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
        await fetch(`${state.backendUrl.replace(/\/$/, '')}/api/knowledge/${file.id}?uid=${state.user.uid}`, { method: 'DELETE' });
        loadKnowledgeList();
      };
      list.appendChild(item);
    });
  } catch (err) {
    list.innerHTML = `<div class="empty-hint">Error: ${err.message}</div>`;
  }
}
