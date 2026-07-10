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
      if [ -z "${2:-}" ]; then echo "Erro: --prefix requer um valor" >&2; exit 1; fi
      INSTALL_PREFIX="$2"; shift 2 ;;
    --endpoint)
      if [ -z "${2:-}" ]; then echo "Erro: --endpoint requer um valor" >&2; exit 1; fi
      HIVEMIND_ENDPOINT="$2"; shift 2 ;;
    --help|-h)
      echo "Uso: bash install.sh [--prefix <dir>] [--endpoint <host:port>]"; exit 0 ;;
    *)
      echo "Opção desconhecida: $1" >&2; exit 1 ;;
  esac
done

INSTALL_BIN_DIR="${INSTALL_PREFIX}/bin"

# ── Dependency checks ─────────────────────────────────────────────────────────
if ! command -v bun > /dev/null 2>&1; then
  echo "Erro: 'bun' é necessário mas não foi encontrado." >&2
  echo "Instale o bun: curl -fsSL https://bun.sh/install | bash" >&2
  echo "Depois rode novamente: bash install.sh" >&2
  exit 1
fi

if ! command -v openssl > /dev/null 2>&1; then
  echo "Erro: 'openssl' é necessário mas não foi encontrado." >&2
  echo "Instale: sudo apt-get install openssl  (Ubuntu/Debian)" >&2
  exit 1
fi

echo "Instalando o HiveMind..."
echo "  HIVEMIND_HOME: ${HIVEMIND_HOME}"

# ── Create directories ────────────────────────────────────────────────────────
mkdir -p "${HIVEMIND_HOME}/.claude"
mkdir -p "${HIVEMIND_HOME}/runtime"

# _set_env_kv: idempotent set-or-update of a KEY=value line in $HIVEMIND_HOME/.env.
_set_env_kv() {
  local _key="$1" _val="$2"
  if grep -q "^${_key}=" "${HIVEMIND_HOME}/.env"; then
    sed -i "s|^${_key}=.*|${_key}=${_val}|" "${HIVEMIND_HOME}/.env"
  else
    printf '%s=%s\n' "${_key}" "${_val}" >> "${HIVEMIND_HOME}/.env"
  fi
}

# Persist the product endpoint so the runtime reads it at startup (before enrollment).
touch "${HIVEMIND_HOME}/.env"
_set_env_kv HIVEMIND_ENDPOINT "${HIVEMIND_ENDPOINT}"
echo "  Endpoint:    ${HIVEMIND_ENDPOINT}"

# Pin the update source (item 4.4, hivemind update): the remote URL + branch
# recorded HERE, once, at install time — 'hivemind update' pulls from this
# pinned pair, not from whatever the local clone's remote/branch might drift
# to later. This is requirement 1 (fonte pinada) of the hardened pull-agent.
if [ -d "${SCRIPT_DIR}/.git" ]; then
  _pinned_remote="$(git -C "${SCRIPT_DIR}" remote get-url origin 2>/dev/null || echo '')"
  _pinned_branch="$(git -C "${SCRIPT_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'main')"
  _set_env_kv HIVEMIND_SOURCE_DIR "${SCRIPT_DIR}"
  _set_env_kv HIVEMIND_UPDATE_REMOTE "${_pinned_remote}"
  _set_env_kv HIVEMIND_UPDATE_BRANCH "${_pinned_branch}"
  echo "  Update src:  ${SCRIPT_DIR} (${_pinned_remote:-no remote}@${_pinned_branch})"
else
  echo "  Update src:  (skipped — ${SCRIPT_DIR} is not a git clone, 'hivemind update' unavailable)"
fi

# ── Copy files ────────────────────────────────────────────────────────────────
# NOTE (item 1.6, prompts não expostos): self-core.seed does NOT exist in this
# repo anymore and must NEVER be added back to this copy list. The espinha
# (identity/posture/resonance/purpose/voice) is provisioned server-side at
# enrollment and read via fos_recall({mode:'topic', topic:'self/core'}) — see
# CLAUDE.md's "Espinha (self-core)" section. Copying a real identity file into
# a public client repo/install is exactly the leak this item closed.
cp "${SCRIPT_DIR}/CLAUDE.md" "${HIVEMIND_HOME}/CLAUDE.md"
cp "${SCRIPT_DIR}/.claude/settings.json" "${HIVEMIND_HOME}/.claude/settings.json"

# Copy runtime (preserve permissions; exclude node_modules if present).
rsync -a --exclude='node_modules/' --exclude='bun.lock' \
  "${SCRIPT_DIR}/runtime/" "${HIVEMIND_HOME}/runtime/" 2>/dev/null \
  || cp -r "${SCRIPT_DIR}/runtime/." "${HIVEMIND_HOME}/runtime/"

# ── Install bun dependencies ──────────────────────────────────────────────────
echo "Instalando dependências do runtime (bun install)..."
(cd "${HIVEMIND_HOME}/runtime" && bun install --silent 2>/dev/null || bun install)

# ── Install hivemind binary ───────────────────────────────────────────────────
# Try system-wide prefix first; fallback to user-local ~/.local/bin.
_install_binary() {
  local _dest_dir="$1"
  mkdir -p "${_dest_dir}" 2>/dev/null || return 1
  [ -w "${_dest_dir}" ] || return 1
  cp "${SCRIPT_DIR}/bin/hivemind" "${_dest_dir}/hivemind"
  chmod +x "${_dest_dir}/hivemind"
  echo "  Binário:     ${_dest_dir}/hivemind"
  return 0
}

if ! _install_binary "${INSTALL_BIN_DIR}"; then
  LOCAL_BIN="${HOME}/.local/bin"
  if ! _install_binary "${LOCAL_BIN}"; then
    echo "Erro: não foi possível escrever em ${INSTALL_BIN_DIR} ou ${LOCAL_BIN}" >&2
    exit 1
  fi
  # Warn if ~/.local/bin is not on PATH.
  if [[ ":${PATH}:" != *":${LOCAL_BIN}:"* ]]; then
    echo ""
    echo "Nota: ${LOCAL_BIN} não está no seu PATH. Adicione:"
    echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
  fi
fi

# ── Smoke check ───────────────────────────────────────────────────────────────
if command -v hivemind > /dev/null 2>&1; then
  echo "  Smoke:       $(hivemind --version)"
else
  echo "  Smoke:       (hivemind ainda não está no PATH — veja a nota acima)"
fi

echo ""
echo "HiveMind instalado. Rode: hivemind"
echo "Na primeira execução, você será guiado pela configuração do certificado."
