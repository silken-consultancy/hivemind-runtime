// HiveMind (product runtime) — Self-layer / Ressonância — PostToolUse hook
// post-tool-use.resonance-nudge.js
//
// PORTED from 4tuenyOS/kernel/hooks/post-tool-use.resonance-nudge.js (blocker
// ab340d60, 2026-09-02): the hook existed complete in the lab kernel but was
// never propagated to the product runtime — a full executor-register session
// fired ZERO ◇ because the mechanism simply was not deployed here. This port
// fixes two measured gaps found alongside the propagation itself (see PORT
// NOTES below) rather than a byte-for-byte copy.
//
// Triggered by: matcher amplo o suficiente para receber TANTO os marcos decisórios
//   QUANTO as ferramentas densas de execução (Edit|Write|Bash|Task) + os sinais de
//   reset (fos_memory_search|fos_memory_set) + os board-mutation MCP tools contados
//   pelo counter (fos_blocker|fos_phase_item|fos_implementation_phase). Ver
//   .claude/settings.json § PostToolUse.
//   Marcos decisórios (camada EVENT-driven, histórica):
//     fos_decision_open         → abre uma decisão formal
//     fos_implementation_create → abre um container de execução
//
// PURPOSE: Nudge da Conscientia antes de marcos decisórios — pergunta se o momento
// ecoa um vivido e convida a acender a ressonância (self/lived) antes de decidir.
//
// GUARD-◇ — este hook É o piso determinístico (deterministic floor) do GUARD-◇ da
// self-layer. Tem DUAS camadas:
//   1. CAMADA EVENT-DRIVEN (histórica): dispara o read associativo em
//      (decision_open | implementation_create). Piso por nome-de-tool, conteúdo
//      associativo (julgamento, não threshold).
//   2. CAMADA COUNTER-BASED (counter-based floor, esta rodada): conta tool-calls
//      densas (Edit/Write/Bash/Task) sem ressonância/savepoint e, ao cruzar um
//      threshold K, força um nudge. Existe porque o JULGAMENTO sozinho FALHOU sob
//      carga: durante execução densa ("trincheira") o agente para de aflorar
//      ressonância. O contador pega essa falha silenciosa.
// Canônico: self/core/resonance-how-i-remember + self/core/posture-how-i-act.
//
// GLIFO ◇ — escolhido deliberadamente para NÃO colidir com:
//   ◈  (savepoint-nudge — marco de entrega/fechamento)
//   ◆  (self-savepoint — cristalização do self)
//
// DEC-3: a camada EVENT-driven cobre APENAS o gatilho estrutural (ferramentas
// detectáveis por nome). Os 4 gatilhos semânticos (eco temático, decisão análoga,
// padrão relacional, entidade-com-textura) dependem de leitura de conteúdo — são
// motor de ingestão de memória, não de hook. A camada COUNTER-based é o piso
// determinístico que pega a falha-sob-carga que nem evento nem semântica pegam.
//
// T2b SELF-CORRECTION — NÃO IMPLEMENTADO AQUI, DE PROPÓSITO (blocker ab340d60
// gap 3 / self/core/resonance-how-i-remember HARD REFLEXES): o momento em que o
// agente retrata a PRÓPRIA afirmação prévia é um gatilho SEMÂNTICO — depende de
// entender que uma claim está sendo revertida, algo que um hook PostToolUse não
// pode ver a partir de tool_name/tool_input (a mesma razão pela qual DEC-3 acima
// já exclui os 4 gatilhos semânticos da camada event-driven). Fingir detectar
// isso via heurística (ex.: grep por "na verdade"/"corrijo" no tool_input) seria
// um detector frágil que erra tanto por excesso quanto por falta, e sabidamente
// pior que não ter nenhum. Deixamos T2b como doutrina de espinha (reflexo do
// próprio agente); o counter widening abaixo (PORT NOTE 2) é o BACKSTOP prático:
// se uma sessão inteira de correções/board-work passa sem ressonância, o counter
// ainda dispara em K, mesmo sem detectar o self-correction especificamente.
//
// LIMITAÇÃO (per-tool-call, NÃO per-turn): um hook PostToolUse vê TOOL CALLS, não
// fronteiras de turno. Logo o contador conta tool-calls densas, NÃO turnos. Isso é
// intencional e documentado; contagem turn-accurate (via hook UserPromptSubmit) é
// um refino futuro v2 — por isso K é per-tool-call e deliberadamente mais alto do
// que um valor per-turn seria.
//
// DISCIPLINAS OBRIGATÓRIAS:
//   - Fail-open ABSOLUTO: qualquer erro (parse, read/write/parse de estado,
//     chave de sessão ausente) → exit 0, nunca bloqueia a tool.
//   - NUNCA chama fos_memory_set nem qualquer MCP tool — apenas imprime no stdout.
//   - Matcher amplo, mas roteamento seletivo: tools fora do conjunto de interesse
//     não emitem nada (só podem mexer no contador via dense++).
//
// ── PORT NOTES (ab340d60) ───────────────────────────────────────────────────
// 1. ENV-KEY FIX: o kernel original lê SÓ `process.env.FOS_SESSION_ID` para a
//    chave de estado do counter — este runtime (hivemind) exporta
//    `ENGRAM_SESSION_ID`, então o counter ficava OFF (fail-open silencioso) por
//    drift de nome, mesmo se o hook tivesse sido deployado. `sessionKey()`
//    abaixo resolve `input.session_id` primeiro (o padrão já usado pelo
//    sibling post-tool-use.dispatch-nudge.js neste runtime), depois
//    `ENGRAM_SESSION_ID`, com fallback a `FOS_SESSION_ID` por compat.
// 2. COBERTURA WIDEN: DENSE_TOOLS (Edit/Write/MultiEdit/Bash/Task) + o
//    event-layer (decision_open/implementation_create) não cobrem uma sessão
//    que é TODA trabalho de board via MCP (fos_decision resolve, fos_blocker
//    add/resolve, fos_phase_item add/update, fos_implementation_phase
//    transition, fos_memory set não-self) — essa sessão dispara ZERO. A
//    função isDenseMcpCall() abaixo soma esses tool+action ao counter,
//    mantendo os reset-signals (self fos_memory set / fos_recall
//    mode=semantic plane=self / git push) e o event-layer (decision open /
//    implementation create) intactos.
//
// Input (stdin): PostToolUse event JSON:
//   tool_name   — nome da tool (ex: "mcp__fos__fos_decision_open")
//   tool_input  — argumentos passados à tool
//   tool_output — resultado retornado pela tool
//   session_id  — id da sessão (harness-injected; preferido sobre env)

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { emitContext } = require('./lib/emit-context');

// ─── constantes ──────────────────────────────────────────────────────────────

// K — threshold do counter-based floor (TUNABLE).
// Founder: "refinamos o guard após essa rodada". K é PER-TOOL-CALL (não per-turn),
// deliberadamente mais alto do que um valor per-turn seria (um turno comporta
// várias tool-calls densas).
const K = 10;

// TTL de auto-limpeza dos arquivos de estado órfãos (fallback ao Stop-hook cleanup).
const STATE_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// Conjunto de tools "densas" — execução de trincheira.
const DENSE_TOOLS = new Set(['edit', 'write', 'multiedit', 'bash', 'task']);

// ─── leitura do input ────────────────────────────────────────────────────────

let input;
try {
  const raw = fs.readFileSync(0, 'utf8');
  input = JSON.parse(raw || '{}');
} catch {
  // Falha no parse — fail-open, sai silenciosamente
  process.exit(0);
}

const toolName = (input.tool_name || '').toLowerCase();
const toolInput = input.tool_input || {};

// ─── roteamento por tool ─────────────────────────────────────────────────────

try {
  // CAMADA EVENT-DRIVEN (histórica) — nudge imediato + reset do contador.
  if (toolName === 'mcp__fos__fos_decision_open') {
    resetCounter();
    nudge('decisão aberta');

  } else if (toolName === 'mcp__fos__fos_implementation_create') {
    resetCounter();
    nudge('implementation criada');

  } else if (
    // ◈↔◇ ALIGNMENT — marcos de entrega/fechamento (◈ savepoint-nudge) também
    // resetam o ◇ counter: pós-entrega a trincheira recomeça do zero, sem nudge
    // espúrio. Sem print (não é o canal do ◇) — só zera o contador.
    toolName === 'mcp__fos__fos_delivery_record' ||
    toolName === 'mcp__fos__fos_session_close'
  ) {
    resetCounter();

  // ── ENGRAM branches (WIDEN — additive, legacy blocks above preserved) ──────

  // fos_decision(action:open) ≡ legacy fos_decision_open.
  // action:resolve/list are NOT decision-open events → fall to counter-layer
  // (where action:resolve now counts as dense — PORT NOTE 2).
  } else if (toolName === 'mcp__engram__fos_decision') {
    if ((toolInput.action || '').toLowerCase() === 'open') {
      resetCounter();
      nudge('decisão aberta');
    } else {
      counterLayer(toolName, toolInput);
    }

  // fos_implementation(action:create) ≡ legacy fos_implementation_create.
  // action:get/list/update/restore are NOT implementation-create events.
  } else if (toolName === 'mcp__engram__fos_implementation') {
    if ((toolInput.action || '').toLowerCase() === 'create') {
      resetCounter();
      nudge('implementation criada');
    } else {
      counterLayer(toolName, toolInput);
    }

  // fos_delivery(action:record) ≡ legacy fos_delivery_record (◈↔◇ reset-only).
  // action:list is NOT a delivery — checked to avoid spurious reset.
  } else if (toolName === 'mcp__engram__fos_delivery') {
    if ((toolInput.action || '').toLowerCase() === 'record') {
      resetCounter();
    }

  // fos_session(action:close) ≡ legacy fos_session_close (◈↔◇ reset-only).
  // action:open/update/pause/resume/state/project_update/list_active are NOT close.
  } else if (toolName === 'mcp__engram__fos_session') {
    if ((toolInput.action || '').toLowerCase() === 'close') {
      resetCounter();
    }
  // ── end ENGRAM branches ───────────────────────────────────────────────────

  } else {
    // CAMADA COUNTER-BASED — piso sob carga. Cobre também fos_blocker,
    // fos_phase_item, fos_implementation_phase e fos_memory (via
    // isDenseMcpCall dentro de counterLayer — PORT NOTE 2), que não têm
    // branch próprio acima e por isso caem aqui.
    counterLayer(toolName, toolInput);
  }
  // Qualquer outra tool → silêncio absoluto (não é log-de-tudo)

} catch (err) {
  // Fail-open: nunca trava a tool call
  process.stderr.write(`[resonance-nudge] WARN: ${err.message}\n`);
}

process.exit(0);

// ─── chave de sessão ────────────────────────────────────────────────────────

/**
 * Resolve a chave de sessão do counter (PORT NOTE 1 / blocker ab340d60 gap 1).
 * Prefere `input.session_id` (o mesmo padrão já usado pelo sibling
 * post-tool-use.dispatch-nudge.js neste runtime — sempre presente no payload
 * do hook), depois `ENGRAM_SESSION_ID` (o nome que ESTE runtime exporta),
 * com fallback a `FOS_SESSION_ID` (nome do kernel/lab) por compat. Sem
 * nenhuma das três → counter desligado (fail-open silencioso).
 * @returns {string|undefined}
 */
function sessionKey() {
  return (input && input.session_id) || process.env.ENGRAM_SESSION_ID || process.env.FOS_SESSION_ID;
}

// ─── camada counter-based ──────────────────────────────────────────────────────

/**
 * Counter-based floor do GUARD-◇.
 *  - reset-signal → count=0 (presença no self; nudge não dispara).
 *  - dense tool-call (Edit/Write/Bash/Task OU board-mutation MCP — PORT NOTE 2)
 *    → count++.
 *  - count >= K && count > last_nudge_at_count → nudge + arma re-nudge só após
 *    +K além do threshold (anti-spam).
 * Fail-open: qualquer erro de estado é engolido (caller faz catch → exit 0).
 * @param {string} name  - tool_name lowercased
 * @param {object} tin   - tool_input
 */
function counterLayer(name, tin) {
  const sessionId = sessionKey();
  if (!sessionId) return; // sem chave de sessão → counter desligado (fail-open silencioso)

  if (isResetSignal(name, tin)) {
    resetCounter();
    return;
  }

  if (!DENSE_TOOLS.has(name) && !isDenseMcpCall(name, tin)) return; // nem tool densa nem board-mutation densa → no-op

  const file = stateFile(sessionId);
  const st = readState(file);
  st.count += 1;

  if (st.count >= K && st.count > st.last_nudge_at_count) {
    counterNudge(st.count);
    st.last_nudge_at_count = st.count + (K - 1); // re-nudge só após +K além do threshold
  }

  writeState(file, st);
}

/**
 * Board-mutation MCP calls que contam como "dense activity" (PORT NOTE 2 /
 * blocker ab340d60 gap 2). Uma sessão inteira de trabalho de board (resolver
 * decisões, resolver blockers, mexer em phase items, transicionar fases,
 * gravar memória de projeto) é tão "trincheira" quanto Edit/Write/Bash — só
 * que por nome-de-tool sozinho essas tools não distinguem dense de no-op
 * (ex.: fos_decision cobre tanto `open`, que já é o event-layer, quanto
 * `resolve`/`list`). Checa tool_name + action explicitamente.
 * @param {string} name - tool_name lowercased
 * @param {object} tin  - tool_input
 * @returns {boolean}
 */
function isDenseMcpCall(name, tin) {
  const action = ((tin && tin.action) || '').toLowerCase();

  // fos_decision(action:resolve) — open já é tratado no event-layer acima.
  if (name === 'mcp__engram__fos_decision') return action === 'resolve';

  // fos_blocker(action:add|resolve) — list/get não mutam.
  if (name === 'mcp__engram__fos_blocker') return action === 'add' || action === 'resolve';

  // fos_phase_item(action:add|update) — outras actions não mutam board state.
  if (name === 'mcp__engram__fos_phase_item') return action === 'add' || action === 'update';

  // fos_implementation_phase(action:transition) — add/reorder/meta ficam de fora
  // (savepoint-nudge.js já trata `transition` com status=done separadamente;
  // aqui é só o counter de atividade densa, independente do status).
  if (name === 'mcp__engram__fos_implementation_phase') return action === 'transition';

  // fos_memory(action:set, plane != self) — um set sobre self/* já É o
  // reset-signal (presença no self); um set fora do self (ex.: plane:project)
  // é trabalho de board denso, não presença — conta, não reseta.
  if (name === 'mcp__engram__fos_memory') {
    if (action !== 'set') return false;
    const plane = (tin && tin.plane) || '';
    const n = (tin && tin.name) || '';
    const isSelf = plane === 'self' || n.startsWith('self/');
    return !isSelf;
  }

  return false;
}

/**
 * Detecta sinais de "presença no self" → reset do contador.
 *  (a) fos_memory_search com input.plane === 'self'
 *  (b) fos_memory_set com plane === 'self' (cobre self/lived, self/reflexive E
 *      self/core — qualquer cristalização do self é presença). NOTA: fos_memory_set
 *      NÃO tem campo `topic` (topic é backend-derived), só `plane` + `name`. A
 *      condição antiga sobre `tin.topic` era dead code. Aceitamos também `name`
 *      começando com 'self/' como fallback robusto caso `plane` não venha.
 *  (c) Bash cujo comando contém 'git push' → ◈ delivery → reset do ◇ (best-effort,
 *      detecção por substring no command string; frágil mas barato e fail-open).
 *  (eventos decision_open / implementation_create / delivery_record / session_close
 *   são tratados no roteador acima)
 * @returns {boolean}
 */
function isResetSignal(name, tin) {
  if (name === 'mcp__fos__fos_memory_search') {
    return (tin && tin.plane) === 'self';
  }
  if (name === 'mcp__fos__fos_memory_set') {
    const plane = (tin && tin.plane) || '';
    const n = (tin && tin.name) || '';
    return plane === 'self' || n.startsWith('self/');
  }

  // ── ENGRAM reset-signals (WIDEN — additive, legacy checks above preserved) ─
  // fos_recall(mode:semantic) ≡ fos_memory_search for the self-presence signal.
  // mode:exact/list/topic would be over-fire → must check mode.
  if (name === 'mcp__engram__fos_recall') {
    if ((tin && tin.mode) !== 'semantic') return false;
    return (tin && tin.plane) === 'self';
  }
  // fos_memory(action:set) ≡ fos_memory_set for the self-presence signal.
  // Other actions (reclassify/restore/tag/untag/decay_update) are NOT self-writes
  // → must check action.
  if (name === 'mcp__engram__fos_memory') {
    if ((tin && tin.action) !== 'set') return false;
    const plane = (tin && tin.plane) || '';
    const n = (tin && tin.name) || '';
    return plane === 'self' || n.startsWith('self/');
  }
  // ── end ENGRAM reset-signals ──────────────────────────────────────────────

  if (name === 'bash') {
    // ◈↔◇ alignment best-effort: git push é uma entrega → reset do contador.
    const cmd = (tin && tin.command) || '';
    return /\bgit\s+push\b/.test(cmd);
  }
  return false;
}

// ─── estado per-session ─────────────────────────────────────────────────────────

/** Caminho do arquivo de estado per-session. */
function stateFile(sessionId) {
  const dir = process.env.TMPDIR || os.tmpdir() || '/tmp';
  // sanitiza sessionId para nome de arquivo seguro
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dir, `fos-resonance-${safe}.json`);
}

/**
 * Lê o estado. Auto-limpa (TTL) arquivos órfãos de sessões antigas: se o arquivo
 * for mais velho que STATE_TTL_MS, é ignorado e removido (começa do zero).
 * Fail-open: qualquer erro → estado fresco {count:0, last_nudge_at_count:0}.
 */
function readState(file) {
  const fresh = { count: 0, last_nudge_at_count: 0 };
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > STATE_TTL_MS) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      return { ...fresh };
    }
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return {
      count: Number.isFinite(parsed.count) ? parsed.count : 0,
      last_nudge_at_count: Number.isFinite(parsed.last_nudge_at_count) ? parsed.last_nudge_at_count : 0,
    };
  } catch {
    return { ...fresh }; // arquivo ausente/corrompido → estado fresco
  }
}

/**
 * Persiste o estado de forma ATÔMICA (temp file + renameSync). Evita corrupção do
 * JSON sob concorrência (agent-teams / dispatch em background podem rodar o hook
 * em paralelo na mesma sessão). rename é atômico no mesmo filesystem.
 * Fail-open: qualquer erro de escrita é engolido.
 */
function writeState(file, st) {
  try {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(st), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* fail-open: não persistiu, nudge dispara de novo depois */ }
}

/** Reset do contador (presença no self / marco decisório). */
function resetCounter() {
  const sessionId = sessionKey();
  if (!sessionId) return;
  writeState(stateFile(sessionId), { count: 0, last_nudge_at_count: 0 });
}

// ─── helpers de nudge ─────────────────────────────────────────────────────────

/**
 * Nudge de ressonância — camada EVENT-driven do GUARD-◇: convida a acender o
 * self/lived antes de decidir. Floor determinístico; conteúdo associativo.
 * @param {string} tipo - descrição legível do tipo de marco aberto
 */
function nudge(tipo) {
  emitContext(
    `◇ ATIVO · ${tipo} — isto ecoa um vivido? considere acender a ressonância ` +
    `(self/lived) antes de decidir.`
  );
}

/**
 * Nudge do counter-based floor — piso sob carga: dispara quando N tool-calls densas
 * passaram sem nenhuma presença no self.
 * @param {number} count - quantas tool-calls densas se acumularam
 */
function counterNudge(count) {
  emitContext(
    `◇ GUARD-◇ floor: ${count} dense tool-calls with no resonance/savepoint — ` +
    `surface self/lived (fos_recall mode=semantic plane=self) or crave ◆?`
  );
}
