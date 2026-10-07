# install.ps1 - HiveMind installer for native Windows (PROXY-ONLY).
#
# Windows counterpart of `bash install.sh --proxy-only` (impl 3e2c90da, phase W,
# item W1). Installs the connection layer only: the unchanged bun daemon + mTLS
# proxy (runtime\), %USERPROFILE%\.hivemind\.env, the components marker and the
# `hivemind` launcher on the user PATH. The Claude Code harness is not built on
# Windows. Does NOT provision a certificate - run `hivemind` afterwards for the
# first-time setup (enrollment).
#
# Run it from a git clone of hivemind-runtime (Git for Windows is required - it
# is the update channel):
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Endpoint host:port] [-Autostart]
#
# Requirements, all checked BEFORE anything is written (a failed check leaves
# nothing installed): git, bun, openssl. openssl is taken from PATH or from Git
# for Windows' own build (<Git>\mingw64\bin\openssl.exe, OpenSSL 3.x, works
# without an openssl.cnf); the daemon shells out to a bare `openssl`, so the
# directory found here is recorded in .env (HIVEMIND_OPENSSL_DIR) and the
# launcher prepends it to the daemon's PATH.
#
# Writes (idempotent - re-running converges to the same state):
#   %USERPROFILE%\.hivemind\                     ACL = current user only, inheritance off (holds .env)
#   %USERPROFILE%\.hivemind\.components          "proxy"
#   %USERPROFILE%\.hivemind\.bun-cache-created   only when THIS install's `bun install` created
#                                                %USERPROFILE%\.bun\install\cache (uninstall reads it)
#   %USERPROFILE%\.hivemind\.env                 HIVEMIND_ENDPOINT + update pin + HIVEMIND_OPENSSL_DIR + HIVEMIND_BUN_EXE
#   %USERPROFILE%\.hivemind\runtime\             copy of runtime\ (minus node_modules, bun.lock) + bun install
#   %USERPROFILE%\.engram\                       cert/key dir; ACL = current user only, inheritance off
#   (reads + deletes %USERPROFILE%\.engram\kept-credentials.env when `hivemind uninstall
#    -KeepCerts` left one: its MTLS_*/HIVEMIND_OWNER/FOS_API_KEY are merged into .env)
#   %LOCALAPPDATA%\hivemind\bin\hivemind.ps1     the launcher
#   %LOCALAPPDATA%\hivemind\bin\hivemind.cmd     frozen shim (so `hivemind` resolves from cmd/PowerShell)
#   HKCU\Environment Path                        + %LOCALAPPDATA%\hivemind\bin (only if absent)
#   -Autostart ONLY: `hivemind autostart on` (per-user Scheduled Task, Startup-folder fallback);
#   without -Autostart no autostart entry is created.
#
# Test seams (process environment only - never read from .env):
#   HIVEMIND_INSTALL_USER_PATH_FILE  read/write the user Path value from/to this
#                                    text file instead of HKCU\Environment.
#   HIVEMIND_OPENSSL_CANDIDATES      ';'-separated directories searched for
#                                    openssl.exe INSTEAD of the defaults (Git's
#                                    mingw64\bin, ShiningLight's install dir).
#
# This file is ASCII on purpose: Windows PowerShell 5.1 misreads UTF-8 without a
# BOM (measured in W0 on an em dash).

[CmdletBinding()]
param(
  [string]$Endpoint = '',
  [switch]$Autostart,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$ScriptDir = $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# Windows PowerShell 5.1 turns ANY stderr line of a native command into a
# terminating error under ErrorActionPreference=Stop (measured: `git ... 2>$null`
# throws). Native calls go through this wrapper and are judged by exit code.
function Invoke-Native([scriptblock]$sb) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $sb | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $old }
}

function Fail([string]$msg) {
  [Console]::Error.WriteLine("Error: $msg")
  exit 1
}

if ($Help) {
  Write-Output 'Usage: powershell -ExecutionPolicy Bypass -File install.ps1 [-Endpoint <host:port>] [-Autostart]'
  Write-Output '  Installs the HiveMind proxy (proxy-only) for this Windows user; run `hivemind` afterwards.'
  Write-Output '  -Autostart  also run `hivemind autostart on` at the end (start the proxy at log-on; needs a'
  Write-Output '              certificate - on a fresh machine run `hivemind` first). Default: off.'
  exit 0
}

# ---- Paths -------------------------------------------------------------------
$UserHome = $env:USERPROFILE
if (-not $UserHome) { Fail 'USERPROFILE is not set.' }
if ($env:HIVEMIND_HOME) { $HivemindHome = $env:HIVEMIND_HOME } else { $HivemindHome = Join-Path $UserHome '.hivemind' }
$EngramDir = Join-Path $UserHome '.engram'
if (-not $env:LOCALAPPDATA) { Fail 'LOCALAPPDATA is not set.' }

# F11: HIVEMIND_HOME must be strictly inside the profile (same path rules as the
# launcher's Test-UninstallRoot guard): never the profile itself or one of its
# ancestors, never outside it, never overlapping the clone this script runs
# from, never a link/junction. The tree gets a user-only ACL, the update renames
# it and the uninstall deletes it - all three trust this path.
function Get-NormPath([string]$p) {
  if (-not $p) { return '' }
  try { return [IO.Path]::GetFullPath($p).TrimEnd('\') } catch { return '' }
}
function Test-PathInside([string]$child, [string]$parent) {
  $c = $child.TrimEnd('\') + '\'
  $q = $parent.TrimEnd('\') + '\'
  return ($c.Length -gt $q.Length -and $c.StartsWith($q, [StringComparison]::OrdinalIgnoreCase))
}
$hmN = Get-NormPath $HivemindHome
$homeN = Get-NormPath $UserHome
if (-not $hmN -or -not $homeN) { Fail "HIVEMIND_HOME ($HivemindHome) is not a valid path - nothing was installed." }
if ($hmN -ieq $homeN -or (Test-PathInside $homeN $hmN)) { Fail "HIVEMIND_HOME ($hmN) is or contains your profile ($homeN) - nothing was installed." }
if (-not (Test-PathInside $hmN $homeN)) { Fail "HIVEMIND_HOME ($hmN) is not inside your profile ($homeN) - nothing was installed. Unset HIVEMIND_HOME (default: %USERPROFILE%\.hivemind)." }
$srcN = Get-NormPath $ScriptDir
if ($srcN -and ($hmN -ieq $srcN -or (Test-PathInside $hmN $srcN) -or (Test-PathInside $srcN $hmN))) {
  Fail "HIVEMIND_HOME ($hmN) overlaps the clone this script runs from ($srcN) - nothing was installed."
}
if ((Test-Path -LiteralPath $hmN) -and ((Get-Item -LiteralPath $hmN -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  Fail "HIVEMIND_HOME ($hmN) is a link/junction - nothing was installed."
}
$BinDir = Join-Path $env:LOCALAPPDATA 'hivemind\bin'

if (-not $Endpoint) {
  if ($env:HIVEMIND_ENDPOINT) { $Endpoint = $env:HIVEMIND_ENDPOINT } else { $Endpoint = 'hivemind.ia.br:4443' }
}

function Test-Interactive {
  try {
    return ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected)
  } catch { return $false }
}

# ---- Dependency checks (nothing is written before all of them pass) ----------
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
  Fail "'git' not found. Install Git for Windows (https://git-scm.com/download/win) and re-run."
}
$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) {
  [Console]::Error.WriteLine("Error: 'bun' not found. Install it with:")
  [Console]::Error.WriteLine('  powershell -c "irm bun.sh/install.ps1 | iex"')
  [Console]::Error.WriteLine('then open a new terminal and re-run this installer.')
  exit 1
}

function Get-OpensslCandidateDirs {
  if ($env:HIVEMIND_OPENSSL_CANDIDATES) {
    return @($env:HIVEMIND_OPENSSL_CANDIDATES -split ';' | Where-Object { $_ })
  }
  $dirs = @()
  # Git for Windows: <Git>\cmd\git.exe -> <Git>\mingw64\bin\openssl.exe
  $gitRoot = Split-Path -Parent (Split-Path -Parent $git.Source)
  $dirs += (Join-Path $gitRoot 'mingw64\bin')
  $dirs += 'C:\Program Files\Git\mingw64\bin'
  # ShiningLight.OpenSSL.Light (winget) default install dir.
  $dirs += 'C:\Program Files\OpenSSL-Win64\bin'
  return $dirs
}

function Find-OpensslDir {
  $onPath = Get-Command openssl.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($onPath) { return (Split-Path -Parent $onPath.Source) }
  foreach ($d in (Get-OpensslCandidateDirs)) {
    if (Test-Path -LiteralPath (Join-Path $d 'openssl.exe') -PathType Leaf) { return $d }
  }
  return $null
}

function Write-OpensslInstructions {
  [Console]::Error.WriteLine("Error: 'openssl' not found (not on PATH, not in Git for Windows' mingw64\bin).")
  [Console]::Error.WriteLine('  HiveMind needs openssl to create your certificate. Either:')
  [Console]::Error.WriteLine('    - reinstall/repair Git for Windows (it ships openssl in <Git>\mingw64\bin), or')
  [Console]::Error.WriteLine('    - install OpenSSL:  winget install --id ShiningLight.OpenSSL.Light -e')
  [Console]::Error.WriteLine('  then re-run this installer. Nothing was installed.')
}

$OpensslDir = Find-OpensslDir
if (-not $OpensslDir) {
  if (-not (Test-Interactive)) {
    Write-OpensslInstructions
    exit 1
  }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { Write-OpensslInstructions; exit 1 }
  Write-Output "'openssl' was not found. HiveMind can install it with:"
  Write-Output '  winget install --id ShiningLight.OpenSSL.Light -e'
  $answer = Read-Host 'Install it now? Type yes to continue'
  if ($answer -ne 'yes') { Write-OpensslInstructions; exit 1 }
  Invoke-Native { & $winget.Source install --id ShiningLight.OpenSSL.Light -e 2>&1 } | Write-Output
  $OpensslDir = Find-OpensslDir
  if (-not $OpensslDir) { Write-OpensslInstructions; exit 1 }
}
$OpensslDir = (Resolve-Path -LiteralPath $OpensslDir).ProviderPath

# The harness is never built on Windows; refuse to downgrade a tree that has one
# (same guard as `install.sh --proxy-only`).
if ((Test-Path -LiteralPath (Join-Path $HivemindHome '.claude\settings.json')) -or
    (Test-Path -LiteralPath (Join-Path $HivemindHome '.claude\hooks'))) {
  Fail "a Claude Code harness is already installed in $HivemindHome\.claude - remove it first."
}

if (-not (Test-Path -LiteralPath (Join-Path $ScriptDir 'runtime\src\server.ts') -PathType Leaf)) {
  Fail "runtime not found next to this installer ($ScriptDir\runtime). Run install.ps1 from a hivemind-runtime clone."
}
if (-not (Test-Path -LiteralPath (Join-Path $ScriptDir 'bin\hivemind.ps1') -PathType Leaf)) {
  Fail "launcher not found next to this installer ($ScriptDir\bin\hivemind.ps1)."
}

Write-Output 'Installing HiveMind (proxy-only)...'

# ---- User-only ACL (founder decision 95a181bd; blocker 26ed2154) -------------
# Applied to BOTH %USERPROFILE%\.engram (certs/keys) and %USERPROFILE%\.hivemind
# (its .env carries FOS_API_KEY after enrollment).
# chmod/mode 0600 is a no-op on Windows (W0): files inherit the parent's ACL. So
# the parent is tightened: inheritance removed, a single (OI)(CI) Full Control
# ACE for the current user. Everything setup writes below it later (mtls\ keys,
# cache\, device-id) inherits exactly that. Re-applying is harmless.
function Set-UserOnlyAcl([string]$dir) {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $out = Invoke-Native { & icacls.exe $dir /inheritance:r /grant:r "*${sid}:(OI)(CI)F" 2>&1 }
  if ($LASTEXITCODE -ne 0) { Fail "icacls failed on ${dir}: $out" }
  # Drop any explicit ACE for another principal left by an earlier ACL.
  $acl = Get-Acl -LiteralPath $dir
  foreach ($rule in $acl.Access) {
    $rsid = $null
    try { $rsid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $rsid = "$($rule.IdentityReference)" }
    if ($rsid -ne $sid) {
      $out = Invoke-Native { & icacls.exe $dir /remove:g "*$rsid" 2>&1 }
      if ($LASTEXITCODE -ne 0) { Fail "icacls /remove failed on ${dir}: $out" }
    }
  }
  Assert-UserOnlyAcl $dir $true
}

function Assert-UserOnlyAcl([string]$path, [bool]$mustBeProtected) {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $acl = Get-Acl -LiteralPath $path
  if ($mustBeProtected -and -not $acl.AreAccessRulesProtected) { Fail "ACL on $path still inherits from its parent." }
  if (@($acl.Access).Count -lt 1) { Fail "ACL on $path grants nobody." }
  foreach ($rule in $acl.Access) {
    $rsid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rsid -ne $sid) { Fail "ACL on $path still grants $($rule.IdentityReference)." }
  }
}
# ---- Components marker FIRST -------------------------------------------------
# Same rule as install.sh: a partial failure must never leave a markerless tree.
New-Item -ItemType Directory -Force -Path $HivemindHome | Out-Null
# Tighten BEFORE any file is written into it: .env (FOS_API_KEY, written later by
# the setup daemon), .components and runtime\ all inherit the single user ACE.
# On a re-run icacls also re-propagates to files already there.
Set-UserOnlyAcl $HivemindHome
# An existing .env (re-run / upgrade) could carry EXPLICIT ACEs of its own, which
# the parent's propagation does not remove: reset it to inherit-only, then assert.
$EnvFile = Join-Path $HivemindHome '.env'
if (Test-Path -LiteralPath $EnvFile -PathType Leaf) {
  $out = Invoke-Native { & icacls.exe $EnvFile /reset 2>&1 }
  if ($LASTEXITCODE -ne 0) { Fail "icacls /reset failed on ${EnvFile}: $out" }
  Assert-UserOnlyAcl $EnvFile $false
}
[IO.File]::WriteAllText((Join-Path $HivemindHome '.components'), "proxy`n", $Utf8NoBom)

# ---- Cert/key dir -------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $EngramDir | Out-Null
Set-UserOnlyAcl $EngramDir

# ---- .env (UTF-8 without BOM, LF; set-or-update, other keys preserved) -------
function Set-EnvKeys([hashtable]$pairs, [string[]]$order) {
  $lines = New-Object System.Collections.Generic.List[string]
  if (Test-Path -LiteralPath $EnvFile) {
    $raw = [IO.File]::ReadAllText($EnvFile, $Utf8NoBom)
    foreach ($l in ($raw -split "`r?`n")) { $lines.Add($l) }
    while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
  }
  foreach ($k in $order) {
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i].StartsWith("$k=")) { $lines[$i] = "$k=$($pairs[$k])"; $found = $true }
    }
    if (-not $found) { $lines.Add("$k=$($pairs[$k])") }
  }
  # F11: atomic - tmp in the same (user-only ACL) dir + rename over .env, so a
  # crash mid-write never leaves a truncated .env.
  $tmp = "$EnvFile.tmp.$PID"
  [IO.File]::WriteAllText($tmp, (($lines -join "`n") + "`n"), $Utf8NoBom)
  Move-Item -LiteralPath $tmp -Destination $EnvFile -Force
}

# HIVEMIND_BUN_EXE: the bun this install used, recorded like the openssl dir so
# a start launched by the log-on task (scheduler environment, no shell PATH)
# finds it (E5 CI T5: bun on the job PATH only -> the task's start exited 1).
$envPairs = @{ HIVEMIND_ENDPOINT = $Endpoint; HIVEMIND_OPENSSL_DIR = $OpensslDir; HIVEMIND_BUN_EXE = $bun.Source }
$envOrder = @('HIVEMIND_ENDPOINT')
# Update pin - same keys and logic as install.sh: only when run from a clone.
if (Test-Path -LiteralPath (Join-Path $ScriptDir '.git')) {
  $remote = Invoke-Native { & git -C $ScriptDir remote get-url origin 2>$null }
  if ($LASTEXITCODE -ne 0 -or -not $remote) { $remote = '' }
  $branch = Invoke-Native { & git -C $ScriptDir rev-parse --abbrev-ref HEAD 2>$null }
  if ($LASTEXITCODE -ne 0 -or -not $branch) { $branch = 'main' }
  $envPairs['HIVEMIND_SOURCE_DIR'] = $ScriptDir
  $envPairs['HIVEMIND_UPDATE_REMOTE'] = "$remote".Trim()
  $envPairs['HIVEMIND_UPDATE_BRANCH'] = "$branch".Trim()
  $envOrder += @('HIVEMIND_SOURCE_DIR', 'HIVEMIND_UPDATE_REMOTE', 'HIVEMIND_UPDATE_BRANCH')
}
$envOrder += @('HIVEMIND_OPENSSL_DIR', 'HIVEMIND_BUN_EXE')
Set-EnvKeys $envPairs $envOrder

# ---- Credentials kept by `hivemind uninstall -KeepCerts` (blocker 3b7a507e) ---
# The uninstall moved the .env credential keys (MTLS_*, HIVEMIND_OWNER,
# FOS_API_KEY) to %USERPROFILE%\.engram\kept-credentials.env (user-only, like all
# of .engram). Merge them back - only keys the new .env does not already have
# (a newer enrollment always wins) and only when the certificate + key they
# point at are still there - then delete the file so the secret is not left in
# two places. Values are never printed.
$KeptCreds = Join-Path $EngramDir 'kept-credentials.env'
if (Test-Path -LiteralPath $KeptCreds -PathType Leaf) {
  $kept = @{}; $keptOrder = @()
  foreach ($l in ([IO.File]::ReadAllText($KeptCreds, $Utf8NoBom) -split "`r?`n")) {
    if ($l -match '^(MTLS_[A-Z0-9_]+|HIVEMIND_OWNER|FOS_API_KEY)=(.*)$') {
      if (-not $kept.ContainsKey($Matches[1])) { $keptOrder += $Matches[1] }
      $kept[$Matches[1]] = $Matches[2]
    }
  }
  $certOk = $kept['MTLS_CERT_PATH'] -and $kept['MTLS_KEY_PATH'] -and
    (Test-Path -LiteralPath $kept['MTLS_CERT_PATH'] -PathType Leaf) -and (Test-Path -LiteralPath $kept['MTLS_KEY_PATH'] -PathType Leaf)
  if ($certOk) {
    $have = [IO.File]::ReadAllText($EnvFile, $Utf8NoBom)
    $add = @($keptOrder | Where-Object { $have -notmatch "(?m)^$([regex]::Escape($_))=" })
    if ($add.Count -gt 0) { Set-EnvKeys $kept $add }
    Write-Output "Restored the enrollment credentials kept by 'hivemind uninstall -KeepCerts' ($($add.Count) keys) - no re-enrollment needed."
  } else {
    Write-Output "Note: the credentials kept by 'hivemind uninstall -KeepCerts' point at a certificate that is gone - not restored; run hivemind to enroll again."
  }
  Remove-Item -LiteralPath $KeptCreds -Force
}

# ---- Runtime copy (minus node_modules / bun.lock) + bun install --------------
$RuntimeSrc = Join-Path $ScriptDir 'runtime'
$RuntimeDst = Join-Path $HivemindHome 'runtime'
New-Item -ItemType Directory -Force -Path $RuntimeDst | Out-Null
$srcRoot = (Resolve-Path -LiteralPath $RuntimeSrc).ProviderPath.TrimEnd('\')
Get-ChildItem -LiteralPath $srcRoot -Recurse -Force | ForEach-Object {
  $rel = $_.FullName.Substring($srcRoot.Length + 1)
  if ($rel -match '(^|\\)node_modules(\\|$)' -or $rel -eq 'bun.lock') { return }
  $dst = Join-Path $RuntimeDst $rel
  if ($_.PSIsContainer) {
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
  } else {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $dst -Force
  }
}

Write-Output 'Installing runtime dependencies (bun install)...'
# bun's default package cache is %USERPROFILE%\.bun\install\cache. Record it ONLY
# when this `bun install` created it, so the uninstall removes the cache we made
# and never a cache the user already had (or that another bun program made). A
# marker from an earlier run is kept as is.
$BunCacheMarker = Join-Path $HivemindHome '.bun-cache-created'
$bunRels = @('.bun', '.bun\install', '.bun\install\cache')
$bunPre = @{}
foreach ($rel in $bunRels) { $bunPre[$rel] = Test-Path -LiteralPath (Join-Path $UserHome $rel) }
Push-Location -LiteralPath $RuntimeDst
try {
  # --production: runtime deps only, never the devDependencies (item D3).
  $bunOut = Invoke-Native { & $bun.Source install --production --silent 2>&1 }
  if ($LASTEXITCODE -ne 0) { $bunOut = Invoke-Native { & $bun.Source install --production 2>&1 } }
  $bunExit = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($bunExit -ne 0) { Fail "bun install failed in ${RuntimeDst}:`n$($bunOut | Out-String)" }
if (-not (Test-Path -LiteralPath $BunCacheMarker) -and -not $bunPre['.bun\install\cache'] -and
    (Test-Path -LiteralPath (Join-Path $UserHome '.bun\install\cache') -PathType Container)) {
  # One relative path per line: the levels this install created (uninstall
  # removes the cache, and the parents listed here only if left empty).
  $created = @($bunRels | Where-Object { -not $bunPre[$_] })
  [IO.File]::WriteAllText($BunCacheMarker, (($created -join "`n") + "`n"), $Utf8NoBom)
}

# ---- Launcher + frozen shim --------------------------------------------------
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Copy-Item -LiteralPath (Join-Path $ScriptDir 'bin\hivemind.ps1') -Destination (Join-Path $BinDir 'hivemind.ps1') -Force
# FROZEN: this shim never changes between versions (updates only replace
# hivemind.ps1), so a running cmd.exe never reads a file that is being rewritten.
$shim = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0hivemind.ps1`" %*`r`nexit /b %ERRORLEVEL%`r`n"
[IO.File]::WriteAllText((Join-Path $BinDir 'hivemind.cmd'), $shim, [Text.Encoding]::ASCII)

# ---- User PATH (only if absent) ----------------------------------------------
function Get-UserPathValue {
  if ($env:HIVEMIND_INSTALL_USER_PATH_FILE) {
    if (Test-Path -LiteralPath $env:HIVEMIND_INSTALL_USER_PATH_FILE) {
      return ([IO.File]::ReadAllText($env:HIVEMIND_INSTALL_USER_PATH_FILE, $Utf8NoBom)).TrimEnd("`r", "`n")
    }
    return ''
  }
  $key = Get-Item -LiteralPath 'HKCU:\Environment'
  # DoNotExpandEnvironmentNames: keep %VARS% in the stored value intact.
  return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}

function Set-UserPathValue([string]$value) {
  if ($env:HIVEMIND_INSTALL_USER_PATH_FILE) {
    [IO.File]::WriteAllText($env:HIVEMIND_INSTALL_USER_PATH_FILE, $value + "`n", $Utf8NoBom)
    return
  }
  # ExpandString preserves %VAR% entries ([Environment]::SetEnvironmentVariable
  # would rewrite the value as REG_SZ and break them).
  Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value $value -Type ExpandString
  # Tell running shells/Explorer the environment changed (new terminals pick it up).
  if (-not ('HiveMind.EnvBroadcast' -as [type])) {
    Add-Type -Namespace HiveMind -Name EnvBroadcast -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
  }
  $r = [UIntPtr]::Zero
  [void][HiveMind.EnvBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
}

$userPath = Get-UserPathValue
$entries = @($userPath -split ';' | Where-Object { $_ })
$norm = $BinDir.TrimEnd('\')
$present = $false
foreach ($e in $entries) {
  if ([Environment]::ExpandEnvironmentVariables($e).TrimEnd('\') -ieq $norm) { $present = $true }
}
if (-not $present) {
  if ($userPath -and -not $userPath.EndsWith(';')) { $userPath += ';' }
  Set-UserPathValue ($userPath + $BinDir)
  Write-Output "Added $BinDir to your user PATH (open a new terminal to use it)."
}
if ((";$env:Path;") -notlike "*;$BinDir;*") { $env:Path = "$BinDir;$env:Path" }

# ---- Smoke check -------------------------------------------------------------
$shimPath = Join-Path $BinDir 'hivemind.cmd'
$ver = Invoke-Native { & cmd.exe /c "`"$shimPath`" --version" 2>&1 }
if ($LASTEXITCODE -ne 0) { Fail "installed launcher did not run: $ver" }
Write-Output "  OK: $ver"
Write-Output ''
Write-Output 'HiveMind installed (proxy-only). Open a new terminal and run: hivemind'
Write-Output 'On the first run you will be guided through the certificate setup.'

# ---- Autostart (impl 3e2c90da, phase A, item A2) - ONLY with -Autostart -------
# Runs the launcher just installed. It needs a certificate; without one the
# install still succeeds and the exact next step is printed.
if ($Autostart) {
  Write-Output ''
  $launcherPs1 = Join-Path $BinDir 'hivemind.ps1'
  $auto = Invoke-Native { & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $launcherPs1 autostart on 2>&1 }
  $autoRc = $LASTEXITCODE
  foreach ($l in @($auto)) { Write-Output $l }
  if ($autoRc -ne 0) {
    Write-Output 'Autostart was NOT turned on. After the first `hivemind` run (enrollment), run: hivemind autostart on'
  }
}
exit 0
