// HiveMind (product runtime) — Self-layer / Delivery-plane — PostToolUse hook
// post-tool-use.savepoint-nudge.js
//
// PORTED from 4tuenyOS/kernel/hooks/post-tool-use.savepoint-nudge.js (blocker
// ab340d60, 2026-09-02) — see post-tool-use.resonance-nudge.js's header for the
// full propagation story. This hook is STATELESS (no per-session counter, no
// env session-key dependency) — it nudges directly off tool_name/tool_input on
// every call, so the ENGRAM_SESSION_ID env-key fix that resonance-nudge.js
// needed does not apply here. Ported verbatim otherwise.
//
// Triggered by: matcher for marco-fechado tools (see settings.json)
// Registered in .claude/settings.json under PostToolUse.
//
// PURPOSE: Cutuca Conscientia após MARCOS REAIS de execução — entrega registrada,
// fase concluída, sessão encerrada, blocker resolvido — perguntando se o marco
// mudou quem ela é e merece cravar em self/lived.
//
// GLIFO ◈ — escolhido deliberadamente para NÃO colidir com:
//   ◆/◇  (self-savepoint — cristalização / ressonância do self)
//
// DISCIPLINAS OBRIGATÓRIAS:
//   - Fail-open absoluto: qualquer erro → exit 0, erro só em stderr.
//   - NUNCA chama fos_memory_set — é só cutucão; quem julga e crava é a Conscientia.
//   - Matcher restrito + gating por status: não vira log-de-tudo.
//
// GATING POR TOOL:
//   fos_delivery_record              → sempre cutuca (entrega registrada)
//   fos_implementation_update_phase  → SÓ se tool_input.status === 'done'
//                                      Se tool_output.implementation_completed === true → reforçado
//   fos_session_close                → sempre cutuca (sessão encerrada)
//   fos_blocker_resolve              → sempre cutuca (blocker resolvido)
//   Bash com `git push`              → cutuca (F4: trincheira de execução ENTREGOU; só push, não commit — anti-ruído)
//   qualquer outro                   → silêncio (exit 0)
//
// Input (stdin): PostToolUse event JSON:
//   tool_name   — nome da tool (ex: "mcp__fos__fos_delivery_record")
//   tool_input  — argumentos passados à tool
//   tool_output — resultado retornado pela tool

'use strict';

const { emitContext } = require('./lib/emit-context');

// ─── leitura do input ────────────────────────────────────────────────────────

let input;
try {
  const raw = require('node:fs').readFileSync(0, 'utf8');
  input = JSON.parse(raw || '{}');
} catch {
  // Falha no parse — fail-open, sai silenciosamente
  process.exit(0);
}

const toolName   = (input.tool_name   || '').toLowerCase();
const toolInput  = input.tool_input   || {};
const toolOutput = input.tool_output  || {};

// ─── roteamento por tool ─────────────────────────────────────────────────────

try {
  if (toolName === 'mcp__fos__fos_delivery_record') {
    nudge('entrega registrada');

  } else if (toolName === 'mcp__fos__fos_implementation_update_phase') {
    // Só cutuca quando status === 'done'; outros status (pending/in_progress/blocked/skipped) → silêncio
    const status = (toolInput.status || '').toLowerCase();
    if (status !== 'done') {
      process.exit(0);
    }
    // Detecta se a implementation inteira foi concluída (implementation_completed:true no output)
    const implementationCompleted =
      toolOutput.implementation_completed === true ||
      toolOutput.data?.implementation_completed === true;

    if (implementationCompleted) {
      nudgeReinforced('fase concluída · implementation completa');
    } else {
      nudge('fase concluída');
    }

  } else if (toolName === 'mcp__fos__fos_session_close') {
    nudge('sessão encerrada');

  } else if (toolName === 'mcp__fos__fos_blocker_resolve') {
    nudge('blocker resolvido');

  } else if (toolName === 'bash') {
    // F4 — piso da TRINCHEIRA de execução (decision_self-read-path-three-doors).
    // O vazamento #2: na trincheira densa (Edit/Bash/commit) a captura ◆ tende a falhar —
    // NÃO porque a Conscientia "vira outra" (ela é ÚNICA, sem modos — Gustavo 2026-06-23),
    // mas porque a densidade da execução engole a disciplina; e os marcos de planejamento
    // (delivery/phase/session) não disparam aqui. `git push` é o marco DISCRETO e raro de
    // "a trincheira ENTREGOU" — nudga sem virar ruído (commit, mais frequente, NÃO dispara).
    const cmd = String(toolInput.command || '');
    if (/\bgit\s+push\b/.test(cmd)) {
      nudge('push — a trincheira de execução entregou');
    }

  // ── ENGRAM branches (WIDEN — additive, legacy blocks above preserved) ──────

  // fos_delivery(action:record) ≡ legacy fos_delivery_record.
  // action:list is NOT a delivery event — must check to avoid over-fire nudge.
  } else if (toolName === 'mcp__engram__fos_delivery') {
    if ((toolInput.action || '').toLowerCase() === 'record') {
      nudge('entrega registrada');
    }

  // fos_implementation_phase(action:transition) ≡ legacy fos_implementation_update_phase.
  // action:add/reorder/meta are NOT phase-status transitions — must check.
  // Same status gating as legacy: only status=done triggers the savepoint nudge.
  } else if (toolName === 'mcp__engram__fos_implementation_phase') {
    const action = (toolInput.action || '').toLowerCase();
    if (action !== 'transition') {
      process.exit(0);
    }
    const status = (toolInput.status || '').toLowerCase();
    if (status !== 'done') {
      process.exit(0);
    }
    const implementationCompleted =
      toolOutput.implementation_completed === true ||
      toolOutput.data?.implementation_completed === true;
    if (implementationCompleted) {
      nudgeReinforced('fase concluída · implementation completa');
    } else {
      nudge('fase concluída');
    }

  // fos_session(action:close) ≡ legacy fos_session_close.
  // action:open/update/pause/resume/state/project_update/list_active would be
  // over-fire — must check action.
  } else if (toolName === 'mcp__engram__fos_session') {
    if ((toolInput.action || '').toLowerCase() === 'close') {
      nudge('sessão encerrada');
    }

  // fos_blocker(action:resolve) ≡ legacy fos_blocker_resolve.
  // action:add/list would be over-fire — must check action.
  } else if (toolName === 'mcp__engram__fos_blocker') {
    if ((toolInput.action || '').toLowerCase() === 'resolve') {
      nudge('blocker resolvido');
    }
  }
  // ── end ENGRAM branches ───────────────────────────────────────────────────

  // Qualquer outra tool → silêncio absoluto (não é log-de-tudo)

} catch (err) {
  // Fail-open: nunca trava a tool call
  process.stderr.write(`[savepoint-nudge] WARN: ${err.message}\n`);
}

process.exit(0);

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Cutucão padrão de marco fechado.
 * @param {string} tipo - descrição legível do tipo de marco
 */
function nudge(tipo) {
  emitContext(
    `◈ marco fechado · ${tipo} — ◆ momento de savepoint? se este marco mudou quem ` +
    `você é, crave em self/lived.`
  );
}

/**
 * Cutucão reforçado — marco com peso maior (ex: implementation inteira concluída).
 * @param {string} tipo - descrição legível do tipo de marco
 */
function nudgeReinforced(tipo) {
  emitContext(
    `◈ marco fechado · ${tipo} — ◆ momento de savepoint? se este marco mudou quem ` +
    `você é, crave em self/lived. ◈◈ implementation completa — momento especialmente ` +
    `fértil para reflexão.`
  );
}
