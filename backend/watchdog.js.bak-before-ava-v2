// watchdog.js — Aureon's "immune system".
//
// What this does NOT do: rewrite code, auto-deploy fixes, or guess at
// anything novel. That's deliberately out of scope — an auto-patching bot
// with deploy access is a bigger risk than the bugs it's meant to catch.
//
// What it DOES do, same shape as a body's immune system — a fixed set of
// pre-approved responses to known patterns, plus a signal to a human the
// moment something doesn't match a known pattern:
//   1. Tracks failures of each AI provider (gemini/groq/openai/claude). If
//      one is clearly degraded (repeated failures in a short window), it
//      sends ONE Telegram alert (not a flood) saying so — "known pattern,
//      already falling back automatically, FYI."
//   2. Catches uncaught exceptions / unhandled promise rejections that would
//      otherwise either crash the whole process or fail silently. Logs them,
//      alerts a human immediately (this is the "never seen this before"
//      case), and — for non-fatal ones — lets the process keep running
//      instead of taking the whole backend down over one bad request.
//   3. A periodic self-ping that checks the backend can still reach its own
//      /health route. Three misses in a row (internal hang, not just a slow
//      request) triggers one alert.
//   4. /api/watchdog/status — safe, non-secret status (uptime, recent error
//      counts, which providers look healthy) so a human can check in without
//      digging through Render logs.
//   5. /api/watchdog/report — the Android app itself posts here when it
//      recovers from a crash (see AureonCrashReporter.java). So "watchdog"
//      isn't just a backend thing watching backend problems — app-side
//      crashes reach the same alert pipeline too.
//
// Alerts go to email via Resend (resend.com, free tier, no SDK needed —
// just a fetch call like everything else in this file). If RESEND_API_KEY /
// ALERT_EMAIL_TO aren't set, every alert just logs to console instead —
// nothing breaks, it just can't reach you until you set those two values.
// See WATCHDOG-SETUP.md for the 2-minute signup.
//
// IMPORTANT — this does not fix Render free-tier cold starts/sleeping by
// itself (a sleeping dyno can't run its own cron). That needs an external
// pinger (UptimeRobot, free) hitting /health every 5–10 min — see
// WATCHDOG-SETUP.md. This module's self-ping is for catching internal hangs
// while the server IS awake, which is a different problem.

const BOOT_TIME = Date.now();

// category -> { timestamps: [ms,...] }
const errorLog = {};
// category -> last time we actually sent an alert for it (cooldown, so one
// degraded provider doesn't spam 50 messages in 10 minutes)
const lastAlertSentAt = {};

const WINDOW_MS = 10 * 60 * 1000;      // look at failures in the last 10 min
const PATTERN_THRESHOLD = 5;            // 5+ failures in that window = "degraded"
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // don't re-alert the same category for 30 min

const MAX_LOGGED_ERRORS = 50;
const recentErrors = []; // [{category, message, at}] most recent first, for /status

// --- the actual "healing" part ---
// When a category crosses the pattern threshold, instead of just alerting,
// also mark it temporarily "disabled" for a cooldown window. Callers (see
// isDisabled below) can check this and skip straight to a fallback instead
// of wasting a request on a provider that's already failed 5 times in a
// row — a real, bounded, automatic action, not just a notification.
// After the cooldown, it's automatically eligible again — the very next
// successful call clears the disabled state (see clearDisabled), so this
// self-corrects without needing a human to flip anything back on.
const COOLDOWN_MS = 5 * 60 * 1000; // 5 min before retrying a degraded category
const disabledUntil = {}; // category -> timestamp

function isDisabled(category) {
  const until = disabledUntil[category] || 0;
  return Date.now() < until;
}

// Call this from the success path of whatever recordError() tracks, so a
// provider that's recovered on its own is immediately trusted again rather
// than waiting out the rest of a stale cooldown.
function clearDisabled(category) {
  if (disabledUntil[category]) delete disabledUntil[category];
}

async function sendEmailAlert(subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL_TO;
  const from = process.env.ALERT_EMAIL_FROM || 'Aureon Watchdog <onboarding@resend.dev>';
  if (!apiKey || !to) {
    console.warn('[watchdog] Email alerting not configured, would have sent:', subject, '|', text);
    return;
  }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
      }),
    });
  } catch (sendErr) {
    // Alerting itself failing is the one thing we can only log, not escalate.
    console.error('[watchdog] Email alert failed to send:', sendErr.message);
  }
}

// Call this from an existing catch block when a known, already-handled
// failure happens (a provider call failing, a fallback kicking in, etc).
// This is the "known pattern" path — logs it, and only alerts a human if
// the SAME category keeps failing (one blip is normal, a trend isn't).
function recordError(category, err) {
  const now = Date.now();
  const message = (err && err.message) ? err.message : String(err);

  recentErrors.unshift({ category, message, at: now });
  if (recentErrors.length > MAX_LOGGED_ERRORS) recentErrors.length = MAX_LOGGED_ERRORS;

  if (!errorLog[category]) errorLog[category] = [];
  errorLog[category].push(now);
  errorLog[category] = errorLog[category].filter(t => now - t < WINDOW_MS);

  const countInWindow = errorLog[category].length;
  if (countInWindow < PATTERN_THRESHOLD) return;

  // Healing action: route around this category for a few minutes rather
  // than keep hitting something that's already failed 5 times in a row.
  // Bounded and automatic — no human needed for this part.
  disabledUntil[category] = now + COOLDOWN_MS;
  console.warn(`[watchdog] "${category}" crossed the failure threshold — routing around it for ${COOLDOWN_MS / 60000} min.`);

  const lastAlert = lastAlertSentAt[category] || 0;
  if (now - lastAlert < ALERT_COOLDOWN_MS) return; // already alerted recently, don't spam

  lastAlertSentAt[category] = now;
  sendEmailAlert(
    `⚠️ Aureon watchdog: "${category}" degraded — auto-healing active`,
    `"${category}" has failed ${countInWindow} times in the last ${Math.round(WINDOW_MS / 60000)} min.\n\n` +
    `Last error: ${message}\n\n` +
    `Auto-healing: requests are being routed around "${category}" for the next ${COOLDOWN_MS / 60000} min, ` +
    `then it'll be tried again automatically. No action needed unless this keeps recurring.`
  );
}

// Call this for genuinely unexpected failures — an uncaught exception, an
// unhandled rejection, anything that doesn't fit an existing catch block.
// Unlike recordError, this always alerts immediately (no threshold, no
// cooldown-per-category) because by definition nothing else is handling it.
function recordUnknown(source, err) {
  const message = (err && err.stack) ? err.stack : String(err);
  console.error(`[watchdog] UNKNOWN (${source}):`, err);
  recentErrors.unshift({ category: `unknown:${source}`, message: String(err && err.message || err), at: Date.now() });
  if (recentErrors.length > MAX_LOGGED_ERRORS) recentErrors.length = MAX_LOGGED_ERRORS;

  sendEmailAlert(
    `🚨 Aureon watchdog: UNKNOWN error (${source})`,
    `This doesn't match a known pattern, no automatic fix exists for it.\n\n` +
    `${message.slice(0, 2000)}\n\n` +
    `The server is still running (this was caught, not a full crash) but this needs a human look.`
  );
}

function statusSnapshot() {
  const now = Date.now();
  const providerHealth = {};
  for (const category of Object.keys(errorLog)) {
    if (isDisabled(category)) {
      providerHealth[category] = `auto-healing (retrying in ${Math.ceil((disabledUntil[category] - now) / 60000)} min)`;
    } else {
      const countInWindow = errorLog[category].filter(t => now - t < WINDOW_MS).length;
      providerHealth[category] = countInWindow >= PATTERN_THRESHOLD ? 'degraded' : 'ok';
    }
  }
  return {
    uptimeSeconds: Math.round((now - BOOT_TIME) / 1000),
    bootedAt: new Date(BOOT_TIME).toISOString(),
    providerHealth,
    recentErrors: recentErrors.slice(0, 15), // most recent 15 only, keep it light
    emailAlertsConfigured: !!(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_TO),
  };
}

function init(app) {
  // --- 1 & 2: global safety net for anything not already caught ---
  // Node's default behavior for an uncaught exception is to crash the whole
  // process; for an unhandled rejection it varies by version but trends
  // the same way. Catching both means one bad, unanticipated error takes
  // down a single request instead of the entire backend (and every other
  // user's in-flight request with it). Render would restart a crashed
  // process anyway, but that's 30-50s of downtime for everyone, not just
  // the one request that triggered it.
  process.on('uncaughtException', (err) => {
    recordUnknown('uncaughtException', err);
    // Deliberately NOT calling process.exit() — see comment above. If the
    // process is actually in a bad state this won't save it, but for the
    // common case (one bad async callback) it keeps everyone else's
    // requests working.
  });
  process.on('unhandledRejection', (reason) => {
    recordUnknown('unhandledRejection', reason);
  });

  // --- 3: self-ping to catch internal hangs ---
  let consecutiveSelfPingFailures = 0;
  setInterval(async () => {
    try {
      const port = process.env.PORT || 3000;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        consecutiveSelfPingFailures = 0;
      } else {
        throw new Error(`/health returned ${res.status}`);
      }
    } catch (pingErr) {
      consecutiveSelfPingFailures++;
      console.warn(`[watchdog] self-ping failed (${consecutiveSelfPingFailures}):`, pingErr.message);
      if (consecutiveSelfPingFailures === 3) {
        sendEmailAlert(
          '🚨 Aureon watchdog: backend may be hung',
          `Backend hasn't responded to its own /health check 3 times in a row. ` +
          `It may be hung (still "running" per Render, but not actually serving requests). Worth checking Render logs/restarting.`
        );
      }
    }
  }, 5 * 60 * 1000); // every 5 min

  // --- 4: status endpoint — safe to leave public, no secrets in it ---
  app.get('/api/watchdog/status', (req, res) => {
    res.json(statusSnapshot());
  });

  // --- 5: app-side crash reports land here (see AureonCrashReporter.java) ---
  // Deliberately NOT behind verifyAuth — a crashed app may not have a fresh
  // ID token handy, and this only ever ends up as an email to the owner, it
  // doesn't touch any user's data. Payload is small and capped below so it
  // can't be abused as a free-text spam relay to the alert inbox.
  app.post('/api/watchdog/report', (req, res) => {
    const source = String((req.body && req.body.source) || 'android_app').slice(0, 50);
    const report = String((req.body && req.body.report) || '').slice(0, 4000);
    console.error(`[watchdog] app-side report (${source}):`, report);
    recentErrors.unshift({ category: `app:${source}`, message: report.split('\n')[0] || '(empty)', at: Date.now() });
    if (recentErrors.length > MAX_LOGGED_ERRORS) recentErrors.length = MAX_LOGGED_ERRORS;
    sendEmailAlert(
      `📱 Aureon watchdog: app crash reported (${source})`,
      `The Android app recovered from a crash and reported it on next launch:\n\n${report}`
    );
    res.json({ ok: true });
  });

  console.log('[watchdog] initialized' + (process.env.RESEND_API_KEY ? ' (email alerts on)' : ' (email alerts NOT configured — see WATCHDOG-SETUP.md)'));
}

module.exports = { init, recordError, recordUnknown, statusSnapshot, isDisabled, clearDisabled };
