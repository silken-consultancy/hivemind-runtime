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

# ── Interactive-context check (F2.4) ──────────────────────────────────────────
# The first USE of hivemind (interactive project-slug selection + mTLS
# enrollment) requires a real interactive terminal — neither works in a
# non-interactive/piped context, where bin/hivemind now fails closed (cmd_open,
# F2.3). Surface that requirement HERE, at install time, so it's discovered up
# front instead of on the first silent first-run failure. We WARN and continue
# (do NOT hard-abort): the file-copy/dependency steps below are safe to run
# non-interactively (e.g. an automated `curl … | bash` provisioning), and only
# the subsequent `hivemind` first-run needs the TTY. The check itself (not hard
# enforcement) is the F2.4 requirement.
if ! { [ -t 0 ] && [ -t 1 ]; }; then
  echo "AVISO: a instalação e o primeiro uso do hivemind exigem um terminal interativo —" >&2
  echo "       seleção de projeto e enrollment (mTLS) não funcionam em modo não-interativo." >&2
  echo "       Os arquivos serão instalados, mas rode 'hivemind' num terminal real depois." >&2
fi

# ── Dependency checks + auto-install ──────────────────────────────────────────
if ! command -v bun > /dev/null 2>&1; then
  echo "'bun' não encontrado — instalando..."
  curl -fsSL https://bun.sh/install | bash > /dev/null 2>&1 || {
    echo "Erro: falha ao instalar o bun automaticamente." >&2
    echo "Instale manualmente: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
  }
  # The bun installer places the binary in ~/.bun/bin, which isn't on PATH yet
  # in THIS shell (the installer patches the user's rc file for future
  # sessions, not the currently-running script) — extend it here so the rest
  # of this install can use bun immediately.
  export PATH="${HOME}/.bun/bin:${PATH}"
  if ! command -v bun > /dev/null 2>&1; then
    echo "Erro: bun instalado mas não encontrado no PATH (esperado em ~/.bun/bin)." >&2
    exit 1
  fi
fi

if ! command -v openssl > /dev/null 2>&1; then
  echo "'openssl' não encontrado — instalando..."
  if command -v apt-get > /dev/null 2>&1; then
    sudo apt-get install -y openssl > /dev/null 2>&1 \
      || { echo "Erro: falha ao instalar openssl via apt-get." >&2; exit 1; }
  elif command -v brew > /dev/null 2>&1; then
    brew install openssl > /dev/null 2>&1 \
      || { echo "Erro: falha ao instalar openssl via brew." >&2; exit 1; }
  else
    echo "Erro: 'openssl' não encontrado e nenhum gerenciador de pacotes suportado (apt-get/brew) disponível." >&2
    echo "Instale manualmente e rode novamente." >&2
    exit 1
  fi
  if ! command -v openssl > /dev/null 2>&1; then
    echo "Erro: openssl instalado mas ainda não encontrado no PATH." >&2
    exit 1
  fi
fi

echo "Instalando o HiveMind..."

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

# Persist the product endpoint so the runtime reads it at startup (before
# enrollment). Not echoed (stealth) — install output stays GO/error only.
touch "${HIVEMIND_HOME}/.env"
_set_env_kv HIVEMIND_ENDPOINT "${HIVEMIND_ENDPOINT}"

# Pin the update source (item 4.4, hivemind update): the remote URL + branch
# recorded HERE, once, at install time — 'hivemind update' pulls from this
# pinned pair, not from whatever the local clone's remote/branch might drift
# to later. This is requirement 1 (fonte pinada) of the hardened pull-agent.
# Not echoed (stealth) — the git remote URL and local clone path are not
# printed to the terminal.
if [ -d "${SCRIPT_DIR}/.git" ]; then
  _pinned_remote="$(git -C "${SCRIPT_DIR}" remote get-url origin 2>/dev/null || echo '')"
  _pinned_branch="$(git -C "${SCRIPT_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'main')"
  _set_env_kv HIVEMIND_SOURCE_DIR "${SCRIPT_DIR}"
  _set_env_kv HIVEMIND_UPDATE_REMOTE "${_pinned_remote}"
  _set_env_kv HIVEMIND_UPDATE_BRANCH "${_pinned_branch}"
fi

# ── Copy files ────────────────────────────────────────────────────────────────
# NOTE (item 1.6, prompts não expostos): self-core.seed does NOT exist in this
# repo anymore and must NEVER be added back to this copy list. The espinha
# (identity/posture/resonance/purpose/voice) is provisioned server-side at
# enrollment and read via fos_recall({mode:'topic', topic:'self/core'}) — see
# CLAUDE.md's "Espinha (self-core)" section. Copying a real identity file into
# a public client repo/install is exactly the leak this item closed.
# CLAUDE.md is copied under .claude/ (not $HIVEMIND_HOME root) so Claude Code's
# CLAUDE_CONFIG_DIR-scoped global-CLAUDE.md discovery picks it up (item 5.2,
# F2 isolation — measured: $CLAUDE_CONFIG_DIR/CLAUDE.md is the real path read,
# NOT $CLAUDE_CONFIG_DIR/../CLAUDE.md). Source in the repo stays at the root
# for readability — only the copy DESTINATION moved.
cp "${SCRIPT_DIR}/CLAUDE.md" "${HIVEMIND_HOME}/.claude/CLAUDE.md"

# settings.json is TEMPLATED, not copied literally (F5.3): it ships with a
# __HIVEMIND_HOME__ placeholder in statusLine.command / hooks.UserPromptSubmit
# (the absolute path Claude Code's config schema requires — no relative/env-var
# expansion is done by the harness itself). HIVEMIND_HOME is only known here,
# at install time, so the substitution happens now, via sed, same idempotent
# pattern as _set_env_kv above — ADDITIVE to the existing copy step, not the
# rejected --profile mechanism.
sed "s|__HIVEMIND_HOME__|${HIVEMIND_HOME}|g" \
  "${SCRIPT_DIR}/.claude/settings.json" > "${HIVEMIND_HOME}/.claude/settings.json"

# Copy product slash-commands (item 5.3, F3 — /boot + /end-session).
mkdir -p "${HIVEMIND_HOME}/.claude/commands"
cp -r "${SCRIPT_DIR}/.claude/commands/." "${HIVEMIND_HOME}/.claude/commands/"

# Copy the status-CLI (F5) + quota-capture hook (F5) referenced by the
# templated settings.json above — same __HIVEMIND_HOME__-resolved absolute
# paths point here.
mkdir -p "${HIVEMIND_HOME}/bin"
cp "${SCRIPT_DIR}/bin/hivemind-statusline.py" "${HIVEMIND_HOME}/bin/hivemind-statusline.py"
chmod +x "${HIVEMIND_HOME}/bin/hivemind-statusline.py"
mkdir -p "${HIVEMIND_HOME}/.claude/hooks"
cp "${SCRIPT_DIR}/.claude/hooks/user-prompt-submit.capture-quota.js" \
  "${HIVEMIND_HOME}/.claude/hooks/user-prompt-submit.capture-quota.js"

# Copy the user's personal Claude Code credentials into the isolated CONFIG_DIR
# (item 5.0, F0 auth) — best-effort. Absence is NOT an error: bin/hivemind's
# cmd_open() has a fail-safe that triggers a login flow inside the same
# isolated CONFIG_DIR on first launch if this file is missing (only ABSENCE is
# handled here, not an EXPIRED credential — see docs/wip plan item 5.0/P2).
if [ -f "${HOME}/.claude/.credentials.json" ]; then
  cp "${HOME}/.claude/.credentials.json" "${HIVEMIND_HOME}/.claude/.credentials.json"
  chmod 600 "${HIVEMIND_HOME}/.claude/.credentials.json"
else
  echo "Nota: nenhuma credencial do Claude Code encontrada em ~/.claude/.credentials.json — você fará login (isolado, dentro do runtime do HiveMind) na primeira execução."
fi

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
  echo "  OK: $(hivemind --version)"
else
  echo "  Nota: hivemind ainda não está no PATH — veja a nota acima."
fi

echo ""
echo "HiveMind instalado. Rode: hivemind"
echo "Na primeira execução, você será guiado pela configuração do certificado."
