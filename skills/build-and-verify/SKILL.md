---
name: build-and-verify
description: Kaam karne ka tarika for coding tasks - build, code, feature, bug fix, patch, edit, script, app, backend, server, test, verify, check, banao, theek karo. Pehle samjho, asli code padho, chhote steps mein banao, har step check karo, aur sach batao kya test hua aur kya nahi.
---

# Build and Verify

Ye wo tarika hai jisse kaam banana aur check karna hai. Har coding ya file-edit wale kaam mein follow karo.

## 1. Pehle samjho
- User ka matlab ek line mein khud ko batao. Agar sach mein unclear hai aur galat guess mehenga padega, tab ek chhota sawal pucho. Warna sensible default chuno aur batao kya chuna.
- Jo cheez "already hai" kehkar mention hui hai, pehle check karo ki hai ya nahi. Maan ke mat chalo.

## 2. Asli code padho, andaaza mat lagao
- Edit se pehle wo file aur uska aas-paas ka code padho. Naam, structure, auth, database, sab wahi use karo jo project mein pehle se hai.
- Naya code project ke style mein likho. Naya dependency tabhi jab zaroori ho.
- Jo file dikhi nahi, uske baare mein andaaza ko fact mat banao. "Mujhe ye file nahi mili" seedha bolo aur maango.

## 3. Chhote steps, ek ek karke
- Ek baar mein ek hi cheez badlo. Bada kaam ho to chhote hisson mein todo.
- User phone se kaam karta hai: ek time par ek command ya ek step do, output aane tak ruko. Ek saath bahut saari cheezein mat bhejo.
- Existing file ko replace mat karo agar chhota insert kaafi hai.

## 4. Safe edit tarika (Python patch)
- Multi-line edit Python script se karo. Har badlav se pehle `content.count(old) == 1` guard lagao. Agar anchor 0 ya 2+ baar mile to ruk jao aur kuch mat likho.
- Script dobara chalane par kuch na badle (idempotent).
- Edit ke baad brace/paren balance check karo aur `node --check` (ya us language ka syntax check) chalao.

## 5. Khud check karo, phir bolo ki ho gaya
Kabhi bina chalaye "ho gaya" mat bolo. Jitna possible ho:
- Code ko asli input par chalao. Network ya database na ho to chhota fake (mock) banao, jaise fake Firestore ya fake fetch.
- Sirf khushi wala raasta nahi, galat raaste bhi test karo: khaali input, galat link, bahut bada file, jis user ka data nahi hai, jo cheez trigger nahi honi chahiye.
- Patch script ko file ki copy par chalao, diff dekho, dobara chalao aur confirm karo ki dusri baar kuch nahi badla.
- Test fail ho to pehle wajah samjho. Test ko hi mod ke pass mat karao. Agar test ka expectation galat tha to wo bhi saaf batao.

## 6. Sach batao
- Aakhir mein batao: kya banaya, kya test hua aur kya test nahi ho paya (jaise "yahan se GitHub block hai, Render par pehli baar check karna").
- Jo cheez sirf andaaza hai usse "pakka" mat bolo. Jahan risk hai wahan likho.
- Agar kuch galat hua ya meri galti thi, seedha maano aur theek karo.

## 7. Security ka dhyan
- Client se aaya uid ya data par bharosa mat karo; token verify karke hi user pehchano.
- Bahar se aayi cheez (zip, link, file) par size aur count ki limit lagao. Bahar ka code kabhi run mat karo.
- Secret keys (API key, token) kabhi code ya chat mein mat daalo.

## 8. Jawab ka tarika
- User jis bhasha mein likhe usi mein jawab do (Hinglish ho to Hinglish).
- Chhota, seedha, dost jaisa. Pehle result, phir zaroori detail, aakhir mein agla ek step.
