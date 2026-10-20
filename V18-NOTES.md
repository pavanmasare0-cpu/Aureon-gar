# v18 = v17 (Ava jail gate + Ava Guard) + Ava Desktop + stealth off
- Ava Desktop: /api/sentinel/ava-desk (owner login). Chat ab Ava Guard se guzarti hai: browser me check + server par dobara check (backend/ava-desk.js).
- Blocked message wahi dobara Send karo = override. Secrets/card numbers model ko jaane se pehle redact ho jaate hain.
- dash-auth.js: stealth default OFF (Render env DASH_STEALTH=1 se wapas on).
- Backend change => Render redeploy. www/ badli hai (app.js, index.html, ava-guard.js) => APK rebuild chahiye.
- Tests: node --test backend/test/*.test.js
