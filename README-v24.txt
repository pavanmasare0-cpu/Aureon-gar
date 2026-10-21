Aureon v24 (backend only; Render redeploy YES, APK rebuild NO)
NEW  llm-text.js   : Gemini first, Groq (plain text) automatically when Gemini is out of quota / key invalid
FIX  apk-maker.js  : APK generation no longer dies on Gemini quota ("All 2 keys failed"): Groq fallback, patient retry (6x),
                     2-pass quality (draft + senior review/polish)
CHG  ava-studio.js : uses llm-text; Ava can start a project by herself (setting, ~30k lines, one job at a time)
CHG  ava-desk.html : "Ava Code" section removed. One command box understands: APK / project / UI design / upgrade / prototype
                     ("50k lines", "1 million", "10 lakh" in the text sets the size). APK jobs appear in the gallery + circle with
                     status, Download, Source, Badlao. Settings: auto project.
Render env tip: GEMINI_API_KEY key #2 is invalid -> fix/remove it. GROQ_API_KEY (or GROQ_API_KEYS, comma separated) is the fallback.
