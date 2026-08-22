// ===== Aureon AI — frontend logic (MVP) =====
// Talks to your own backend (see /backend). No API keys live in this app.

const state = {
  backendUrl: localStorage.getItem('aureon_backend_url') || '',
  model: localStorage.getItem('aureon_model') || 'openai',
  chats: JSON.parse(localStorage.getItem('aureon_chats') || '[]'),
  currentMessages: []
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
$('btn-settings').onclick = () => openSheet('sheet-settings');
$('btn-send-home').onclick = () => startChatFrom($('home-input').value);
$('home-input').addEventListener('keydown', e => { if (e.key === 'Enter') startChatFrom(e.target.value); });

document.querySelectorAll('.quick-card').forEach(card => {
  card.onclick = () => {
    const prompts = {
      ask: '', file: 'Analyze this file: ', image: 'Analyze this image: ',
      code: 'Help me write code for: ', search: 'Search the web for: ', write: 'Help me write: '
    };
    startChatFrom(prompts[card.dataset.prompt] || '');
  };
});

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
}

function renderRecent() {
  const list = $('recent-list');
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
  state.backendUrl = $('backend-url-input').value.trim();
  localStorage.setItem('aureon_backend_url', state.backendUrl);
  closeSheet('sheet-settings');
};

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
  // CSS handles the glow/fade animation timing; JS just swaps the active screen
  // once the splash has had its moment (matches the 2.4s CSS fade-out delay).
  setTimeout(() => {
    splash.classList.remove('active');
    showScreen('screen-home');
  }, 2500);
}

// ---------- Init ----------
$('model-pill').textContent = MODEL_LABELS[state.model];
$('backend-url-input').value = state.backendUrl;
renderRecent();
runSplash();
