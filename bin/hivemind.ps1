# hivemind.ps1 - HiveMind launcher for native Windows (PROXY-ONLY).
#
# Windows counterpart of bin/hivemind on a proxy-only install (impl 3e2c90da,
# phase W, item W2). Starts/stops the UNCHANGED bun daemon (runtime\src\server.ts:
# the local mTLS proxy + the first-login setup server) and prints how to connect
# an MCP client to it. It never launches Claude Code and never opens a session -
# a proxy-only vessel opens its own, as any foreign MCP client does.
#
#   hivemind [<slug>] | start     enroll if there is no certificate yet, else
#                                 start the proxy and print the connect hints
#   hivemind stop                 stop the daemon (forced - see below)
#   hivemind update               pull + verify + staged swap of the runtime
#                                 and this launcher, rollback on a failed
#                                 proxy health check (item W7); also run
#                                 silently on launch (start / no args)
#   hivemind status               pidfile + command-line check + health probes
#   hivemind uninstall [-Yes] [-KeepCerts]
#                                 remove everything HiveMind installed (item W3)
#   hivemind autostart on|off|status
#                                 start the proxy at log-on (opt-in, item A2):
#                                 per-user Scheduled Task, Startup-folder fallback
#   hivemind --help | --version
#   --verbose (anywhere)          say why the on-launch update check skipped
#
# Stop is forceful by design (founder decision 95a181bd): on Windows a bun
# process gets no SIGTERM (Stop-Process = TerminateProcess), and `taskkill`
# without /F arrives as SIGHUP, which server.ts deliberately ignores (measured in
# W0). So `stop` uses Stop-Process -Force, and ONLY on a PID whose command line is
# bun running THIS install's runtime\src\server.ts - never a recycled PID. The
# daemon's state is written atomically (tmp + rename), so a hard kill is safe.
#
# Installed by install.ps1 as %LOCALAPPDATA%\hivemind\bin\hivemind.ps1 and
# reached through the frozen hivemind.cmd shim next to it.
#
# Test seams (process env only): HIVEMIND_NO_BROWSER=1 prints the setup URL
# without opening a browser; HIVEMIND_INSTALL_USER_PATH_FILE and
# HIVEMIND_UNINSTALL_ROOT_STORE redirect the uninstall's user-Path edit and
# certificate-store removal (see Invoke-Uninstall); HIVEMIND_UPDATE_CA_FILE
# makes the update's LATEST_SHA manifest fetch trust that CA file (a local
# fixture in the smoke) - see Test-CommitIntegrity.
#
# This file is ASCII on purpose (Windows PowerShell 5.1 misreads BOM-less UTF-8).

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$HivemindVersion = '0.1.0'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# ---- Paths (same layout as bin/hivemind; homedir() = %USERPROFILE%) ----------
$UserHome = $env:USERPROFILE
if (-not $UserHome) {
  # Every path below hangs off it; an empty profile root must never become a
  # relative path (and never an uninstall target).
  [Console]::Error.WriteLine('Error: USERPROFILE is not set - refusing to run.')
  exit 1
}
if ($env:HIVEMIND_HOME) { $HivemindHome = $env:HIVEMIND_HOME } else { $HivemindHome = Join-Path $UserHome '.hivemind' }
$EngramDir       = Join-Path $UserHome '.engram'
$CacheDir        = Join-Path $EngramDir 'cache'
$CertDir         = Join-Path $EngramDir 'mtls'
$RuntimeLog      = Join-Path $CacheDir 'hivemind-runtime.log'
$RuntimePidFile  = Join-Path $CacheDir 'hivemind-runtime.pid'
$SetupPidFile    = Join-Path $CacheDir 'hivemind-setup.pid'
$RuntimeDir      = Join-Path $HivemindHome 'runtime'
$RuntimeBin      = Join-Path $RuntimeDir 'src\server.ts'
$LocalHttpsCa    = Join-Path $CertDir 'local-https\ca.cert.pem'
$EnvFile         = Join-Path $HivemindHome '.env'
# Update (W7): staged tree + rollback copy, siblings of HIVEMIND_HOME (as on Linux).
$StagingDir      = "$HivemindHome.staging"
$LastGoodDir     = "$HivemindHome.last-good"
# uninstall -KeepCerts: the .env credential keys, kept next to the certs (3b7a507e a).
$KeptCredsFile   = Join-Path $EngramDir 'kept-credentials.env'
$DefaultEndpoint = 'hivemind.ia.br:4443'
$DirectMcpUrlDefault = 'https://api.hivemind.ia.br/v1/mcp'
$DirectMcpUrlOverride = $env:HIVEMIND_DIRECT_MCP_URL   # process env only, never .env

# Windows PowerShell 5.1 turns any stderr line of a native command into a
# terminating error under ErrorActionPreference=Stop. Native calls go through
# this wrapper and are judged by exit code.
function Invoke-Native([scriptblock]$sb) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $sb | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $old }
}

function Write-Err([string]$msg) { [Console]::Error.WriteLine($msg) }

function Test-Interactive {
  try {
    return ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected)
  } catch { return $false }
}

# ---- .env (UTF-8, LF or CRLF, backslash Windows paths kept verbatim) ---------
# Read as UTF-8 explicitly: setup.ts writes a UTF-8 em dash in the header line,
# which Get-Content without -Encoding mangles on 5.1 (W0).
$DotEnv = @{}
if (Test-Path -LiteralPath $EnvFile -PathType Leaf) {
  foreach ($raw in ([IO.File]::ReadAllText($EnvFile, $Utf8NoBom) -split "`r?`n")) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { continue }
    $k = $line.Substring(0, $eq).Trim()
    $v = $line.Substring($eq + 1).Trim()
    if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
      $v = $v.Substring(1, $v.Length - 2)
    }
    $DotEnv[$k] = $v
  }
}

# Resolution order = the daemon's (env.ts): process env wins, then .env, then
# the default - so the ports probed here are the ports the daemon binds.
function Get-Conf([string]$key, [string]$default = '') {
  $p = [Environment]::GetEnvironmentVariable($key, 'Process')
  if ($p) { return $p }
  if ($DotEnv.ContainsKey($key) -and $DotEnv[$key]) { return $DotEnv[$key] }
  return $default
}

$RuntimePort = Get-Conf 'AR_PORT' '7777'
$ProxyPort   = Get-Conf 'MTLS_PROXY_PORT' '7779'
$Endpoint    = Get-Conf 'HIVEMIND_ENDPOINT' $DefaultEndpoint
$Owner       = Get-Conf 'HIVEMIND_OWNER' ''

# ---- Helpers -----------------------------------------------------------------
function Get-HttpCode([string]$url) {
  # curl.exe ships with Windows 10+. -k: this is a LIVENESS probe of a loopback
  # listener (any HTTP status = alive); trust is the client's concern, not ours.
  $code = Invoke-Native { & curl.exe -s -k --ssl-no-revoke -o NUL -w '%{http_code}' --max-time 3 $url 2>$null }
  if (-not $code) { return '000' }
  return ("$code").Trim()
}

function Test-RuntimeHealthy { return ((Get-HttpCode "http://127.0.0.1:$RuntimePort/healthz") -eq '200') }
function Test-ProxyAlive     { return ((Get-HttpCode "https://127.0.0.1:$ProxyPort/v1/mcp") -ne '000') }

function Test-HasCert {
  if (-not (Test-Path -LiteralPath $CertDir -PathType Container)) { return $false }
  if ($Owner) { return (Test-Path -LiteralPath (Join-Path $CertDir "$Owner.cert.pem") -PathType Leaf) }
  return [bool](Get-ChildItem -LiteralPath $CertDir -Filter '*.cert.pem' -File -ErrorAction SilentlyContinue)
}

# Identity check: the PID is bun AND its command line carries the FULL path of
# THIS install's runtime\src\server.ts (fixed string, case-insensitive like the
# filesystem). A recycled PID, another bun program, or another install's daemon
# never matches.
function Test-IsOurDaemon([int]$procId) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
  if (-not $p) { return $false }
  if ($p.Name -notin @('bun.exe', 'bun')) { return $false }
  if (-not $p.CommandLine) { return $false }
  return ($p.CommandLine.IndexOf($RuntimeBin, [StringComparison]::OrdinalIgnoreCase) -ge 0)
}

function Read-PidFile([string]$file) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
  $t = ([IO.File]::ReadAllText($file)).Trim()
  $n = 0
  if ([int]::TryParse($t, [ref]$n) -and $n -gt 0) { return $n }
  return $null
}

function Test-Alive([int]$procId) { return [bool](Get-Process -Id $procId -ErrorAction SilentlyContinue) }

# Forced stop of one verified PID; waits until it is really gone.
function Stop-OurDaemon([int]$procId) {
  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 50 -and (Test-Alive $procId); $i++) { Start-Sleep -Milliseconds 100 }
  return (-not (Test-Alive $procId))
}

# Our daemons that no pidfile records (pidfile written only after healthz, or a
# daemon that outlived the window that started it) - selected by IDENTITY, never
# by port, same rule as bin/hivemind's _reap_orphan_runtimes.
function Get-OrphanDaemons {
  $all = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue
  $out = @()
  foreach ($p in @($all)) {
    if ($p -and $p.CommandLine -and $p.CommandLine.IndexOf($RuntimeBin, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $out += [int]$p.ProcessId
    }
  }
  return $out
}

# Stop whatever daemon of ours is around (both pidfiles, then orphans). A pidfile
# PID that is not ours is never killed - only the stale pidfile is cleared.
function Remove-StaleRuntime {
  foreach ($f in @($RuntimePidFile, $SetupPidFile)) {
    $procId = Read-PidFile $f
    if ($procId -and (Test-Alive $procId)) {
      if (Test-IsOurDaemon $procId) { [void](Stop-OurDaemon $procId) }
    }
    Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
  }
  foreach ($procId in (Get-OrphanDaemons)) { [void](Stop-OurDaemon $procId) }
}

function Get-OpensslDir {
  $d = Get-Conf 'HIVEMIND_OPENSSL_DIR' ''
  if ($d -and (Test-Path -LiteralPath (Join-Path $d 'openssl.exe') -PathType Leaf)) { return $d }
  $onPath = Get-Command openssl.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($onPath) { return (Split-Path -Parent $onPath.Source) }
  return $null
}

# bun, resolved the way a log-on start can rely on: the autostart task (and the
# Startup-folder fallback) runs with the SCHEDULER's environment - the registry
# PATH, cwd C:\Windows\System32 - never the interactive shell's. A bun reachable
# only from the shell PATH made the task's `start` exit 1 with no trace (E5 CI,
# run 37548533915: bun on the job PATH only). Order: HIVEMIND_BUN_EXE (recorded
# by install.ps1) -> PATH -> %USERPROFILE%\.bun\bin\bun.exe (bun's installer).
function Resolve-BunExe {
  $c = Get-Conf 'HIVEMIND_BUN_EXE' ''
  if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { return $c }
  $onPath = Get-Command bun -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($onPath -and $onPath.Source) { return $onPath.Source }
  $d = Join-Path $UserHome '.bun\bin\bun.exe'
  if (Test-Path -LiteralPath $d -PathType Leaf) { return $d }
  return $null
}

function Assert-Prereqs {
  $script:BunExe = Resolve-BunExe
  if (-not $script:BunExe) {
    Write-Err "Error: 'bun' is required but not found. Install: powershell -c `"irm bun.sh/install.ps1 | iex`""
    exit 1
  }
  if (-not (Test-Path -LiteralPath $RuntimeBin -PathType Leaf)) {
    Write-Err "Error: runtime not found at $RuntimeBin. Re-run install.ps1."
    exit 1
  }
  $script:OpensslDir = Get-OpensslDir
  if (-not $script:OpensslDir) {
    Write-Err "Error: 'openssl' is required but not found. Re-run install.ps1 (it detects Git for Windows' openssl)."
    exit 1
  }
}

# ---- device-id (same file + rules as bin/hivemind _resolve_device_id) --------
function Write-Atomic([string]$path, [string]$content) {
  $tmp = "$path.tmp.$PID"
  [IO.File]::WriteAllText($tmp, $content + "`n", $Utf8NoBom)
  Move-Item -LiteralPath $tmp -Destination $path -Force
}

function Get-CertFingerprint([string]$certFile) {
  # Same shape as `openssl x509 -fingerprint -sha256` (upper hex, ':'-joined).
  try {
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certFile)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = $sha.ComputeHash($cert.RawData)
    return (($hash | ForEach-Object { $_.ToString('X2') }) -join ':')
  } catch { return '' }
}

function Resolve-DeviceId {
  $idFile = Join-Path $EngramDir 'device-id'
  $bindFile = Join-Path $EngramDir 'device-id-cert-binding'
  New-Item -ItemType Directory -Force -Path $EngramDir | Out-Null
  $id = ''
  if (Test-Path -LiteralPath $idFile -PathType Leaf) { $id = ([IO.File]::ReadAllText($idFile)).Trim() }
  if (-not $id) { $id = [guid]::NewGuid().ToString(); Write-Atomic $idFile $id }
  $certFile = Join-Path $CertDir "$Owner.cert.pem"
  if ($Owner -and (Test-Path -LiteralPath $certFile -PathType Leaf)) {
    $fp = Get-CertFingerprint $certFile
    if ($fp) {
      if ((Test-Path -LiteralPath $bindFile -PathType Leaf) -and (([IO.File]::ReadAllText($bindFile)).Trim()) -and (([IO.File]::ReadAllText($bindFile)).Trim() -ne $fp)) {
        Write-Err '[hivemind] device_id/cert binding MISMATCH - cert changed (re-enrollment) or device-id was copied from another machine. Regenerating device_id and rebinding to the current cert.'
        $id = [guid]::NewGuid().ToString(); Write-Atomic $idFile $id
      }
      Write-Atomic $bindFile $fp
    }
  }
  return $id
}

# ---- Daemon spawn ------------------------------------------------------------
# Spawned through ShellExecute (Start-Process WITHOUT -Redirect*), wrapped in
# `cmd /d /c "bun run server.ts >> log 2>&1"`:
#  - no handle inheritance: Start-Process -RedirectStandardOutput uses
#    CreateProcess(bInheritHandles=TRUE), so the daemon kept THIS process's
#    stdout/stderr open for its whole life and any caller capturing `hivemind
#    start` output through a pipe/file (CI, scripts, WSL) never saw EOF. Clearing
#    HANDLE_FLAG_INHERIT on the std handles did NOT stop it (measured); the
#    ShellExecute path did (measured: output file released on exit);
#  - one cumulative, appended log (hivemind-runtime.log), as on Linux;
#  - the environment is inherited (measured), so the setup nonce still travels
#    by environment only - never on a command line.
# The pidfile records the bun process (the cmd wrapper exits when bun does).
function Start-Daemon([string[]]$extraArgs, [hashtable]$extraEnv) {
  New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
  $saved = @{}
  $envSet = @{
    AR_PORT = $RuntimePort
    MTLS_PROXY_PORT = $ProxyPort
    PATH = "$script:OpensslDir;$env:PATH"   # the daemon spawns a bare `openssl`
  }
  foreach ($k in $extraEnv.Keys) { $envSet[$k] = $extraEnv[$k] }
  foreach ($k in $envSet.Keys) {
    $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
    [Environment]::SetEnvironmentVariable($k, [string]$envSet[$k], 'Process')
  }
  try {
    $extra = ''
    if ($extraArgs) { $extra = ' ' + ($extraArgs -join ' ') }
    $inner = "`"$($script:BunExe)`" run `"$RuntimeBin`"$extra >> `"$RuntimeLog`" 2>&1"
    $wrapper = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', "`"$inner`"") `
      -WorkingDirectory $RuntimeDir -WindowStyle Hidden -PassThru
  } finally {
    # Secrets (the setup nonce) never outlive the spawn in this process's env.
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
  }
  # Find the bun child of the wrapper (by parent PID + identity, never by port).
  for ($i = 0; $i -lt 40; $i++) {
    $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($wrapper.Id)" -ErrorAction SilentlyContinue)
    foreach ($k in $kids) {
      if ($k -and (Test-IsOurDaemon ([int]$k.ProcessId))) { return [int]$k.ProcessId }
    }
    if ($wrapper.HasExited) { return 0 }
    Start-Sleep -Milliseconds 125
  }
  return 0
}

# Wait for healthz; fail fast if the process died (EADDRINUSE / crash).
function Wait-Healthy([int]$procId, [int]$seconds = 15) {
  if (-not $procId) { return $false }
  for ($i = 0; $i -lt ($seconds * 4); $i++) {
    if (Test-RuntimeHealthy) {
      # Only OUR process answering counts - a foreign daemon on the port does not.
      if (Test-Alive $procId) { return $true }
    }
    if (-not (Test-Alive $procId)) { return $false }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

# ---- Setup (first run: no certificate) ---------------------------------------
function Invoke-SetupMode {
  Write-Output ''
  Write-Output "  * HiveMind - shared memory runtime"
  Write-Output "  -> $Endpoint"
  Write-Output 'First run detected - no certificate found.'
  Write-Output 'Starting setup server...'
  Remove-StaleRuntime

  # One-shot nonce: to the daemon via its environment only, to the user via the
  # URL printed below; never written to disk or to the log.
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $nonce = (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')

  $sp = Start-Daemon @('--setup-only') @{ HIVEMIND_SETUP_NONCE = $nonce }
  if ($sp) { [IO.File]::WriteAllText($SetupPidFile, "$sp`n", $Utf8NoBom) }
  if (-not (Wait-Healthy $sp 15)) {
    Write-Err "Error: the setup server did not start (port $RuntimePort busy or startup crash)."
    Write-Err "       Log: $RuntimeLog"
    if ($sp -and (Test-Alive $sp) -and (Test-IsOurDaemon $sp)) { [void](Stop-OurDaemon $sp) }
    Remove-Item -LiteralPath $SetupPidFile -Force -ErrorAction SilentlyContinue
    exit 1
  }

  $url = "http://localhost:$RuntimePort/setup?nonce=$nonce"
  Write-Output "Opening browser: $url"
  if ($env:HIVEMIND_NO_BROWSER -ne '1') {
    try { Start-Process $url | Out-Null } catch { Write-Output "(Could not open the browser - open it manually: $url)" }
  }
  Write-Output "Fill in your API Key, then click 'Configure mTLS'."
  Write-Output 'Waiting for enrollment to complete (timeout: 5 min)...'
  [Console]::Out.Flush()

  $done = $false
  for ($i = 0; $i -lt 300; $i++) {
    if (-not (Test-Alive $sp)) {
      Write-Err "Error: the setup server exited unexpectedly (pid $sp). Log: $RuntimeLog"
      Remove-Item -LiteralPath $SetupPidFile -Force -ErrorAction SilentlyContinue
      exit 1
    }
    $st = Invoke-Native { & curl.exe -s --max-time 3 "http://127.0.0.1:$RuntimePort/setup/status" 2>$null }
    if ("$st" -match '"done"\s*:\s*true') { $done = $true; break }
    Start-Sleep -Seconds 1
  }
  if ((Test-Alive $sp) -and (Test-IsOurDaemon $sp)) { [void](Stop-OurDaemon $sp) }
  Remove-Item -LiteralPath $SetupPidFile -Force -ErrorAction SilentlyContinue
  if (-not $done) {
    Write-Err 'Timeout: enrollment did not complete in 5 minutes.'
    exit 1
  }
  Write-Output ''
  Write-Output "Done. Run 'hivemind' to start the proxy."
  exit 0
}

# ---- Proxy start (idempotent) ------------------------------------------------
# The enrollment credentials the daemon needs to start the mTLS proxy (setup.ts
# writes them to .env). A certificate file alone is NOT enough (blocker 3b7a507e).
$CredentialKeys = @('MTLS_CERT_PATH', 'MTLS_KEY_PATH', 'MTLS_CA_PATH', 'HIVEMIND_OWNER', 'FOS_API_KEY')

# The proxy listener comes up next to healthz; give it a moment, fail fast if
# the daemon died.
function Wait-ProxyAlive([int]$procId, [int]$seconds = 10) {
  for ($i = 0; $i -lt ($seconds * 4); $i++) {
    if (Test-ProxyAlive) { return $true }
    if ($procId -and -not (Test-Alive $procId)) { return $false }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Get-ProxyDownMessage {
  $missing = @($CredentialKeys | Where-Object { -not (Get-Conf $_ '') })
  $lines = @("Error: a certificate is present in $CertDir but the mTLS proxy is not listening on port $ProxyPort after start - the runtime was stopped.")
  if ($missing.Count -gt 0) {
    $lines += "       $EnvFile is missing $($missing -join ', ') (the enrollment credentials); the certificate alone cannot start the proxy."
    $lines += "       Re-enroll: move the *.cert.pem / *.key.pem files out of $CertDir, then run 'hivemind' again."
  } else {
    $lines += "       Check the daemon log: $RuntimeLog"
  }
  return ($lines -join "`n")
}

# Returns '' when the runtime is up - and, when a certificate is present, the
# mTLS proxy is listening too (3b7a507e b) - else the error text. Never exits:
# the update's health check + rollback (Invoke-Update) call it as well.
function Start-ProxyCore {
  if ((Test-RuntimeHealthy) -and (Test-ProxyAlive)) {
    $procId = Read-PidFile $RuntimePidFile
    if ($procId -and (Test-IsOurDaemon $procId)) { return '' }
    # Healthy but not recorded: adopt it only if it IS ours; else fall through.
    $orph = @(Get-OrphanDaemons)
    if ($orph.Count -eq 1) { [IO.File]::WriteAllText($RuntimePidFile, "$($orph[0])`n", $Utf8NoBom); return '' }
  }
  Remove-StaleRuntime
  $deviceId = Resolve-DeviceId
  $dp = 0
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    $dp = Start-Daemon @() @{ HIVEMIND_DEVICE_ID = $deviceId }
    if (Wait-Healthy $dp 15) {
      # Pidfile only after healthz: never records a bun that died at startup.
      [IO.File]::WriteAllText($RuntimePidFile, "$dp`n", $Utf8NoBom)
      break
    }
    if ($dp -and (Test-Alive $dp) -and (Test-IsOurDaemon $dp)) { [void](Stop-OurDaemon $dp) }
    Remove-StaleRuntime
    $dp = 0
  }
  if (-not $dp) {
    return "Error: hivemind runtime did not start (port $RuntimePort busy or startup crash). Check: $RuntimeLog"
  }
  # healthz alone is not "started": with a certificate present the proxy must
  # listen, else every client fails later with no hint of why. Do not leave a
  # proxy-less daemon behind (the next start would adopt nothing anyway).
  if ((Test-HasCert) -and -not (Wait-ProxyAlive $dp 10)) {
    if ((Test-Alive $dp) -and (Test-IsOurDaemon $dp)) { [void](Stop-OurDaemon $dp) }
    Remove-Item -LiteralPath $RuntimePidFile -Force -ErrorAction SilentlyContinue
    return (Get-ProxyDownMessage)
  }
  return ''
}

function Start-Proxy {
  $e = Start-ProxyCore
  if ($e) { Write-Err $e; exit 1 }
}

function Get-DirectMcpUrl {
  if ($DirectMcpUrlOverride) { return $DirectMcpUrlOverride }
  if ($Endpoint -eq $DefaultEndpoint) { return $DirectMcpUrlDefault }
  return $null
}

function Write-ConnectHints {
  $url = "https://127.0.0.1:$ProxyPort/v1/mcp"
  $webHost = ($Endpoint -split ':')[0]
  Write-Output ''
  Write-Output 'HiveMind proxy is running (proxy-only install - Claude Code is not started).'
  Write-Output ''
  Write-Output "  MCP URL:  $url"
  Write-Output ''
  Write-Output '  Connect a client to it:'
  Write-Output "    Claude Code:  claude mcp add --transport http --scope user engram $url"
  Write-Output '    Codex:        add to %USERPROFILE%\.codex\config.toml:'
  Write-Output '                    [mcp_servers.engram]'
  Write-Output "                    url = `"$url`""
  Write-Output '    Any other MCP client: use the MCP URL above (streamable HTTP).'
  Write-Output ''
  Write-Output "  TLS: the proxy's certificate is issued by a local CA:"
  Write-Output "    $LocalHttpsCa"
  Write-Output '  It is NOT trusted automatically. Per client:'
  Write-Output "    curl.exe:            curl.exe --ssl-no-revoke --cacert `"$LocalHttpsCa`" $url ..."
  Write-Output '                         (--ssl-no-revoke is required: the local CA publishes no revocation list)'
  Write-Output "    Node-based clients:  set NODE_EXTRA_CA_CERTS=$LocalHttpsCa"
  Write-Output '    PowerShell/.NET and other Windows clients: trust the CA for your user'
  Write-Output "                         certutil -user -addstore Root `"$LocalHttpsCa`"   (Windows asks you to confirm)"
  Write-Output ''
  $direct = Get-DirectMcpUrl
  if ($direct) {
    Write-Output '  Fallback - a client that cannot use this local proxy can connect directly to the'
    Write-Output '  engram MCP over HTTPS with a bearer key (where your plan allows it):'
    Write-Output "    URL:     $direct"
    Write-Output '    Header:  Authorization: Bearer fospb_...'
    Write-Output "    Key:     create it in the HiveMind web app (https://$webHost/app), API Key access."
    Write-Output ''
  }
}

# ---- User-only ACL (same rule as install.ps1, decision 95a181bd) -------------
# chmod is a no-op on Windows: the parent dir is tightened (inheritance removed,
# one (OI)(CI) Full Control ACE for the current user) and children inherit it.
function Test-UserOnlyAcl([string]$path, [bool]$mustBeProtected = $false) {
  try {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl = Get-Acl -LiteralPath $path
    if ($mustBeProtected -and -not $acl.AreAccessRulesProtected) { return $false }
    if (@($acl.Access).Count -lt 1) { return $false }
    foreach ($rule in $acl.Access) {
      if ($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid) { return $false }
    }
    return $true
  } catch { return $false }
}

function Set-UserOnlyAcl([string]$dir) {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  [void](Invoke-Native { & icacls.exe $dir /inheritance:r /grant:r "*${sid}:(OI)(CI)F" /Q 2>&1 })
  if ($LASTEXITCODE -ne 0) { return $false }
  $acl = Get-Acl -LiteralPath $dir
  foreach ($rule in $acl.Access) {
    $rsid = $null
    try { $rsid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $rsid = "$($rule.IdentityReference)" }
    if ($rsid -ne $sid) {
      [void](Invoke-Native { & icacls.exe $dir /remove:g "*$rsid" /Q 2>&1 })
      if ($LASTEXITCODE -ne 0) { return $false }
    }
  }
  return (Test-UserOnlyAcl $dir $true)
}

# ---- Uninstall (item W3) -----------------------------------------------------
# Same contract as bin/hivemind `uninstall` (phase U), for what install.ps1 +
# enrollment write on Windows. Order: stop (pidfiles + identity, never by port)
# -> local HTTPS CA out of the user Root store -> %USERPROFILE%\.hivemind ->
# %USERPROFILE%\.engram (or, with -KeepCerts, everything but the mtls certs and
# device-id) -> the bun cache ONLY if install.ps1 recorded that it created it ->
# the launcher dir off the user Path -> (autostart: nothing yet, phase A) -> the
# launcher dir LAST.
# Invariants: only the fixed paths HiveMind writes are touched (no scan); every
# removal root passes Test-UninstallRoot first, and a single refusal aborts the
# whole uninstall before anything is stopped or removed; directory removal
# (Remove-Tree) never follows a junction/symlink inside the tree; never touches
# bun, openssl, Git, the clone, or any client config.
# Seams (process env only): HIVEMIND_INSTALL_USER_PATH_FILE (same as install.ps1)
# and HIVEMIND_UNINSTALL_ROOT_STORE (CurrentUser store name instead of Root).
$script:UninstallRoots = @()
$script:UninstallFailed = $false
$script:GuardVerb = 'uninstall'   # 'update' when Invoke-Update runs the same guard

function Get-NormPath([string]$p) {
  if (-not $p) { return '' }
  try { return [IO.Path]::GetFullPath($p).TrimEnd('\') } catch { return '' }
}

function Test-PathInside([string]$child, [string]$parent) {
  $c = $child.TrimEnd('\') + '\'
  $p = $parent.TrimEnd('\') + '\'
  return ($c.Length -gt $p.Length -and $c.StartsWith($p, [StringComparison]::OrdinalIgnoreCase))
}

# THE decider for every removal root. Absent path -> passes, not approved.
function Test-UninstallRoot([string]$label, [string]$path, [string]$base, [string]$kind) {
  if (-not $path) { Write-Err "Error: $label is empty - refusing to $script:GuardVerb."; return $false }
  $n = Get-NormPath $path
  $h = Get-NormPath $UserHome
  $b = Get-NormPath $base
  if (-not $n -or -not $b) { Write-Err "Error: $label ($path) is not a valid path - refusing to $script:GuardVerb."; return $false }
  if ($n -ieq $h -or (Test-PathInside $h $n)) {
    Write-Err "Error: $label ($n) is or contains your profile ($h) - refusing to $script:GuardVerb."; return $false
  }
  if (-not (Test-PathInside $n $b)) {
    Write-Err "Error: $label ($n) is not strictly inside $b - refusing to $script:GuardVerb."; return $false
  }
  $src = Get-NormPath (Get-Conf 'HIVEMIND_SOURCE_DIR' '')
  if ($src -and ($n -ieq $src -or (Test-PathInside $n $src) -or (Test-PathInside $src $n))) {
    Write-Err "Error: $label ($n) overlaps the HiveMind git clone ($src) - refusing to $script:GuardVerb."; return $false
  }
  if (-not (Test-Path -LiteralPath $n)) { return $true }
  $item = Get-Item -LiteralPath $n -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    Write-Err "Error: $label ($n) is a link/junction - refusing to $script:GuardVerb (remove it by hand)."; return $false
  }
  $up = $n
  while ($up -and (Test-PathInside $up $b) -or $up -ieq $n) {
    if (Test-Path -LiteralPath (Join-Path $up '.git')) {
      Write-Err "Error: $label ($n) is or is inside a git repository ($up) - refusing to $script:GuardVerb."; return $false
    }
    $up = Split-Path -Parent $up
    if (-not $up) { break }
  }
  $has = { param($rel) Test-Path -LiteralPath (Join-Path $n $rel) }
  switch ($kind) {
    'hivemind' {
      if (-not ((& $has '.components') -or (& $has 'runtime\src\server.ts'))) {
        Write-Err "Error: $label ($n) has no HiveMind fingerprint (.components or runtime\src\server.ts) - refusing to $script:GuardVerb."; return $false
      }
    }
    'engram' {
      $any = @(Get-ChildItem -LiteralPath $n -Force -ErrorAction SilentlyContinue)
      if ($any.Count -gt 0 -and -not ((& $has 'mtls') -or (& $has 'cache') -or (& $has 'device-id'))) {
        Write-Err "Error: $label ($n) has no HiveMind fingerprint (mtls\, cache\ or device-id) - refusing to $script:GuardVerb."; return $false
      }
    }
    'launcher' {
      if (-not ((& $has 'hivemind.ps1') -or (& $has 'hivemind.cmd'))) {
        Write-Err "Error: $label ($n) has no hivemind.ps1 / hivemind.cmd - refusing to $script:GuardVerb."; return $false
      }
    }
    'plain' { }
  }
  $script:UninstallRoots += $n
  return $true
}

# Delete a file/dir tree WITHOUT following junctions/symlinks: a reparse point
# is removed as a link (RemoveDirectory / DeleteFile), never descended into.
# Measured: bun's package cache holds directory links, on which
# [IO.Directory]::Delete(path, $true) fails with "access denied" half-way.
# ReadOnly flags are cleared first.
function Remove-Tree($info) {
  if ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    if ($info -is [IO.DirectoryInfo]) { [IO.Directory]::Delete($info.FullName, $false) } else { [IO.File]::Delete($info.FullName) }
    return
  }
  if ($info.Attributes -band [IO.FileAttributes]::ReadOnly) {
    $info.Attributes = $info.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
  }
  if ($info -is [IO.DirectoryInfo]) {
    foreach ($c in $info.GetFileSystemInfos()) { Remove-Tree $c }
    [IO.Directory]::Delete($info.FullName, $false)
  } else {
    [IO.File]::Delete($info.FullName)
  }
}

# Remove one file/dir - ONLY when it is an approved root or inside one.
function Remove-UninstallPath([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $n = Get-NormPath $path
  $ok = $false
  foreach ($r in $script:UninstallRoots) { if ($n -ieq $r -or (Test-PathInside $n $r)) { $ok = $true } }
  if (-not $ok) { Write-Err "  ! not removing ${path}: outside every guarded HiveMind root"; return }
  try { Remove-Tree (Get-Item -LiteralPath $n -Force) } catch { }
  if (Test-Path -LiteralPath $n) {
    Write-Err "  ! could not remove $n - remove it by hand:  rmdir /s /q `"$n`""
    $script:UninstallFailed = $true
  } else {
    Write-Output "  removed: $n"
  }
}

function Get-UninstallUserPathValue {
  $f = $env:HIVEMIND_INSTALL_USER_PATH_FILE
  if ($f) {
    if (Test-Path -LiteralPath $f) { return ([IO.File]::ReadAllText($f, $Utf8NoBom)).TrimEnd("`r", "`n") }
    return ''
  }
  $key = Get-Item -LiteralPath 'HKCU:\Environment'
  return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}

function Set-UninstallUserPathValue([string]$value) {
  $f = $env:HIVEMIND_INSTALL_USER_PATH_FILE
  if ($f) { [IO.File]::WriteAllText($f, $value + "`n", $Utf8NoBom); return }
  # ExpandString keeps %VAR% entries intact (same as install.ps1).
  Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value $value -Type ExpandString
  if (-not ('HiveMind.EnvBroadcast' -as [type])) {
    Add-Type -Namespace HiveMind -Name EnvBroadcast -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
  }
  $r = [UIntPtr]::Zero
  [void][HiveMind.EnvBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
}

# User Path entries that are the launcher dir (expanded, case-insensitive).
function Get-LauncherPathEntries([string]$binDir) {
  $norm = $binDir.TrimEnd('\')
  return @((Get-UninstallUserPathValue) -split ';' | Where-Object { $_ -and ([Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $norm) })
}

function Remove-LauncherFromUserPath([string]$binDir) {
  $value = Get-UninstallUserPathValue
  $norm = $binDir.TrimEnd('\')
  $all = @($value -split ';')
  $keep = @($all | Where-Object { -not ($_ -and ([Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $norm)) })
  if ($keep.Count -eq $all.Count) { return }
  try {
    Set-UninstallUserPathValue ($keep -join ';')
    Write-Output "  removed: $binDir from your user PATH"
  } catch {
    Write-Err "  ! could not edit your user PATH - remove $binDir from it by hand (System Properties > Environment Variables)."
    $script:UninstallFailed = $true
  }
}

function Get-LocalCaThumbprint {
  if (-not (Test-Path -LiteralPath $LocalHttpsCa -PathType Leaf)) { return $null }
  try { return (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($LocalHttpsCa)).Thumbprint } catch { return $null }
}

function Test-CaInStore([string]$store, [string]$thumb) {
  return [bool](Get-ChildItem -LiteralPath "Cert:\CurrentUser\$store" -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $thumb })
}

# Only the CA whose thumbprint is the local HTTPS CA's; must run before .engram
# (which holds that CA file) is removed. Failure -> manual command, continue.
function Remove-LocalCaFromStore([string]$store, [string]$thumb) {
  if (-not $thumb -or -not (Test-CaInStore $store $thumb)) { return }
  $out = Invoke-Native { & certutil.exe -user -delstore $store $thumb 2>&1 }
  if (Test-CaInStore $store $thumb) {
    Write-Err "  ! could not remove the local HTTPS CA from your $store store - run:"
    Write-Err "      certutil -user -delstore $store $thumb"
    $script:UninstallFailed = $true
  } else {
    Write-Output "  removed: local HTTPS CA $thumb from the CurrentUser\$store store"
  }
}

# uninstall -KeepCerts keeps the IDENTITY, and the identity is more than the
# cert files: the daemon starts the mTLS proxy only with MTLS_CERT_PATH/KEY_PATH/
# CA_PATH, and authenticates with HIVEMIND_OWNER + FOS_API_KEY - all in .hivemind\
# .env, which the uninstall removes (blocker 3b7a507e, owner decision a). Those
# keys (MTLS_* + HIVEMIND_OWNER + FOS_API_KEY, nothing else) are written to
# .engram\kept-credentials.env, which inherits .engram's user-only ACL; install.ps1
# merges them back into the new .env and deletes the file. Values are never
# printed. If the result is not user-only, the file is deleted again and the
# uninstall says re-enrollment will be needed.
function Save-KeptCredentials {
  if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { return }
  if (-not (Test-Path -LiteralPath $EngramDir -PathType Container)) { return }
  $keep = New-Object System.Collections.Generic.List[string]
  foreach ($raw in ([IO.File]::ReadAllText($EnvFile, $Utf8NoBom) -split "`r?`n")) {
    $line = $raw.Trim()
    if ($line -match '^(MTLS_[A-Z0-9_]+|HIVEMIND_OWNER|FOS_API_KEY)=') { $keep.Add($line) }
  }
  if ($keep.Count -eq 0) { return }
  $body = "# HiveMind - enrollment credentials kept by 'hivemind uninstall -KeepCerts'.`n" +
    "# install.ps1 merges them back into %USERPROFILE%\.hivemind\.env and deletes this file.`n" +
    (($keep -join "`n") + "`n")
  try {
    $tmp = "$KeptCredsFile.tmp.$PID"
    [IO.File]::WriteAllText($tmp, $body, $Utf8NoBom)
    Move-Item -LiteralPath $tmp -Destination $KeptCredsFile -Force
  } catch {
    Write-Err "  ! could not keep the enrollment credentials - after reinstalling, re-enroll (run hivemind)."
    $script:UninstallFailed = $true
    return
  }
  if (-not (Test-UserOnlyAcl $KeptCredsFile)) {
    Remove-Item -LiteralPath $KeptCredsFile -Force -ErrorAction SilentlyContinue
    Write-Err "  ! $EngramDir is not user-only - the enrollment credentials were NOT kept; after reinstalling, re-enroll."
    $script:UninstallFailed = $true
    return
  }
  Write-Output "  kept:    the enrollment credentials of .env ($($keep.Count) keys) in $KeptCredsFile (-KeepCerts)"
}

# ---- Autostart (impl 3e2c90da, phase A, item A2) ------------------------------
# `hivemind autostart on|off|status` - opt-in, default OFF (a default install or
# an update never creates it). Mechanism: a per-user Scheduled Task (no admin;
# measured 2026-10-06: a non-admin user registers an AtLogOn task for itself)
# whose action is the INSTALLED launcher (%LOCALAPPDATA%\hivemind\bin\
# hivemind.ps1, never the .cmd shim via PATH) with `start`, hidden. A log-on
# start runs the W7 update check like any start (founder 2026-10-05, A-2).
# Fallback when the registration is refused (e.g. policy): a .cmd in the user's
# Startup folder. Requires a certificate: a log-on start must never land in
# interactive enrollment.
# Test seams (process env only): HIVEMIND_AUTOSTART_TASK_NAME (a throwaway task
# name), HIVEMIND_AUTOSTART_STARTUP_DIR (the Startup folder), and
# HIVEMIND_AUTOSTART_FORCE_FALLBACK=1 (behave as if registration were refused).
$AutostartTaskName = 'HiveMindProxy'
if ($env:HIVEMIND_AUTOSTART_TASK_NAME) { $AutostartTaskName = $env:HIVEMIND_AUTOSTART_TASK_NAME }
$AutostartCmdName = 'hivemind-proxy.cmd'
$AutostartLog = Join-Path $CacheDir 'hivemind-autostart.log'

function Get-AutostartStartupDir {
  if ($env:HIVEMIND_AUTOSTART_STARTUP_DIR) { return $env:HIVEMIND_AUTOSTART_STARTUP_DIR }
  return [Environment]::GetFolderPath('Startup')
}

function Get-AutostartCmdFile {
  $d = Get-AutostartStartupDir
  if (-not $d) { return $null }
  return (Join-Path $d $AutostartCmdName)
}

function Get-InstalledLauncher {
  if (-not $env:LOCALAPPDATA) { return $null }
  return (Join-Path $env:LOCALAPPDATA 'hivemind\bin\hivemind.ps1')
}

# The log-on entry runs `autostart run` (not a bare `start`): same start, plus
# its own output and exit code appended to $AutostartLog - a log-on start has
# no console, so without it a failure there is invisible (E5 CI T5).
function Get-AutostartArguments([string]$launcher) {
  return "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" autostart run"
}

function Get-AutostartTask {
  if ($AutostartTaskName -notmatch '^[A-Za-z0-9._-]+$') { return $null }
  try {
    return (Get-ScheduledTask -TaskPath '\' -TaskName $AutostartTaskName -ErrorAction SilentlyContinue | Select-Object -First 1)
  } catch { return $null }
}

function Invoke-AutostartOn {
  if ($AutostartTaskName -notmatch '^[A-Za-z0-9._-]+$') { Write-Err "Error: invalid task name '$AutostartTaskName'."; exit 1 }
  if (-not (Test-HasCert)) {
    Write-Err "Error: no certificate yet - run 'hivemind' first (enrollment), then 'hivemind autostart on'."
    exit 1
  }
  $launcher = Get-InstalledLauncher
  if (-not $launcher -or -not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    Write-Err "Error: the installed launcher was not found ($launcher) - run install.ps1 first."
    exit 1
  }
  if ($launcher.IndexOfAny([char[]]@('"', '%')) -ge 0) {
    Write-Err "Error: '$launcher' cannot be written safely into an autostart entry (no quotes or % allowed)."
    exit 1
  }
  $argLine = Get-AutostartArguments $launcher
  $who = "$env:USERDOMAIN\$env:USERNAME"
  $registered = $false
  $why = ''
  if ($env:HIVEMIND_AUTOSTART_FORCE_FALLBACK -eq '1') {
    $why = 'registration skipped (HIVEMIND_AUTOSTART_FORCE_FALLBACK=1)'
  } else {
    try {
      $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $UserHome
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $who
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
      $principal = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Limited
      $desc = "HiveMind: starts the local mTLS proxy at log-on. Written by 'hivemind autostart on'; removed by 'hivemind autostart off' and 'hivemind uninstall'."
      Register-ScheduledTask -TaskPath '\' -TaskName $AutostartTaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Description $desc -Force -ErrorAction Stop | Out-Null
      $registered = $true
    } catch {
      $why = "$($_.Exception.Message)".Trim()
    }
  }
  $cmdFile = Get-AutostartCmdFile
  if ($registered) {
    # One mechanism at a time: a fallback file left by an earlier `on` would start it twice.
    if ($cmdFile -and (Test-Path -LiteralPath $cmdFile -PathType Leaf)) { Remove-Item -LiteralPath $cmdFile -Force }
    Write-Output "  Scheduled Task: \$AutostartTaskName (at log-on of $who)"
    Write-Output "    action: powershell.exe $argLine"
    Write-Output "    log:    $AutostartLog"
  } else {
    if (-not $cmdFile) { Write-Err "Error: the Scheduled Task was refused ($why) and the Startup folder is unknown - nothing was written."; exit 1 }
    $content = "@echo off`r`nrem HiveMind - written by 'hivemind autostart on'; removed by 'hivemind autostart off' and 'hivemind uninstall'.`r`n" +
      "start `"`" /min powershell.exe $argLine`r`n"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cmdFile) | Out-Null
    [IO.File]::WriteAllText($cmdFile, $content, [Text.Encoding]::ASCII)
    Write-Output "  Scheduled Task not available ($why)"
    Write-Output "  Startup folder fallback: $cmdFile"
    Write-Output "    log:    $AutostartLog"
  }
  Write-Output '[hivemind] autostart on. Undo: hivemind autostart off'
  exit 0
}

# Removes the task and the fallback file. Returns the number removed (messages go
# straight to the console, never the pipeline); never throws.
function Remove-Autostart {
  $n = 0
  $t = Get-AutostartTask
  if ($t) {
    try {
      Unregister-ScheduledTask -TaskPath '\' -TaskName $AutostartTaskName -Confirm:$false -ErrorAction Stop
      [Console]::Out.WriteLine("  removed: scheduled task \$AutostartTaskName")
      $n++
    } catch {
      Write-Err "  ! could not remove scheduled task \$AutostartTaskName - remove it by hand: schtasks /delete /tn $AutostartTaskName /f"
      $script:UninstallFailed = $true
    }
  }
  $cmdFile = Get-AutostartCmdFile
  if ($cmdFile -and (Test-Path -LiteralPath $cmdFile -PathType Leaf)) {
    try {
      Remove-Item -LiteralPath $cmdFile -Force
      [Console]::Out.WriteLine("  removed: $cmdFile")
      $n++
    } catch {
      Write-Err "  ! could not remove $cmdFile - delete it by hand."
      $script:UninstallFailed = $true
    }
  }
  return $n
}

function Get-AutostartPlanLines {
  $lines = @()
  if (Get-AutostartTask) { $lines += "    scheduled task \$AutostartTaskName (autostart at log-on)" }
  $cmdFile = Get-AutostartCmdFile
  if ($cmdFile -and (Test-Path -LiteralPath $cmdFile -PathType Leaf)) { $lines += "    $cmdFile (autostart at log-on)" }
  return $lines
}

function Invoke-AutostartStatus {
  $on = $false
  Write-Output 'HiveMind autostart'
  $t = Get-AutostartTask
  if ($t) {
    $on = $true
    $info = $null
    try { $info = Get-ScheduledTaskInfo -TaskPath '\' -TaskName $AutostartTaskName -ErrorAction Stop } catch { }
    Write-Output "  Scheduled Task: \$AutostartTaskName ($($t.State))"
    Write-Output "    action: $($t.Actions[0].Execute) $($t.Actions[0].Arguments)"
    if ($info) { Write-Output "    last run: $($info.LastRunTime)  last result: $($info.LastTaskResult)" }
  } else {
    Write-Output '  Scheduled Task: not registered'
  }
  $cmdFile = Get-AutostartCmdFile
  if ($cmdFile -and (Test-Path -LiteralPath $cmdFile -PathType Leaf)) {
    $on = $true
    Write-Output "  Startup folder fallback: $cmdFile"
  }
  if (Test-Path -LiteralPath $AutostartLog -PathType Leaf) { Write-Output "  Log of the log-on starts: $AutostartLog" }
  if ($on) { Write-Output 'autostart: on' } else { Write-Output 'autostart: off' }
  exit 0
}

# `hivemind autostart run` - what the log-on task / Startup entry executes. Runs
# `start` in a child (same launcher, hidden console) with its stdout/stderr
# captured, then appends a header (who, cwd, the bun and openssl it resolved,
# PATH size), that output and the exit code to $AutostartLog (kept under 1 MB:
# one rotation to .1). Exits with start's code, so the task's last result is
# start's. Never prompts: no console behind a log-on start.
function Invoke-AutostartRun {
  try { Set-Location -LiteralPath $UserHome } catch { }
  New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
  try {
    if ((Test-Path -LiteralPath $AutostartLog -PathType Leaf) -and ((Get-Item -LiteralPath $AutostartLog).Length -gt 1MB)) {
      Move-Item -LiteralPath $AutostartLog -Destination "$AutostartLog.1" -Force
    }
  } catch { }
  $bun = Resolve-BunExe; if (-not $bun) { $bun = 'NOT FOUND' }
  $ssl = Get-OpensslDir; if (-not $ssl) { $ssl = 'NOT FOUND' }
  $pathN = @("$env:PATH" -split ';' | Where-Object { $_ }).Count
  $head = "=== $((Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')) autostart run: user=$env:USERDOMAIN\$env:USERNAME pid=$PID cwd=$((Get-Location).Path) launcher=$PSCommandPath bun=$bun openssl-dir=$ssl PATH-entries=$pathN"
  $out = "$AutostartLog.$PID.out"; $err = "$AutostartLog.$PID.err"
  $code = 1
  $body = ''
  try {
    $ps = Join-Path $PSHOME 'powershell.exe'
    $p = Start-Process -FilePath $ps -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", 'start') `
      -WorkingDirectory $UserHome -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    $null = $p.Handle   # PS 5.1: without touching Handle, ExitCode reads back as $null
    if ($p.WaitForExit(600000)) { $p.WaitForExit(); $code = $p.ExitCode } else { $body += "start did not exit within 10 min`n" }
    foreach ($f in @($out, $err)) {
      if (Test-Path -LiteralPath $f) { $body += [IO.File]::ReadAllText($f) }
    }
  } catch {
    $body += "autostart run failed to launch start: $($_.Exception.Message)`n"
  } finally {
    Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue
  }
  $txt = $head + "`n" + ($body.TrimEnd() -replace "`r`n", "`n") + "`n=== exit $code`n"
  try { [IO.File]::AppendAllText($AutostartLog, $txt, $Utf8NoBom) } catch { }
  exit $code
}

function Invoke-Autostart([string[]]$argv) {
  $sub = ''
  if ($argv.Count -gt 0) { $sub = [string]$argv[0] }
  switch -Exact ($sub) {
    'on'     { Invoke-AutostartOn }
    'status' { Invoke-AutostartStatus }
    'run'    { Invoke-AutostartRun }
    'off' {
      $script:UninstallFailed = $false
      $n = Remove-Autostart
      if ($n -gt 0) { Write-Output "[hivemind] autostart off (a running proxy keeps running; 'hivemind stop' stops it)." }
      else { Write-Output '[hivemind] autostart is already off - nothing to remove.' }
      if ($script:UninstallFailed) { exit 1 }
      exit 0
    }
    default { Write-Err 'Usage: hivemind autostart on|off|status'; exit 1 }
  }
}

# The launcher dir goes LAST. When this script IS the installed launcher, the
# hivemind.cmd shim that started it is still running and re-reads its batch
# file after PowerShell exits - deleting the dir now makes cmd fail with "path
# not found" and exit 1 (measured). So the removal is handed to a detached,
# hidden PowerShell (ShellExecute: no inherited handles) that waits for this
# process to exit, gives cmd a moment to finish the shim, then deletes.
function Remove-LauncherDir([string]$binDir) {
  if (-not (Test-Path -LiteralPath $binDir)) { return }
  $parent = Split-Path -Parent $binDir
  $self = Get-NormPath $PSCommandPath
  if ($self -and (Test-PathInside $self $binDir)) {
    $q = { param($s) "'" + ($s -replace "'", "''") + "'" }
    $cmd = "Wait-Process -Id $PID -Timeout 120 -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; " +
      "try { Remove-Item -LiteralPath $(& $q $binDir) -Recurse -Force } catch { }; " +
      "if ((Test-Path -LiteralPath $(& $q $parent)) -and -not (Get-ChildItem -LiteralPath $(& $q $parent) -Force)) { Remove-Item -LiteralPath $(& $q $parent) -Force }"
    try {
      Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', $cmd) | Out-Null
      Write-Output "  removing: $binDir (right after this command exits)"
      Write-Output "           if it is still there afterwards:  rmdir /s /q `"$binDir`""
    } catch {
      Write-Err "  ! could not schedule the removal of $binDir - remove it by hand:  rmdir /s /q `"$binDir`""
      $script:UninstallFailed = $true
    }
    return
  }
  Remove-UninstallPath $binDir
  if ((Test-Path -LiteralPath $parent) -and -not (Get-ChildItem -LiteralPath $parent -Force)) {
    if (Test-UninstallRoot 'the empty launcher parent dir' $parent $env:LOCALAPPDATA 'plain') { Remove-UninstallPath $parent }
  }
}

function Invoke-UninstallHelp {
  Write-Output 'Usage: hivemind uninstall [-Yes] [-KeepCerts]'
  Write-Output '       (from the clone: powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-Yes] [-KeepCerts])'
  Write-Output ''
  Write-Output '  Removes everything HiveMind installed for this Windows user (proxy-only):'
  Write-Output '    the running daemon (stopped through its pidfile / process identity),'
  Write-Output '    the local HTTPS CA from your CurrentUser Root store (only if you added it),'
  Write-Output '    %USERPROFILE%\.hivemind (runtime, .env) + its update copies (.hivemind.staging / .last-good),'
  Write-Output '    %USERPROFILE%\.engram (certs, device id, cache),'
  Write-Output '    %USERPROFILE%\.bun\install\cache ONLY if the HiveMind install created it,'
  Write-Output '    the launcher dir (%LOCALAPPDATA%\hivemind\bin) and its user PATH entry,'
  Write-Output '    the autostart Scheduled Task / Startup-folder entry (hivemind autostart).'
  Write-Output '  The full list is printed first; without -Yes you are asked to confirm [y/N]'
  Write-Output '  (a terminal is required - without one, pass -Yes).'
  Write-Output ''
  Write-Output '  -Yes, -y, --yes            Do not ask for confirmation.'
  Write-Output '  -KeepCerts, --keep-certs   Keep the identity: %USERPROFILE%\.engram\mtls certs, device-id, the'
  Write-Output '                             trusted local CA and the enrollment credentials from .env (moved to'
  Write-Output '                             %USERPROFILE%\.engram\kept-credentials.env, user-only; install.ps1'
  Write-Output '                             merges them back) - no re-enrollment needed. Cache + port-map.json go.'
  Write-Output ''
  Write-Output '  Never touched: bun, openssl, Git, the git clone, any MCP client config. No server-side revoke.'
}

function Invoke-Uninstall([string[]]$argv) {
  $yes = $false; $keep = $false
  foreach ($a in $argv) {
    switch -Exact ($a) {
      { $_ -in @('-Yes', '--yes', '-y', '/y') } { $yes = $true; continue }
      { $_ -in @('-KeepCerts', '--keep-certs') } { $keep = $true; continue }
      { $_ -in @('-h', '--help', '-Help', 'help') } { Invoke-UninstallHelp; exit 0 }
      'all' { continue }
      { $_ -in @('harness', 'proxy') } {
        Write-Err "Error: a Windows install is proxy-only - there is no '$a' component to remove on its own. Use: hivemind uninstall [-Yes]"
        exit 1
      }
      default {
        Write-Err "Error: unknown argument '$a' for 'hivemind uninstall'."
        Write-Err '       Usage: hivemind uninstall [-Yes] [-KeepCerts]'
        exit 1
      }
    }
  }

  $lad = $env:LOCALAPPDATA
  if (-not $lad) { Write-Err 'Error: LOCALAPPDATA is not set - refusing to $script:GuardVerb.'; exit 1 }
  $binDir = Join-Path $lad 'hivemind\bin'
  $bunCache = Join-Path $UserHome '.bun\install\cache'
  $bunMarker = Join-Path $HivemindHome '.bun-cache-created'
  $rootStore = 'Root'
  if ($env:HIVEMIND_UNINSTALL_ROOT_STORE) { $rootStore = $env:HIVEMIND_UNINSTALL_ROOT_STORE }

  # Guard first: any refusal aborts before anything is stopped or removed.
  $script:UninstallRoots = @()
  $okAll = (Test-UninstallRoot 'HIVEMIND_HOME' $HivemindHome $UserHome 'hivemind') -and
    (Test-UninstallRoot 'the engram dir' $EngramDir $UserHome 'engram') -and
    (Test-UninstallRoot 'the launcher dir' $binDir $lad 'launcher') -and
    (Test-UninstallRoot 'the update staging dir' $StagingDir $UserHome 'plain') -and
    (Test-UninstallRoot 'the update rollback copy' $LastGoodDir $UserHome 'plain')
  if (-not $okAll) { exit 1 }

  # The bun cache: only what install.ps1 recorded creating (read BEFORE .hivemind goes).
  $bunCreated = @()
  if (Test-Path -LiteralPath $bunMarker -PathType Leaf) {
    $bunCreated = @(([IO.File]::ReadAllText($bunMarker)) -split "`r?`n" | Where-Object { $_ -in @('.bun', '.bun\install', '.bun\install\cache') })
  }
  $removeBunCache = ($bunCreated -contains '.bun\install\cache') -and (Test-Path -LiteralPath $bunCache)
  if ($removeBunCache -and -not (Test-UninstallRoot 'the bun cache' $bunCache $UserHome 'plain')) { exit 1 }

  if (-not $yes -and -not (Test-Interactive)) {
    Write-Err "Error: 'hivemind uninstall' asks for confirmation and the input is not a terminal."
    Write-Err '       Run it in an interactive terminal, or pass -Yes to skip the confirmation.'
    exit 1
  }

  $thumb = Get-LocalCaThumbprint
  $caInStore = ($thumb -and (Test-CaInStore $rootStore $thumb))
  $pathEntries = @()
  try { $pathEntries = @(Get-LauncherPathEntries $binDir) } catch { }
  $daemonPids = @()
  foreach ($f in @($RuntimePidFile, $SetupPidFile)) {
    $p = Read-PidFile $f
    if ($p -and (Test-Alive $p) -and (Test-IsOurDaemon $p)) { $daemonPids += $p }
  }
  foreach ($p in (Get-OrphanDaemons)) { if ($daemonPids -notcontains $p) { $daemonPids += $p } }

  $plan = New-Object System.Collections.Generic.List[string]
  if ($daemonPids.Count -gt 0) { $plan.Add("    daemon: pid $($daemonPids -join ', ') (forced stop of the verified process)") }
  if ($caInStore -and -not $keep) { $plan.Add("    CurrentUser\$rootStore certificate store: local HTTPS CA $thumb") }
  if (Test-Path -LiteralPath $HivemindHome) { $plan.Add("    $HivemindHome\ (runtime, .env)") }
  foreach ($aux in @($StagingDir, $LastGoodDir)) {
    if (Test-Path -LiteralPath $aux) { $plan.Add("    $aux\ (update staging / rollback copy - holds a copy of .env)") }
  }
  if (Test-Path -LiteralPath $EngramDir) {
    if ($keep) { $plan.Add("    $EngramDir\ except mtls\ certs + device-id (cache and port-map.json DO go); the enrollment credentials of .env are kept in $KeptCredsFile") }
    else { $plan.Add("    $EngramDir\ (certificates, device id, cache)") }
  }
  if ($removeBunCache) { $plan.Add("    $bunCache\ (created by the HiveMind install)") }
  foreach ($e in $pathEntries) { $plan.Add("    user PATH entry: $e") }
  if (Test-Path -LiteralPath $binDir) { $plan.Add("    $binDir\ (the hivemind launcher)") }
  foreach ($l in @(Get-AutostartPlanLines)) { $plan.Add($l) }

  if ($plan.Count -eq 0) {
    Write-Output 'Nothing of HiveMind is installed for this user - nothing to remove.'
    exit 0
  }

  Write-Output 'HiveMind - uninstall. This removes:'
  Write-Output ''
  foreach ($l in $plan) { Write-Output $l }
  Write-Output ''
  if ($keep -and $caInStore) { Write-Output "  Kept (-KeepCerts): the local HTTPS CA in CurrentUser\$rootStore, mtls\ certs, device-id." }
  if ((Test-Path -LiteralPath $bunCache) -and -not $removeBunCache) {
    Write-Output "  Kept: $bunCache - your bun cache, not created by the HiveMind install."
  }
  Write-Output '  Kept: bun, openssl, Git, the git clone, your MCP client configs.'
  Write-Output ''

  if (-not $yes) {
    $ans = Read-Host 'Remove all of the above? [y/N]'
    if ($ans -notin @('y', 'Y', 'yes', 'YES', 's', 'S', 'sim', 'SIM')) { Write-Output 'Aborted - nothing removed.'; exit 0 }
  }

  # 1. Stop: pidfiles + identity (never by port); wait for the cmd wrappers too,
  #    whose working directory is inside .hivemind\runtime.
  Remove-StaleRuntime
  for ($i = 0; $i -lt 40; $i++) {
    $left = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf($RuntimeBin, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
    if ($left.Count -eq 0) { break }
    Start-Sleep -Milliseconds 125
  }
  if ($daemonPids.Count -gt 0) { Write-Output "  stopped: daemon pid $($daemonPids -join ', ')" }

  # 2. Root store (before .engram, which holds the CA file it is matched against).
  if (-not $keep) { Remove-LocalCaFromStore $rootStore $thumb }

  # 3. .hivemind (with -KeepCerts, its credential keys are moved to .engram FIRST)
  if ($keep) { Save-KeptCredentials }
  Remove-UninstallPath $HivemindHome
  # 3b. The update's staging dir and rollback copy (each holds a copy of .env).
  Remove-UninstallPath $StagingDir
  Remove-UninstallPath $LastGoodDir

  # 4. .engram
  if ($keep) {
    if (Test-Path -LiteralPath $EngramDir) {
      foreach ($e in @(Get-ChildItem -LiteralPath $EngramDir -Force)) {
        if ($e.Name -in @('mtls', 'device-id', 'device-id-cert-binding', 'kept-credentials.env')) { continue }
        Remove-UninstallPath $e.FullName
      }
      if (Test-Path -LiteralPath $CertDir) {
        foreach ($e in @(Get-ChildItem -LiteralPath $CertDir -Force -Filter 'port-map.json*')) { Remove-UninstallPath $e.FullName }
      }
      Write-Output "  kept:    $CertDir certs + device-id (-KeepCerts)"
    }
  } else {
    Remove-UninstallPath $EngramDir
  }

  # 5. The bun cache this install created (parents only if it created them AND they are now empty).
  if ($removeBunCache) {
    Remove-UninstallPath $bunCache
    foreach ($rel in @('.bun\install', '.bun')) {
      $d = Join-Path $UserHome $rel
      if (($bunCreated -contains $rel) -and (Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force)) {
        if (Test-UninstallRoot "the empty $rel dir" $d $UserHome 'plain') { Remove-UninstallPath $d }
      }
    }
  }

  # 6. User PATH, 7. autostart (task / Startup fallback), 8. the launcher dir LAST.
  Remove-LauncherFromUserPath $binDir
  [void](Remove-Autostart)
  Remove-LauncherDir $binDir

  Write-Output ''
  if ($script:UninstallFailed) {
    Write-Err 'HiveMind uninstall finished WITH ERRORS - see the lines marked ! above.'
    exit 1
  }
  Write-Output 'HiveMind uninstalled. Kept on purpose: bun, openssl, Git, the git clone, your MCP client configs.'
  Write-Output 'Not done: no server-side revoke - this device record stays on the engram.'
  Write-Output 'Reinstall: powershell -ExecutionPolicy Bypass -File install.ps1 (from the clone), then run hivemind.'
  exit 0
}

# ---- Update (item W7) --------------------------------------------------------
# Port of bin/hivemind cmd_update + _maybe_auto_update for a proxy-only Windows
# install. Same model: pinned origin -> fetch -> reset --hard origin/<branch> ->
# integrity (git verify-commit, OR HEAD == the LATEST_SHA manifest at
# https://<endpoint host>/hivemind/LATEST_SHA) else revert + abort -> stage into
# %USERPROFILE%\.hivemind.staging -> stop -> rename live -> .last-good, staging ->
# live -> launcher swap -> start + health (healthz AND, with a certificate, the
# mTLS proxy listening) -> on failure: restore .last-good + the launcher, reset
# the clone, restart.
# Windows specifics (measured in W0/W7 smoke):
#  - the daemon AND its cmd wrapper (whose working dir is inside .hivemind\
#    runtime) are gone before any rename: an open handle / CWD makes the rename
#    fail -> abort with nothing changed;
#  - the staged tree carries EVERY top-level entry of the live tree except
#    runtime\ (the git-managed part) - .env, .components, .claude\, and whatever
#    gets written there next - never an allowlist;
#  - the staging dir gets the user-only ACL BEFORE .env is copied into it, and
#    the ACL is re-asserted on the live tree after every swap / rollback;
#  - hivemind.cmd is FROZEN (cmd.exe reads a running batch file by offset): only
#    hivemind.ps1 is replaced, via hivemind.ps1.new + Move-Item, keeping
#    hivemind.ps1.last-good. PowerShell has parsed this whole file already, so
#    replacing it mid-run is safe.
# Output goes straight to the console (never the pipeline); the result code is
# $script:UpdateRc. -Quiet (the on-launch check) prints nothing.
$script:UpdateQuiet = $false
$script:UpdateRc = 0
function Say([string]$m) { if (-not $script:UpdateQuiet) { [Console]::Out.WriteLine($m) } }
function SayErr([string]$m) { if (-not $script:UpdateQuiet) { [Console]::Error.WriteLine($m) } }

function Invoke-GitIn([string]$dir, [string[]]$gitArgs) {
  $o = Invoke-Native { & git -C $dir @gitArgs 2>&1 }
  $script:GitExit = $LASTEXITCODE
  return ((@($o) -join "`n").Trim())
}

function Get-LauncherPs1 {
  if (-not $env:LOCALAPPDATA) { return '' }
  return (Join-Path $env:LOCALAPPDATA 'hivemind\bin\hivemind.ps1')
}

# 0 = trusted. (a) a signature git already trusts; (b) HEAD equals the LATEST_SHA
# manifest published on the product HTTPS domain (a channel separate from git).
# Fetched with curl.exe (ships with Windows 10+, already used for every probe
# here): Windows PowerShell 5.1's Invoke-WebRequest needs -UseBasicParsing and
# may not offer TLS 1.2 by default. Fails CLOSED: unreachable / empty manifest
# = untrusted. HIVEMIND_UPDATE_CA_FILE (test seam, process env only) pins the CA
# for this one fetch (+ --ssl-no-revoke: a local CA publishes no CRL).
function Test-CommitIntegrity([string]$dir) {
  [void](Invoke-GitIn $dir @('verify-commit', 'HEAD'))
  if ($script:GitExit -eq 0) { return $true }
  $hostName = ($Endpoint -split ':')[0]
  if (-not $hostName) { return $false }
  $curlArgs = @('-sf', '--max-time', '5', "https://$hostName/hivemind/LATEST_SHA")
  if ($env:HIVEMIND_UPDATE_CA_FILE) { $curlArgs = @('--cacert', $env:HIVEMIND_UPDATE_CA_FILE, '--ssl-no-revoke') + $curlArgs }
  $exp = Invoke-Native { & curl.exe @curlArgs 2>$null }
  if ($LASTEXITCODE -ne 0) { return $false }
  $exp = ((@($exp) -join '') -replace '\s', '')
  if (-not $exp) { return $false }
  return ((Invoke-GitIn $dir @('rev-parse', 'HEAD')) -eq $exp)
}

function Remove-DirTree([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $true }
  try { Remove-Tree (Get-Item -LiteralPath $path -Force) } catch { }
  return (-not (Test-Path -LiteralPath $path))
}

# Stop the daemon and wait for every process whose command line names this
# install's server.ts (the bun AND its cmd wrapper) - they hold the runtime dir.
function Stop-AllOurs {
  Remove-StaleRuntime
  for ($i = 0; $i -lt 80; $i++) {
    $left = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf($RuntimeBin, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
    if ($left.Count -eq 0) { return $true }
    foreach ($p in $left) { if ($p.Name -in @('bun.exe', 'bun')) { [void](Stop-OurDaemon ([int]$p.ProcessId)) } }
    Start-Sleep -Milliseconds 125
  }
  return $false
}

# Directory rename with a short retry (an indexer / AV handle can linger).
function Move-Dir([string]$from, [string]$to) {
  for ($i = 0; $i -lt 20; $i++) {
    try { [IO.Directory]::Move($from, $to); return $true } catch { Start-Sleep -Milliseconds 250 }
  }
  return $false
}

# Build the new tree in $target from the clone, never touching the live one.
function New-StagedTree([string]$src, [string]$target) {
  if (-not (Remove-DirTree $target)) { return "could not clear an old $target" }
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  # User-only BEFORE any secret (.env) lands in it.
  if (-not (Set-UserOnlyAcl $target)) { return "could not make $target user-only" }
  # Tier 1 - git-managed: runtime\ from the clone (minus node_modules, bun.lock) + bun install.
  $srcRoot = (Resolve-Path -LiteralPath (Join-Path $src 'runtime')).ProviderPath.TrimEnd('\')
  $dstRoot = Join-Path $target 'runtime'
  New-Item -ItemType Directory -Force -Path $dstRoot | Out-Null
  foreach ($it in @(Get-ChildItem -LiteralPath $srcRoot -Recurse -Force)) {
    $rel = $it.FullName.Substring($srcRoot.Length + 1)
    if ($rel -match '(^|\\)node_modules(\\|$)' -or $rel -eq 'bun.lock') { continue }
    $dst = Join-Path $dstRoot $rel
    if ($it.PSIsContainer) { New-Item -ItemType Directory -Force -Path $dst | Out-Null }
    else { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null; Copy-Item -LiteralPath $it.FullName -Destination $dst -Force }
  }
  Push-Location -LiteralPath $dstRoot
  try {
    # --production: runtime deps only, never the devDependencies (item D3).
    [void](Invoke-Native { & $script:BunExe install --production --silent 2>&1 })
    if ($LASTEXITCODE -ne 0) { [void](Invoke-Native { & $script:BunExe install --production 2>&1 }) }
    $bunExit = $LASTEXITCODE
  } finally { Pop-Location }
  if ($bunExit -ne 0) { return "bun install failed in $dstRoot" }
  # Tier 2 - runtime-written: EVERY other entry of the live tree, as is (live wins).
  foreach ($e in @(Get-ChildItem -LiteralPath $HivemindHome -Force)) {
    if ($e.Name -ieq 'runtime') { continue }
    try { Copy-Item -LiteralPath $e.FullName -Destination (Join-Path $target $e.Name) -Recurse -Force }
    catch { return "could not carry $($e.Name) into the staged tree: $_" }
  }
  return ''
}

function Update-LauncherFile([string]$src) {
  $lp = Get-LauncherPs1
  if (-not $lp -or -not (Test-Path -LiteralPath $lp -PathType Leaf)) { return $true }   # not installed (run from the clone)
  try {
    Copy-Item -LiteralPath $lp -Destination "$lp.last-good" -Force
    Copy-Item -LiteralPath (Join-Path $src 'bin\hivemind.ps1') -Destination "$lp.new" -Force
    Move-Item -LiteralPath "$lp.new" -Destination $lp -Force
    return $true
  } catch {
    Remove-Item -LiteralPath "$lp.new" -Force -ErrorAction SilentlyContinue
    return $false
  }
}

function Restore-LauncherFile {
  $lp = Get-LauncherPs1
  if ($lp -and (Test-Path -LiteralPath "$lp.last-good" -PathType Leaf)) {
    try { Move-Item -LiteralPath "$lp.last-good" -Destination $lp -Force } catch { SayErr "  ! could not restore $lp from $lp.last-good" }
  }
}

# Health after a swap: healthz AND (with a certificate) the proxy listening.
# Without a certificate (not enrolled yet) healthz is the whole check and the
# daemon is not left running (a proxy-only daemon without a cert serves nothing).
function Test-UpdatedRuntime {
  $e = Start-ProxyCore
  if ($e) { return $false }
  if (-not (Test-HasCert)) { [void](Stop-AllOurs) }
  return $true
}

# F4/G1 - update integrity. INVARIANT: an update never discards local work in
# HIVEMIND_SOURCE_DIR. An update runs `git reset --hard` on its source, so it
# runs only on a source that is, by CONTENT:
#   (a) clean - `git status --porcelain --untracked-files=no` is empty;
#   (b) fast-forwardable - HEAD is reachable from the fetched origin/<branch>
#       (checked only when $ref is given, i.e. after the fetch);
#   (c) answerable - any git query here that fails refuses (fail CLOSED).
# Plus the shape signal: a source that tracks .github\ is a development clone
# (a dist clone never does) and Windows has no managed clone to move it to - it
# is never updated. Nothing is exempt: a dist clone passes only because it is
# clean and fast-forwardable. Read-only (ls-files, rev-parse, merge-base, and
# status with --no-optional-locks: no index refresh written).
# Returns '' = safe, else the reason to refuse.
function Get-UpdateSourceRefusal([string]$src, [string]$ref = '') {
  $failed = { param($q) "a git query on it failed (git $q, exit $($script:GitExit)) - cannot prove it holds no local work" }
  try {
    [void](Invoke-GitIn $src @('ls-files', '--error-unmatch', '.github'))
    if ($script:GitExit -eq 0) { return 'it is a development clone (it tracks .github\)' }
    if ($script:GitExit -ne 1) { return (& $failed 'ls-files') }
    [void](Invoke-GitIn $src @('rev-parse', '--verify', '-q', 'HEAD'))
    if ($script:GitExit -ne 0) { return (& $failed 'rev-parse HEAD') }
    $st = Invoke-GitIn $src @('--no-optional-locks', 'status', '--porcelain', '--untracked-files=no')
    if ($script:GitExit -ne 0) { return (& $failed 'status') }
    if ($st) { return 'it has uncommitted changes to tracked files' }
    if ($ref) {
      [void](Invoke-GitIn $src @('merge-base', '--is-ancestor', 'HEAD', $ref))
      if ($script:GitExit -eq 1) { return "its HEAD has commits that are not on $ref (local or unpushed work)" }
      if ($script:GitExit -ne 0) { return (& $failed 'merge-base') }
    }
    return ''
  } catch { return "a git query on it failed ($($_.Exception.Message)) - cannot prove it holds no local work" }
}

function Write-UpdateRefusal([string]$src, [string]$why) {
  if ($script:UpdateQuiet) {
    if ($script:VerboseLog) { Write-Err "[hivemind] auto-update skipped: ${src}: $why - never reset --hard" }
    return
  }
  $hint = 'Commit and push (or stash) that work, or point HIVEMIND_SOURCE_DIR at a clean clone, then run ''hivemind update'' again.'
  if ($why -like '*development clone*') { $hint = 'Install from the distribution repository (or re-run install.ps1 from a dist clone) to get updates.' }
  SayErr "Error: refusing to update - ${src}: $why. An update runs 'git reset --hard' on its source and would discard that work. Nothing was changed. $hint"
}

function Invoke-Update {
  $script:UpdateRc = 1
  $src = Get-Conf 'HIVEMIND_SOURCE_DIR' ''
  if (-not $src -or -not (Test-Path -LiteralPath (Join-Path $src '.git'))) {
    SayErr 'Error: HIVEMIND_SOURCE_DIR not set or not a git clone - re-run install.ps1 from a clone to pin the update source.'
    return
  }
  $why = Get-UpdateSourceRefusal $src
  if ($why) { Write-UpdateRefusal $src $why; return }
  # The swap renames/deletes these three fixed paths: same guard as the
  # uninstall (inside the profile, never the profile itself, never the clone,
  # no link/junction, HiveMind fingerprint on the live tree).
  $script:GuardVerb = 'update'
  $script:UninstallRoots = @()
  $guardOk = (Test-UninstallRoot 'HIVEMIND_HOME' $HivemindHome $UserHome 'hivemind') -and
    (Test-UninstallRoot 'the update staging dir' $StagingDir $UserHome 'plain') -and
    (Test-UninstallRoot 'the update rollback copy' $LastGoodDir $UserHome 'plain')
  if (-not $guardOk) { return }
  $branch = Get-Conf 'HIVEMIND_UPDATE_BRANCH' 'main'
  $pinned = Get-Conf 'HIVEMIND_UPDATE_REMOTE' ''
  $current = Invoke-GitIn $src @('remote', 'get-url', 'origin')
  if ($script:GitExit -ne 0) { $current = '' }
  if ($pinned -and $current -ne $pinned) {
    SayErr "Error: origin remote changed since install (pinned: $pinned, current: $current) - refusing to update."
    return
  }
  Say "Checking $branch for updates..."
  [void](Invoke-GitIn $src @('fetch', '--quiet', 'origin', $branch))
  if ($script:GitExit -ne 0) { SayErr 'Error: fetch failed (network?) - staying on the current version.'; return }
  $before = Invoke-GitIn $src @('rev-parse', 'HEAD')
  $after = Invoke-GitIn $src @('rev-parse', "origin/$branch")
  if ($script:GitExit -ne 0 -or -not $after) { SayErr "Error: origin/$branch not found - staying on the current version."; return }
  $b12 = $before.Substring(0, [Math]::Min(12, $before.Length)); $a12 = $after.Substring(0, [Math]::Min(12, $after.Length))
  if ($before -eq $after) { Say "Already up to date ($b12)."; $script:UpdateRc = 0; return }
  # G1: after the fetch, before any reset - HEAD must be reachable from the
  # fetched origin/<branch>. Every reset below (and each rollback to $before)
  # runs only on a source that passed here: clean and fast-forwardable.
  $why = Get-UpdateSourceRefusal $src "origin/$branch"
  if ($why) { Write-UpdateRefusal $src $why; return }

  [void](Invoke-GitIn $src @('reset', '--hard', "origin/$branch"))
  if ($script:GitExit -ne 0) { SayErr "Error: could not reset the clone to origin/$branch - resolve it by hand in $src."; return }
  if (-not (Test-CommitIntegrity $src)) {
    SayErr "Error: integrity check FAILED for $a12 - not applying, reverting the clone to $b12."
    [void](Invoke-GitIn $src @('reset', '--hard', $before))
    return
  }
  Say "Verified $a12 - staging..."

  $err = New-StagedTree $src $StagingDir
  if ($err) {
    SayErr "Error: staging build failed ($err) - current installation untouched."
    [void](Remove-DirTree $StagingDir)
    [void](Invoke-GitIn $src @('reset', '--hard', $before))
    return
  }

  Say 'Staged - swapping in...'
  $restartOld = {
    [void](Invoke-GitIn $src @('reset', '--hard', $before))
    [void](Start-ProxyCore)
  }
  if (-not (Stop-AllOurs)) {
    SayErr 'Error: the running daemon did not stop - not swapping; current installation untouched.'
    [void](Remove-DirTree $StagingDir); & $restartOld; return
  }
  if (-not (Remove-DirTree $LastGoodDir)) {
    SayErr "Error: could not clear the old rollback copy $LastGoodDir - not swapping; current installation untouched."
    [void](Remove-DirTree $StagingDir); & $restartOld; return
  }
  if (-not (Move-Dir $HivemindHome $LastGoodDir)) {
    SayErr "Error: could not move $HivemindHome aside (a process still holds it?) - not swapping; current installation untouched."
    [void](Remove-DirTree $StagingDir); & $restartOld; return
  }
  if (-not (Move-Dir $StagingDir $HivemindHome)) {
    [void](Move-Dir $LastGoodDir $HivemindHome)
    SayErr "Error: could not move the staged tree into place - restored the previous one."
    [void](Remove-DirTree $StagingDir); & $restartOld; return
  }
  [void](Set-UserOnlyAcl $HivemindHome)
  [void](Set-UserOnlyAcl $LastGoodDir)
  if (-not (Update-LauncherFile $src)) { SayErr '  ! could not replace the launcher (hivemind.ps1) - the runtime was updated; the launcher stays as is.' }

  if (Test-UpdatedRuntime) {
    Say "Updated: $b12 -> $a12."
    $script:UpdateRc = 0
    return
  }

  SayErr "Error: post-update health check FAILED (runtime / mTLS proxy) - rolling back to $b12."
  [void](Stop-AllOurs)
  $rolled = (Remove-DirTree $HivemindHome) -and (Move-Dir $LastGoodDir $HivemindHome)
  if (-not $rolled) {
    SayErr "Error: rollback could not restore $LastGoodDir into $HivemindHome - restore it by hand (rename the folder) or re-run install.ps1."
    return
  }
  [void](Set-UserOnlyAcl $HivemindHome)
  Restore-LauncherFile
  [void](Invoke-GitIn $src @('reset', '--hard', $before))
  $e = Start-ProxyCore
  if ($e) { SayErr $e }
  SayErr "Rolled back - running $b12."
}

# Remote head with a hard timeout (git has none of its own for ls-remote).
function Get-RemoteHead([string]$gitExe, [string]$src, [string]$branch, [int]$timeoutMs) {
  try {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $gitExe
    $psi.Arguments = "-C `"$src`" ls-remote origin refs/heads/$branch"
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $p = [Diagnostics.Process]::Start($psi)
    $so = $p.StandardOutput.ReadToEndAsync(); $se = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($timeoutMs)) { try { $p.Kill() } catch { }; return '' }
    if ($p.ExitCode -ne 0) { return '' }
    return ((($so.Result -split "`n")[0] -split "`t")[0]).Trim()
  } catch { return '' }
}

# Silent on-launch check (start / no args): best-effort, fail-open on ANY error;
# 5 s cap on the remote check; an update that applies reuses Invoke-Update.
function Invoke-MaybeAutoUpdate {
  try {
    $src = Get-Conf 'HIVEMIND_SOURCE_DIR' ''
    if (-not $src -or -not (Test-Path -LiteralPath (Join-Path $src '.git'))) { return }
    $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $git) { return }
    $why = Get-UpdateSourceRefusal $src
    if ($why) {
      if ($script:VerboseLog) { Write-Err "[hivemind] auto-update skipped: ${src}: $why - never reset --hard" }
      return
    }
    $remote = Get-RemoteHead $git.Source $src (Get-Conf 'HIVEMIND_UPDATE_BRANCH' 'main') 5000
    if (-not $remote) { return }
    $local = Invoke-GitIn $src @('rev-parse', 'HEAD')
    if ($remote -eq $local) { return }
    $script:UpdateQuiet = $true
    Invoke-Update
  } catch { } finally { $script:UpdateQuiet = $false }
}

# ---- Commands ----------------------------------------------------------------
function Invoke-Start([string]$slug) {
  Assert-Prereqs
  if (-not (Test-HasCert)) { Invoke-SetupMode }
  Invoke-MaybeAutoUpdate
  Start-Proxy
  Write-Output "[hivemind] proxy running on port $ProxyPort"
  if ($slug) {
    Write-Err "[hivemind] '$slug' ignored - this install has no Claude Code harness, so no session is opened here."
  }
  Write-ConnectHints
  exit 0
}

function Invoke-Stop {
  $rc = 0
  $procId = Read-PidFile $RuntimePidFile
  if (Test-Path -LiteralPath $RuntimePidFile) {
    if ($procId -and (Test-Alive $procId)) {
      if (Test-IsOurDaemon $procId) {
        if (Stop-OurDaemon $procId) {
          Write-Output '[hivemind] runtime stopped'
        } else {
          Write-Err "[hivemind] runtime pid $procId did not exit"
          $rc = 1
        }
        Remove-Item -LiteralPath $RuntimePidFile -Force -ErrorAction SilentlyContinue
      } else {
        # Recycled PID (crash left the pidfile behind): never kill it.
        Write-Err "[hivemind] pidfile PID $procId is not a hivemind runtime (stale/recycled) - not killing, clearing pidfile"
        Remove-Item -LiteralPath $RuntimePidFile -Force -ErrorAction SilentlyContinue
      }
    } else {
      Write-Output "[hivemind] no running runtime at pid $procId"
      Remove-Item -LiteralPath $RuntimePidFile -Force -ErrorAction SilentlyContinue
    }
  } else {
    Write-Output '[hivemind] no runtime pid file found (already stopped?)'
  }
  # Leftover --setup-only daemon (interrupted enrollment) - same identity check.
  $sp = Read-PidFile $SetupPidFile
  if ($sp -and (Test-Alive $sp) -and (Test-IsOurDaemon $sp)) { [void](Stop-OurDaemon $sp) }
  Remove-Item -LiteralPath $SetupPidFile -Force -ErrorAction SilentlyContinue
  exit $rc
}

function Invoke-Status {
  Write-Output "HiveMind v$HivemindVersion - status"
  Write-Output ''
  $procId = Read-PidFile $RuntimePidFile
  if ($procId -and (Test-Alive $procId) -and (Test-IsOurDaemon $procId)) {
    Write-Output "  Daemon:     running (pid $procId)"
  } elseif ($procId) {
    Write-Output "  Daemon:     pidfile pid $procId is not a running hivemind runtime"
  } else {
    Write-Output '  Daemon:     no pidfile'
  }
  $healthy = Test-RuntimeHealthy
  if ($healthy) { Write-Output "  Runtime:    OK (port $RuntimePort)" } else { Write-Output "  Runtime:    STOPPED (port $RuntimePort)" }
  if (Test-ProxyAlive) { Write-Output "  mTLS proxy: OK (port $ProxyPort)" } else { Write-Output "  mTLS proxy: not responding (port $ProxyPort)" }
  if (Test-HasCert) {
    if ($Owner) { Write-Output "  Cert:       present (owner=$Owner)" } else { Write-Output '  Cert:       present' }
  } else {
    Write-Output "  Cert:       NOT FOUND - run 'hivemind' to enroll"
  }
  Write-Output "  Endpoint:   $Endpoint"
  exit 0
}

function Invoke-Help {
  Write-Output 'Usage: hivemind [<slug>] | start | stop | status | update | uninstall | autostart on|off|status | --help | --version'
  Write-Output ''
  Write-Output '  hivemind [<slug>]     Proxy-only install: enroll on first run, else start the proxy and'
  Write-Output '                        print how to connect your MCP client (Claude Code is never started;'
  Write-Output '                        a slug is ignored).'
  Write-Output '  hivemind start        Same as above.'
  Write-Output '  hivemind stop         Stop the proxy (forced stop of the verified daemon process).'
  Write-Output '  hivemind status       Show daemon, proxy and certificate state.'
  Write-Output '  hivemind update       Update from the pinned git clone: verify (signature or the published'
  Write-Output '                        LATEST_SHA), staged swap, rollback if the proxy is not healthy after.'
  Write-Output '                        Also checked silently on every start (fail-open). Never runs on a'
  Write-Output '                        development clone (one that tracks .github\) - install from dist.'
  Write-Output '  hivemind uninstall [-Yes] [-KeepCerts]'
  Write-Output '                        Remove everything HiveMind installed (see: hivemind uninstall --help).'
  Write-Output '  hivemind autostart on|off|status'
  Write-Output '                        Start the proxy at log-on (opt-in; off by default): a per-user'
  Write-Output '                        Scheduled Task (fallback: a Startup-folder entry). Needs a certificate.'
  Write-Output '  hivemind --version    Print version.'
  Write-Output '  --verbose             (anywhere) say why the on-launch update check skipped.'
}

# --verbose anywhere in argv (global flag, as in bin/hivemind): stripped before
# dispatch; today it only un-silences the skip reasons of the on-launch check.
$script:VerboseLog = $false
$argv = @()
foreach ($a in $args) { if ([string]$a -eq '--verbose') { $script:VerboseLog = $true } else { $argv += $a } }
$cmd = ''
if ($argv.Count -gt 0) { $cmd = [string]$argv[0] }
switch -Exact ($cmd) {
  ''          { Invoke-Start '' }
  'start'     { Invoke-Start '' }
  'stop'      { Invoke-Stop }
  'status'    { Invoke-Status }
  'uninstall' { Invoke-Uninstall @($argv | Select-Object -Skip 1) }
  'update'    { Assert-Prereqs; Invoke-Update; exit $script:UpdateRc }
  'autostart' { Invoke-Autostart @($argv | Select-Object -Skip 1) }
  '--version' { Write-Output "HiveMind v$HivemindVersion"; exit 0 }
  '-v'        { Write-Output "HiveMind v$HivemindVersion"; exit 0 }
  'version'   { Write-Output "HiveMind v$HivemindVersion"; exit 0 }
  '--help'    { Invoke-Help; exit 0 }
  '-h'        { Invoke-Help; exit 0 }
  'help'      { Invoke-Help; exit 0 }
  { $_ -in @('restart', 'health', 'resume', 'install') } {
    # bin/hivemind commands not built for Windows yet - never mistaken for a slug.
    Write-Err "hivemind ${cmd}: not available on Windows yet."
    exit 1
  }
  default {
    if ($cmd.StartsWith('-')) { Write-Err "Unknown option: $cmd"; Invoke-Help; exit 1 }
    Invoke-Start $cmd
  }
}
