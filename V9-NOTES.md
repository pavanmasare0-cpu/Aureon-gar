# v9 — kya badla
1. **Old chat "Failed to fetch" bug:** purani photos har naye message ke saath poori bheji jaati thi (aur localStorage/Firestore me poori save hoti thi). Ab: sirf naye photo-message ki photos jaati hain (~3 follow-ups tak), saved chat me sirf photo-count, purani chats startup par apne aap halki ho jaati hain, aur error me request ka size + `/health` link dikhta hai.
2. **Photos ka koi limit nahi:** ek saath kitni bhi photos chuno, "＋" se aur jodo, ✕ se ek-ek hatao. Zyada photos ho to har photo thodi chhoti compress hoti hai (10 tak: 1600px, 30 tak: 1280px, uske baad 1024px). Server ek request me ~18 MB tak bhejta hai, usse zyada ho to baaki chhod kar bata deta hai.
3. **Full screen:** status bar + navigation bar hide, notch ke aage tak; edge se swipe karo to bars thodi der dikhte hain.
4. **Ava Mind:** `AVA-MIND.md` dekho.
5. **Ava ka mood ab Aureon ki main chat me bhi chalta hai:** gaali/taareef likhne par, aur photo bhejne par (photo ka mood-check, kuch save nahi hota). Test: "angry ho jao".
