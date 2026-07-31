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

  // Fail-CLOSED: a session-less override is meaningless — refuse, do not grant.
  const sessionId = process.env.ENGRAM_SESSION_ID;
  if (!sessionId) {
    process.stderr.write('[execute-boundary-override] refused: ENGRAM_SESSION_ID is not set\n');
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

  process.stderr.write(`[execute-boundary-override] granted (turn_seq=${turnSeq})\n`);
  process.exit(0);
}

// Only run when invoked directly (`node execute-boundary-override.mjs ...`),
// not when the gate hook dynamically imports appendAudit() from it.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('execute-boundary-override.mjs');
if (invokedDirectly) {
  main();
}
