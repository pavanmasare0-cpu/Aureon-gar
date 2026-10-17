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

## v8 — Dashboard ka tala (koi Sentinel / Security dashboard ko touch bhi na kar sake)
Dono dashboards ab ek hi shared lock (`backend/dash-auth.js`) se bandh hain:

| Layer | Kya karta hai |
|---|---|
| **Stealth** | Bina login wale ko normal "Cannot GET ..." 404 dikhta hai — scanner ko pata hi nahi chalta ki yahan dashboard hai (dashboard ke andar band/chalu kar sakte ho) |
| **Code sirf ek baar** | `?code=` ek baar chalta hai, session ban jata hai aur URL se code gayab. Page ke HTML mein koi secret nahi rehta |
| **2FA (Authenticator)** | Google Authenticator / Aegis / Microsoft. Dashboard → *Dashboard access* → Setup 2FA. Replay-proof (ek code ek baar) |
| **Step-up** | Fix approve, IP block/unblock, settings, naya phone — har sensitive kaam par naya 2FA code (ek baar daalne ke baad 5 min chhoot) |
| **Session** | Random id, HttpOnly + Secure + SameSite=Strict cookie, 30 min idle / 8 ghante max, tumhare browser se bandha, jab chaho "baaki sab sessions band" |
| **Lockout** | 5 galat try → IP 30 min ban. 10 min mein 25 galat try (kisi bhi IP se) → naye logins 15 min band + email |
| **IP allow-list** (optional) | Dashboard sirf tumhare IP se khule |
| **Audit log** | Har login / galat try / action ka record dashboard mein; naye device se login par email |
| **Headers** | CSP, no-frame, no-referrer, no-store, nosniff |

**Zaroori:** `SENTINEL_OWNER_CODE` ab **compulsory** hai. Pehle ye set na ho to dashboard khula rehta tha (warning ke saath); ab set na ho to 503 deta hai. Lamba random code rakho, aur alag se `SENTINEL_ENC_KEY` bhi set karo (2FA secret / tokens usi se encrypt hote hain).
**Phone kho jaye / 2FA nahi chal raha:** Render par `DASH_TOTP_DISABLE=1` daalo, code se login karo, naya 2FA lagao, phir wo variable hata do.
Aureon app ka "Sentinel Dashboard" button pehle jaisa hi kaam karta hai (code → session → clean URL).

## Link / message / file checker (dashboard → "Link / File check")
- **Link:** URL ki shakal (look-alike naam jaise paytrn.com, punycode, IP, .apk, shortener...), server-side par link kholkar asli destination aur page (password box, form kahin aur bhej raha?), domain kitna naya hai (RDAP), SSL certificate, aur optional Google Safe Browsing / VirusTotal (`GOOGLE_SAFE_BROWSING_KEY`, `VT_API_KEY`). Link **server** kholta hai, tumhara phone nahi. Internal/private addresses scan nahi hote (SSRF-safe).
- **Message:** SMS/WhatsApp text paste karo — OTP/PIN maangna, KYC/Aadhaar bahana, digital-arrest, lottery, task-job, UPI collect jaise scam pattern + message ke andar ke links ki jaanch (+ `GROQ_API_KEY` ho to AI ki chhoti raay).
- **File** (15 MB tak): asli type (magic bytes) vs naam, `invoice.pdf.exe`, RTL trick, APK ki permissions (SMS/accessibility/overlay combo), macro wale Office file, PDF ke andar JavaScript, zip ke andar exe, khatarnaak scripts. File sirf memory mein jaanchi jaati hai — save/execute nahi. SHA-256 + VirusTotal link milta hai.
- Verdict: LOW RISK / SUSPICIOUS / DANGEROUS + wajah + kya karna hai. **Ye andaza hai, antivirus nahi** — "LOW RISK" ka matlab "100% safe" nahi.

## Mera phone (dashboard → "My Phone" + app → Settings → Phone Security)
1. Dashboard → My Phone → **Naya phone jodo** → device key (sirf ek baar dikhti hai; ye key sirf report bhej sakti hai, dashboard nahi khol sakti).
2. Repo mein `python3 apply-phone-guard.py` chalao (plugin, permission, Settings row jodta hai), `npx cap sync android`, APK rebuild.
3. App → Settings → **Phone Security** → key paste → *Abhi check karo*. Uske baad app khulne par roz apne aap.
Kya dekhta hai: screen lock, root/test-keys, USB debugging, security patch / Android version, **Accessibility / Device-admin / Notification-listener** wale apps, Play Store ke bahar se aaye apps jo SMS (OTP) padh sakte hain, stalkerware jaise naam, remote-control apps (AnyDesk...), naye install hue shak wale apps, storage / battery / restart. Score + kya karna hai; naya HIGH khatra mile to email.
**Seedhi baat:** ye settings + app-list ka *posture check* hai. Ye dusre apps ke andar nahi dekh sakta, phone ki files scan nahi karta, aur sirf tab chalta hai jab app khulti hai (background scan nahi). Pure Android API padhta hai, kuch badalta nahi. `QUERY_ALL_PACKAGES` permission Play Store par restricted hai — tumhari sideloaded APK ke liye theek hai, Play Store par daalna ho to alag se form bharna padega.

## Defense options (dashboard → "Defense")
Live badalte hain (redeploy nahi): mode (monitor / protect / strict / off), rate-limit, auto-ban kitni der, scanner-probe ban ghante, hacking-tools (sqlmap, nikto, nuclei...) ko User-Agent se block, bina-User-Agent block, email alert on/off, IP allow-list, aur **LOCKDOWN** (emergency: sirf allow-list ke IP + ye dashboards chalte hain, baaki sab 503 — asli users bhi rukte hain, isliye sirf attack mein).

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
cp -r v5tmp/backend/. backend/ && cp -r v5tmp/shield-lite v5tmp/android-phone-guard . && cp v5tmp/*.md v5tmp/apply-phone-guard.py . && python3 v5tmp/apply-server-patch.py backend/server.js && rm -rf v5tmp
printf "\nsentinel-data/\nsecurity-data/\n*.bak-before-security\n" >> backend/.gitignore
git status        # server.js (5 lines), sentinel-dashboard.js + naye files dikhne chahiye
git add -A && git commit -m "Sentinel: Firestore persistence + GitHub hardening; Security Operations dashboard"
git push          # Render khud redeploy karega — APK rebuild nahi chahiye
```
