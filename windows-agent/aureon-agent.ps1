<#
.SYNOPSIS
  Aureon Windows Endpoint Agent — read-only telemetry + approved, whitelisted response actions.

.DESCRIPTION
  * Every few minutes it READS: Defender status, Windows Firewall profiles, listening ports,
    startup items, scheduled tasks (non-Microsoft), local Administrators, last hot-fix, unsigned
    programs running from user-writable folders, UAC / SMBv1 / RDP / BitLocker state.
  * It sends that to YOUR Aureon backend with its own agent key (stored encrypted with DPAPI,
    machine scope, in a folder only SYSTEM + Administrators can read).
  * It can run ONLY these actions, and ONLY after you approved them in the dashboard:
      block_ip / unblock_ip     (adds / removes Windows Firewall rules named "AureonBlock-<ip>")
      enable_firewall           (Set-NetFirewallProfile -Enabled True for Domain/Private/Public)
      defender_update           (Update-MpSignature)
      defender_quick_scan       (Start-MpScan -ScanType QuickScan)
      terminate_process         (Stop-Process, only if pid AND exe name match)
    It never executes free-form commands, and it re-validates every parameter itself.
  * It does NOT scan files, read documents, log keystrokes or touch anything else.

.EXAMPLE
  # run PowerShell as Administrator
  .\aureon-agent.ps1 -Install -Server https://aureone.onrender.com -Key ek_xxxxxxxx
  .\aureon-agent.ps1 -Once          # one cycle right now (useful to test)
  .\aureon-agent.ps1 -Uninstall

.NOTES
  Needs Windows PowerShell 5.1+ and an elevated session to install. Review this file before
  you run it — it is plain text on purpose. Created by Aureon Sentinel.
#>
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Once,
  [string]$Server,
  [string]$Key,
  [int]$EveryMinutes = 5
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Security

$AgentDir  = Join-Path $env:ProgramData 'Aureon'
$CfgPath   = Join-Path $AgentDir 'agent.json'
$TaskName  = 'AureonAgent'
$LogPath   = Join-Path $AgentDir 'agent.log'

function Write-Log([string]$m) {
  try { Add-Content -Path $LogPath -Value ("{0}  {1}" -f (Get-Date -Format s), $m) } catch {}
  if ($Host.Name -ne 'ServerRemoteHost') { Write-Host $m }
}
function Protect-Text([string]$t) {
  $b = [Text.Encoding]::UTF8.GetBytes($t)
  [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine))
}
function Unprotect-Text([string]$t) {
  $b = [Convert]::FromBase64String($t)
  [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine))
}
function Test-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ------------------------------------------------------------------ install / uninstall
if ($Uninstall) {
  if (-not (Test-Admin)) { throw 'Run as Administrator.' }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $AgentDir -ErrorAction SilentlyContinue
  Write-Host 'Aureon agent removed. (Firewall rules named AureonBlock-* were left in place; remove them in Windows Defender Firewall if you want.)'
  return
}
if ($Install) {
  if (-not (Test-Admin)) { throw 'Run PowerShell as Administrator to install.' }
  if (-not $Server -or -not $Key) { throw 'Usage: -Install -Server https://your-backend -Key ek_...' }
  if ($Server -notmatch '^https://') { throw 'Server must be an https:// URL.' }
  if ($Key -notmatch '^ek_[A-Za-z0-9_\-]{20,}$') { throw 'That does not look like an agent key (ek_...).' }
  New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
  & icacls $AgentDir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
  $cfg = @{ server = $Server.TrimEnd('/'); key = (Protect-Text $Key) } | ConvertTo-Json
  Set-Content -Path $CfgPath -Value $cfg -Encoding UTF8
  $copy = Join-Path $AgentDir 'aureon-agent.ps1'
  Copy-Item -Path $PSCommandPath -Destination $copy -Force
  $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"{0}`" -Once" -f $copy)
  $trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
  $pri = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Principal $pri -Force | Out-Null
  Write-Host "Installed. The agent reports every $EveryMinutes minutes. Log: $LogPath"
  Write-Host 'Run:  .\aureon-agent.ps1 -Once   to send a first report now.'
  return
}

# ------------------------------------------------------------------ config
if (-not (Test-Path $CfgPath)) { throw "Not installed. Run: .\aureon-agent.ps1 -Install -Server https://... -Key ek_..." }
$cfg = Get-Content -Raw -Path $CfgPath | ConvertFrom-Json
$script:ServerUrl = [string]$cfg.server
$script:AgentKey  = Unprotect-Text ([string]$cfg.key)

function Invoke-Aureon([string]$Method, [string]$Path, $Body) {
  $h = @{ 'x-agent-key' = $script:AgentKey }
  $uri = $script:ServerUrl + $Path
  if ($null -ne $Body) {
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $h -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 8 -Compress) -TimeoutSec 40
  }
  return Invoke-RestMethod -Method $Method -Uri $uri -Headers $h -TimeoutSec 40
}

# ------------------------------------------------------------------ telemetry (READ ONLY)
function Get-Telemetry {
  $t = [ordered]@{}
  try { $os = Get-CimInstance Win32_OperatingSystem; $t.host = @{ name = $env:COMPUTERNAME; os = [string]$os.Caption; build = [string]$os.BuildNumber } } catch { $t.host = @{ name = $env:COMPUTERNAME } }

  try {
    $mp = Get-MpComputerStatus
    $t.defender = @{ enabled = [bool]$mp.AntivirusEnabled; realtime = [bool]$mp.RealTimeProtectionEnabled; sigAgeDays = [int]$mp.AntivirusSignatureAge; tamper = [bool]$mp.IsTamperProtected }
  } catch {}

  try {
    $fw = @{}
    foreach ($p in Get-NetFirewallProfile) { $fw[[string]$p.Name] = ([string]$p.Enabled -eq 'True') }
    $t.firewall = $fw
  } catch {}

  try {
    $names = @{}
    foreach ($pr in Get-Process) { $names[[int]$pr.Id] = [string]$pr.ProcessName }
    $t.listening = @(Get-NetTCPConnection -State Listen | Select-Object -First 300 | ForEach-Object {
      @{ port = [int]$_.LocalPort; addr = [string]$_.LocalAddress; pid = [int]$_.OwningProcess; proc = $names[[int]$_.OwningProcess] } })
  } catch {}

  try {
    $t.startup = @(Get-CimInstance Win32_StartupCommand | Select-Object -First 100 | ForEach-Object { @{ name = [string]$_.Name; cmd = [string]$_.Command; loc = [string]$_.Location } })
  } catch {}

  try {
    $t.tasks = @(Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\Microsoft\*' } | Select-Object -First 100 | ForEach-Object {
      $a = $_.Actions | Select-Object -First 1
      @{ name = [string]$_.TaskName; path = [string]$a.Execute; state = [string]$_.State } })
  } catch {}

  try { $t.admins = @(Get-LocalGroupMember -SID 'S-1-5-32-544' | ForEach-Object { [string]$_.Name }) } catch {}

  try {
    $hf = Get-HotFix | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 1
    $days = if ($hf) { [int]((Get-Date) - $hf.InstalledOn).TotalDays } else { 9999 }
    $pending = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
    $t.updates = @{ lastHotfixDays = $days; pendingReboot = [bool]$pending }
  } catch {}

  # unsigned programs running from user-writable folders (the classic malware location) — no file contents are read
  try {
    $bad = @()
    $seen = @{}
    foreach ($pr in Get-Process) {
      $path = $null; try { $path = $pr.Path } catch {}
      if (-not $path -or $seen.ContainsKey($path)) { continue }
      $seen[$path] = $true
      if ($path -notmatch '\\(AppData|Temp|Downloads|Users\\Public|ProgramData)\\') { continue }
      if ($bad.Count -ge 40) { break }
      $sig = Get-AuthenticodeSignature -FilePath $path -ErrorAction SilentlyContinue
      $bad += @{ name = ([string]$pr.ProcessName + '.exe'); path = $path; pid = [int]$pr.Id; signed = ($sig -and [string]$sig.Status -eq 'Valid') }
    }
    $t.processes = $bad
  } catch {}

  $sec = @{}
  try { $sec.uac = ((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction Stop).EnableLUA -eq 1) } catch {}
  try { $sec.rdp = ((Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -ErrorAction Stop).fDenyTSConnections -eq 0) } catch {}
  try { $sec.smb1 = [bool](Get-SmbServerConfiguration -ErrorAction Stop).EnableSMB1Protocol } catch {}
  try { $sec.bitlocker = ([string](Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction Stop).ProtectionStatus -eq 'On') } catch {}
  $t.security = $sec
  return $t
}

# ------------------------------------------------------------------ response actions (whitelist; each param re-validated here)
function Test-Ipv4([string]$ip) {
  if ($ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { return $false }
  try { [void][ipaddress]$ip } catch { return $false }
  if ($ip -match '^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)') { return $false }   # never touch private / local ranges
  return $true
}
function Invoke-Action($a) {
  switch ([string]$a.type) {
    'block_ip' {
      $ip = [string]$a.params.ip
      if (-not (Test-Ipv4 $ip)) { throw 'invalid or private IP' }
      $n = "AureonBlock-$ip"
      if (-not (Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $n -Direction Inbound  -Action Block -RemoteAddress $ip -Profile Any | Out-Null
        New-NetFirewallRule -DisplayName "$n-out" -Direction Outbound -Action Block -RemoteAddress $ip -Profile Any | Out-Null
      }
      return "blocked $ip (inbound + outbound)"
    }
    'unblock_ip' {
      $ip = [string]$a.params.ip
      if (-not (Test-Ipv4 $ip)) { throw 'invalid or private IP' }
      Remove-NetFirewallRule -DisplayName "AureonBlock-$ip", "AureonBlock-$ip-out" -ErrorAction SilentlyContinue
      return "unblocked $ip"
    }
    'enable_firewall' {
      $p = [string]$a.params.profile
      if (@('Domain', 'Private', 'Public') -notcontains $p) { throw 'invalid profile' }
      Set-NetFirewallProfile -Profile $p -Enabled True
      return "firewall enabled for $p"
    }
    'defender_update'     { Update-MpSignature; return 'signatures updated' }
    'defender_quick_scan' { Start-MpScan -ScanType QuickScan -AsJob | Out-Null; return 'quick scan started' }
    'terminate_process' {
      $procId = [int]$a.params.pid
      $name = [string]$a.params.name
      if ($procId -le 4 -or $name -notmatch '^[\w.\- ]{1,60}\.exe$') { throw 'invalid process parameters' }
      $pr = Get-Process -Id $procId -ErrorAction Stop
      if (([string]$pr.ProcessName + '.exe') -ine $name) { throw 'pid does not belong to that program any more — refused' }
      Stop-Process -Id $procId -Force
      return "terminated $name ($procId)"
    }
    default { throw "unsupported action: $($a.type)" }
  }
}

# ------------------------------------------------------------------ one cycle
try {
  Write-Log 'cycle start'
  $rep = Get-Telemetry
  Invoke-Aureon 'POST' '/api/security/endpoint/report' $rep | Out-Null
  $todo = Invoke-Aureon 'GET' '/api/security/endpoint/poll' $null
  foreach ($a in @($todo.actions)) {
    $ok = $true; $msg = ''
    try { $msg = Invoke-Action $a } catch { $ok = $false; $msg = $_.Exception.Message }
    Write-Log ("action {0} {1}: {2}" -f $a.type, $(if ($ok) { 'ok' } else { 'FAILED' }), $msg)
    Invoke-Aureon 'POST' '/api/security/endpoint/result' @{ actionId = [string]$a.id; ok = $ok; message = $msg } | Out-Null
  }
  Write-Log 'cycle done'
} catch {
  Write-Log ("cycle failed: " + $_.Exception.Message)
  if (-not $Once) { throw }
}
