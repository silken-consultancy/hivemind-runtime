#!/usr/bin/env bash
# install.sh — HiveMind one-shot installer (WSL/Linux).
#
# Installs the hivemind binary to PATH and copies runtime files to $HIVEMIND_HOME.
# Does NOT provision a certificate — run 'hivemind' after install for first-time setup.
#
# Components (impl 3e2c90da, phase S): the PROXY (connection layer: runtime
# daemon + mTLS proxy, .env, binary) is always installed; the Claude Code
# HARNESS (CLAUDE.md, settings.json, commands, hooks, statusline, isolated
# credentials seed) is installed by default and skipped with --proxy-only.
# What is installed is recorded in $HIVEMIND_HOME/.components ("proxy harness"
# or "proxy"). Re-running without --proxy-only adds the harness later.
#
# Usage:
#   bash install.sh                  # proxy + harness; binary to /usr/local/bin (fallback: ~/.local/bin)
#   bash install.sh --prefix <dir>   # install binary to <dir>/bin/hivemind
#   bash install.sh --proxy-only     # proxy only — connect any MCP client to it (`hivemind` prints how)
#   bash install.sh --autostart      # also run `hivemind autostart on` at the end (opt-in; needs a
#                                    # certificate — on a fresh machine run `hivemind` first, then
#                                    # `hivemind autostart on`). Without it, no autostart entry is created.

set -euo pipefail

HIVEMIND_HOME="${HIVEMIND_HOME:-$HOME/.hivemind}"
HIVEMIND_ENDPOINT="${HIVEMIND_ENDPOINT:-hivemind.ia.br:4443}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_PREFIX="/usr/local"
PROXY_ONLY=0
AUTOSTART=0

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      if [ -z "${2:-}" ]; then echo "Erro: --prefix requer um valor" >&2; exit 1; fi
      INSTALL_PREFIX="$2"; shift 2 ;;
    --endpoint)
      if [ -z "${2:-}" ]; then echo "Erro: --endpoint requer um valor" >&2; exit 1; fi
      HIVEMIND_ENDPOINT="$2"; shift 2 ;;
    --proxy-only)
      PROXY_ONLY=1; shift ;;
    --autostart)
      AUTOSTART=1; shift ;;
    --help|-h)
      echo "Uso: bash install.sh [--prefix <dir>] [--endpoint <host:port>] [--proxy-only] [--autostart]"
      echo "  --proxy-only   instala só o proxy (sem o harness do Claude Code); conecte qualquer"
      echo "                 cliente MCP a ele — rode 'hivemind' depois para ver como."
      echo "  --autostart    liga 'hivemind autostart on' no fim (sobe o proxy no login; exige"
      echo "                 certificado — numa máquina nova rode 'hivemind' antes). Padrão: desligado."
      exit 0 ;;
    *)
      echo "Opção desconhecida: $1" >&2; exit 1 ;;
  esac
done

INSTALL_BIN_DIR="${INSTALL_PREFIX}/bin"

# --proxy-only never strips an existing harness (that is `hivemind uninstall
# harness`, which also removes the isolated Claude Code state after listing it).
if [ "${PROXY_ONLY}" = "1" ] \
  && { [ -f "${HIVEMIND_HOME}/.claude/settings.json" ] || [ -d "${HIVEMIND_HOME}/.claude/hooks" ]; }; then
  echo "Erro: o harness do Claude Code já está instalado em ${HIVEMIND_HOME}/.claude." >&2
  echo "      Para ficar só com o proxy, remova-o com: hivemind uninstall harness" >&2
  exit 1
fi

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
if [ "${PROXY_ONLY}" != "1" ]; then
  mkdir -p "${HIVEMIND_HOME}/.claude"
fi
mkdir -p "${HIVEMIND_HOME}/runtime"
# Proxy-only: the marker goes down FIRST, before .env / runtime copy / bun
# install — a partial failure must never leave a markerless runtime, which
# bin/hivemind would read as proxy+harness and try to open Claude Code from.
if [ "${PROXY_ONLY}" = "1" ]; then
  printf 'proxy\n' > "${HIVEMIND_HOME}/.components"
fi

# _sed_escape_repl: escape sed REPLACEMENT-text specials (& = whole match,
# \ = escape/backreference start) so an arbitrary value (a --endpoint flag,
# a git-derived remote URL) can never corrupt the sed substitution below.
_sed_escape_repl() { printf '%s' "$1" | sed -e 's/[\&]/\\&/g'; }

# _set_env_kv: idempotent set-or-update of a KEY=value line in $HIVEMIND_HOME/.env.
_set_env_kv() {
  local _key="$1" _val
  _val="$(_sed_escape_repl "$2")"
  if grep -q "^${_key}=" "${HIVEMIND_HOME}/.env"; then
    sed -i "s|^${_key}=.*|${_key}=${_val}|" "${HIVEMIND_HOME}/.env"
  else
    printf '%s=%s\n' "${_key}" "$2" >> "${HIVEMIND_HOME}/.env"
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

# ── Credentials kept by `hivemind uninstall --keep-certs` (blocker 3b7a507e) ──
# The cert files alone do not start the mTLS proxy: MTLS_CERT_PATH/KEY_PATH/
# CA_PATH, HIVEMIND_OWNER and FOS_API_KEY lived in the .env that uninstall
# removed, so it parked those lines (MTLS_* + HIVEMIND_OWNER + FOS_API_KEY) in
# ~/.engram/kept-credentials.env (0600). Merge them back — only keys the .env
# does not already have (a newer enrollment always wins) and only while the
# cert + key they point at still exist — then delete the file so the secret is
# not left in two places. Values are never printed. Without that file this
# block does nothing.
_KEPT_CREDENTIALS="${HOME}/.engram/kept-credentials.env"
if [ -f "${_KEPT_CREDENTIALS}" ]; then
  _kc_cert="$(sed -n 's/^MTLS_CERT_PATH=//p' "${_KEPT_CREDENTIALS}" | tail -n 1)"
  _kc_key="$(sed -n 's/^MTLS_KEY_PATH=//p' "${_KEPT_CREDENTIALS}" | tail -n 1)"
  if [ -n "${_kc_cert}" ] && [ -n "${_kc_key}" ] && [ -f "${_kc_cert}" ] && [ -f "${_kc_key}" ]; then
    chmod 600 "${HIVEMIND_HOME}/.env"
    _kc_added=0
    while IFS= read -r _kc_line || [ -n "${_kc_line}" ]; do
      _kc_k="${_kc_line%%=*}"
      [ "${_kc_k}" != "${_kc_line}" ] || continue
      [[ "${_kc_k}" =~ ^(MTLS_[A-Z0-9_]+|HIVEMIND_OWNER|FOS_API_KEY)$ ]] || continue
      if grep -q "^${_kc_k}=" "${HIVEMIND_HOME}/.env"; then continue; fi
      printf '%s\n' "${_kc_line}" >> "${HIVEMIND_HOME}/.env"
      _kc_added=$((_kc_added + 1))
    done < "${_KEPT_CREDENTIALS}"
    echo "Credenciais do enrollment guardadas por 'hivemind uninstall --keep-certs' restauradas (${_kc_added} keys) — sem novo enrollment."
  else
    echo "Nota: as credenciais guardadas por 'hivemind uninstall --keep-certs' apontam para um certificado/chave que não existe mais — não restauradas; rode 'hivemind' para fazer o enrollment de novo."
  fi
  rm -f "${_KEPT_CREDENTIALS}"
fi

# ── Copy files ────────────────────────────────────────────────────────────────
# NOTE (item 1.6, prompts não expostos): self-core.seed does NOT exist in this
# repo anymore and must NEVER be added back to this copy list. The espinha
# (identity/posture/resonance/purpose/voice) is provisioned server-side at
# enrollment and read via fos_recall({mode:'topic', topic:'self/core'}) — see
# CLAUDE.md's "Espinha (self-core)" section. Copying a real identity file into
# a public client repo/install is exactly the leak this item closed.
# ── HARNESS component (skipped with --proxy-only) — from here to "end of the
# HARNESS component" below; the block is kept unindented so the default
# (proxy+harness) install stays line-for-line what it was.
if [ "${PROXY_ONLY}" != "1" ]; then
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
#
# MERGE-SAFE (founder report): a re-install used to `sed ... >` this file
# directly — a full-file OVERWRITE that silently deleted whatever the user had
# added on top of the shipped defaults (extra permissions.allow/deny entries
# via /config, a custom hook, etc.), forcing full reconfiguration on every
# re-install. Deep-merge via scripts/merge-settings-json.mjs instead: objects
# merge key-by-key (the user's extra keys survive), arrays are TEMPLATE-OWNED
# WITH REVOCATION (code-review fix — the template's entries are always
# present; an existing entry survives only if it's not already covered by the
# template AND wasn't part of the PREVIOUS template shipment, tracked via a
# sidecar `settings.json.template-snapshot.json` the script itself maintains
# — so a permission/hook the template stops shipping is actually revoked on
# the next install/re-install, while a genuinely user-added entry still
# survives; see scripts/merge-settings-json.mjs's own docstring for the full
# semantics), scalars re-apply the freshly-templated value (statusLine command
# path, defaultMode, hook command lines must track the shipped runtime, not a
# stale local edit). A corrupted/non-object existing file is treated as absent
# — never aborts the install; a fresh install (no pre-existing file) is just
# the templated content, unchanged.
_templated_settings="$(mktemp)"
sed "s|__HIVEMIND_HOME__|${HIVEMIND_HOME}|g" \
  "${SCRIPT_DIR}/.claude/settings.json" > "${_templated_settings}"
bun run "${SCRIPT_DIR}/scripts/merge-settings-json.mjs" \
  "${HIVEMIND_HOME}/.claude/settings.json" "${_templated_settings}"
rm -f "${_templated_settings}"

# Copy product slash-commands (item 5.3, F3 — /boot + /end-session).
# These are THIN STUBS (Branch B, decision_serve-boot-and-end-session-as-mcp-prompts-fail-closed):
# the canonical procedure body no longer lives here — each stub fetches it live from the
# engram via fos_procedure({id}) at invocation time and executes it verbatim. FAIL-CLOSED:
# if the engram is unreachable, the stub does not fall back to any local copy — the session
# does not boot/close. See CLAUDE.md § Session start / § Session close for the full contract.
mkdir -p "${HIVEMIND_HOME}/.claude/commands"
cp -r "${SCRIPT_DIR}/.claude/commands/." "${HIVEMIND_HOME}/.claude/commands/"

# Copy the status-CLI (F5) + quota-capture hook (F5) referenced by the
# templated settings.json above — same __HIVEMIND_HOME__-resolved absolute
# paths point here.
mkdir -p "${HIVEMIND_HOME}/bin"
cp "${SCRIPT_DIR}/bin/hivemind-statusline.py" "${HIVEMIND_HOME}/bin/hivemind-statusline.py"
chmod +x "${HIVEMIND_HOME}/bin/hivemind-statusline.py"
mkdir -p "${HIVEMIND_HOME}/.claude/hooks"
# Copy the WHOLE hooks dir (the class), never a per-file allowlist — a forgotten
# file in a cherry-pick list is exactly what shipped a settings.json Stop entry
# referencing a hook the update path never installed (ERR_MODULE_NOT_FOUND at the
# Stop event). settings.json is the single source of which hooks are registered.
cp -r "${SCRIPT_DIR}/.claude/hooks/." "${HIVEMIND_HOME}/.claude/hooks/"

# Seed the isolated CONFIG_DIR's Claude Code credentials from the user's
# personal ones ONLY when the isolated destination doesn't have one yet
# (item 5.0, F0 auth) — best-effort, seed-on-absence by design. A live,
# already-logged-in isolated credential must never be clobbered by a
# possibly-stale personal copy on every (re)install/re-enroll — that was
# measured to force a spurious logout on every reinstall. If neither exists,
# bin/hivemind's cmd_open() has a fail-safe that triggers a login flow inside
# the same isolated CONFIG_DIR on first launch (known limitation: an EXPIRED
# credential is not detected here, only absence).
if [ ! -f "${HIVEMIND_HOME}/.claude/.credentials.json" ]; then
  if [ -f "${HOME}/.claude/.credentials.json" ]; then
    cp "${HOME}/.claude/.credentials.json" "${HIVEMIND_HOME}/.claude/.credentials.json"
    chmod 600 "${HIVEMIND_HOME}/.claude/.credentials.json"
  else
    # Genuinely no source AND no isolated credential yet — only case where
    # the login-on-first-run note applies. When the isolated destination
    # already has a (possibly live) credential, this whole block is skipped
    # and nothing is printed — see the note above about not scaring a
    # re-install with a false logout warning.
    echo "Nota: nenhuma credencial do Claude Code encontrada em ~/.claude/.credentials.json — você fará login (isolado, dentro do runtime do HiveMind) na primeira execução."
  fi
fi
fi
# ── end of the HARNESS component ─────────────────────────────────────────────

# Copy runtime (preserve permissions; exclude node_modules if present).
rsync -a --exclude='node_modules/' --exclude='bun.lock' \
  "${SCRIPT_DIR}/runtime/" "${HIVEMIND_HOME}/runtime/" 2>/dev/null \
  || cp -r "${SCRIPT_DIR}/runtime/." "${HIVEMIND_HOME}/runtime/"

# ── Install bun dependencies ──────────────────────────────────────────────────
echo "Instalando dependências do runtime (bun install)..."
# --production: runtime deps only — a user install never gets the
# devDependencies (typescript, @types/bun) (impl 3e2c90da, item D3).
(cd "${HIVEMIND_HOME}/runtime" && bun install --production --silent 2>/dev/null || bun install --production)

# ── Component marker (phase S2) — read by bin/hivemind's _has_harness ─────────
# (the proxy-only marker was already written before the runtime copy, above)
if [ "${PROXY_ONLY}" != "1" ]; then
  printf 'proxy harness\n' > "${HIVEMIND_HOME}/.components"
fi

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

INSTALLED_BIN="${INSTALL_BIN_DIR}/hivemind"
if ! _install_binary "${INSTALL_BIN_DIR}"; then
  LOCAL_BIN="${HOME}/.local/bin"
  INSTALLED_BIN="${LOCAL_BIN}/hivemind"
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
if [ "${PROXY_ONLY}" = "1" ]; then
  echo "Instalação só-proxy: 'hivemind' sobe o proxy e mostra como conectar o seu cliente MCP."
fi

# ── Autostart (impl 3e2c90da, phase A) — ONLY with --autostart ────────────────
# Runs the binary just installed. It needs a certificate; without one the
# install still succeeds and the exact next step is printed.
if [ "${AUTOSTART}" = "1" ]; then
  echo ""
  if HIVEMIND_HOME="${HIVEMIND_HOME}" bash "${INSTALLED_BIN}" autostart on; then
    :
  else
    echo "Autostart NÃO foi ligado. Depois do primeiro 'hivemind' (enrollment), rode: hivemind autostart on"
  fi
fi
