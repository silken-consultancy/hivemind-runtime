# uninstall.ps1 - thin wrapper over `hivemind uninstall` on native Windows (impl
# 3e2c90da, phase W, item W3; parity with uninstall.sh).
#
# The product path is `hivemind uninstall` (bin\hivemind.ps1 Invoke-Uninstall):
# it lists everything first, then stops the daemon and removes %USERPROFILE%\
# .hivemind, %USERPROFILE%\.engram, the launcher and its user PATH entry. This
# script only forwards to the clone's own bin\hivemind.ps1, so it keeps working
# even when `hivemind` is no longer on PATH.
#
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1             # lists, then asks
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Yes        # no confirmation
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -KeepCerts  # keep mtls certs + device-id
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 --help
#
# ASCII on purpose (Windows PowerShell 5.1 misreads BOM-less UTF-8).

$launcher = Join-Path $PSScriptRoot 'bin\hivemind.ps1'
if (Test-Path -LiteralPath $launcher -PathType Leaf) {
  & $launcher uninstall @args
  exit $LASTEXITCODE
}
$installed = Get-Command hivemind -ErrorAction SilentlyContinue
if ($installed) {
  & $installed.Source uninstall @args
  exit $LASTEXITCODE
}
[Console]::Error.WriteLine("Error: neither $launcher nor an installed 'hivemind' was found.")
exit 1
