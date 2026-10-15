// security/detect.js — attack signatures. Pure functions, no side effects.
//
// Two tiers on purpose:
//   * URL signatures  — path traversal, system-file reads, scanner probes.
//     These have essentially no legitimate use in a request URL, so they are
//     high-confidence and may auto-block.
//   * Payload patterns — SQLi / XSS / command-injection strings. Aureon is an
//     AI chat + coding assistant, so users legitimately paste code that looks
//     exactly like this. These are FLAGGED (logged) by default and only block
//     in SECURITY_MODE=strict.

const URL_RULES = [
  { id: 'PATH_TRAVERSAL', severity: 'HIGH', re: /(\.\.[\/\\]|%2e%2e(%2f|%5c|\/|\\)|\.\.%2f|%252e%252e)/i, name: 'Path traversal' },
  { id: 'SYSTEM_FILE', severity: 'HIGH', re: /(\/etc\/(passwd|shadow|hosts)\b|\/proc\/self\/|\bwin\.ini\b|\bboot\.ini\b)/i, name: 'System file access attempt' },
  { id: 'SCANNER_PROBE', severity: 'HIGH', re: /^\/(\.env|\.git(\/|$)|\.aws|\.ssh|wp-(login|admin|content|includes)|wordpress|phpmyadmin|pma\b|xmlrpc\.php|cgi-bin|vendor\/phpunit|actuator|server-status|config\.(env|json|php|yml)|backup\.(sql|zip|tar)|\.ds_store)/i, name: 'Vulnerability-scanner probe' },
];

const PAYLOAD_RULES = [
  { id: 'SQLI', severity: 'MEDIUM', re: /(\bunion\b[\s\S]{0,20}\bselect\b|\bselect\b[\s\S]{1,60}\bfrom\b[\s\S]{1,40}\b(information_schema|pg_catalog|sqlite_master)\b|;\s*drop\s+table\b|'\s*or\s*'?1'?\s*=\s*'?1|\bsleep\s*\(\s*\d+\s*\)|\bbenchmark\s*\()/i, name: 'SQL injection pattern' },
  { id: 'XSS', severity: 'MEDIUM', re: /(<script\b|javascript:\s*[a-z(]|\bon(error|load|mouseover|focus)\s*=\s*["']?[^>\s]+)/i, name: 'Cross-site scripting pattern' },
  { id: 'CMD_INJECTION', severity: 'MEDIUM', re: /(;|\||&&|`|\$\()\s*(cat|ls|id|whoami|uname|wget|curl|nc|ncat|bash|sh|powershell)\b/i, name: 'OS command injection pattern' },
  { id: 'REMOTE_SHELL', severity: 'MEDIUM', re: /(\/bin\/(ba)?sh\b|\bcmd\.exe\b|\bpowershell(\.exe)?\s+-)/i, name: 'Remote shell pattern' },
];

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

// path + raw query string, plus one level of decoding (catches %2e%2e etc.)
function detectUrl(req) {
  const raw = req.originalUrl || req.url || '';
  const decoded = safeDecode(raw);
  const pathOnly = safeDecode((raw.split('?')[0]) || '');
  for (const r of URL_RULES) {
    if (r.re.test(raw) || r.re.test(decoded) || r.re.test(pathOnly)) return { ...r, tier: 'url' };
  }
  return null;
}

function detectPayload(text) {
  if (!text) return null;
  const t = String(text).slice(0, 20000); // bound the work per request
  const d = safeDecode(t);
  for (const r of PAYLOAD_RULES) {
    if (r.re.test(t) || r.re.test(d)) return { ...r, tier: 'payload' };
  }
  return null;
}

module.exports = { detectUrl, detectPayload, URL_RULES, PAYLOAD_RULES };
