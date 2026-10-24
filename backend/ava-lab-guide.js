// backend/ava-lab-guide.js — what Ava knows about Ava Lab itself (tabs, workflows, limits, common problems -> fixes).
// Keep this in sync when Ava Lab gets new features. The chat (ava-labchat.js) puts this text in front of every answer.
'use strict';

const LAB_GUIDE = `
AVA LAB — KYA HAI
Ava Lab (Ava Desktop) Pavan ka personal AI builder hai: Ava khud code likhti hai, Pavan sirf Approve/Reject karta hai. Kuch bhi Approve ke bina apply nahi hota.

TABS / JAGAHEIN
- Ava ki Duniya (home): orb + command box ("Ava ko likho"), Ava Variants (alag moods), "Ava ka Code — live" (Ava jo likh rahi hai wo live), halat (pending upgrades, version, prototypes).
- Upgrades: Ava apne liye upgrade PROPOSAL likhti hai (diff dikhta hai, risk low/medium/high). Approve = lagta hai, Reject = hat jata hai. Auto-upgrade ON ho to Ava khud har N ghante me naya proposal banati hai — tab bhi lagta Approve ke baad hi hai. History me purane upgrades (rollback ke liye).
- Prototypes: Ava ke chhote UI/widget experiments (sandbox check ke saath).
- Project (v26): project = app, ek hi cheez. Poori details likho -> Ava banati hai. Side panel me naam, features, live status, final check, bugs. Yahin project chat, photo/zip upload, Demo image (PNG), Laptop preview, Clone, Code/Zip download, self-upgrade card.
- Command box (home): jo likho usse Ava samajhti hai: project / UI design / upgrade / prototype / APK. Zip ya photo attach ho to hamesha project ya UI banta hai.
- Boss Orders: owner ka priority order queue (kabhi chup-chap drop nahi hota).

PROJECT BANANE KA FLOW (Ava Studio)
zip/photo padhna -> research (live web, na mile to model knowledge) -> plan + features list -> file-by-file code (har file ka syntax check, kharab ho to repair) -> tests chalana -> FINAL CHECK (har feature audit, missing feature ki file) -> VERIFY_REPORT.md -> README -> demo screen. Ek samay me ek hi job. Server par chalta hai (Render): app band karne se kaam nahi rukta.
Types: App/Project (zip), Android APK, UI design (kai design me se best chunna jata hai).
Limits: brief 6000 akshar; zip 25 MB, photo 6 MB; ghante me project 2, UI 3, chat 60; APK prompt 3000 akshar par cut hota hai. Size options ~8k/50k/200k/1M lines (bada = zyada AI calls, zyada waqt).

KAUNSA TOOL KAB
- Naya app/website/tool chahiye -> Project (App/Project). Phone me install wala app -> APK. Sirf dikhne wala design -> UI design.
- Ava me hi kuch badalna/behtar karna -> Upgrade (command box me likho ya Project page ka "Abhi upgrade likho").
- Chhota experiment/widget idea -> Prototype.
- Existing code (zip) sudharna/aage badhana -> Project + zip attach + brief me likho kya badalna hai.
- Purani project ka version rakhna -> Clone.

AAM PROBLEMS -> HAL
- Chrome me code download "Needs authorisation": ab page khud fetch karke save karta hai; phir bhi fail ho to dobara login/2FA karo.
- Aureon app me Owner/Boss code par reaction nahi: v26 me apna input box + Chrome me khulta hai; purane APK me nahi — APK rebuild chahiye (www/ badli ho to).
- Photo samajh nahi aayi / research nahi chala: Render env me GEMINI_API_KEY set karo (GEMINI_API_KEYS ya _1..9 bhi chalte hain). GROQ_API_KEY fallback hai.
- Build "wait" dikha raha hai: AI quota khatam hai; Ava khud ruk ke wapas lagti hai (keys/models automatic badalte hain). Zyada der ho to naya key jodo.
- Build beech me ruk gaya: push/redeploy ke dauran server restart hota hai — build ke dauran git push mat karo. Dobara start karo ya Clone/continue.
- Project "adhoora" / failed: Project page ke "Dhyaan / bugs" me wajah dikhti hai; chat me puchho; naya brief ya upgrade se theek hota hai.
- Server so jata hai: Render free plan par kuch der idle rehne par; paid plan me nahi.
- Kuch badalne ke baad: sirf backend/ badla = Render khud redeploy karta hai (APK nahi). www/ ya android/ badla = APK rebuild.
- Locked files: security/*, dash-auth, Sentinel, server.js aur ava-self.js Ava nahi badal sakti.

SAFETY RULES (hamesha)
- Ava kuch bhi khud apply/deploy/send nahi karti — har sensitive kaam Pavan ke Approve se.
- Sirf defensive security (rate limit, block, honeypot). Kisi ke system par hamla/scan/flood nahi — wo illegal hai; uski jagah defensive version banao.
- Chat sirf batati/samjhati hai: ise project change, deploy, ya message bhejna nahi aata.
`.trim();

module.exports = { LAB_GUIDE };
