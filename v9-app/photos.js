// ---------- v9: many photos per message, lean chat storage ----------
// Old chats stored every photo as full base64 inside localStorage / Firestore and re-sent ALL of them with every new
// message — that is what made old chats fail with "Failed to fetch". Now: photos are compressed on pick, only the
// newest photo-message is sent to the AI, and saved chats keep a photo COUNT instead of the pixels.
function slimForStorage(msgs) {
  if (!Array.isArray(msgs)) return [];
  return msgs.map((m) => {
    if (!m || (!m.image && !m.images && !m.thumbs)) return m;
    const { image, images, thumbs, ...rest } = m;
    const n = (images && images.length) || (image ? 1 : 0);
    return n ? { ...rest, imageCount: n } : rest;
  });
}

(function migrateOldChats() {
  try {
    let changed = false;
    state.chats.forEach((c) => {
      if (!c || !Array.isArray(c.messages)) return;
      if (c.messages.some((m) => m && (m.image || m.images || m.thumbs))) { c.messages = slimForStorage(c.messages); changed = true; }
    });
    if (changed) localStorage.setItem('aureon_chats', JSON.stringify(state.chats));
  } catch (e) { /* never block startup */ }
})();

function loadImageForCompress(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('cannot decode ' + (file.name || 'image'))); };
    img.src = url;
  });
}
function drawScaled(img, maxSide, quality) {
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const k = Math.min(1, maxSide / Math.max(w0, h0));
  const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(w0 * k)); cv.height = Math.max(1, Math.round(h0 * k));
  const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', quality);
}
async function prepareImage(file, spec) {
  try {
    const img = await loadImageForCompress(file);
    return { mimeType: 'image/jpeg', data: drawScaled(img, spec.side, spec.q).split(',')[1], thumb: drawScaled(img, 384, 0.6) };
  } catch (e) {
    // could not decode (odd format) — send the original bytes like before
    const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    const [prefix, data] = dataUrl.split(',');
    return { mimeType: (prefix.match(/data:(.*);base64/) || [])[1] || file.type || 'image/jpeg', data, thumb: dataUrl.length < 400000 ? dataUrl : '' };
  }
}

async function handleImagePick(files) {
  state.pendingFileText = null; state.pendingFileName = null;
  if (state.pendingImage && state.pendingImage.mimeType && state.pendingImage.mimeType.startsWith('video/')) state.pendingImage = null;
  if (!Array.isArray(state.pendingImages)) state.pendingImages = [];
  const total = state.pendingImages.length + files.length; // no limit on the count — just smaller files when there are many
  const spec = total <= 10 ? { side: 1600, q: 0.82 } : total <= 30 ? { side: 1280, q: 0.74 } : { side: 1024, q: 0.66 };
  $('image-preview-bar').classList.remove('hidden');
  let n = 0;
  for (const f of files) {
    $('attach-name').textContent = `🗜️ photos tayyar ho rahi hain… ${++n}/${files.length}`;
    try { state.pendingImages.push(await prepareImage(f, spec)); } catch (e) { console.error('photo skipped:', e); }
  }
  state.pendingImage = state.pendingImages[0] || null;
  renderImageStrip();
}

function renderImageStrip() {
  const bar = $('image-preview-bar'); if (!bar) return;
  let strip = $('image-preview-strip');
  if (!strip) { strip = document.createElement('div'); strip.id = 'image-preview-strip'; strip.className = 'image-preview-strip'; bar.insertBefore(strip, bar.firstChild); }
  const imgs = state.pendingImages || [];
  strip.innerHTML = '';
  const card = bar.querySelector('.attach-card'); if (card) card.style.display = imgs.length ? 'none' : '';
  if (imgs.length) { $('image-preview-thumb').classList.add('hidden'); $('file-preview-label').classList.add('hidden'); }
  imgs.forEach((im, i) => {
    const w = document.createElement('div'); w.className = 'strip-item';
    const t = document.createElement('img'); t.src = im.thumb || `data:${im.mimeType};base64,${im.data}`; w.appendChild(t);
    const x = document.createElement('button'); x.type = 'button'; x.className = 'strip-x'; x.textContent = '✕'; x.setAttribute('aria-label', 'Remove photo');
    x.onclick = () => { state.pendingImages.splice(i, 1); state.pendingImage = state.pendingImages[0] || null; if (!state.pendingImages.length) bar.classList.add('hidden'); renderImageStrip(); };
    w.appendChild(x); strip.appendChild(w);
  });
  if (imgs.length) { const more = document.createElement('button'); more.type = 'button'; more.className = 'strip-add'; more.textContent = '＋'; more.setAttribute('aria-label', 'Add more photos'); more.onclick = () => $('image-input').click(); strip.appendChild(more); }
  $('attach-name').textContent = imgs.length ? `📷 ${imgs.length} photo${imgs.length > 1 ? 's' : ''}` : '';
}

function addUserPhotosMessage(text, imgs) {
  const div = document.createElement('div'); div.className = 'msg user msg-photos';
  const shown = imgs.slice(0, 8);
  const grid = document.createElement('div'); grid.className = 'photo-grid n' + Math.min(shown.length, 4);
  shown.forEach((im) => { const i = document.createElement('img'); i.src = im.thumb || `data:${im.mimeType};base64,${im.data}`; grid.appendChild(i); });
  div.appendChild(grid);
  const cap = [text, imgs.length > shown.length ? `+${imgs.length - shown.length} aur photos` : (imgs.length > 1 ? `${imgs.length} photos` : '')].filter(Boolean).join('\n');
  if (cap) { const c = document.createElement('div'); c.className = 'msg-image-caption'; c.textContent = cap; div.appendChild(c); }
  $('messages').appendChild(div); $('messages').scrollTop = $('messages').scrollHeight;
  return div;
}

// What actually goes to the AI: only the NEWEST photo-message keeps its photos; older ones become a one-line note.
function messagesForBackend(messages) {
  let lastImg = -1;
  messages.forEach((m, i) => { if (m && m.role === 'user' && ((m.images && m.images.length) || (m.image && m.image.data))) lastImg = i; });
  const slim = messages.map((m, i) => {
    if (!m || (!m.image && !m.images && !m.thumbs)) return m;
    if (i === lastImg && i >= messages.length - 6) { const { thumbs, ...rest } = m; return rest; } // newest photos stay for ~3 follow-ups, then they are dropped
    const { image, images, thumbs, ...rest } = m;
    const n = (images && images.length) || (image ? 1 : 0);
    return n ? { ...rest, content: (rest.content || '') + `\n[${n} earlier photo${n > 1 ? 's' : ''} left out here to save space]` } : rest;
  });
  return messagesForBackendText(slim);
}
