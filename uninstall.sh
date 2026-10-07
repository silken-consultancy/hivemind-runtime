#!/usr/bin/env bash
# uninstall.sh — dev convenience: a thin wrapper over `hivemind uninstall`.
#
# The product path is `hivemind uninstall` (bin/hivemind cmd_uninstall) — it
# lists everything first, then removes the harness (incl. the isolated Claude
# Code state), the client wiring, $HIVEMIND_HOME, ~/.engram, the system CA and
# the binaries. This script only forwards to it, so it keeps working even when
# `hivemind` is no longer on PATH: it runs the clone's own bin/hivemind.
#
# Usage (flags pass through 1:1):
#   bash uninstall.sh                # lists, then asks before removing
#   bash uninstall.sh -y|--yes       # no confirmation (test scripts)
#   bash uninstall.sh --keep-certs   # keep ~/.engram/mtls certs + device-id
#   bash uninstall.sh harness        # only the Claude Code harness; the proxy stays
#   bash uninstall.sh --help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "${SCRIPT_DIR}/bin/hivemind" ]; then
  exec bash "${SCRIPT_DIR}/bin/hivemind" uninstall "$@"
fi
exec hivemind uninstall "$@"
