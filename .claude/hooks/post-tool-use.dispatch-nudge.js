// HiveMind — execute-boundary backstop — PostToolUse hook
// (matcher: Edit|Write|MultiEdit|Bash — see .claude/settings.json)
// post-tool-use.dispatch-nudge.js
//
// Triggered by: PostToolUse, matcher "Edit|Write|MultiEdit|Bash".
//
// PURPOSE:
//   It is easy to slide into doing a whole flow by hand in the foreground —
//   dozens of ssh/git/docker/psql commands, or a long run of bare Edit/Write
//   calls, in the main loop — which keeps the session busy and unresponsive
//   instead of pushing the work to the background and staying available. This
//   hook is a lightweight, non-blocking reminder to do that. It never blocks
//   a command — the hard enforcement lives in the sibling PreToolUse gate,
//   pre-tool-use.execute-boundary-gate.js, which reads the SAME counter this
//   hook maintains.
//
// THE RULE:
//   - Up to ~10 hands-on/mutating calls in the foreground = fine (fluidity —
//     this is NOT a cage; one-offs and short diagnostics are welcome inline).
//   - Past ~10 = this is a FLOW → push it to the background and stay responsive.
//   - Mechanism = a NON-BLOCKING nudge, NEVER a hard block/gate. A blocking gate
//     caps too much and freezes the flow; the goal is to REMIND, not to prevent.
//     You always decide (the hard ceiling, at CEILING=15, is enforced elsewhere).
//
// WHAT WIDENED (execute-boundary hard-gate arc): originally this hook only
// counted mutating Bash commands. Edit/Write/MultiEdit now ALWAYS count too —
// classification moved to lib/execute-boundary-classifier.js's
// isMutatingToolCall(), shared with the PreToolUse hard gate so the definition
// of "counts" never drifts between the reminder and the enforcement.
//
// MECHANICS:
//   - Per-session counter (keyed by session id), in a temp file under TMPDIR.
//     Keyed by session, so a new session starts from zero; a TTL (STATE_TTL_MS)
//     auto-cleans orphaned state files as a fallback. Also reset at the start
//     of every user turn by user-prompt-submit.execute-boundary-turn-reset.js.
//   - Counts ONLY mutating/remote calls (see lib/execute-boundary-classifier.js).
//     Read-only commands do not count (fluidity > noise). If ambiguous → does
//     NOT count.
//   - On CROSSING the threshold (10) and every +STEP (5) after, emits the nudge
//     through the PostToolUse additionalContext channel (anti-spam). A raw
//     process.stdout.write is transcript-only and never reaches the model, so the
//     nudge is emitted via lib/emit-context (hookSpecificOutput.additionalContext).
//
// SUB-AGENTS DO NOT COUNT (only the main loop slides into hands-on mode):
//   when this hook runs inside a sub-agent, the work is ALREADY dispatched — the
//   nudge would be noise. Detected via the MEASURED input.agent_id signal (see
//   lib/execute-boundary-classifier.js's isSubagentContext — CLAUDE_AGENT_NAME
//   and transcript_path were both probed live and found unreliable for this).
//
// MANDATORY DISCIPLINES (ABSOLUTE fail-open):
//   - Any error (parse, missing env, state read/write) → exit 0, NEVER blocks the
//     tool call. Errors go to stderr only.
//   - NEVER calls MCP or the network. Only reads/writes the state file and emits
//     the nudge via the additionalContext channel.
//   - Not a log-everything: a read-only/non-mutating call → silent no-op.
//
// Input (stdin): PostToolUse event JSON — { tool_name, tool_input, session_id, ... }

'use strict';

const fs = require('node:fs');
const { emitContext } = require('./lib/emit-context');
const { isMutatingToolCall, isSubagentContext, stateFile, THRESHOLD, STEP } = require('./lib/execute-boundary-classifier');

// TTL to auto-clean orphaned state files (fallback; state is keyed by session).
const STATE_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// Exported for the dogfood/test. When require()d, the hook body does NOT run.
if (require.main !== module) {
  module.exports = { THRESHOLD, STEP };
} else {
  main();
}

// ─── hook body ────────────────────────────────────────────────────────────────

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0); // fail-open
  }

  try {
    const toolName = input.tool_name || '';
    const toolInput = input.tool_input || {};
    if (!isMutatingToolCall(toolName, toolInput)) process.exit(0); // not counted → silent no-op

    // A sub-agent already IS the dispatch — do not count (nudge would be noise).
    if (isSubagentContext(input)) process.exit(0);

    // Session key: prefer the event's session_id (always present in the hook
    // payload); fall back to the runtime-exported ENGRAM_SESSION_ID. No key at
    // all → off (fail-open).
    const sessionId = input.session_id || process.env.ENGRAM_SESSION_ID;
    if (!sessionId) process.exit(0);

    const file = stateFile('dispatch', sessionId);
    const st = readState(file);
    st.count += 1;

    // Fires on CROSSING the threshold and every +STEP after (anti-spam).
    if (st.count >= THRESHOLD && st.count > st.last_nudge_at_count) {
      emitNudge(st.count);
      st.last_nudge_at_count = st.count >= THRESHOLD + STEP - 1
        ? st.count + STEP - 1        // already past the first: next at +STEP
        : THRESHOLD + STEP - 1;      // first fire (at 10): next at 15
    }

    writeState(file, st);
  } catch (err) {
    process.stderr.write(`[dispatch-nudge] WARN: ${err.message}\n`);
  }

  process.exit(0);
}

// ─── subagent detection ───────────────────────────────────────────────────────
// isSubagentContext is imported from lib/execute-boundary-classifier.js (the
// measured input.agent_id discriminator) — no local definition here anymore.

// ─── per-session state ──────────────────────────────────────────────────────────
// stateFile('dispatch', sessionId) → hivemind-dispatch-<session>.json, resolved
// via lib/execute-boundary-classifier.js's shared path-builder (same convention
// used by the turn-reset hook and the override CLI for their own state files).

function readState(file) {
  const fresh = { count: 0, last_nudge_at_count: 0 };
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > STATE_TTL_MS) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      return { ...fresh };
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    return {
      count: Number.isFinite(parsed.count) ? parsed.count : 0,
      last_nudge_at_count: Number.isFinite(parsed.last_nudge_at_count) ? parsed.last_nudge_at_count : 0,
    };
  } catch {
    return { ...fresh };
  }
}

function writeState(file, st) {
  try {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(st), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* fail-open */ }
}

// ─── nudge ────────────────────────────────────────────────────────────────────

function emitNudge(count) {
  emitContext(
    `⚠ ${count} hands-on/mutating commands in this session (foreground). ` +
    `You're running a lot of hands-on work in the foreground. If this is a FLOW ` +
    `(not short one-off diagnostics), the discipline is non-blocking: push the ` +
    `long/hands-on work to the background (run_in_background) and stay responsive. ` +
    `Non-blocking nudge — you decide.`
  );
}
