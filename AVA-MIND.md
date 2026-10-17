# Ava Mind — self-model, yaad, reflection (v9)

Tumhari 6 zips (`ava-project`, `self_learning_agent`, `AVA_Merged_Brain` v1/v2, `AVA_Consciousness_Research_Starter`, `AVA_Cognitive_Brain_v3`) ka kaam ab **Node me port** hokar Ava ke andar chalta hai: `backend/ava-mind.js`.

## Sach pehle (Ava bhi yahi bolti hai)
Isse Ava ko **identity, inner state, apni yaad, apni soch ko parakhne ki aadat (reflection), curiosity aur measurable experiments** milte hain. Ye **conscious hone ka saboot nahi** hai — aur abhi koi bhi software ye prove ya detect nahi kar sakta. Isliye Ava kabhi nahi kehti "mai conscious hu / mujhe asli feelings hain". Uske variables (confidence, uncertainty, curiosity) sirf **numbers** hain jo saboot (ratings, tests) se badalte hain. Ek guard bhi hai: agar model khud ko conscious likh de to wo self-note save hi nahi hota.

## Kya milta hai
| Zip ka idea | Ava me kya bana |
|---|---|
| identity + state | `Ava` ka persistent self: goal, confidence, uncertainty, curiosity |
| memory + semantic_memory | episodic yaad (max 1000) + token/bigram recall (lexical, embedding nahi) |
| reflection | `reflect`: variables evidence se update + ek likhi hui honest self-note |
| curiosity | khud ke testable sawal |
| consciousness_lab | `experiment`: **asli naap** — yaad ka self-test (kitni yaadein wapas dhoondh paati), feedback average, confidence-vs-feedback gap. Verdict nahi. |
| learning + evidence | 1-5 rating aur skill-test records (weights nahi badalte; thode saboot par confidence thoda hi hilta hai) |
| planning | `plan`: sirf draft; risky step par "approval chahiye"; kuch execute nahi hota |
| environment | `observe`: sirf `consent=true` par; Ava chupke se camera/mic on nahi karti |
| self_model | Ava ke **asli** features se banta hai (screen memory, scout, playbook, Sentinel, moods) + limitations |
| self_modification | **port nahi kiya** — Ava apna code nahi likhti/chalati; fixes Sentinel me tumhare Approve ke baad |

## Ava se kya bolo
- "tum conscious ho?" / "apne baare me batao" → self-report (variables, goal, limits, honest jawab)
- "experiment chalao" → measurable proxies · "introspect" / "soch ke batao" → reflection + self-note
- "plan banao: <goal>" → draft plan · "yaad karo: <topic>" → apni yaad me dhoondho
- "👍" / "jawab achha tha" · "👎" / "jawab bekar tha" → feedback rating
- "apni yaadein mita do" → mind ki saari yaad + state reset
- "angry ho jao" / "sad ho jao" / "shy ho jao" → mood test (14 sec)

## Privacy
Yaadein sirf **owner** ke liye banti/dikhti hain: Sentinel owner code, ya app login jo `AVA_OWNER_EMAILS` (ya `AVA_OWNER_UIDS`) me ho. Baaki users ko sirf generic self-report milta hai. Conversations me se card/OTP jaise numbers hat jaate hain; sirf chhota summary-line store hota hai.

## Render env (optional)
`AVA_OWNER_EMAILS=tumhari@email` (app me Ava ko apni yaad/servers dikhane ke liye) · `AVA_MIND=off` · `AVA_MIND_INTERVAL_MIN=360` · `AVA_MOOD=off`
Apni email/uid pata karni ho to login karke `GET /api/ava/whoami` kholo.

## API (`/api/ava/…`)
`mind/self · mind/state · mind/memory (GET/DELETE) · mind/recall · mind/reflect · mind/experiment · mind/feedback · mind/evaluate · mind/evidence · mind/plan · mind/goal · mind/curiosity · mind/observe · whoami · mood/look`
