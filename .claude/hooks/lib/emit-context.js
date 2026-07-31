// HiveMind — shared nudge emit channel for PostToolUse hooks.
//
// THE BUG THIS FIXES: a PostToolUse hook that emits via a plain
// `process.stdout.write(text)` on exit 0 is NOT surfaced to the model — that
// stdout lands in the transcript only. The channel that actually reaches the
// main loop's context is the PostToolUse JSON `hookSpecificOutput.additionalContext`.
// A nudge fired via raw stdout fires correctly yet is invisible to the model.
//
// Every PostToolUse nudge emits through here, so the channel contract lives in
// ONE place. Fail-open absolute: any error is swallowed — a nudge is cheap, it
// must never break the tool call it rode in on.

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

module.exports = { emitContext };
