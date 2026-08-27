// HiveMind — execute-boundary HARD GATE — PreToolUse hook
// (matcher: Edit|Write|MultiEdit|Bash — see .claude/settings.json)
// pre-tool-use.execute-boundary-gate.js
//
// PURPOSE:
//   The advisory nudge (post-tool-use.dispatch-nudge.js) reminds; this hook
//   ENFORCES. Past CEILING mutating/hands-on main-loop calls in the current
//   turn, it DENIES the next one — forcing a dispatch instead of continuing
//   the flow piece-meal in the foreground. Anchor:
//   decision_execute-boundary-hard-gate-messenger-exclusive-override-turn-scoped-audited-lab-and-product.
//
// WHAT COUNTS: delegated entirely to lib/execute-boundary-classifier.js's
// isMutatingToolCall() — Edit/Write/MultiEdit always count; Bash counts only
// when isMutatingBash() matches. fos_* calls and reads never count.
//
// SUBAGENTS ARE EXEMPT — this gate targets the main loop only. Builder-work IS
// a dispatched builder's job; a dispatched subagent making 30 edits is correct,
// not drift. Detected via the MEASURED input.agent_id signal (2026-07-31 live
// probe — CLAUDE_AGENT_NAME is EMPTY for subagents and transcript_path is the
// PARENT session's in both contexts, so neither is a reliable discriminator;
// see lib/execute-boundary-classifier.js's isSubagentContext).
//
// EXCEPT ONE THING — subagents can never invoke the override CLI: exemption
// from the ceiling does NOT extend to granting themselves an override. The
// CLI's own CLAUDE_AGENT_NAME refusal (lib/execute-boundary-override.mjs) is
// UNRELIABLE for subagents for the same env reason above, so the REAL
// protection lives here: a subagent's Bash call that would run
// execute-boundary-override.mjs is denied outright, using the reliable
// agent_id signal (isOverrideCliInvocation, same shared lib).
//
// STATE OWNERSHIP — this hook is a PURE READER of all three state files. It
// never increments or resets any of them:
//   - hivemind-dispatch-<session>.json     owned by post-tool-use.dispatch-nudge.js
//   - hivemind-turn-<session>.json         owned by user-prompt-submit.execute-boundary-turn-reset.js
//   - hivemind-execute-override-<session>.json  owned by lib/execute-boundary-override.mjs
// A single-owner-per-file discipline avoids a double-writer race between this
// hook and the ones that actually mutate state.
//
// THE OVERRIDE — messenger-only, turn-scoped, audited: valid only if the grant
// file exists AND its turn_seq matches the CURRENT turn_seq (a new user message
// wipes the grant via the turn-reset hook — no set-and-forget). A valid consume
// appends a 'consumed' line to the SAME audit JSONL the grant used (imported
// from lib/execute-boundary-override.mjs, not duplicated here).
//
// ⚠ ACTIVATION STATUS (2026-08-27, item A2.1): this hook is REGISTERED in
//   .claude/settings.json but gated OFF by default via
//   ENGRAM_EXECUTE_BOUNDARY_GATE (unset/anything-but-"enforce" → INERT).
//   Enable-parity twin of the lab's FOS_EXECUTE_BOUNDARY_GATE gate
//   (kernel/hooks/pre-tool-use.execute-boundary-gate.js) — same default-off
//   posture, same early-exit-before-stdin ordering, product-convention var
//   name (ENGRAM_* not FOS_*; do NOT rename the lab's var to match). Ships
//   dark deliberately: flipping ENGRAM_EXECUTE_BOUNDARY_GATE to "enforce" is
//   the founder's deploy act (OPEN-A), never a default this hook assumes.
//
// MANDATORY DISCIPLINES:
//   - Parse error / no session id / unexpected error → fail-open, ALLOW. This
//     gate must never accidentally deny due to a bug in itself — that would be
//     worse than the advisory nudge it replaces (which never blocked at all).
//   - NEVER calls MCP or the network. Reads stdin + local state files only.
//
// Input (stdin): PreToolUse event JSON —
//   { tool_name, tool_input, session_id, transcript_path?, ... }

'use strict';

const fs = require('node:fs');
const {
  isMutatingToolCall,
  isSubagentContext,
  isOverrideCliInvocation,
  stateFile,
  CEILING,
} = require('./lib/execute-boundary-classifier');

// Gate is INERT unless explicitly flipped to "enforce" — see ACTIVATION
// STATUS above. Enable-parity with the lab's FOS_EXECUTE_BOUNDARY_GATE,
// product-convention name.
const MODE = (process.env.ENGRAM_EXECUTE_BOUNDARY_GATE || 'off').toLowerCase();

if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    selftest();
  } else {
    main();
  }
}

async function main() {
  // Runs BEFORE stdin is even touched — a MODE=off gate never parses input,
  // cheapest + safest (mirrors lab's ordering exactly).
  if (MODE !== 'enforce') process.exit(0);

  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0); // fail-open: cannot parse → allow
  }

  try {
    const toolName = input.tool_name || '';
    const toolInput = input.tool_input || {};

    if (isSubagentContext(input)) {
      // Subagents are exempt from the ceiling — builder-work IS their job.
      // But they must NEVER be able to grant themselves the override: deny
      // that ONE invocation outright, structurally, using the reliable
      // agent_id signal (the CLI's own env-based refusal is not reliable
      // for a subagent — see header).
      if (isOverrideCliInvocation(toolName, toolInput)) {
        deny(
          'Subagents cannot invoke the execute-boundary override CLI — this override is ' +
          'messenger-only, structurally, regardless of the (env-unreliable for subagents) ' +
          'refusal inside the CLI itself.'
        );
        return;
      }
      process.exit(0); // otherwise exempt
    }

    if (!isMutatingToolCall(toolName, toolInput)) process.exit(0); // not counted → allow

    const sessionId = input.session_id || process.env.ENGRAM_SESSION_ID;
    if (!sessionId) process.exit(0); // no session key → fail-open, allow

    const count = readCount(stateFile('dispatch', sessionId));
    if (count < CEILING) process.exit(0); // under ceiling → allow silently

    const turnSeq = readTurnSeq(stateFile('turn', sessionId));
    const override = readOverride(stateFile('execute-override', sessionId));
    const valid = !!override && override.granted === true && override.turn_seq === turnSeq;

    if (valid) {
      await consumeOverride(sessionId, toolName, turnSeq, override.ok_ref);
      process.exit(0); // allow — override consumed for this call
    }

    deny(
      `${count} hands-on/mutating commands in this turn — this is a FLOW, ` +
      'dispatch it to a subagent instead of continuing inline. If a founder OK ' +
      'for one more inline call was actually given, run: ' +
      "node .claude/hooks/lib/execute-boundary-override.mjs --ok '<quote>' first."
    );
  } catch (err) {
    process.stderr.write(`[execute-boundary-gate] WARN: ${err.message}\n`);
    process.exit(0); // fail-open on unexpected error — never deny by accident
  }
}

// ─── state readers (pure — never write) ─────────────────────────────────────

function readCount(file) {
  try {
    const st = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    return Number.isFinite(st.count) ? st.count : 0;
  } catch {
    return 0;
  }
}

function readTurnSeq(file) {
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    return Number.isFinite(t.turn_seq) ? t.turn_seq : 0;
  } catch {
    return 0;
  }
}

function readOverride(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
  } catch {
    return null;
  }
}

// ─── override consume — audits via the SAME appender the grant used ────────

async function consumeOverride(sessionId, toolName, turnSeq, okRef) {
  try {
    const mod = await import('./lib/execute-boundary-override.mjs');
    if (mod && typeof mod.appendAudit === 'function') {
      mod.appendAudit(sessionId, {
        event: 'consumed',
        tool_name: toolName,
        turn_seq: turnSeq,
        ok_ref: okRef,
        consumed_at: new Date().toISOString(),
      });
    }
  } catch {
    /* audit is best-effort; must never block the allow it rides on */
  }
}

// ─── deny ────────────────────────────────────────────────────────────────────

function deny(reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

// ─── self-test (node pre-tool-use.execute-boundary-gate.js --selftest) ─────
//
// Asserts BOTH MODE branches (item A2.1 ACCEPTANCE) by re-spawning this same
// file as a child process with crafted stdin + env, since MODE is read once
// at module load. Craft: a CEILING-count dispatch state file + a mutating
// Edit call, no override — this WOULD deny if MODE were 'enforce'.
//   - MODE unset (default off): must exit silently, NO stdout at all — proves
//     the early-exit runs before stdin is even read.
//   - MODE=enforce: SAME input must DENY (unchanged prior/lab behavior).
function selftest() {
  const { execFileSync } = require('node:child_process');
  const sessionId = `selftest-${process.pid}-${Date.now()}`;
  const dispatchFile = stateFile('dispatch', sessionId);
  let fail = 0;

  try {
    fs.writeFileSync(dispatchFile, JSON.stringify({ count: CEILING }));

    const payload = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/execute-boundary-gate.selftest' },
      session_id: sessionId,
    });

    const offEnv = { ...process.env };
    delete offEnv.ENGRAM_EXECUTE_BOUNDARY_GATE;
    const offResult = execFileSync(process.execPath, [__filename], {
      input: payload,
      env: offEnv,
      encoding: 'utf8',
    });
    if (offResult.trim() !== '') {
      fail++;
      console.error(`  FAIL (MODE=off/unset should be silent-allow): got stdout: ${offResult}`);
    }

    const enforceEnv = { ...process.env, ENGRAM_EXECUTE_BOUNDARY_GATE: 'enforce' };
    const enforceResult = execFileSync(process.execPath, [__filename], {
      input: payload,
      env: enforceEnv,
      encoding: 'utf8',
    });
    let parsed;
    try {
      parsed = JSON.parse(enforceResult);
    } catch {
      parsed = null;
    }
    const denied = !!(
      parsed &&
      parsed.hookSpecificOutput &&
      parsed.hookSpecificOutput.permissionDecision === 'deny'
    );
    if (!denied) {
      fail++;
      console.error(`  FAIL (MODE=enforce should DENY at CEILING): got stdout: ${enforceResult}`);
    }
  } finally {
    try { fs.unlinkSync(dispatchFile); } catch { /* best-effort cleanup */ }
  }

  if (fail) { console.error(`selftest: ${fail} FAILED`); process.exit(1); }
  console.log('selftest: OK (MODE=off/unset silent-allow, MODE=enforce denies at CEILING)');
  process.exit(0);
}
