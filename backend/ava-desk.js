// backend/ava-desk.js — Ava Desktop = Ava Lab (v21). The whole desktop UI IS Ava Lab:
// orb (prototypes), variants, live code, upgrades, Ava ki Duniya. Data comes from /api/sentinel/ava/* (backend/ava-self.js).
//
//   GET /api/sentinel/ava-desk           the page (same owner login / stealth lock as the other dashboards)
//   GET /api/sentinel/ava-desk/guard.js  Ava Guard for the page (its CSP only allows scripts from this origin)
const fs = require('fs');
const path = require('path');
const express = require('express');

const PAGE = fs.readFileSync(path.join(__dirname, 'ava-desk.html'), 'utf8');
const GUARD_FILE = path.join(__dirname, 'public', 'ava-guard.js');
const BRAIN_FILE = path.join(__dirname, 'ava-brain.html');   // the 3D brain shown in Ava Lab (iframe), fed with Ava's real memories
const { dataDir } = require('./data-dir');
// three.js r128 (pinned). The dashboard CSP only allows scripts from this origin, so it is fetched once from cdnjs and served from here.
const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
let threeMem = null;
async function getThree() {
  if (threeMem) return threeMem;
  const file = path.join(dataDir('vendor'), 'three-r128.min.js');
  try { const t = fs.readFileSync(file, 'utf8'); if (t.length > 100000 && t.includes('REVISION')) return (threeMem = t); } catch (e) { /* not cached yet */ }
  const r = await fetch(THREE_URL, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('three.js ' + r.status);
  const t = await r.text();
  if (t.length < 100000 || !t.includes('REVISION')) throw new Error('three.js download looks wrong');
  try { fs.writeFileSync(file, t); } catch (e) { /* read-only disk: keep in memory only */ }
  return (threeMem = t);
}
let guard = null;
try { guard = require(GUARD_FILE); } catch (e) { guard = null; }

module.exports = function createAvaDesk({ auth }) {
  const router = express.Router();
  router.get('/ava-desk', (req, res) => auth.dashboard(req, res, () => { res.type('html').send(PAGE); }));
  router.get('/ava-desk/brain', (req, res) => { try { res.type('html').send(fs.readFileSync(BRAIN_FILE, 'utf8')); } catch (e) { res.status(404).type('text/plain').send('brain page missing'); } });   // already behind apiGate (same login as the desk)
  router.get('/ava-desk/three.js', async (req, res) => {
    try { res.type('application/javascript').set('Cache-Control', 'private, max-age=86400').send(await getThree()); }
    catch (e) { res.status(502).type('text/plain').send('three.js nahi mili: ' + e.message); }
  });
  router.get('/ava-desk/guard.js', (req, res) => {
    if (!guard) return res.status(404).type('text/plain').send('guard not installed');
    res.type('application/javascript').send(fs.readFileSync(GUARD_FILE, 'utf8'));
  });
  return { router, page: PAGE };
};
