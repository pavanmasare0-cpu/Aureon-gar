# Aureon Windows Endpoint Agent
1. Dashboard → *Windows PC* → **+ Naya PC jodo** → copy the agent key (shown once).
2. On the PC, PowerShell **as Administrator**, in the folder with `aureon-agent.ps1`:
   `.\aureon-agent.ps1 -Install -Server https://YOUR-BACKEND -Key ek_...`
3. `.\aureon-agent.ps1 -Once` sends a first report immediately. Log: `C:\ProgramData\Aureon\agent.log`.
4. Remove: `.\aureon-agent.ps1 -Uninstall` (firewall rules named `AureonBlock-*` are kept; delete them in Windows Defender Firewall if wanted).

What it reads: Defender status, firewall profiles, listening ports, startup entries, non-Microsoft scheduled tasks, local admins,
last hot-fix, unsigned programs running from user-writable folders, UAC / SMBv1 / RDP / BitLocker. It never reads documents,
keystrokes or browser data. It can run only the whitelisted actions you **approved** in the dashboard and re-validates every
parameter itself. The key is stored DPAPI-encrypted (machine scope) in a folder only SYSTEM + Administrators can read.

**Status:** written carefully but not executed on Windows by its author — read it first and try it on one machine.
