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
// ⚠ ACTIVATION STATUS (2026-08-27, item A2.1, revised same day for
//   fail-safe default): this hook ENFORCES BY DEFAULT. Only the literal
//   value "off" for ENGRAM_EXECUTE_BOUNDARY_GATE disables it — unset, the
//   string "enforce", or any typo/unexpected value all fall through to
//   enforcing. This is deliberate: a misspelled or absent override must
//   never silently disable the gate. The key is intentionally NOT shipped
//   in .claude/settings.json's "env" block — merge-settings-json.mjs treats
//   template-defined env scalars as template-owned (the template value
//   always wins on install/update), so if this key lived in the template,
//   no tenant edit or shell export could durably override it. Leaving it
//   absent from the template means a tenant can set
//   ENGRAM_EXECUTE_BOUNDARY_GATE=off (in their own settings.json "env" block
//   or via shell export) and have that override survive updates. Setting it
//   to "off" is a deliberate kill-switch act, not a default this hook ships
//   with.
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

// Gate ENFORCES by default. Only the literal "off" disables it — see
// ACTIVATION STATUS above. The one and only enable/disable key is
// ENGRAM_EXECUTE_BOUNDARY_GATE.
const MODE = (process.env.ENGRAM_EXECUTE_BOUNDARY_GATE || 'enforce').toLowerCase();

if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    selftest();
  } else {
    main();
  }
}

async function main() {
  // Runs BEFORE stdin is even touched — a MODE=off gate never parses input,
  // cheapest + safest (mirrors lab's ordering exactly). Fail-safe guard:
  // only the literal "off" disables. Unset, "enforce", or any typo all fall
  // THROUGH to enforcing — this is the whole point (item A2.1 revision).
  if (MODE === 'off') process.exit(0);

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

    // Embed the RESOLVED sessionId (input.session_id-preferring — see
    // header/blocker d85e3fb7) in the deny reason itself. The override CLI is
    // a standalone process with no stdin/harness input, so --session here is
    // the ONLY way it can learn this gate's actual state-file key — it must
    // NOT fall back to guessing via ENGRAM_SESSION_ID alone, which can differ
    // from input.session_id (measured live: harness session_id
    // d6525965-... vs ENGRAM_SESSION_ID 06658549-... in the same turn).
    deny(
      `${count} hands-on/mutating commands in this turn — this is a FLOW, ` +
      'dispatch it to a subagent instead of continuing inline. If a founder OK ' +
      'for one more inline call was actually given, run: ' +
      `node .claude/hooks/lib/execute-boundary-override.mjs --ok '<quote>' --session ${sessionId} first.`
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
// Asserts ALL FOUR MODE cases (item A2.1 fail-safe revision) by re-spawning
// this same file as a child process with crafted stdin + env, since MODE is
// read once at module load. Craft: a CEILING-count dispatch state file + a
// mutating Edit call, no override — this DENIES whenever MODE resolves to
// enforcing.
//   - unset            → ENFORCING (must DENY)
//   - "off"             → inert (must be silent-allow, NO stdout)
//   - "enforce"         → ENFORCING (must DENY)
//   - "enforcce" (typo) → ENFORCING (must DENY) — this is the fail-safe
//     case and the whole point of the revision: a typo must never silently
//     disable the gate.
function selftest() {
  const { execFileSync } = require('node:child_process');
  const sessionId = `selftest-${process.pid}-${Date.now()}`;
  const dispatchFile = stateFile('dispatch', sessionId);
  let fail = 0;

  const runCase = (label, envValue, expectDeny) => {
    const env = { ...process.env };
    if (envValue === undefined) {
      delete env.ENGRAM_EXECUTE_BOUNDARY_GATE;
    } else {
      env.ENGRAM_EXECUTE_BOUNDARY_GATE = envValue;
    }

    const payload = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/execute-boundary-gate.selftest' },
      session_id: sessionId,
    });

    const result = execFileSync(process.execPath, [__filename], {
      input: payload,
      env,
      encoding: 'utf8',
    });

    if (expectDeny) {
      let parsed;
      try {
        parsed = JSON.parse(result);
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
        console.error(`  FAIL (${label} should DENY at CEILING): got stdout: ${result}`);
      } else {
        // Reconciliation check (blocker d85e3fb7): the override CLI runs as a
        // standalone process with no stdin/harness input, so it can ONLY ever
        // learn the gate's resolved sessionId if the gate hands it over. The
        // deny reason IS that hand-over — it must embed `--session
        // <sessionId>` so a copy-pasted override invocation targets the SAME
        // state-file key this gate just read from, not whatever
        // ENGRAM_SESSION_ID happens to be in the messenger's env (which may
        // differ from input.session_id — the exact bug measured live this
        // session).
        const reason = (parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecisionReason) || '';
        if (!reason.includes(`--session ${sessionId}`)) {
          fail++;
          console.error(`  FAIL (${label} deny reason must embed "--session ${sessionId}" for override-CLI reconciliation): ${reason}`);
        } else {
          console.log(`  ok: ${label} → DENY (enforcing), reason embeds --session ${sessionId}`);
        }
      }
    } else {
      if (result.trim() !== '') {
        fail++;
        console.error(`  FAIL (${label} should be silent-allow): got stdout: ${result}`);
      } else {
        console.log(`  ok: ${label} → silent-allow (inert)`);
      }
    }
  };

  try {
    fs.writeFileSync(dispatchFile, JSON.stringify({ count: CEILING }));

    runCase('unset', undefined, true);
    runCase('"off"', 'off', false);
    runCase('"enforce"', 'enforce', true);
    runCase('"enforcce" (typo)', 'enforcce', true);
  } finally {
    try { fs.unlinkSync(dispatchFile); } catch { /* best-effort cleanup */ }
  }

  // ─── subagent-override-denial (PORTED, item B1.10 — single-harness port of
  // §4 from the retired kernel/hooks/.test-fixtures/execute-boundary-parity.js;
  // the lab-comparison premise is dead, but the isolation-boundary assertion
  // itself is not comparative and was otherwise going untested anywhere in
  // this repo). Proves the deny fires HERE, at the gate, via
  // isSubagentContext + isOverrideCliInvocation (the reliable input.agent_id
  // signal) — NOT via lib/execute-boundary-override.mjs's own
  // CLAUDE_AGENT_NAME refusal, which is empty/unreliable for a dispatched
  // subagent (see lib/execute-boundary-classifier.js's isSubagentContext
  // header). CLAUDE_AGENT_NAME is deliberately deleted from every env below
  // so a pass here cannot be silently riding on that unreliable signal.
  const subagentSessionId = `selftest-subagent-${process.pid}-${Date.now()}`;
  const subagentDispatchFile = stateFile('dispatch', subagentSessionId);

  const runSubagentCase = (label, toolName, toolInput, expectDeny) => {
    const env = { ...process.env, ENGRAM_EXECUTE_BOUNDARY_GATE: 'enforce' };
    delete env.CLAUDE_AGENT_NAME; // the deny must not depend on this

    const payload = JSON.stringify({
      tool_name: toolName,
      tool_input: toolInput,
      session_id: subagentSessionId,
      agent_id: 'sub-selftest',
      agent_type: 'general-purpose',
    });

    const result = execFileSync(process.execPath, [__filename], {
      input: payload,
      env,
      encoding: 'utf8',
    });

    let denied = false;
    try {
      const parsed = JSON.parse(result);
      denied = !!(
        parsed &&
        parsed.hookSpecificOutput &&
        parsed.hookSpecificOutput.permissionDecision === 'deny'
      );
    } catch {
      /* not JSON → not a deny */
    }

    if (denied !== expectDeny) {
      fail++;
      console.error(`  FAIL (subagent: ${label} should ${expectDeny ? 'DENY' : 'allow'}): got stdout: ${result}`);
    } else {
      console.log(`  ok: subagent: ${label} → ${expectDeny ? 'DENY' : 'allow'}`);
    }
  };

  try {
    // count is at CEILING so (b) also proves subagent exemption holds even
    // when the ceiling itself would otherwise deny a main-loop call.
    fs.writeFileSync(subagentDispatchFile, JSON.stringify({ count: CEILING }));

    // (a) subagent RUNNING the override CLI → DENY, structurally, even
    // though subagents are otherwise exempt from the ceiling.
    runSubagentCase(
      'running the override CLI',
      'Bash',
      { command: "node .claude/hooks/lib/execute-boundary-override.mjs --ok 'x'" },
      true
    );

    // (b) subagent doing ordinary mutating work (not the override CLI) stays
    // EXEMPT (allow) even AT ceiling — regression guard so (a) isn't
    // accidentally over-broad.
    runSubagentCase(
      'ordinary edit at ceiling',
      'Edit',
      { file_path: '/tmp/execute-boundary-gate.selftest' },
      false
    );

    // (c) subagent Bash call that only MENTIONS the override CLI — allowed
    // because no command SEGMENT actually RUNS it (invocation-shape test, see
    // lib/execute-boundary-classifier.js's isOverrideCliInvocation). The
    // COMPOUND form (`cd … && grep …`) is the exact B1.8 false positive: its
    // lead token is `cd`, so the old ^-anchored READONLY_LEAD exemption
    // wrongly denied it. Confirmed end-to-end through the real gate subprocess,
    // not just the unit-level classifier call.
    runSubagentCase(
      'merely mentioning the override CLI in a compound read (cd && grep)',
      'Bash',
      { command: 'cd repo && grep -n founder .claude/hooks/lib/execute-boundary-override.mjs' },
      false
    );

    // (d) subagent running the override CLI behind a shell -c wrapper — the
    // false-negative a runtime-enumeration detector let through (item B1.8
    // 🔴 fix). The pure-read allow-list denies it: the segment names the path
    // and its lead word (`bash`) is not a read verb. Proven end-to-end here.
    runSubagentCase(
      'running the override CLI behind a bash -c wrapper',
      'Bash',
      { command: 'bash -c "node .claude/hooks/lib/execute-boundary-override.mjs --ok x"' },
      true
    );
  } finally {
    try { fs.unlinkSync(subagentDispatchFile); } catch { /* best-effort cleanup */ }
  }

  if (fail) { console.error(`selftest: ${fail} FAILED`); process.exit(1); }
  console.log('selftest: OK (unset/enforce/typo all enforce, only "off" is inert; subagent override-CLI denial (direct + bash -c wrapper), exemption, and compound read-only-mention allow all confirmed end-to-end)');
  process.exit(0);
}
