#!/usr/bin/env bash
# install.sh — HiveMind one-shot installer (WSL/Linux).
#
# Installs the hivemind binary to PATH and copies runtime files to $HIVEMIND_HOME.
# Does NOT provision a certificate — run 'hivemind' after install for first-time setup.
#
# Usage:
#   bash install.sh                  # installs to /usr/local/bin (fallback: ~/.local/bin)
#   bash install.sh --prefix <dir>   # install binary to <dir>/bin/hivemind

set -euo pipefail

HIVEMIND_HOME="${HIVEMIND_HOME:-$HOME/.hivemind}"
HIVEMIND_ENDPOINT="${HIVEMIND_ENDPOINT:-hivemind.silken.ia.br:4443}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_PREFIX="/usr/local"

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      if [ -z "${2:-}" ]; then echo "Error: --prefix requires a value" >&2; exit 1; fi
      INSTALL_PREFIX="$2"; shift 2 ;;
    --endpoint)
      if [ -z "${2:-}" ]; then echo "Error: --endpoint requires a value" >&2; exit 1; fi
      HIVEMIND_ENDPOINT="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: bash install.sh [--prefix <dir>] [--endpoint <host:port>]"; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

INSTALL_BIN_DIR="${INSTALL_PREFIX}/bin"

# ── Dependency checks ─────────────────────────────────────────────────────────
if ! command -v bun > /dev/null 2>&1; then
  echo "Error: 'bun' is required but not found." >&2
  echo "Install bun: curl -fsSL https://bun.sh/install | bash" >&2
  echo "Then re-run: bash install.sh" >&2
  exit 1
fi

if ! command -v openssl > /dev/null 2>&1; then
  echo "Error: 'openssl' is required but not found." >&2
  echo "Install: sudo apt-get install openssl  (Ubuntu/Debian)" >&2
  exit 1
fi

echo "Installing HiveMind..."
echo "  HIVEMIND_HOME: ${HIVEMIND_HOME}"

# ── Create directories ────────────────────────────────────────────────────────
mkdir -p "${HIVEMIND_HOME}/.claude"
mkdir -p "${HIVEMIND_HOME}/runtime"

# Persist the product endpoint so the runtime reads it at startup (before enrollment).
touch "${HIVEMIND_HOME}/.env"
if grep -q '^HIVEMIND_ENDPOINT=' "${HIVEMIND_HOME}/.env"; then
  sed -i "s|^HIVEMIND_ENDPOINT=.*|HIVEMIND_ENDPOINT=${HIVEMIND_ENDPOINT}|" "${HIVEMIND_HOME}/.env"
else
  printf 'HIVEMIND_ENDPOINT=%s\n' "${HIVEMIND_ENDPOINT}" >> "${HIVEMIND_HOME}/.env"
fi
echo "  Endpoint:    ${HIVEMIND_ENDPOINT}"

# ── Copy files ────────────────────────────────────────────────────────────────
cp "${SCRIPT_DIR}/CLAUDE.md" "${HIVEMIND_HOME}/CLAUDE.md"
cp "${SCRIPT_DIR}/.claude/settings.json" "${HIVEMIND_HOME}/.claude/settings.json"

# Copy runtime (preserve permissions; exclude node_modules if present).
rsync -a --exclude='node_modules/' --exclude='bun.lock' \
  "${SCRIPT_DIR}/runtime/" "${HIVEMIND_HOME}/runtime/" 2>/dev/null \
  || cp -r "${SCRIPT_DIR}/runtime/." "${HIVEMIND_HOME}/runtime/"

# ── Install bun dependencies ──────────────────────────────────────────────────
echo "Installing runtime dependencies (bun install)..."
(cd "${HIVEMIND_HOME}/runtime" && bun install --silent 2>/dev/null || bun install)

# ── Install hivemind binary ───────────────────────────────────────────────────
# Try system-wide prefix first; fallback to user-local ~/.local/bin.
_install_binary() {
  local _dest_dir="$1"
  mkdir -p "${_dest_dir}" 2>/dev/null || return 1
  [ -w "${_dest_dir}" ] || return 1
  cp "${SCRIPT_DIR}/bin/hivemind" "${_dest_dir}/hivemind"
  chmod +x "${_dest_dir}/hivemind"
  echo "  Binary:      ${_dest_dir}/hivemind"
  return 0
}

if ! _install_binary "${INSTALL_BIN_DIR}"; then
  LOCAL_BIN="${HOME}/.local/bin"
  if ! _install_binary "${LOCAL_BIN}"; then
    echo "Error: cannot write to ${INSTALL_BIN_DIR} or ${LOCAL_BIN}" >&2
    exit 1
  fi
  # Warn if ~/.local/bin is not on PATH.
  if [[ ":${PATH}:" != *":${LOCAL_BIN}:"* ]]; then
    echo ""
    echo "Note: ${LOCAL_BIN} is not in your PATH. Add it:"
    echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
  fi
fi

# ── Smoke check ───────────────────────────────────────────────────────────────
if command -v hivemind > /dev/null 2>&1; then
  echo "  Smoke:       $(hivemind --version)"
else
  echo "  Smoke:       (hivemind not yet on PATH — see PATH note above)"
fi

echo ""
echo "HiveMind installed. Run: hivemind"
echo "On first run, you'll be guided through certificate setup."
