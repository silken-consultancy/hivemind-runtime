// HiveMind — execute-boundary turn-boundary reset — UserPromptSubmit hook
// user-prompt-submit.execute-boundary-turn-reset.js
//
// Triggered by: UserPromptSubmit, on EVERY user message (see .claude/settings.json,
// second entry in the UserPromptSubmit array alongside capture-quota.js).
//
// PURPOSE:
//   The execute-boundary hard gate (pre-tool-use.execute-boundary-gate.js) and its
//   messenger-only override (lib/execute-boundary-override.mjs) are TURN-SCOPED —
//   a founder OK for "one more inline call" authorizes exactly the current turn,
//   never set-and-forget. This hook is what makes that real: on every new user
//   message it (1) bumps the turn counter, (2) invalidates any prior override
//   grant, and (3) resets the mutating-call counter so the new turn starts clean.
//
// MANDATORY DISCIPLINES (ABSOLUTE fail-open):
//   - Any error (parse, missing session id, read/write) → exit 0, NEVER blocks
//     the prompt. This hook must never be the reason a user message stalls.
//   - NEVER calls MCP or the network. Only touches the three local state files.
//
// Input (stdin): UserPromptSubmit event JSON — { session_id, prompt, ... }

'use strict';

const fs = require('node:fs');
const { stateFile } = require('./lib/execute-boundary-classifier');

main();

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0); // fail-open: cannot parse → no-op
  }

  try {
    const sessionId = input.session_id || process.env.ENGRAM_SESSION_ID;
    if (!sessionId) process.exit(0); // no session key → fail-open, no-op

    // (1) bump turn_seq — monotonic, one new turn per UserPromptSubmit.
    const turnFile = stateFile('turn', sessionId);
    const turn = readJson(turnFile, { turn_seq: 0 });
    turn.turn_seq = Number.isFinite(turn.turn_seq) ? turn.turn_seq + 1 : 1;
    writeJson(turnFile, turn);

    // (2) a new turn invalidates any prior override grant — no set-and-forget.
    try { fs.unlinkSync(stateFile('execute-override', sessionId)); } catch { /* absent is fine */ }

    // (3) reset the mutating-call counter for the new turn.
    writeJson(stateFile('dispatch', sessionId), { count: 0, last_nudge_at_count: 0 });
  } catch (err) {
    process.stderr.write(`[execute-boundary-turn-reset] WARN: ${err.message}\n`);
  }

  process.exit(0);
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    return { ...fallback, ...parsed };
  } catch {
    return { ...fallback };
  }
}

function writeJson(file, obj) {
  try {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* fail-open */ }
}
