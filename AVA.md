# Ava — Aureon ka flying bot

Ava ek tairta hua AI bot hai jo **Aureon app** aur **Sentinel dashboard** dono me poori screen pe khud ghoomta rehta hai.

## Kya karta hai
- **Khud ghoomta hai** — random jagah udta hai, ruk ke idhar-udhar dekhta hai, aankhein ghoomne ki disha me jaati hain. Ungli se pakad ke kahin bhi chhod sakte ho.
- **Khud sochta / seekhta hai** — har ~90 min me ek topic chunta hai (har 3rd round me topic khud decide karta hai), Gemini + Google Search se research karta hai, 2-4 pakke facts yaad rakhta hai aur bubble me bolta hai: "🧠 Naya seekha: …".
- **Tap karo → chhota chat** — type karo ya 🎤 se bolo. App me wohi dimaag/memory/phone-actions (call, alarm, battery, WhatsApp…) jo main chat me hain. Sentinel me status batata hai aur `check now` / `scan` chala sakta hai.
- **Khud bolta hai** — naya seekhne par (kam se kam 2 min gap) aur har jawab bolta hai. 🔊 se mute.

## Baat-cheet (hands-free)
- Ava ke chat me 💬 dabao → **Baat-cheet mode**: tum bolo, Ava jawab bolti hai, phir khud dobara sunti hai. "bas" / "stop" bolo to band. 2 baar kuch na suna to khud band.
- 🎤 = ek baar bolo, ek jawab.
- **Automation:** wahi tools jo main chat me hain — call, SMS, WhatsApp, alarm, app kholna, battery, reminders, form-fill. Call/SMS/Instagram/live-location se pehle confirm poochti hai.
- **Kahin se bhi bulana:** Aureon ko Default Assistant banao to "Aureon" bolte hi (kisi bhi app ke upar) voice session khulta hai.

## Ava phone screen par (doosre apps ke upar)
Settings → General → **"Ava phone screen par"** ON karo. Pehli baar Android "Display over other apps" permission maangega — Aureon ko allow karke switch dobara ON karo.
- Ava poore phone par ghoomti hai, pakad ke kahin bhi chhod sakte ho.
- Tap karo: agar Aureon Default Assistant hai to voice session wahin khulta hai (bolo, jawab suno, automation); warna Aureon app khulta hai.
- Aureon app khula ho to overlay Ava chhup jaati hai (in-app Ava dikhti hai), screen off hone par bhi ruk jaati hai.
- Phone restart ke baad Aureon ek baar kholo, overlay wapas aa jaata hai.
- Files: `android/.../AvaOverlayService.java` (+ manifest, `AureonActionsPlugin`, `AureonVoiceInteractionService`, `MainActivity`).

## Safety (jaan-boojh ke)
- Ava Sentinel me **Approve / Reject / Apply / Restart / Delete kabhi nahi kar sakta** — sirf health check aur scan. Approve tumhare haath me hi hai.
- Seekha hua sirf facts hain — code ya server pe koi asar nahi.
- Seekhne ke liye sirf Gemini (web search ke saath) use hota hai; Groq fallback nahi, warna bina search ke "seekhna" = banaayi hui baatein.
- Calls/SMS/Instagram/live-location wale phone actions pe wahi confirm popup aata hai jo main chat me aata hai.

## Files
| File | Kaam |
|---|---|
| `www/ava-bot.js` | Bot + chat panel (app aur Sentinel dono ke liye ek hi file) |
| `backend/ava.js` | `/api/ava/*` — chat, brain, learn, background learner |
| `backend/public/ava-bot.js` | Sentinel ke liye copy. `www/ava-bot.js` edit karo to `cd backend && npm run sync-ava` |
| `www/index.html` | `<script src="ava-bot.js">` add |
| `backend/server.js` | `/api/ava` mount |
| `backend/sentinel-dashboard.js` | dashboard me widget load |

## Env (Render) — sab optional
`SENTINEL_OWNER_CODE` (zaroor set karo — Ava ka Sentinel chat isi se locked hota hai), `AVA_LEARN=off`, `AVA_LEARN_INTERVAL_MIN=90`, `AVA_TOPICS=topic1, topic2`.

## Hide / wapas
Settings → General me "Ava (udta hua bot)" switch se Ava poori band/on hoti hai. Panel me `—` dabao to Ava chhup jaata hai; screen ke kinare ek chhota ✦ button aata hai, usse wapas bulao.

---

# Ava v2 — screen dekhna, khud khoj, khud sudharna

## 👁 Screen dekhna + yaad rakhna (Gemini Live jaisa)
- Panel me **👁** dabao (ya bolo "screen dekhna shuru karo"). Android ka apna "record/cast shuru karein?" dialog aata hai — Start dabao. Jab tak chal raha hai notification me **"Ava screen dekh rahi hai"** + **Band karo** button dikhta hai.
- Har ~6 sec me, **sirf jab screen badli ho**, ek chhota frame backend ko jaata hai → Gemini vision use text-summary banata hai ("Chrome: Gemini API docs padh rahe the") → **photo kabhi save nahi hoti**, sirf summary.
- Pucho: "abhi screen par kya hai?", "maine kal kya dekha tha?", "jo article padh raha tha uska naam?" — jawab sirf yaad ki hui summaries se aata hai, banaya hua nahi.
- Browser/Sentinel me bhi chalta hai (👁 → tab/screen chuno; tab khula rehna chahiye).
- **Privacy:** lock screen / screen off me kuch nahi jaata · `FLAG_SECURE` waali screens (banking apps, password manager, incognito) black aati hain, bheji nahi jaatin · password/OTP/card/secret dikhe to wo frame drop (aur card/OTP jaise numbers summary se bhi hat jaate hain) · yaad 14 din baad khud mit jaati hai (`AVA_SCREEN_TTL_DAYS`) · "screen ki yaad mita do" bolo to sab turant delete · device key sirf frame bhej sakti hai, kuch padh nahi sakti.
- **Quota dhyan:** har frame = 1 Gemini vision call. Default cap **90/ghanta** (`AVA_SCREEN_MAX_PER_HOUR`). Chat ka Gemini key wahi hai, toh free quota jaldi khatam ho sakta hai — zaroorat ho tab hi 👁 on rakho.
- Frame jaate waqt Google ke Gemini ko jaata hai (sensitive filter uske *baad* lagta hai) — isliye bank/private cheez kholte waqt 👁 band kar do.

## 🔭 Khud naya khojna + batana
- Har ~4 ghante (`AVA_SCOUT_INTERVAL_MIN`) Ava web (Gemini + Google Search) se pichle ~7 din ke **naye AI tools / models / free APIs / frameworks** dhundhti hai, **link sach me khulta hai ya nahi check** karti hai (banaye hue link drop), score ≥7 wale rakhti hai.
- Naya mile to bubble me bolti hai: "🔭 Naya mila: …". 🔭 dabao ya bolo "kya naya mila?" → list + link. "khoj karo" bolo to abhi dhundhti hai.
- Score ≥8 pe **email digest** (agar Render par `RESEND_API_KEY` + `ALERT_EMAIL_TO` set hain — wahi jo watchdog use karta hai), 6 ghante me max 1.
- Sabse achhe find par khud **gehri padhai** karti hai: kya hai, Aureon me kaise use ho, ek caveat.

## 🧠 Khud ki thinking upgrade
- Har ~6 ghante Ava apni haal ki baat-cheet dekhti hai aur 1-3 chhote **"playbook" rules** likhti hai (kaise behtar jawab dena) + **"mujhse ye nahi hua"** list (capability wishes). `GET /api/ava/playbook` me dekho, `DELETE /api/ava/playbook/<id>` ya `/all` se mita do.
- Rules sirf jawab ki quality ke baare me ho sakte hain — permission/security/approve/delete/secret jaisi cheez wale rules code se hi reject hote hain. Playbook "soft notes" hai, safety rules ke upar nahi.
- **Mushkil sawal** (compare/kyun/plan/debug/lamba) par draft → khud ki critique → final, yaani do baar sochkar jawab.
- Code ya server ko Ava kabhi nahi badalti; "upgrade" matlab notes + sochne ka tareeka, model/code nahi.

## Naye endpoints (`/api/ava/…`)
`screen/enroll, screen/frame, screen/ask, screen/memory (GET/DELETE), screen/pause, screen/revoke, discoveries, discoveries/seen, scout, playbook, reflect`

## Naye env (sab optional)
`AVA_SCREEN=off` · `AVA_SCREEN_TTL_DAYS=14` · `AVA_SCREEN_MAX_PER_HOUR=90` · `AVA_SCOUT=off` · `AVA_SCOUT_INTERVAL_MIN=240` · `AVA_REFLECT=off` · `AVA_REFLECT_INTERVAL_MIN=360` · `AVA_EMAIL_DISCOVERIES=off` · `AVA_TZ=Asia/Kolkata`

## Naye files
`backend/ava-extra.js` · `android/.../AvaScreenWatchService.java` · `AureonActionsPlugin.java` (startScreenWatch/stopScreenWatch/getScreenWatch) · `AndroidManifest.xml` (mediaProjection service + permission)

## Moods (angry / rone wala / sharmaya hua)
- Ava ke 3 naye mood hain: **angry 😠** (laal, tirchi bhauhein, hilti hai), **sad 😢** (neela-grey, aansu), **shy 🙈** (gulabi, blush, ^ ^ aankhein).
- Screen dekhte waqt backend ka vision model batata hai: sexual/nude content -> shy (uska description kabhi save nahi hota), kuch galat/harmful (violence, cruelty, abuse, scam, nafrat) -> angry, rona/dukh wali scene -> sad.
- Mood ~14 sec rehta hai. In-app orb aur phone-overlay dono me dikhta hai. Server route: `GET /api/ava/screen/mood`.
- Chat words se bhi: gaali/"bekar" -> angry, "cute/sundar" -> shy, "bye" -> sad.


---

## Ava + Sentinel link (v8)
- Ava ab tumhare **Sentinel servers** ki khabar rakhti hai: server down hote hi bubble + awaaz ("⚠️ Boss, OmniSell API down hai!"), theek hone par "✅ Sab servers wapas theek".
- Bolo: **"mere servers kaise hain?"** → health score, kaun down, kitne fix approval ke liye, uptime 24h.
- **Sirf owner ko** milta hai. Dashboard/owner-code se hamesha; Aureon **app** me chahiye to Render env me apna login daalo: `AVA_OWNER_EMAILS=tumhara@gmail.com` (ya `AVA_OWNER_UIDS=<firebase uid>`). Baaki app users ko server info nahi dikhti.
- Sentinel dashboard par Ava ka bubble wapas aa gaya.
