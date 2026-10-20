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
let guard = null;
try { guard = require(GUARD_FILE); } catch (e) { guard = null; }

module.exports = function createAvaDesk({ auth }) {
  const router = express.Router();
  router.get('/ava-desk', (req, res) => auth.dashboard(req, res, () => { res.type('html').send(PAGE); }));
  router.get('/ava-desk/guard.js', (req, res) => {
    if (!guard) return res.status(404).type('text/plain').send('guard not installed');
    res.type('application/javascript').send(fs.readFileSync(GUARD_FILE, 'utf8'));
  });
  return { router, page: PAGE };
};
