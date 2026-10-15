# Aureon Security Operations — Setup

Cyber-defense layer jo Aureon backend ke **saamne** baithta hai: har request pehle
yahan se guzarti hai. Sirf **defensive** hai — request block karta hai aur IP ko
**limited time** ke liye ban karta hai. Attacker ke system par kuch nahi karta
(scan / hack-back illegal hota hai).

## Kya kya karta hai
| Layer | Kya pakadta hai | Default action (protect) |
|---|---|---|
| IP block-list | pehle se banned IP, `SECURITY_BLOCKLIST` | 403 |
| Rate-limit / DDoS | 200+ requests / 10s ek IP se | 429; 3 baar repeat → 15 min ban |
| URL signatures | `../`, `/etc/passwd`, `/.env`, `/wp-login.php`, `/phpmyadmin`, `/.git` ... | 403 + ban (probe = 24h, traversal = 60 min) |
| Scanner behaviour | 60s mein 15+ unknown (404) URLs | 30 min ban |
| Payload patterns | SQLi / XSS / command-injection strings | **sirf flag (log)** — block nahi |
| Owner-code brute force | 5 galat code | 30 min ban |
| Posture scan | owner code, env vars, express version, hardcoded secrets | report |

**Payload patterns ko default mein block kyun nahi karte:** Aureon AI/coding
assistant hai — users chat mein `SELECT * FROM ...`, `<script>` jaisa code paste
karte hi hain. Block karte to asli users ban ho jaate. `SECURITY_MODE=strict`
karoge to ye bhi block honge (chat/sentinel/security/memory paths ki body ko
chhodkar).

## Modes (`SECURITY_MODE`, Render → Environment)
- `monitor` — sab detect + log, **kuch block nahi**. Pehle isse shuru karna safe hai.
- `protect` — **default**. Upar table jaisa.
- `strict` — payload patterns bhi block.
- `off` — band.

## Setup
1. Zip ki files repo mein copy karo (neeche "Apply" dekho) aur push karo.
2. Render → Environment: `SENTINEL_OWNER_CODE` (lamba random) — **zaroori**, iske
   bina security dashboard 503 deta hai (khula nahi chhodta).
3. Optional: `SECURITY_MODE`, `SECURITY_ALLOW_IPS` (tumhare apne fixed IP, comma
   separated), `SECURITY_RATE_MAX`, `SECURITY_BLOCKLIST`, `SECURITY_BODY_SKIP`,
   `RESEND_API_KEY` + `ALERT_EMAIL_TO` (HIGH attack blocked par email, 10 min
   mein max 1).
4. Dashboard: `https://aureone.onrender.com/api/security/dashboard?code=TUMHARA_CODE`

## GitHub Guard — koi tumhare repo ko touch kare to pata chale
Dashboard mein **GitHub Guard** section hai: `owner/repo` (ya poora github.com URL)
daalo aur "Watch" dabao. Teen tareeke se nazar rakhta hai:

1. **Real-time (webhook)** — GitHub turant Aureon ko bataata hai.
2. **Polling** — har 5 min Events API check (sirf token chahiye, webhook ke bina bhi chalta hai).
3. **State diff** — har 30 min visibility, collaborators, deploy keys, webhooks aur
   branch-protection ka snapshot; kuch badla to alert. Clone-count spike bhi.

| Kya hua | Severity | Email |
|---|---|---|
| Untrusted bande ka push / force-push / branch delete | HIGH | haan |
| Naya collaborator, naya deploy key, naya webhook | HIGH | haan |
| Repo public ho gaya, branch protection hata | HIGH | haan |
| Fork, clone spike, default branch badli | MEDIUM | dashboard |
| Kisi ne star kiya, issue/PR khola | LOW | dashboard |

**Setup (ek baar):**
1. GitHub fine-grained token: us repo tak limited. Permissions: **Contents: Read**,
   **Administration: Read** (collaborators / keys / webhooks / traffic dikhne ke liye),
   **Metadata: Read**. Render → `GITHUB_TOKEN` (ya dashboard mein har repo ke saath alag token).
   Jo cheez token se nahi dikhti, dashboard mein "Blind spots" mein likha aata hai.
2. Render → `SECURITY_GITHUB_TRUSTED=tumhara-github-username` (comma se aur bhi).
   Repo ka owner automatically trusted hai; **org repo** ya doosre account se push
   karte ho to username yahan zaroor daalo, warna apne hi push par alert aayega.
3. **Real-time ke liye:** Render → `GITHUB_WEBHOOK_SECRET=<lamba random>`. Phir repo →
   Settings → Webhooks → Add: Payload URL `https://aureone.onrender.com/api/security/github-webhook`,
   Content type `application/json`, Secret wahi, Events: *Send me everything*.
4. Optional: `SECURITY_GITHUB_REPOS=owner/repo,owner/repo2` (start par auto-add),
   `SECURITY_GITHUB_CLONE_ALERT=5` (ek din mein itne unique cloners par alert).

**Seedhi baat — kya NAHI pata chal sakta:**
- GitHub owner ko ye **nahi batata ki public repo kisne dekha ya clone kiya** — sirf
  total count milta hai. Isliye repo **Private** rakho. Private repo ko sirf wahi
  chhoo sakta hai jise tumne access diya.
- Events API mein kabhi kabhi kuch minute ki deri hoti hai (webhook real-time hai).
- Force-push polling se sirf "0 commit push" ke roop mein dikhta hai; pakka force-push
  alert webhook se aata hai.
- Agar kisi ne tumhara GitHub **account** hi compromise kar liya, to Aureon ko wahi
  dikhega jo repo par hota hai. Apne account par 2FA/passkey zaroor on rakho, aur
  github.com/settings/security-log kabhi kabhi dekho.
- Branch protection (force-push band + PR required) GitHub par khud on karo — Aureon
  sirf batata hai ki wo on hai ya nahi.

## Saare apps par security (OmniSell wagairah)
Ek hi dashboard se sab apps dikhte hain:
1. Aureon (Render) → `SECURITY_INGEST_KEYS=omnisell:koi-lamba-key,doosraapp:doosra-key`
2. Dusre app mein `shield-lite/shield-lite.js` copy karo aur sabse pehle lagao:
```js
const shield = require('./shield-lite');
app.set('trust proxy', 1);
app.use(shield({ app: 'omnisell', reportUrl: 'https://aureone.onrender.com', key: process.env.SHIELD_KEY }));
```
   (Node 18+, koi dependency nahi.) Us app ke Render par `SHIELD_KEY=koi-lamba-key` (wahi jo upar diya).
3. Wo app probes/traversal/flood block karta hai, har incident dashboard mein
   `omnisell` tag ke saath aata hai, aur dashboard par kiya hua **Block** har app par
   ~1 minute mein lagu ho jata hai.
Aureon ka Android app khud server nahi hai — uski suraksha uska backend (upar wala) karta hai.

## Safety nets (khud ko lockout se bachane ke liye)
- Private/loopback IPs (127.x, 10.x, 192.168.x, 172.16-31.x) **kabhi block nahi**.
- `SECURITY_ALLOW_IPS` wale IP kabhi block nahi.
- Saari bans **temporary** hain (expire ho jaati hain); dashboard se **Unblock**
  kar sakte ho. Apna hi IP "Block" nahi kar sakte.
- Dashboard / Sentinel URLs par signature-checks nahi chalte (unme owner code
  URL mein hota hai).
- `server.js` mein `app.set('trust proxy', 1)` laga hai — Render ek proxy ke
  peeche hai, isse asli client IP milta hai. Iske bina rate-limit/ban sab galat
  IP par lagte.

## Data
Blocked IPs aur incidents Firestore (`aureon_persist`) mein save hote hain, to
deploy par wipe nahi hote. `FIREBASE_SERVICE_ACCOUNT` set hona chahiye; warna
sirf local file (deploy par chali jaati hai).

## Jo ye NAHI karta (seedhi baat)
- Ye ek app-level filter hai, **network-level DDoS protection nahi**. Bahut bada
  volumetric attack Render tak pahunchne se pehle rokna ho to Cloudflare jaisa
  proxy chahiye.
- Purani zips ki "Threat Intel" list mein sirf placeholder (documentation) IPs
  the — fake feed hata di. Apni asli list `SECURITY_BLOCKLIST` mein daal sakte ho.
- `npm audit` jaisa deep dependency scan nahi; sirf express version + secrets +
  config check hota hai. Alag se `npm audit` chalate raho.

## Apply
```bash
cd /workspaces/Aureon-gar && git pull
unzip -o Aureon-sentinel-security-v5.zip -d v5tmp
cp -r v5tmp/backend/. backend/ && cp -r v5tmp/shield-lite . && cp v5tmp/*.md . && python3 v5tmp/apply-server-patch.py backend/server.js && rm -rf v5tmp
printf "\nsentinel-data/\nsecurity-data/\n*.bak-before-security\n" >> backend/.gitignore
git status        # server.js (5 lines), sentinel-dashboard.js + naye files dikhne chahiye
git add -A && git commit -m "Sentinel: Firestore persistence + GitHub hardening; Security Operations dashboard"
git push          # Render khud redeploy karega — APK rebuild nahi chahiye
```
