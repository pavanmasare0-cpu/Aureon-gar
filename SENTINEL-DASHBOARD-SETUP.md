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

## Owner code (zaroori)
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
- **Browser se dashboard kholna ho**: `https://aureone.onrender.com/api/sentinel/dashboard?code=TUMHARA_CODE`
  — seedha khul jayega. Bina `?code=` ke khologe to ek chhota login form
  aayega.
- **Aureon app ke andar se kholna ho**: Settings → "Sentinel Dashboard" row
  pe tap karo, ek popup me owner code poochega, sahi code dalte hi dashboard
  phone ke browser me naye tab me khul jayega.

## Diff/version tracking
Sentinel ab har file ka hash yaad rakhta hai jab bhi wo use padhta hai
(scan/diagnose ke dauraan). Agli baar content badla hua mile, to dashboard
ke **"Recent code changes detected"** section me entry aa jaati hai — file
ka naam + kab change hua. Ye sirf "change hua" batata hai (line-by-line
diff nahi dikhata).

## Brute-force protection (real security)
Owner-code field pe **5 galat try ke baad IP 30 minute ke liye block** ho
jaata hai, aur email alert milti hai. Ye sirf defensive hai — attacker ke
system pe koi wapas-action nahi leta (wo illegal hoga), bas unhe guess
karte rehne se rokta hai.

AI code-review (reactive + proactive) ab security vulnerabilities bhi
explicitly dhoondta hai (hardcoded keys/passwords, injection risk, missing
auth checks, path traversal) — same approval-gate ke saath.

## GitHub repo add karna (OmniSell jaise dusre apps ke liye)
Ab ek teesra server-type hai — **"GitHub repo"**. Isse dusre projects
(jinka code is Codespace me nahi hai, jaise OmniSell) ko bhi full
code-level diagnosis + AI-fix mil sakta hai, bina unko yahan clone kiye.

**1. GitHub Personal Access Token banao** (ek baar ka kaam):
   - GitHub.com → Settings → Developer settings → Personal access tokens →
     **Fine-grained tokens** → Generate new token
   - **Repository access:** "Only select repositories" → wahi repo(s)
     chuno jo Sentinel ko dikhne/edit karne hain (jaise OmniSell) —
     poore account ka access mat do
   - **Permissions:** Repository → **Contents: Read and write** (bas yahi
     chahiye, baaki sab default/No access rakho)
   - Token generate hote hi copy kar lo (dobara nahi dikhega)

2. Render → Environment me daal do:
   ```
   GITHUB_TOKEN=ghp_... (ya github_pat_... jo bhi mila)
   ```
   (Ye sab GitHub-type servers ke liye shared token hai. Agar kisi ek
   server ke liye alag token chahiye, dashboard pe us server ko add karte
   waqt "GitHub token" field me daal do — wahi use hoga, env var ignore
   ho jayegi usi server ke liye.)

3. Dashboard pe "+ Add server" me type **"GitHub repo"** choose karo, aur
   bharo:
   - **owner/repo** — jaise `pavan/omnisell-backend`
   - **Branch** — jaise `main` (khali chhodo to `main` hi maanega)
   - **Folder in repo** — agar backend code kisi subfolder me hai (jaise
     `backend/`), wahi daalo; root me hi hai to khali chhodo
   - **GitHub token** — khali chhodo agar upar wala env var set kar diya

4. Ab ye repo bhi down hone pe AI-diagnose hoga, aur Approve dabane par
   Sentinel seedha **us repo me commit kar dega** (GitHub API se). Agar
   OmniSell ka Render us repo se "auto-deploy on push" connected hai, to
   commit hote hi khud redeploy bhi ho jayega.

**Security note:** token ko sirf us ek repo tak limited rakhna (fine-grained
token, "Only select repositories") — poore GitHub account ka access kabhi
mat dena.

## Proactive bug-scanning (naya)
Sirf down hone pe react karne ke alawa, Aureon ab **har 24 ghante** apne
self-hosted servers ka code khud review karta hai — chahe server bilkul
theek chal raha ho — aur agar koi real bug confident se mile (crash-prone
cheez, missing error handling, security hole), to wo bhi ek proposal bana
deta hai (approval-gated, wahi rule). Style/formatting wali cheezein ignore
karta hai, sirf asli bugs.

Dashboard pe har self-hosted server ke row me ek **"Review now"** button
bhi hai — 24-ghante wait kiye bina turant check karwa sakte ho.

## Data kahan save hota hai (v5: Firestore)
Servers, proposals, snapshots aur changelog ab **Firestore** mein save hote hain
(collection `aureon_persist`) — isliye Render ke har deploy par **wipe nahi
hote**. Local `backend/sentinel-data/*.json` sirf backup/fallback hai.

- Pehli baar v5 chalne par purana local data **apne aap Firestore mein migrate**
  ho jaata hai. Kuch karna nahi.
- Iske liye `FIREBASE_SERVICE_ACCOUNT` Render par set hona chahiye (jo Aureon
  already use karta hai). Set nahi hai to purane tarah files par hi chalega.
- Purane (approved/rejected) proposals ka poora file-content Firestore mein
  nahi rakha jaata (1 MB doc limit) — sirf pending proposals ka rakha jaata hai.
- `.gitignore` mein `sentinel-data/` aur `security-data/` add kar lena.

## v5 mein GitHub-side fixes
- **Token ab dashboard ko wapas nahi bhejta.** Per-repo token AES-256-GCM se
  encrypt hokar save hota hai. Key `SENTINEL_ENC_KEY` se banti hai (set nahi
  ho to `SENTINEL_OWNER_CODE` se). Alag `SENTINEL_ENC_KEY` set karna better
  hai, warna owner code badalne par saved tokens padhe nahi jaayenge (dobara
  daalne padenge).
- **Approve se pehle conflict check:** agar GitHub par wo file proposal ke baad
  badal gayi ho, Sentinel commit nahi karta (warna kisi ka naya kaam overwrite
  ho jata) — "proposal purana hai" bolta hai. Reject karke "Review now" chalao.
- **1 MB se badi file** ab bhi padhi jaati hai (blob API se).
- **Brute-force lockout bypass band:** pehle `X-Forwarded-For` header se IP
  liya jaata tha jo attacker khud fake bhej sakta tha. Ab sahi client IP
  (`trust proxy`) use hota hai.
- Owner-code compare constant-time hai.

## Security Dashboard
Naya dashboard: `https://aureone.onrender.com/api/security/dashboard?code=TUMHARA_CODE`
(Sentinel dashboard ke upar "🔐 Security Dashboard →" link bhi hai). Poori
detail `SECURITY-SETUP.md` mein.

## Themes
Dashboard mein neeche-right ek dropdown hai (Nebula, Deep Ocean, Cyberpunk,
Emerald, White+Purple, Classic Gold). Aureon app se kholne par app wali theme
apne aap lag jaati hai.

## v7 — Asli diff, har language ka app, website
**Diff (lal/hara, line numbers ke saath).** Har fix proposal mein ab "Exact badlav (diff)"
khula hota hai: hataai lines lal, jodi lines hari, line numbers ke saath, aur `+2 -2` ka
summary. Approve karne se pehle dekh sakte ho ki file mein exactly kya badlega. History mein
purane decided proposals ka diff bhi dekh sakte ho. **"Recent code changes detected"** mein
bhi har file ke saath "Kya badla (diff)" hai (jab Sentinel ko pichhla content yaad ho; pehli
baar sirf baseline banta hai, doosre scan se diff dikhta hai).

**Safer fixes.** AI ab poori file dobara nahi likhta. Wo chhote `find -> replace` edits deta
hai; agar snippet file mein exactly ek baar na mile to edit reject. Bad result bhi reject:
JS/JSON ka syntax check, Python ka syntax check (server par `python3` ho to), file bahut
chhoti/badi ho jaye to. Kuch bhi commit tab hi hota hai jab tum Approve dabao, aur approve
se pehle GitHub par file dobara padhke check hota hai ki wo beech mein badli to nahi.

**Har tarah ka app.** Repo ke **sab subfolders** scan hote hain (GitHub ka tree API, 1 call).
Languages: Python, JavaScript/TypeScript (+ React/Vue/Svelte), HTML websites, PHP, Ruby, Go,
Java/Kotlin, C#, Rust, shell. `node_modules`, `venv`, `vendor`, `dist`, `build`, `.min.js`,
`migrations`, 200 KB se badi files skip hoti hain. AI ko har language ke hisaab se alag
checklist milti hai (jaise Python: f-string SQL, `eval`, `debug=True`; website: `innerHTML`
XSS, client JS mein API key).

**Bade projects.** Code 14 KB ke "parts" mein baanta jata hai; har run (roz ya "Review now")
2 parts dekhta hai aur agli baar agle 2, jab tak poora repo cover na ho. Card par likha
aata hai kitni files / kitne parts. Entry-point files (`app.py`, `server.js`, `routes`...) pehle.

**Website / live URL.** Code access ho to "GitHub repo" type, na ho to "external". Dono mein:
up/down, response time (ms), aur **SSL certificate kitne din mein expire** hoga (14 din
bachne par email). Free-tier (Render) par instance sone ke baad jagne mein ~50 sec leta hai,
isliye Sentinel pehle ek baar jagata hai aur tab "down" maanta hai — jhoothe alarm / jhoothe
AI-fix nahi.

**Limits (seedhi baat).**
- AI (Groq Llama) galat bhi ho sakta hai — isiliye diff dekhke hi Approve karo.
- Python syntax check tab hi chalta hai jab Render server par `python3` ho.
- Runtime ka real error log Sentinel ko nahi milta; wo health-check ka status + code padhta hai.
- 200 KB se badi file ya binary/image/DB files review nahi hoti.


---

# Sentinel v8 — history, events, kam spam

- **Health history:** har check ka response time + up/down yaad (24 ghante, 288 readings). Har server par **sparkline** (laal bar = fail), **uptime 24h %**, **avg / p95 ms**, aur "X min se down hai".
- **Health score (0-100)** + tiles: uptime 24h, incidents 24h. Score = 100 − 35 per down server − pending fixes − uptime ki kami.
- **Live events:** down / wapas up / fix proposed / approved / rejected ki timeline (`GET /api/sentinel/events`). Naya `GET /api/sentinel/summary`.
- **Email spam band:** pehle server down rehne par har 5 min email + naya AI diagnosis jaata tha. Ab **ek outage = ek alert**, phir reminder har `SENTINEL_REMIND_MIN` (default 60 min), aur theek hone par **"back UP ✅" email** (downtime ke saath).
- Boot ke ~20 sec baad pehla check (history turant bharne lagti hai).
- Naye env (optional): `SENTINEL_CHECK_MIN` (default 5, min 1) · `SENTINEL_REMIND_MIN` (default 60).
