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

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  $('messages').appendChild(div);
  $('messages').scrollTop = $('messages').scrollHeight;
  return div;
}

async function sendMessage() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  if ($('chat-title-text').textContent === 'New chat') {
    $('chat-title-text').textContent = text.slice(0, 28) + (text.length > 28 ? '…' : '');
  }

  addMessage('user', text);
  state.currentMessages.push({ role: 'user', content: text });
  saveChatSnapshot();

  $('typing-indicator').classList.remove('hidden');

  try {
    const reply = await callBackend(state.currentMessages, state.model);
    $('typing-indicator').classList.add('hidden');
    addMessage('ai', reply);
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
    body: JSON.stringify({ messages, model })
  });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  const data = await res.json();
  return data.reply || '(empty response)';
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
renderRecent();
runSplash();
