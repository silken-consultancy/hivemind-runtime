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

main();

async function main() {
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
      if (toolName === 'Bash' && isOverrideCliInvocation(toolInput.command || '')) {
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
