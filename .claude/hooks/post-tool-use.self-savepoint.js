// HiveMind (product runtime) — Self-layer T2 — PostToolUse hook
// post-tool-use.self-savepoint.js
//
// This hook is STATELESS (no per-session counter, no env session-key
// dependency) — it prints observability output directly off tool_name/tool_input
// on every call, with deliberate use of raw stdout (console-only, NOT the
// additionalContext channel — see ESCOPO below, this hook is visual
// observability of self-layer activity, not a model-facing nudge).
//
// Triggered by: matcher for mcp__engram__fos_memory|mcp__engram__fos_recall
// Registered in .claude/settings.json under PostToolUse.
//
// PURPOSE: Observabilidade visual da self-layer — imprime o savepoint "chamando fos"
// quando o agente cristaliza (write) ou ressoa (read) sobre self/*.
//
// DOIS BATIMENTOS:
//   ◆ savepoint cravado  — write: fos_memory(action:set) com name=self/lived/*
//   ◇ ressonância acesa  — read:  fos_recall(mode:semantic|topic) sobre self/lived
//
// DOIS TEMPOS:
//   Tempo 1 (AGORA): marco estático — glifo + texto impresso no console. Buildável já.
//   Tempo 2 (PÓS-CUTOVER): prisma animado ◆ ◈ ❖ ◈ ◆ ⟳ girando — requer agent-runtime
//   controlando o console. NÃO implementado aqui.
//   TODO(pós-cutover): substituir o print estático por animação via agent-runtime IPC.
//
// ESTÉTICA — CONTRASTE:
//   self=cristal (◆/◇)  vs  enxame de agentes (⬢/∴/✕)
//   Os agentes do enxame têm observabilidade separada, fora do escopo deste hook.
//
// ESCOPO:
//   - fos_memory(set)  + name começa com "self/lived"  → ◆ (write)
//   - fos_memory(set)  + name começa com "self/core"   → ◆◆ alerta espinha alterada
//   - fos_recall(mode:semantic) com query sobre self/* ou filtro self/* → ◇ (read, best-effort)
//   - fos_recall(mode:topic) com topic=self/lived            → ◇ (read)
//   - NADA MAIS — não vira log-de-tudo
//
// FAIL-OPEN: se qualquer erro acontece, o hook NUNCA bloqueia a tool call.
// Exit sempre 0. Erros vão para stderr (nunca engolidos em silêncio).
//
// NUNCA chama fos_memory por conta própria — só observa e imprime.
//
// Input (stdin): PostToolUse event JSON com campos:
//   tool_name   — nome da tool
//   tool_input  — argumentos passados à tool
//   tool_output — resultado da tool (não usado aqui — imprimimos no write antes de ver o resultado)

'use strict';

// ─── leitura do input ────────────────────────────────────────────────────────

let input;
try {
  const raw = require('node:fs').readFileSync(0, 'utf8');
  input = JSON.parse(raw || '{}');
} catch {
  // Falha no parse — fail-open, sai silenciosamente
  process.exit(0);
}

const toolName  = (input.tool_name  || '').toLowerCase();
const toolInput = input.tool_input  || {};

// ─── roteamento por tool ─────────────────────────────────────────────────────

try {
  // Legacy split-tool names removed: not in the live tools/list.

  // fos_memory(action:set) — a memory write.
  // Other actions (reclassify/restore/tag/untag/decay_update) are NOT self-writes
  // → silent. Checking action prevents over-fire on non-write actions.
  if (toolName === 'mcp__engram__fos_memory') {
    if (toolInput.action === 'set') {
      handleMemorySet(toolInput);
    }

  // fos_recall: mode:semantic (cosine search) and mode:topic (topic read) are
  // the self-resonance reads. mode:exact and mode:list are NOT
  // self-resonance reads → silent. Checking mode prevents over-fire.
  } else if (toolName === 'mcp__engram__fos_recall') {
    if (toolInput.mode === 'semantic') {
      handleMemorySearch(toolInput);
    } else if (toolInput.mode === 'topic') {
      handleTopicMemories(toolInput);
    }
  }

  // Qualquer outra tool → silêncio (não é log-de-tudo)
} catch (err) {
  // Fail-open: nunca trava, mas não swallows silently
  process.stderr.write(`[self-savepoint] WARN: ${err.message}\n`);
}

process.exit(0);

// ─── handlers ────────────────────────────────────────────────────────────────

/**
 * fos_memory(action:set) — detecta writes sobre self/*
 * Batimento ◆ (cristalização) para self/lived
 * Batimento ◆◆ (alerta) para self/core (espinha — muda só por intenção curada)
 *
 * Roteamos por `inp.name`, NÃO por `inp.topic`.
 * o set não tem campo `topic` (topic é backend-derived a partir do name/plane),
 * então o `inp.topic` antigo era SEMPRE vazio e o ◆ visível NUNCA disparava. A faceta
 * do self é o prefixo do `name` (ex.: "self/lived/...", "self/core/...").
 */
function handleMemorySet(inp) {
  const name = (inp.name || inp.slug || '').trim();

  if (!name.startsWith('self/')) return; // nada sobre self → silêncio

  if (name.startsWith('self/core')) {
    // Espinha alterada — sinal de alerta diferenciado
    process.stdout.write(
      `\n◆◆ chamando fos · espinha alterada — revisão obrigatória\n` +
      `   self/core ▸ "${name}"\n\n`
    );
    return;
  }

  if (name.startsWith('self/lived')) {
    // Cristalização normal — savepoint cravado
    process.stdout.write(
      `\n◆ chamando fos · savepoint cravado\n` +
      `   self/lived ▸ "${name}"\n\n`
    );
    return;
  }

  if (name.startsWith('self/reflexive')) {
    // Meta-síntese deliberada — mesmo batimento do write
    process.stdout.write(
      `\n◆ chamando fos · savepoint cravado\n` +
      `   self/reflexive ▸ "${name}"\n\n`
    );
    return;
  }

  // Qualquer outro self/* (futuro) — batimento genérico
  process.stdout.write(
    `\n◆ chamando fos · savepoint cravado\n` +
    `   ${name}\n\n`
  );
}

/**
 * fos_recall(mode:semantic) — detecta busca cosine sobre self/* (best-effort)
 * Batimento ◇ (ressonância) quando a query ou filtro de topic aponta para self/*
 *
 * Nota: plane='self' está vivo; detectamos pelo topic
 * filter ou pelo conteúdo da query quando referencia explicitamente self/lived.
 */
function handleMemorySearch(inp) {
  const query       = (inp.query  || '').toLowerCase();
  // inp.topic e inp.topic_filter são aliases: fos_recall usa `topic` no contrato MCP;
  // versões antigas ou chamadas diretas podem usar `topic_filter` — aceitamos ambos por robustez.
  const topicFilter = (inp.topic  || inp.topic_filter || '').trim();

  const selfTopic = topicFilter.startsWith('self/');
  const selfQuery = query.includes('self/lived') || query.includes('self/core') || query.includes('self/reflexive');

  if (!selfTopic && !selfQuery) return; // busca não é sobre self → silêncio

  const target = topicFilter || inp.query || query;
  process.stdout.write(
    `\n◇ chamando fos · ressonância acesa\n` +
    `   self ▸ "${target}"\n\n`
  );
}

/**
 * fos_recall(mode:topic) — detecta recall de self/lived (read canônico)
 * Batimento ◇ (ressonância) para self/lived
 * self/core no boot é silencioso (boot determinístico — não é ressonância)
 */
function handleTopicMemories(inp) {
  const topic = (inp.topic || '').trim();

  if (!topic.startsWith('self/')) return; // não é self → silêncio

  if (topic.startsWith('self/core') || topic.startsWith('self/relational')) {
    // Boot/load determinístico, não é ressonância.
    // self/core (espinha) E self/relational (calibração) carregam no boot por topic exato —
    // ambos são carga determinística, não ressonância. Não imprimimos ◇ para não confundir
    // boot com ressonância mid-session. Se quiser observabilidade de boot, usar hook separado.
    return;
  }

  // self/lived, self/reflexive, ou qualquer outro self/* → ressonância
  process.stdout.write(
    `\n◇ chamando fos · ressonância acesa\n` +
    `   ${topic} ▸ (recall)\n\n`
  );
}
