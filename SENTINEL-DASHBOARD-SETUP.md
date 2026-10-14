# Aureon Sentinel Dashboard — Setup

## Kya hai ye
Ek alag dashboard (chat se bilkul separate) jahan tum jitne chaho utne servers ki
health-check link daal sakte ho — Aureon ka apna backend, ya koi bhi aur server.
Aureon unko har 5 minute me check karta rahega. Koi down mile to:

- **Apna backend (type: self)** — Aureon error + us server ka code dekh ke
  **AI se diagnose karwata hai** (agar `GROQ_API_KEY` set hai — already hai
  tumhare paas) aur asli fix propose karta hai, lekin **file ko tabhi tak
  nahi chhuta jab tak tum dashboard pe "Approve" na dabao.** Agar AI ko
  confidence nahi hai (jaise error code ke bahar ki wajah se ho — network,
  missing env var, koi external service down), to wo khud bol dega "pata
  nahi" bajaye galat guess karne ke, aur Sentinel ek simpler fallback-check
  try karta hai (ek known pattern — missing error-handler). Agar dono me se
  kuch na mile, bas email aayegi ki "server down hai, koi fix propose nahi
  ho paya — khud dekho."
- **Koi aur server (type: external)** — Aureon uska code nahi dekh sakta
  (dusre server pe hosted hai), isliye sirf uptime check kar sakta hai. Agar
  tum ek restart-webhook URL de do, to down hone par Aureon usko call karne
  ka **proposal** banayega — wo bhi sirf Approve dabane par chalega.

Har proposal pe ek email bhi aati hai (same Resend setup jo watchdog already
use karta hai — koi naya setup nahi chahiye agar wo already kiya hua hai).
**Email ek se zyada address pe bhejni ho** (jaise apni main ID + owner wali
ID), to Render ke Environment me `ALERT_EMAIL_TO` field me dono emails
comma se separate karke daal do:
```
ALERT_EMAIL_TO=apni-main-id@gmail.com, owner-wali-id@example.com
```
Dono ID ko har alert milegi.

**Kabhi bhi, kisi bhi haal me, bina tumhare "Approve" dabaye koi file change
nahi hogi, koi webhook call nahi hoga.**

## Integration steps

1. `backend/sentinel-dashboard.js` ko apne repo ke `backend/` folder me daalo
   (ye zip me usi path pe hai).

2. `backend/server.js` ke top ke paas, jahan baaki `require(...)` lines hain,
   ye 2 lines add karo:

   ```js
   const sentinelDashboard = require('./sentinel-dashboard');
   app.use('/api/sentinel', sentinelDashboard);
   ```

   (`app` ka naam agar alag hai to usi se match karo — jahan `app.get('/health', ...)`
   jaisi lines hain, wahi `app` hai.)

3. Commit + push + rebuild/redeploy jaisa hamesha karte ho (ye sirf backend
   change hai, Android APK rebuild karne ki zarurat nahi — bas Render
   redeploy hoga jab tum push karoge).

4. Dashboard yahan khulega:
   ```
   https://aureone.onrender.com/api/sentinel/dashboard
   ```
   Isko bookmark kar lo phone browser me.

## Server add karte waqt

- **Aureon ka apna backend add karna ho** — type `self`, local path wahi
  folder jahan `server.js` hai (Render pe ye hamesha `.` hota hai, kyunki
  backend process usi folder se chal raha hota hai — type `.` field me).
- **Koi aur apna project (jo isi Codespace/server pe hai)** — type `self`,
  uska actual folder path.
- **Koi third-party / dusri jagah hosted link** — type `external`. Agar us
  server ka koi restart-webhook endpoint hai (khud bana ho ya hosting
  provider deta ho) to wahi daal do, warna khali chhod do (sirf monitoring
  hogi, fix khud nahi propose hoga kyunki code access hi nahi hai).

## Owner code (naya — zaroori)
Ab dashboard aur uske saare actions (approve/reject/add-server/scan-now)
**owner code ke bina lock rahenge**. Render → Environment me ek naya
variable add karo:
```
SENTINEL_OWNER_CODE=jo-bhi-secret-code-tumhe-yaad-rahega
```
Agar ye set nahi karoge, dashboard **khula** rahega (koi bhi link jaan ke
access kar sakta hai) — is case me dashboard ke upar ek laal warning banner
dikhega taaki bhoolna na ho.

Code set karne ke baad:
- **Browser se dashboard kholna ho**: `https://aureone.onrender.com/api/sentinel/dashboard`
  par jaate hi ek chhota login form aayega, code daalo, unlock ho jayega.
- **Aureon app ke andar se kholna ho**: Settings → "Sentinel Dashboard" row
  pe tap karo, ek popup me owner code poochega, sahi code dalte hi dashboard
  phone ke browser me naye tab me khul jayega.

## Proactive bug-scanning (naya)
Sirf down hone pe react karne ke alawa, Aureon ab **har 24 ghante** apne
self-hosted servers ka code khud review karta hai — chahe server bilkul
theek chal raha ho — aur agar koi real bug confident se mile (crash-prone
cheez, missing error handling, security hole), to wo bhi ek proposal bana
deta hai (approval-gated, wahi rule). Style/formatting wali cheezein ignore
karta hai, sirf asli bugs.

Dashboard pe har self-hosted server ke row me ek **"Review now"** button
bhi hai — 24-ghante wait kiye bina turant check karwa sakte ho.

## Data kahan save hota hai
`backend/sentinel-data/servers.json` aur `proposals.json` — ye git me commit
NAHI karna (`.gitignore` me `sentinel-data/` add kar lena), warna purani
history baar-baar overwrite hoti rahegi jab bhi naya zip apply karoge.
