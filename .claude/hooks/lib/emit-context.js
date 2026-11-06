// HiveMind — shared emit channel for hook output (PostToolUse nudges and
// PreToolUse denies).
//
// THE BUG THIS FIXES: a PostToolUse hook that emits via a plain
// `process.stdout.write(text)` on exit 0 is NOT surfaced to the model — that
// stdout lands in the transcript only. The channel that actually reaches the
// main loop's context is the PostToolUse JSON `hookSpecificOutput.additionalContext`.
// A nudge fired via raw stdout fires correctly yet is invisible to the model.
//
// Every PostToolUse nudge (emitContext) and PreToolUse deny (emitPreToolUseDeny)
// emits through here, so the channel contract lives in ONE place. Fail-open
// absolute: any error is swallowed — a nudge is cheap, it must never break the
// tool call it rode in on.

'use strict';

/**
 * Emit a nudge into the main loop's context via the PostToolUse additionalContext
 * channel. Replaces raw process.stdout.write(text), which is transcript-only.
 * @param {string} text - the nudge message (plain text; newlines are fine)
 */
function emitContext(text) {
  try {
    process.stdout.write(
      JSON.stringify({
        // additionalContext ONLY — deliberately no systemMessage. additionalContext
        // reaches the MODEL (the decider acts on it); the owner sees the nudge only
        // when the model relays the decision-relevant ones in its own voice, as a
        // normal conversation message. One channel in, model relays out — no double
        // rendering.
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: String(text),
        },
      }) + '\n'
    );
  } catch {
    /* fail-open: never throw out of a nudge */
  }
}

/**
 * Emit a PreToolUse DENY: the permission decision plus the same reason as
 * additionalContext, so the model reads why the call was refused and what to
 * run instead. Fail-open like emitContext: an emit error never throws.
 * @param {string} reason - why the call was refused (plain text)
 */
function emitPreToolUseDeny(reason) {
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: String(reason),
          additionalContext: String(reason),
        },
      }) + '\n'
    );
  } catch {
    /* fail-open: never throw out of a hook */
  }
}

module.exports = { emitContext, emitPreToolUseDeny };
