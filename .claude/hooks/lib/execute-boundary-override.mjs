#!/usr/bin/env node
// HiveMind — execute-boundary override setter — standalone CLI, NOT a registered
// hook. Invoked directly by the messenger, never dispatched to a subagent:
//   node .claude/hooks/lib/execute-boundary-override.mjs --ok "<verbatim founder OK>"
// lib/execute-boundary-override.mjs
//
// PURPOSE:
//   The hard gate (pre-tool-use.execute-boundary-gate.js) denies past CEILING
//   with no escape hatch — this CLI IS the escape hatch. It writes the single
//   grant file the gate reads, so a founder-directed inline drive is not
//   permanently blocked. This is the ONE place that grant is ever written.
//
// MESSENGER-ONLY — the REAL enforcement moved to the GATE (2026-07-31, measured):
//   CLAUDE_AGENT_NAME was measured LIVE to be EMPTY for a dispatched subagent
//   (it inherits the messenger's env), so the refusal below is NOT a reliable
//   structural barrier on its own — a subagent COULD invoke this CLI and slip
//   past this check. The primary, reliable protection now lives in
//   pre-tool-use.execute-boundary-gate.js, which denies a subagent's Bash call
//   outright when it would run THIS file, using the reliable `agent_id`
//   signal present on subagent tool calls (isOverrideCliInvocation +
//   isSubagentContext in lib/execute-boundary-classifier.js). The check below
//   stays as belt-and-suspenders — harmless, just not sufficient alone.
//
// TURN-SCOPED:
//   The grant is stamped with the CURRENT turn_seq (from the turn-reset hook's
//   state file). The gate only honors a grant whose turn_seq matches the turn
//   it is currently evaluating — a new user message resets turn_seq and wipes
//   this grant file outright (user-prompt-submit.execute-boundary-turn-reset.js).
//
// AUDITED:
//   Every grant is appended to a dedicated JSONL (independent of the harness's
//   own event capture) so a fabricated "always overrides, never dispatches"
//   pattern is visible on inspection. appendAudit() is exported so the gate
//   hook imports it for the 'consumed' line instead of duplicating the write.
//
// FAIL-CLOSED (deliberate deviation from this dir's fail-open norm):
//   Every other hook here fails OPEN (never blocks a user-facing action on
//   error). This CLI is the opposite: a session-less or malformed invocation
//   REFUSES rather than silently granting — a meaningless grant must never
//   be written by accident.
//
// SESSION-ID RECONCILIATION (2026-08-27, blocker d85e3fb7-818e-4dab-b034-
// 85b926beae60 — MEASURED never-worked, not a regression: `git log -p` on
// both this file and the gate shows `input.session_id ||
// process.env.ENGRAM_SESSION_ID` in the gate and `process.env.
// ENGRAM_SESSION_ID` alone here were introduced in the SAME originating
// commit (bbc971d, 2026-07-31) and neither has changed since — the mismatch
// was structurally present from day one, just never exercised live because
// the gate defaulted OFF until this session's dark-ship flip to enforce):
//   The gate (pre-tool-use.execute-boundary-gate.js) keys its state-file
//   lookups on `input.session_id || process.env.ENGRAM_SESSION_ID` —
//   `input.session_id` (the harness-supplied id) WINS when present, and it
//   is what makes the gate work for a foreign vessel with no
//   ENGRAM_SESSION_ID at all. This CLI runs as a standalone process spawned
//   by a Bash tool call: it receives no PreToolUse stdin, so it can NEVER
//   see `input.session_id` on its own — only argv and env. Left as
//   `process.env.ENGRAM_SESSION_ID` alone, a grant written here lands under
//   a DIFFERENT state-file key than the one the gate reads from whenever the
//   two ids diverge (measured live: harness session_id
//   d6525965-7c7e-4444-aa32-4f8b8b752f4a vs ENGRAM_SESSION_ID
//   06658549-f642-4e53-b709-e11edf51bed4 in the SAME turn) — the grant is
//   silently invisible to the gate, and the CLI reports "granted" while the
//   very next mutating call is denied identically.
//   FIX (per the gate keeping `input.session_id` as its preferred source of
//   truth — that must not change): the gate's deny() message now embeds its
//   OWN resolved sessionId as `--session <id>` (see the gate's deny() call
//   site). This CLI accepts that as `--session <id>` and PREFERS it over
//   ENGRAM_SESSION_ID — the CLI learns the gate's key, not the other way
//   around. Falls back to ENGRAM_SESSION_ID when no `--session` is given
//   (back-compat for the case the two ids coincide, e.g. bin/hivemind's own
//   CLI where ENGRAM_SESSION_ID IS what the harness passes as
//   input.session_id). turnSeq is read and the grant is written under this
//   SAME resolved `sessionId` — the existing code already threaded one
//   `sessionId` variable through both, so fixing its resolution alone closes
//   the "grant born stale under turn_seq 0" half of the bug too.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─── stateFile(kind, sessionId) — same convention as lib/execute-boundary-classifier.js ──
// Duplicated (not imported) on purpose: this file is ESM (.mjs), the classifier
// is CommonJS (.js) — importing it here would require the same cross-format
// dance the gate hook does in the other direction. Three lines, verified
// identical to the classifier's version; keep them in sync if either changes.
function stateFile(kind, sessionId) {
  const dir = process.env.TMPDIR || os.tmpdir() || '/tmp';
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dir, `hivemind-${kind}-${safe}.json`);
}

function auditFile(sessionId) {
  const dir = process.env.TMPDIR || os.tmpdir() || '/tmp';
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dir, `hivemind-execute-override-audit-${safe}.jsonl`);
}

function writeJson(file, obj) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, file);
}

// Exported so pre-tool-use.execute-boundary-gate.js appends the 'consumed'
// line here too — ONE audit-write path, not two independently-typed ones.
export function appendAudit(sessionId, entry) {
  try {
    fs.appendFileSync(auditFile(sessionId), JSON.stringify(entry) + '\n');
  } catch {
    /* audit is best-effort; must never block the grant/consume it rides on */
  }
}

// ─── resolveSessionId(argv, env) — the reconciliation fix (blocker d85e3fb7) ──
// PREFERS `--session <id>` (the gate's own resolved sessionId, handed over
// via its deny message) over ENGRAM_SESSION_ID — the CLI learns the gate's
// key; the gate keeps preferring input.session_id, unchanged. Falls back to
// ENGRAM_SESSION_ID when no (or an empty) --session is given. Pure function,
// exported so it is testable by import alone — importing this module never
// runs main() (see the invokedDirectly guard at the bottom), so a caller can
// exercise this in isolation without invoking the CLI itself.
export function resolveSessionId(argv, env) {
  const list = Array.isArray(argv) ? argv : [];
  const idx = list.indexOf('--session');
  const fromArg = idx !== -1 ? list[idx + 1] : '';
  if (fromArg && String(fromArg).trim()) return String(fromArg).trim();
  return ((env && env.ENGRAM_SESSION_ID) || '').toString();
}

function main() {
  const okIdx = process.argv.indexOf('--ok');
  const ok = okIdx !== -1 ? process.argv[okIdx + 1] : '';
  if (!ok || !ok.trim()) {
    process.stderr.write('[execute-boundary-override] refused: --ok "<quote of the founder OK>" is required\n');
    process.exit(1);
  }

  // STRUCTURAL refusal — see header. Nothing is written when this fires.
  if (process.env.CLAUDE_AGENT_NAME) {
    process.stderr.write('[execute-boundary-override] refused: subagents cannot grant this override\n');
    process.exit(1);
  }

  // Fail-CLOSED: a session-less override is meaningless — refuse, do not
  // grant. sessionId now PREFERS --session <id> (the gate's resolved key,
  // copy-pasted verbatim from its deny message) over ENGRAM_SESSION_ID — see
  // the SESSION-ID RECONCILIATION header note above (blocker d85e3fb7).
  const sessionId = resolveSessionId(process.argv, process.env);
  if (!sessionId) {
    process.stderr.write(
      '[execute-boundary-override] refused: no session id — pass --session <id> ' +
      '(copy it from the gate\'s deny message) or set ENGRAM_SESSION_ID\n'
    );
    process.exit(1);
  }

  let turnSeq = 0;
  try {
    const turn = JSON.parse(fs.readFileSync(stateFile('turn', sessionId), 'utf8') || '{}');
    turnSeq = Number.isFinite(turn.turn_seq) ? turn.turn_seq : 0;
  } catch {
    /* no turn file yet → turn_seq 0 (pre-first-reset edge case) */
  }

  const grantedAt = new Date().toISOString();
  const grant = { granted: true, turn_seq: turnSeq, ok_ref: ok, granted_at: grantedAt };

  try {
    writeJson(stateFile('execute-override', sessionId), grant);
  } catch (err) {
    process.stderr.write(`[execute-boundary-override] refused: could not write grant (${err.message})\n`);
    process.exit(1);
  }

  appendAudit(sessionId, { event: 'granted', turn_seq: turnSeq, ok_ref: ok, granted_at: grantedAt });

  process.stderr.write(`[execute-boundary-override] granted (session=${sessionId}, turn_seq=${turnSeq})\n`);
  process.exit(0);
}

// ─── self-test (node execute-boundary-override.mjs --selftest) ────────────
//
// Unit-level ONLY (deliberate scope limit — see blocker d85e3fb7 task note):
// an end-to-end grant-and-consume cannot be simulated from a dispatched
// subagent, because the gate structurally denies a subagent's Bash call that
// invokes this file at all (isOverrideCliInvocation + isSubagentContext in
// the gate, regardless of which flag is passed) — that IS the gate's
// override-is-messenger-exclusive protection working as designed, not a gap
// to route around. This selftest therefore exercises resolveSessionId()
// directly (pure function, no process spawn, no grant file touched by
// main()) rather than shelling out to `node ... --ok/--session` end-to-end.
// The true end-to-end re-run (grant via --session, confirm the gate's next
// mutating call is ALLOWED) belongs to a real conversational/messenger loop.
function selftest() {
  let fail = 0;
  const check = (label, cond, detail) => {
    if (cond) {
      console.log(`  ok: ${label}`);
    } else {
      fail++;
      console.error(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`);
    }
  };

  // resolveSessionId precedence — the actual reconciliation fix.
  const CASES = [
    [['--ok', 'x', '--session', 'gate-resolved-A'], { ENGRAM_SESSION_ID: 'messenger-env-B' }, 'gate-resolved-A',
      '--session (gate-resolved key) wins over a mismatched ENGRAM_SESSION_ID'],
    [['--ok', 'x'], { ENGRAM_SESSION_ID: 'messenger-env-B' }, 'messenger-env-B',
      'no --session → falls back to ENGRAM_SESSION_ID (back-compat when they coincide)'],
    [['--ok', 'x', '--session', ''], { ENGRAM_SESSION_ID: 'messenger-env-B' }, 'messenger-env-B',
      'empty --session value → falls back to ENGRAM_SESSION_ID, not empty string'],
    [['--ok', 'x', '--session', '   '], { ENGRAM_SESSION_ID: 'messenger-env-B' }, 'messenger-env-B',
      'whitespace-only --session value → falls back to ENGRAM_SESSION_ID'],
    [['--ok', 'x'], {}, '', 'neither --session nor ENGRAM_SESSION_ID present → empty (caller must refuse)'],
    [[], { ENGRAM_SESSION_ID: 'env-only' }, 'env-only', 'no argv at all → still falls back to env'],
  ];
  for (const [argv, env, expected, label] of CASES) {
    const got = resolveSessionId(argv, env);
    check(`resolveSessionId: ${label}`, got === expected, `got=${JSON.stringify(got)} expected=${JSON.stringify(expected)}`);
  }

  if (fail) {
    console.error(`selftest: ${fail} FAILED`);
    process.exit(1);
  }
  console.log(`selftest: OK (${CASES.length} resolveSessionId precedence cases — unit-level only, see header note)`);
  process.exit(0);
}

// Only run when invoked directly (`node execute-boundary-override.mjs ...`),
// not when the gate hook dynamically imports appendAudit() from it.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('execute-boundary-override.mjs');
if (invokedDirectly) {
  if (process.argv.includes('--selftest')) {
    selftest();
  } else {
    main();
  }
}
