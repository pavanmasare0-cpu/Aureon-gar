// security/notify.js — rate-limited email alerts (same Resend setup as Sentinel).
let lastSent = 0;
let lastUrgent = 0;
const MIN_GAP_MS = 10 * 60 * 1000; // at most one email per 10 minutes

async function sendAlert(subject, text, opts) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = (process.env.ALERT_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!apiKey || !to.length) return false;
  // urgent alerts (GitHub tampering) are limited to 1/minute instead of 1/10 minutes
  const gap = opts && opts.urgent ? 60 * 1000 : MIN_GAP_MS;
  if (Date.now() - (opts && opts.urgent ? lastUrgent : lastSent) < gap) return false;
  if (opts && opts.urgent) lastUrgent = Date.now(); else lastSent = Date.now();
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from: process.env.ALERT_EMAIL_FROM || 'Aureon Security <onboarding@resend.dev>', to, subject, text }),
    });
    return true;
  } catch (e) {
    console.error('[security] alert email failed:', e.message);
    return false;
  }
}
module.exports = { sendAlert };
