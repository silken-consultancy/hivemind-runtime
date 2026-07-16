// HiveMind — UserPromptSubmit hook: cota oficial de assinatura via API, fresca por mensagem.
//
// PORQUÊ: os percentuais de sessão/semana NÃO vêm em nenhum campo estruturado do
// Claude Code nem nos headers do transcript — a única fonte além do texto do
// `/usage` é o endpoint OAuth interno `GET https://api.anthropic.com/api/oauth/usage`.
// Ele responde com Bearer do token que o próprio Claude Code mantém fresco em disco
// (CLAUDE_CONFIG_DIR/.credentials.json). Este hook lê esse token, chama o endpoint e
// escreve o MESMO cache ~/.claude/cache/usage.json que a statusline já consome — então
// a tira passa a mostrar a cota oficial atualizando a cada mensagem, sem rodar /usage.
//
// CONTRATO de escrita (compatível com hivemind-statusline.py):
//   { captured_at, source:"api",
//     session_pct, session_reset,         <- five_hour.utilization
//     week_pct, week_reset,               <- seven_day.utilization (global, all-models)
//     week_sonnet_pct, week_sonnet_reset, <- seven_day_sonnet.utilization
//     total_cost_usd?, by_model? }        <- preservados de um scrape /usage anterior
//
// CUIDADOS (verificados 2026-06-10):
//   - Rate-limit: o endpoint dá 429 sob polling agressivo (issue #31637, "not planned").
//     Disparamos em UserPromptSubmit (1×/mensagem) + throttle FOS_QUOTA_REFRESH_SEC (60s).
//   - Não-bloqueante: o fetch roda em processo DETACHED; o turno nunca espera a rede.
//   - Fail-soft: qualquer falha (sem token, token expirado, 401/429, timeout) = no-op
//     silencioso; o cache antigo permanece e a statusline esmaece após o TTL de staleness.
//   - Token: usamos a cópia FRESCA (CLAUDE_CONFIG_DIR primeiro; ~/.claude como fallback).
//     Já compatível com o isolamento CLAUDE_CONFIG_DIR=${HIVEMIND_HOME}/.claude que
//     cmd_open (bin/hivemind) exporta antes do `exec claude` — o token isolado do
//     produto é lido antes do fallback pessoal.
//     Não logamos, não copiamos, não enviamos a lugar nenhum além de api.anthropic.com
//     (audiência legítima do próprio token; uso = auto-monitoramento da própria conta).
//   - CACHE (gate F5.2, confirmado nesta porta): a constante abaixo usa
//     os.homedir() diretamente — NÃO é escopada por CLAUDE_CONFIG_DIR. Resolve
//     sempre para ~/.claude/cache/usage.json (o home REAL do usuário), mesmo
//     dentro de uma sessão hivemind com CLAUDE_CONFIG_DIR isolado. Isso é
//     seguro-por-design: a cota de assinatura é escopada à CONTA Anthropic, não
//     à sessão/config-dir, então compartilhar esse único arquivo de cache entre
//     instalações na mesma conta é inofensivo — e a statusline (que lê o
//     mesmo path hardcoded) sempre concorda com o que este hook escreve.
//
// Env:
//   FOS_USAGE_CACHE         path do cache (default ~/.claude/cache/usage.json)
//   FOS_QUOTA_REFRESH_SEC   idade mínima do cache p/ refazer o fetch (default 60)
//   FOS_QUOTA_DISABLE_API=1 desliga este hook (no-op)

const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE = process.env.FOS_USAGE_CACHE
  || path.join(os.homedir(), '.claude', 'cache', 'usage.json');
const TTL_MS = (parseInt(process.env.FOS_QUOTA_REFRESH_SEC || '60', 10) || 60) * 1000;
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

if (process.env.FOS_QUOTA_DISABLE_API === '1') process.exit(0);

// ── modo --fetch: filho detached que faz a rede e grava o cache ───────────────
if (process.argv[2] === '--fetch') {
  const https = require('https');

  const token = readFreshToken();
  if (!token) process.exit(0);

  const req = https.request(ENDPOINT, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
    timeout: 4000,
  }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      if (res.statusCode !== 200) process.exit(0); // 401/429/etc → mantém cache antigo
      let j;
      try { j = JSON.parse(body); } catch { process.exit(0); }
      writeCache(j);
    });
  });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end();
  return;
}

// ── modo hook: lê stdin, aplica throttle, dispara o filho detached ────────────
try { fs.readFileSync(0, 'utf8'); } catch { /* stdin opcional */ }

// throttle: se o cache já é fresco E veio da API, não refaz.
try {
  const cur = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const st = fs.statSync(CACHE);
  if (cur && cur.source === 'api' && (Date.now() - st.mtimeMs) < TTL_MS) {
    process.exit(0);
  }
} catch { /* sem cache ou ilegível → segue e refaz */ }

try {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [__filename, '--fetch'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
} catch { /* se não der pra spawnar, no-op */ }
process.exit(0);

// ── helpers ───────────────────────────────────────────────────────────────────
function readFreshToken() {
  const dirs = [process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude')]
    .filter(Boolean);
  for (const d of dirs) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(d, '.credentials.json'), 'utf8'));
      const o = c.claudeAiOauth;
      if (o && o.accessToken && (!o.expiresAt || o.expiresAt > Date.now())) {
        return o.accessToken;
      }
    } catch { /* tenta o próximo dir */ }
  }
  return null;
}

function fmtReset(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return ''; }
}

function writeCache(j) {
  const out = { captured_at: new Date().toISOString(), source: 'api' };
  // resetKey = string humana (painel fos-status); rawKey = ISO bruto p/ a tira
  // computar o tempo restante até o reset.
  const pick = (node, pctKey, resetKey, rawKey) => {
    if (node && typeof node.utilization === 'number') {
      out[pctKey] = Math.round(node.utilization);
      out[resetKey] = fmtReset(node.resets_at);
      if (node.resets_at) out[rawKey] = node.resets_at;
    }
  };
  pick(j.five_hour, 'session_pct', 'session_reset', 'session_resets_at');
  pick(j.seven_day, 'week_pct', 'week_reset', 'week_resets_at');
  pick(j.seven_day_sonnet, 'week_sonnet_pct', 'week_sonnet_reset', 'week_sonnet_resets_at');
  if (out.session_pct === undefined && out.week_pct === undefined) process.exit(0);

  // preserva custo/by_model de um scrape /usage anterior (info colateral)
  try {
    const prev = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (prev.total_cost_usd !== undefined && out.total_cost_usd === undefined) {
      out.total_cost_usd = prev.total_cost_usd;
    }
    if (prev.by_model && !out.by_model) out.by_model = prev.by_model;
  } catch { /* sem cache anterior */ }

  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(out, null, 2) + '\n');
  } catch { /* fail-soft */ }
  process.exit(0);
}
