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
$('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });
$('btn-model-switch').onclick = () => openSheet('sheet-model');

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

function addMessage(role, text, wantsPdf = false) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
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
  } else {
    // PDF / doc / other — we can't extract text client-side yet, but still
    // let the user attach it; they'll see a note that content wasn't read.
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

  $('typing-indicator').classList.remove('hidden');

  const wantsPdf = userAskedForPdf(text);

  try {
    const reply = await callBackend(state.currentMessages, state.model);
    $('typing-indicator').classList.add('hidden');
    addMessage('ai', reply, wantsPdf);
    state.currentMessages.push({ role: 'assistant', content: reply });
    saveChatSnapshot();
  } catch (err) {
    $('typing-indicator').classList.add('hidden');
    addMessage('error', `Couldn't reach the AI backend. ${err.message || ''}\n\nSet your backend URL in Settings (⚙) first.`);
  }
}

async function callBackend(messages, model) {
  if (!state.backendUrl) {
    throw new Error('No backend URL configured.');
  }
  const res = await fetch(`${state.backendUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      model,
      systemPrompt: buildSystemPrompt(),
      uid: state.user ? state.user.uid : null,
      useKnowledge: $('toggle-use-knowledge') ? $('toggle-use-knowledge').checked : false
    })
  });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  const data = await res.json();
  return data.reply || '(empty response)';
}

// ---------- Personality + Memory ----------
const BASE_PERSONALITY = `You are Aureon, a friendly and casual AI assistant — talk like a helpful friend, not a formal machine. Keep responses warm, natural, and conversational (like ChatGPT's tone), never stiff or robotic. Match the user's language style — if they write in Hinglish or Hindi, respond that way naturally. Keep it concise unless they ask for detail.`;

function buildSystemPrompt() {
  const memory = localStorage.getItem('aureon_memory') || '';
  if (memory.trim()) {
    return `${BASE_PERSONALITY}\n\nThings to remember about this user (stated by them):\n${memory.trim()}`;
  }
  return BASE_PERSONALITY;
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
      closeDrawer();
      state.currentMessages = chat.messages;
      state.activeChatId = chat.id;
      $('messages').innerHTML = '';
      chat.messages.forEach(m => addMessage(m.role === 'user' ? 'user' : 'ai', m.content));
      $('chat-title-text').textContent = chat.title;
      showScreen('screen-chat');
    };
    list.appendChild(item);
  });
}

// ---------- Settings ----------
$('btn-save-settings').onclick = () => {
  localStorage.setItem('aureon_memory', $('memory-input').value);
  closeSheet('sheet-settings');
};

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
