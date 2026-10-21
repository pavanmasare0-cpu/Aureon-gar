# Aureon Sentinel — Enterprise upgrade v9

Builds on the supplied `Aureon-Sentinel-Enterprise-Hardening-Upgrade.zip` (nothing of yours is removed). Everything runs
**inside the Security dashboard** you already open (`/api/security/dashboard`) — new tabs: SOC · Firewall · Threat intel ·
Windows PC · Backup · Self-test, plus Operators (roles) under *Dashboard access*.

## What is new (mapped to the 8-layer roadmap)
| Layer | Added | Honest status |
|---|---|---|
| 1 Firewall | Ordered **firewall policy** (allow / deny / throttle, IP / CIDR / path / method), versioned history + one-click rollback, self-lockout protection. **Windows Endpoint Agent** manages the real Windows Firewall (PowerShell NetFirewall cmdlets) with approve + rollback | App-level firewall = tested. Windows agent = **written but not run on real Windows by me — review it, test on one PC first**. Not a kernel/WFP driver |
| 2 Zero Trust | **Roles** (viewer / analyst / admin) enforced on every route, operator accounts (scrypt-hashed codes), risk-based re-auth (session moves network ⇒ fresh 2FA), 2FA forced for protection-weakening changes, tamper-evident hash-chained audit log | Coarse roles, operators have no own 2FA. Phone posture does not gate dashboard access |
| 3 AI/threat detection | Explainable correlation rules (7), per-rule precision from your own true/false-positive verdicts, threat-intel enrichment | Rules + heuristics, no ML model. AI has **no** enforcement power: it can only propose |
| 4 EDR | Windows agent: Defender, firewall, listening ports, startup/tasks/admins drift, unsigned programs in user-writable folders, hot-fix age, UAC/SMB1/BitLocker; approved actions only (block IP, firewall ON, Defender update/scan, terminate process) | 5-minute polling, **no** real-time process-creation events, **no** file quarantine |
| 5 API security | Schema validation (type/size/unknown fields) on every state-changing route, role checks, CSRF header, stealth 404, dependency vulnerabilities via OSV, secret scan | Verified by tests below |
| 6 Phishing/malware | Link / message / file scanners + threat-intel domains/hashes; **labelled corpus with measured precision/recall** (tuning *and* held-out) | Small synthetic corpus ⇒ indicator, not certification. No sandbox / no AV signature DB |
| 7 SOC | Cases with severity + "why", timeline, notes, assignment, status workflow, **evidence export (JSON / CSV / HTML + SHA-256)**, threat feeds (Spamhaus DROP, Feodo, URLhaus) + your IOC list | Feeds download at runtime — first download not exercised in my sandbox (parsers are tested) |
| 8 Recovery | **Signed backup**, restore drill (verify), config version history + rollback, self-test shows backup/drill age (RPO/RTO targets) | Restore of Sentinel servers/operators may need a service restart |

**Not claimed:** Microsoft-Defender-or-bank-level security. That needs independent penetration testing, real-world telemetry
and years of maintenance. What you now have is a solid, tested, layered small-team security platform.

## Apply (only changed / new files are in this zip)
```bash
cd /workspaces/Aureon-gar && git pull
unzip -o Aureon-Sentinel-Enterprise-v9.zip
git status                       # review what changed
node --test backend/tests/security.test.js     # 16 tests must pass
git add -A && git commit -m "Security v9: SOC, firewall policy, threat intel, endpoint agent, RBAC, recovery"
git push                         # Render redeploys the backend (no APK rebuild needed)
```
`server.js` is **not** touched. Needs `SENTINEL_OWNER_CODE` (long) and `SENTINEL_ENC_KEY`. Optional: `SECURITY_THREAT_FEEDS=off`
(no downloads), `RESEND_API_KEY` + `ALERT_EMAIL_TO` (emails), `FIREBASE_SERVICE_ACCOUNT` (data survives deploys).

## First 10 minutes after deploying
1. Dashboard → *Dashboard access* → **Setup 2FA**, then tick **Step-up 2FA**.
2. *Self-test* → run it; fix the red items.
3. *Backup* → download a backup, then **Verify** it (that is your restore drill).
4. *Windows PC* → add your PC, read `windows-agent/aureon-agent.ps1`, install it on ONE machine.
5. Add analysts/viewers as operators instead of sharing the owner code.

## Tests (what "pass" means)
`backend/tests/security.test.js` — 16 regression tests: TOTP vector, stealth 404, brute-force ban, session cookie flags +
no secret in page, CSRF, full role matrix + privilege-denied recording, schema/oversize rejection, firewall semantics +
rollback, SOC correlation + explainability, scanner quality gates (tuning ≥95/90, held-out ≥90/85), SSRF guard, endpoint
approval flow (nothing runs before approval, analyst cannot approve, wrong key invisible), IOC + firewall at the guard,
signed backup tamper/wrong-key detection, audit-chain tamper detection, 2FA replay + step-up. These are regression tests,
**not** a penetration test.
