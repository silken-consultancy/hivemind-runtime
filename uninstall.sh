#!/usr/bin/env bash
# uninstall.sh — remove o cliente HiveMind para um estado limpo (dev/test).
#
# Remove: o binário `hivemind`, o $HIVEMIND_HOME (~/.hivemind) e o dir de estado
# do produto ~/.engram (certs mTLS + cache). Para o runtime/proxy antes.
# NÃO toca: o clone git (fonte), o seu ~/.claude pessoal, nem ~/.mcp.json.
#
# Uso:
#   bash uninstall.sh                # pergunta antes de remover
#   bash uninstall.sh -y|--yes       # sem confirmação (para scripts de teste)
#   bash uninstall.sh --keep-certs   # preserva ~/.engram/mtls (não re-enrola do zero)

set -euo pipefail

HIVEMIND_HOME="${HIVEMIND_HOME:-$HOME/.hivemind}"
ENGRAM_DIR="${HOME}/.engram"
ASSUME_YES=0
KEEP_CERTS=0

for arg in "$@"; do
  case "$arg" in
    -y|--yes)     ASSUME_YES=1 ;;
    --keep-certs) KEEP_CERTS=1 ;;
    -h|--help)    echo "Uso: bash uninstall.sh [-y|--yes] [--keep-certs]"; exit 0 ;;
    *)            echo "Opção desconhecida: $arg" >&2; exit 1 ;;
  esac
done

echo "HiveMind — uninstall"
echo "  binário:         $(command -v hivemind 2>/dev/null || echo '(não no PATH)')"
echo "  HIVEMIND_HOME:   ${HIVEMIND_HOME}"
if [ "${KEEP_CERTS}" = "1" ]; then
  echo "  estado produto:  ${ENGRAM_DIR}/cache (certs em ${ENGRAM_DIR}/mtls preservados)"
else
  echo "  estado produto:  ${ENGRAM_DIR} (certs + cache — re-enroll do zero)"
fi
echo ""

if [ "${ASSUME_YES}" != "1" ]; then
  printf "Remover tudo isso? [y/N] "
  read -r _ans
  case "${_ans}" in
    y|Y|yes|YES|s|S|sim|SIM) ;;
    *) echo "Abortado."; exit 0 ;;
  esac
fi

# 1. Parar o runtime/proxy antes de remover os dirs (best-effort).
if command -v hivemind > /dev/null 2>&1; then
  hivemind stop > /dev/null 2>&1 || true
fi
# Fallback: matar pelo pidfile se ainda vivo (o dir some no passo 4 de qualquer forma).
_pidf="${ENGRAM_DIR}/cache/hivemind-runtime.pid"
if [ -f "${_pidf}" ]; then
  _pid="$(cat "${_pidf}" 2>/dev/null || echo '')"
  if [ -n "${_pid}" ] && kill -0 "${_pid}" 2>/dev/null; then
    kill "${_pid}" 2>/dev/null || true
  fi
fi

# 2. Remover o binário instalado (system-wide + user-local).
for _bin in "/usr/local/bin/hivemind" "${HOME}/.local/bin/hivemind"; do
  if [ -e "${_bin}" ]; then
    if rm -f "${_bin}" "${_bin}.last-good" "${_bin}.new" 2>/dev/null; then
      echo "removido: ${_bin}"
    else
      echo "sem permissão p/ remover ${_bin} — rode: sudo rm -f ${_bin}" >&2
    fi
  fi
done

# 3. Remover HIVEMIND_HOME + os dirs de staging/rollback do pull-agent.
rm -rf "${HIVEMIND_HOME}" "${HIVEMIND_HOME}.staging" "${HIVEMIND_HOME}.last-good"
echo "removido: ${HIVEMIND_HOME} (+ .staging/.last-good)"

# 4. Estado do produto (certs + cache), salvo --keep-certs.
if [ "${KEEP_CERTS}" = "1" ]; then
  rm -rf "${ENGRAM_DIR}/cache"
  echo "removido: ${ENGRAM_DIR}/cache (certs preservados)"
else
  rm -rf "${ENGRAM_DIR}"
  echo "removido: ${ENGRAM_DIR} (certs + cache)"
fi

echo ""
echo "Limpo. Reinstalar: bash install.sh  →  depois: hivemind (roda o setup do zero)."
