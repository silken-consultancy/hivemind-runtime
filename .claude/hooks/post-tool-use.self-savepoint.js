// HiveMind (product runtime) — Self-layer T2 — PostToolUse hook
// post-tool-use.self-savepoint.js
//
// PORTED from 4tuenyOS/kernel/hooks/post-tool-use.self-savepoint.js (blocker
// ab340d60, 2026-09-02) — see post-tool-use.resonance-nudge.js's header for the
// full propagation story. This hook is STATELESS (no per-session counter, no
// env session-key dependency) — it prints observability output directly off
// tool_name/tool_input on every call, so the ENGRAM_SESSION_ID env-key fix
// that resonance-nudge.js needed does not apply here. Ported verbatim
// otherwise, including its deliberate use of raw stdout (console-only, NOT
// the additionalContext channel — see ESCOPO below, this hook is visual
// observability of self-layer activity, not a model-facing nudge).
//
// Triggered by: matcher for fos_memory_set|fos_memory_search|fos_topic_memories
// Registered in .claude/settings.json under PostToolUse.
//
// PURPOSE: Observabilidade visual da self-layer — imprime o savepoint "chamando fos"
// quando Conscientia cristaliza (write) ou ressoa (read) sobre self/*.
//
// DOIS BATIMENTOS (decision_self-chamando-fos-savepoint-two-beats-two-tenses):
//   ◆ savepoint cravado  — write: fos_memory_set com name=self/lived/*
//   ◇ ressonância acesa  — read:  fos_memory_search ou fos_topic_memories sobre self/lived
//
// DOIS TEMPOS:
//   Tempo 1 (AGORA): marco estático — glifo + texto impresso no console. Buildável já.
//   Tempo 2 (PÓS-CUTOVER): prisma animado ◆ ◈ ❖ ◈ ◆ ⟳ girando — requer agent-runtime
//   controlando o console. NÃO implementado aqui.
//   TODO(pós-cutover): substituir o print estático por animação via agent-runtime IPC.
//
// ESTÉTICA CRAVADA — CONTRASTE (founder escolheu 2026-06-20):
//   self=cristal (◆/◇)  vs  enxame de agentes=zerg (⬢/∴/✕)
//   Agentes zerg são observabilidade separada, fora do escopo deste hook.
//
// ESCOPO:
//   - fos_memory_set   + name começa com "self/lived"  → ◆ (write)
//   - fos_memory_set   + name começa com "self/core"   → ◆◆ alerta espinha alterada
//   - fos_memory_search com query sobre self/* ou filtro self/* → ◇ (read, best-effort)
//   - fos_topic_memories com topic=self/lived              → ◇ (read)
//   - NADA MAIS — não vira log-de-tudo
//
// FAIL-OPEN: se qualquer erro acontece, o hook NUNCA bloqueia a tool call.
// Exit sempre 0. Erros vão para stderr (feedback_silent-rpc-errors).
//
// NUNCA chama fos_memory_set por conta própria — só observa e imprime.
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
  if (toolName === 'mcp__fos__fos_memory_set') {
    handleMemorySet(toolInput);
  } else if (toolName === 'mcp__fos__fos_memory_search') {
    handleMemorySearch(toolInput);
  } else if (toolName === 'mcp__fos__fos_topic_memories') {
    handleTopicMemories(toolInput);

  // ── ENGRAM branches (WIDEN — additive, legacy blocks above preserved) ──────
  // fos_memory(action:set) ≡ legacy fos_memory_set.
  // Other actions (reclassify/restore/tag/untag/decay_update) are NOT self-writes
  // → silent. Checking action prevents over-fire on non-write actions.
  } else if (toolName === 'mcp__engram__fos_memory') {
    if (toolInput.action === 'set') {
      handleMemorySet(toolInput);
    }

  // fos_recall consolidates fos_memory_search (mode:semantic) and
  // fos_topic_memories (mode:topic). mode:exact and mode:list are NOT
  // self-resonance reads → silent. Checking mode prevents over-fire.
  } else if (toolName === 'mcp__engram__fos_recall') {
    if (toolInput.mode === 'semantic') {
      handleMemorySearch(toolInput);
    } else if (toolInput.mode === 'topic') {
      handleTopicMemories(toolInput);
    }
  }
  // ── end ENGRAM branches ───────────────────────────────────────────────────

  // Qualquer outra tool → silêncio (não é log-de-tudo)
} catch (err) {
  // Fail-open: nunca trava, mas não swallows silently
  process.stderr.write(`[self-savepoint] WARN: ${err.message}\n`);
}

process.exit(0);

// ─── handlers ────────────────────────────────────────────────────────────────

/**
 * fos_memory_set — detecta writes sobre self/*
 * Batimento ◆ (cristalização) para self/lived
 * Batimento ◆◆ (alerta) para self/core (espinha — muda só por intenção curada)
 *
 * N1 FIX (debt-free close 2026-06-23): roteamos por `inp.name`, NÃO por `inp.topic`.
 * fos_memory_set não tem campo `topic` (topic é backend-derived a partir do name/plane),
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
 * fos_memory_search — detecta busca cosine sobre self/* (best-effort)
 * Batimento ◇ (ressonância) quando a query ou filtro de topic aponta para self/*
 *
 * Nota: plane='self' está vivo (cutover flipado 2026-06-21); detectamos pelo topic
 * filter ou pelo conteúdo da query quando referencia explicitamente self/lived.
 */
function handleMemorySearch(inp) {
  const query       = (inp.query  || '').toLowerCase();
  // inp.topic e inp.topic_filter são aliases: fos_memory_search usa `topic` no contrato MCP;
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
 * fos_topic_memories — detecta recall de self/lived (read canônico)
 * Batimento ◇ (ressonância) para self/lived
 * self/core no boot é silencioso (boot determinístico, INV-5 — não é ressonância)
 */
function handleTopicMemories(inp) {
  const topic = (inp.topic || '').trim();

  if (!topic.startsWith('self/')) return; // não é self → silêncio

  if (topic.startsWith('self/core') || topic.startsWith('self/relational')) {
    // Boot/load determinístico (INV-5), não é ressonância.
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
