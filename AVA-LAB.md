# Ava Lab — Ava khud ko upgrade karti hai (Sentinel me)

Sentinel dashboard ke header me **🧪 Ava Lab** link: `/api/sentinel/ava-lab` (wahi login / 2FA jo dashboard ka hai).

## Kya hota hai
1. **"⚡ Upgrade likho"** dabao (optional goal likho). Ava apni files ka outline padhti hai, **khud ek chhota improvement chunti hai**, phir exact code edits **khud likhti hai**.
2. Proposal me dikhta hai: **kya badla**, **kyun**, risk (low/medium/high), kaise check karein, aur **exact diff**.
3. **Approve** karo to file me likha jaata hai (backup ke saath). **Reject** karo to kuch nahi hota.
4. **History** me har upgrade: kya badla, kyun, diff, Ava ka apna chhota note, **↩ Rollback**, aur `.patch` download.

## Auto-upgrade, versions, sandbox
- **Auto-schedule:** Ava Lab me "Ava khud har N ghante" on karo. Ava khud apna code padh ke upgrade **likhti** hai; proposal tayar milta hai, tum Approve karte ho.
- **Versions:** har approved upgrade ek naya **Ava vN** banta hai. History me "⏪ Ava v(N-1) par wapas" se kisi bhi version par laut sakte ho.
- **Sandbox test:** proposal dikhne se pehle change ek alag temporary copy me load hota hai (bina API keys ke environment me). Fail hua to proposal banta hi nahi.
- **Optional auto-apply:** sirf **low-risk, <=40 lines, widget (ava-bot.js)** changes khud live ho sakte hain (default OFF). Backend files hamesha tumhare Approve se.

## Safe location: Ava ki special GitHub branch
Render ka disk har deploy par reset hota hai, isliye approved upgrade **GitHub par Ava ki apni branch `ava-lab`** me commit hota hai (branch khud ban jaati hai, `main` se). **`main` me kuch direct nahi jaata**, to Render bhi tab tak deploy nahi karta jab tak tum merge na karo.

Setup (Render → Environment):
- `AVA_GITHUB_REPO` = `username/Aureon-gar`
- `GITHUB_TOKEN` = fine-grained token, sirf us repo par **Contents: Read and write**
- optional: `AVA_GITHUB_BRANCH` (default `ava-lab`), `AVA_GITHUB_BASE` (default `main`). Ava ki branch `main` nahi ho sakti.

Flow: Approve → upgrade `ava-lab` par commit. Ava Lab me **"PR / diff dekho"** link (GitHub compare) aur **"🚀 main me merge (deploy)"** button. Merge karte hi Render naya code deploy karta hai. Conflict aaye to force nahi hota, GitHub par PR se suljhao. Rollback bhi `ava-lab` par wapas commit hota hai.

Backup: history + naye 4 upgrades ka poora code Firestore me bhi rehta hai. Deploy ke baad purana code wapas aaye to **"⚠ Render reset"** dikhta hai aur **"↻ Dobara lagao"** se upgrade wapas lag jaata hai. Jo abhi branch par nahi gaya uspe **"📌 GitHub me save"** hai (auto-applied widget changes ke liye bhi).

**Token Ava ko nahi milta:** sirf server approve/merge ke baad GitHub se baat karta hai; Ava ka sandbox aur Ava ka likha code `GITHUB_TOKEN` padh hi nahi sakte.

## Safety (jaan-bujh kar)
- Ava **sirf draft** likhti hai. Disk par likhna sirf tumhare Approve par (+ fresh 2FA agar step-up on ho).
- Ava sirf apni files badal sakti hai: `backend/ava.js`, `ava-mind.js`, `ava-extra.js`, `ava-bot.js` (dono copies sync rehti hain).
- **Locked:** `security/*`, `dash-auth.js`, Sentinel, `server.js` aur `ava-self.js` khud. Ava apne guardrails nahi badal sakti.
- Auto-reject: JS syntax error, `eval` / `child_process` / `process.exit` / secrets, safety words (`ownerOnly`, `avaIsOwner`, `sameCode`, `limited(`, `redact(`, `consent`) hatna, 160 lines se bada change, ya agar file proposal ke baad badal gayi ho.
- Max 6 tries / ghanta, max 5 pending.
- **Keys:** Ava ko sirf **Gemini + Groq** keys milti hain (`GEMINI_API_KEY`, `GEMINI_API_KEY_2..4`, `GEMINI_API_KEYS`, aur `GROQ_*` same). Sandbox me bhi sirf yahi. Firebase / owner code / GitHub / dashboard secrets kabhi nahi.
- Ava ka likha backend code: `process.env` se sirf Gemini/Groq keys (aur `AVA_*` settings) padh sakta hai; pura `process.env` ya koi aur secret padhna, ya naye outside URL par kuch bhejna (sirf Gemini, Groq, Aureon host allowed) = proposal auto-reject.
- Clones / self-replication: nahi. Ava ek hi jagah, tumhari nigrani me, versions ke roop me badalti hai.

## Dhyan do
- Backend file badli to **server restart / redeploy** par naya code chalega. `ava-bot.js` (widget) turant live.
- Render ka disk deploy par reset hota hai: permanent rakhna ho to **`.patch` download karke repo me commit** karo.
- AI: Ava ka apna Gemini use hota hai (fallback: `GROQ_API_KEY`).
- Ye Ava ko "conscious" nahi banata — wo code ka draft likhti hai, faisla tumhara.
