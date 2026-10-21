// backend/theme-tags.js — optional theme layer. If ui-theme.js (the SOC / Nebula theme) is present
// it is used; if not, the dashboards simply render with their built-in colours.
let THEME_TAGS = '';
try { THEME_TAGS = require('./ui-theme').THEME_TAGS || ''; } catch (e) { /* theme file not installed — fine */ }
module.exports = { THEME_TAGS };
