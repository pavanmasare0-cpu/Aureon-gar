// backend/attach.js — turns what the owner drops into Ava Lab (a ZIP of a project and/or photos / screenshots) into a compact text "context"
// Ava can build from. Nothing is written to disk or executed: the ZIP is only READ in memory (size/entry caps = zip-bomb safe, no extraction paths).
const zlib = require('zlib');

const MAX_ZIP = 25 * 1024 * 1024, MAX_IMG = 6 * 1024 * 1024, MAX_IMAGES = 4, MAX_ENTRIES = 6000, MAX_UNPACKED = 80 * 1024 * 1024, MAX_READ_FILE = 200 * 1024;
const CONTEXT_CHARS = 26000, PER_FILE = 3200;
const TEXT_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|json|md|txt|html|htm|css|scss|py|java|kt|kts|go|rs|c|cc|cpp|h|hpp|cs|rb|php|sh|yml|yaml|toml|xml|sql|gradle|properties|swift|dart|vue|svelte|ini|cfg|env\.example)$/i;
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|\.next|__pycache__|\.gradle|\.idea|\.vscode|vendor|coverage|target|android\/app\/build|ios\/Pods)(\/|$)/;
const PRIORITY = [/(^|\/)readme(\.md|\.txt)?$/i, /(^|\/)package\.json$/, /(^|\/)(manifest|AndroidManifest)\.(json|xml)$/, /(^|\/)(index|main|app|server)\.(js|ts|py|html|jsx|tsx)$/i, /(^|\/)(pubspec\.yaml|requirements\.txt|pom\.xml|build\.gradle|go\.mod|Cargo\.toml)$/i, /(^|\/)(src|lib|app|routes|api)\//];

function isImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  return null;
}
/** Reads the central directory of a ZIP buffer. Returns [{name, method, csize, usize, off}] */
function zipEntries(buf) {
  let e = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('ye valid ZIP nahi lagti');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = []; let total = 0;
  if (n > MAX_ENTRIES) throw new Error('ZIP me bahut zyada files (' + n + ' > ' + MAX_ENTRIES + ')');
  for (let i = 0; i < n && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString('utf8').replace(/\\/g, '/');
    total += usize; if (total > MAX_UNPACKED) throw new Error('ZIP unpack hone par bahut badi (>' + (MAX_UNPACKED >> 20) + 'MB)');
    out.push({ name, method, csize, usize, off }); p += 46 + nl + xl + cl;
  }
  return out;
}
function readEntry(buf, en) {
  const p = en.off; if (buf.readUInt32LE(p) !== 0x04034b50) return null;
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28); const body = buf.slice(start, start + en.csize);
  if (en.method === 0) return body.slice(0, MAX_READ_FILE);
  if (en.method === 8) { try { return zlib.inflateRawSync(body, { maxOutputLength: MAX_READ_FILE }); } catch (e) { try { return zlib.inflateRawSync(body).slice(0, MAX_READ_FILE); } catch (e2) { return null; } } }
  return null;
}
const rank = (name) => { for (let i = 0; i < PRIORITY.length; i++) if (PRIORITY[i].test(name)) return i; return PRIORITY.length; };

/** Summarise a ZIP: file tree + the most important files (truncated). */
function summariseZip(buf, label) {
  const all = zipEntries(buf).filter((x) => x.name && !x.name.endsWith('/') && !/(^|\/)\.\.(\/|$)/.test(x.name) && !x.name.startsWith('/') && !SKIP_DIR.test(x.name) && !/(^|\/)__MACOSX\//.test(x.name));
  const text = all.filter((x) => TEXT_EXT.test(x.name) && x.usize <= 2 * MAX_READ_FILE).sort((a, b) => rank(a.name) - rank(b.name) || a.name.length - b.name.length);
  const tree = all.slice(0, 400).map((x) => x.name + (x.usize ? ' (' + x.usize + 'B)' : '')).join('\n') + (all.length > 400 ? '\n… +' + (all.length - 400) + ' aur files' : '');
  let used = 0; const shown = []; let lines = 0;
  for (const en of text) {
    const b = readEntry(buf, en); if (!b) continue; const s = b.toString('utf8'); lines += s.split('\n').length;
    if (used < CONTEXT_CHARS && shown.length < 40) { const piece = s.length > PER_FILE ? s.slice(0, PER_FILE) + '\n… (truncated)' : s; used += piece.length; shown.push('### ' + en.name + '\n' + piece); }
  }
  return { files: all.length, textFiles: text.length, lines, text: '--- ZIP "' + label + '": ' + all.length + ' files, ~' + lines + ' text lines ---\nFILE TREE:\n' + tree + '\n\nKEY FILES:\n' + shown.join('\n\n') };
}

const IMG_PROMPT = 'You are helping a software engineer who must rebuild / build from this image. First say what it is (app screenshot, UI mockup, hand-drawn sketch, diagram, whiteboard, document, photo). Then describe it precisely and completely: layout and sections, every visible component and its text, colours (hex guesses), typography, spacing, icons, states, navigation and likely interactions / data flow; for diagrams list entities and relationships; for documents transcribe the important text. End with a bullet list "IMPLIED REQUIREMENTS". Plain text, max 3500 characters, no preamble.';

/**
 * attachments: [{name, mime?, b64}]; llm = require('./llm-text')
 * -> { context, notes[], images, zips, ok }
 */
async function parseAttachments(list, llm) {
  const notes = []; const ctx = []; let images = 0, zips = 0; const imgs = [];
  for (const a of (Array.isArray(list) ? list : []).slice(0, 8)) {
    const name = String((a && a.name) || 'file').replace(/[^\w.\- ]/g, '_').slice(0, 80);
    let buf; try { buf = Buffer.from(String((a && (a.b64 || a.data)) || '').replace(/^data:[^,]*,/, ''), 'base64'); } catch (e) { buf = null; }
    if (!buf || !buf.length) { notes.push(name + ': khaali file'); continue; }
    if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50 || (buf.length > 22 && /\.zip$/i.test(name))) {
      if (buf.length > MAX_ZIP) { notes.push(name + ': ZIP ' + (MAX_ZIP >> 20) + 'MB se badi hai'); continue; }
      try { const z = summariseZip(buf, name); zips++; ctx.push(z.text); notes.push('ZIP padhi: ' + name + ' (' + z.files + ' files, ~' + z.lines + ' lines)'); } catch (e) { notes.push(name + ': ' + e.message); }
      continue;
    }
    const mime = isImage(buf);
    if (mime) {
      if (buf.length > MAX_IMG) { notes.push(name + ': photo ' + (MAX_IMG >> 20) + 'MB se badi hai'); continue; }
      if (imgs.length < MAX_IMAGES) imgs.push({ name, mime, b64: buf.toString('base64') });
      continue;
    }
    if (TEXT_EXT.test(name) && buf.length <= 400 * 1024) { ctx.push('--- FILE "' + name + '" ---\n' + buf.toString('utf8').slice(0, 9000)); notes.push('File padhi: ' + name); continue; }
    notes.push(name + ': ye type support nahi (ZIP, photo ya text/code file do)');
  }
  if (imgs.length) {
    try {
      const d = await llm.vision(IMG_PROMPT + '\nImages attached: ' + imgs.map((i) => i.name).join(', '), imgs, { maxTokens: 5000 });
      images = imgs.length; ctx.push('--- PHOTO / SCREENSHOT ANALYSIS (' + imgs.map((i) => i.name).join(', ') + ') ---\n' + String(d).slice(0, 5000)); notes.push('Photo dekhi: ' + images);
    } catch (e) { notes.push('Photo samajh nahi paayi: ' + String(e.message).slice(0, 100)); }
  }
  return { context: ctx.join('\n\n').slice(0, CONTEXT_CHARS + 6000), notes, images, zips, ok: ctx.length > 0 };
}
module.exports = { parseAttachments, summariseZip, zipEntries, readEntry, isImage, MAX_ZIP, MAX_IMG, MAX_IMAGES };
