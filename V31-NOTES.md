# Aureon v31 — Ava Guard + Connector hata diye, Apps & Automation add

## Hata diya
- Ava Guard: www/ava-guard.js, backend/public/ava-guard.js, test/ava-guard.test.js, app.js ka guard check, index.html ka script tag,
  Ava Desk ka guard.js route / "Ava Guard ON" row / guardOk() checks. (jail-gate test ka sample ab test/fixtures/jail-sample.js)
- Connector (user ki apni Anthropic key wala settings pane): backend/connector file, /api/connectors/claude route, settings row + pane.
  "Smart" aur "Code mode" ab server ki ANTHROPIC_API_KEY se chalte hain. Code mode skills pane waisa hi hai.

## Naya: Settings > Apps & Automation  (backend/connect.js, www/connect-hub.js)
Apps: MCP server (Streamable HTTP) | REST API (Bearer / header / Basic) | Webhook (Slack, Discord, Zapier, Make, n8n, IFTTT).
Automation = seedhi bhasha me kaam + apps + trigger (manual / har N minute / webhook link). AI khud tool chunta, call karta, result dekhta, report deta.
Safety: URL/token AES-256-GCM encrypted | private/internal IP blocked (SSRF) | redirect par token leak nahi | default read-only (Changes allowed ON karna padta hai)
| tool results untrusted data | max 8 calls, 100s | 15 apps, 20 automations, 10 manual runs/ghanta.
Endpoints: /api/connect/apps, /apps/:id/test, /automations, /automations/:id/run, /hook/:id/:secret
Firestore: users/{uid}/apps, automations (top-level, field uid).
Limit: OAuth wale MCP servers (jisme browser login chahiye) abhi nahi — jo token/API key se chalte hain wo chalenge.
Test: cd backend && node --test tests/security.test.js tests/connect.test.js test/ava-jail-gate.test.js
Deploy: backend => Render redeploy. www/ badla => APK rebuild.

Naam: app me kahin "Claude" nahi dikhta (Smart / Code mode). Andar ke ids (claude, claudecode) aur Anthropic API ka model-id purane saved settings ke liye waise hi hain.
