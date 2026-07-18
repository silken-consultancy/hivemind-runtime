// HiveMind — execute-boundary backstop — PostToolUse hook (matcher: Bash)
// post-tool-use.dispatch-nudge.js
//
// Triggered by: PostToolUse, matcher "Bash" (see .claude/settings.json).
//
// PURPOSE:
//   It is easy to slide into doing a whole flow by hand in the foreground —
//   dozens of ssh/git/docker/psql commands in the main loop — which keeps the
//   session busy and unresponsive instead of pushing the work to the background
//   and staying available. This hook is a lightweight, non-blocking reminder to
//   do that. It never blocks a command.
//
// THE RULE:
//   - Up to ~10 hands-on/mutating commands in the foreground = fine (fluidity —
//     this is NOT a cage; one-offs and short diagnostics are welcome inline).
//   - Past ~10 = this is a FLOW → push it to the background and stay responsive.
//   - Mechanism = a NON-BLOCKING nudge, NEVER a hard block/gate. A blocking gate
//     caps too much and freezes the flow; the goal is to REMIND, not to prevent.
//     You always decide.
//
// MECHANICS:
//   - Per-session counter (keyed by session id), in a temp file under TMPDIR.
//     Keyed by session, so a new session starts from zero; a TTL (STATE_TTL_MS)
//     auto-cleans orphaned state files as a fallback.
//   - Counts ONLY mutating/remote commands (see isMutating() below). Read-only
//     commands do not count (fluidity > noise). If ambiguous → does NOT count.
//   - On CROSSING the threshold (10) and every +STEP (5) after, emits the nudge
//     on stdout (anti-spam).
//
// SUB-AGENTS DO NOT COUNT (only the main loop slides into hands-on mode):
//   when this hook runs inside a sub-agent, the work is ALREADY dispatched — the
//   nudge would be noise. Detected best-effort via env/transcript; on detection
//   we exit without counting. (Best-effort; fail-open.)
//
// MANDATORY DISCIPLINES (ABSOLUTE fail-open):
//   - Any error (parse, missing env, state read/write) → exit 0, NEVER blocks the
//     Bash command. Errors go to stderr only.
//   - NEVER calls MCP or the network. Only reads/writes the state file and prints
//     to stdout.
//   - Not a log-everything: a read-only command → silent no-op.
//
// Input (stdin): PostToolUse event JSON — { tool_name, tool_input:{command}, session_id, ... }

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ─── constants (TUNABLE) ────────────────────────────────────────────────────────

// THRESHOLD — the ~10 rule. Up to here = fluidity; past it = it's a FLOW.
const THRESHOLD = 10;
// STEP — periodic re-nudge after the first fire (every +5 mutating), so it does
// not spam every command but keeps the reminder alive if hands-on mode persists.
const STEP = 5;
// TTL to auto-clean orphaned state files (fallback; state is keyed by session).
const STATE_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// ─── classifier: isMutating(cmd) ────────────────────────────────────────────────
//
// Counts a command as "hands-on/mutating" if the command STRING contains an
// operation that changes state (local or remote) or runs remote work. It is
// deliberately CONSERVATIVE: when in doubt, do NOT count (fluidity > noise).
// Compound commands (`cd x && git commit ...`, `bash -lc '... ssh ...'`) count
// ONCE if they contain ANY mutating signal.
//
// COUNTS (mutating / remote):
//   - remote ssh : `ssh -o ...` or `ssh user@host`  (remote execution = hands-on)
//   - scp
//   - docker MUTATING: exec | run | compose up/down/restart/start/stop | rm | stop
//     | start | restart | kill   (docker exec runs a command inside the container)
//   - git MUTATING: commit | push | merge | `checkout -b` | rebase | reset |
//     cherry-pick | revert
//   - psql/SQL DML/DDL: INSERT | UPDATE | DELETE | ALTER | CREATE | DROP | TRUNCATE
//     | GRANT   (only when there is psql/sql context — avoids matching a bare word)
//   - sed -i     : in-place file edit
//   - rm | mv | cp : filesystem mutation (as a command, not a substring)
//   - curl mutating: -X POST/PUT/DELETE/PATCH or --data/-d/--upload-file
//
// DOES NOT COUNT (read-only / diagnostics — fluidity):
//   grep, ls, cat, head, tail, wc, find, sort, uniq, awk, cut, echo, printf, date,
//   git status/diff/log/branch/show/cat-file, docker ps/logs/inspect/images/--version,
//   plain psql SELECT, node -e reads, curl GET, sleep, chmod/mkdir/touch/ln
//   (low-risk local mutations, left out on purpose so as not to become noise).
//
// LIMITATION: this is STRING analysis (it runs nothing). An `ssh` inside the
// quotes of an echo would be a rare false positive — acceptable and fail-open
// (the nudge is cheap). Exported so a dogfood/test can reuse EXACTLY this logic.
function isMutating(rawCmd) {
  const cmd = String(rawCmd || '');
  if (!cmd.trim()) return false;

  // remote ssh — requires a `-o`/`-i`/etc flag OR `user@host`, so it does not
  // match `.ssh/config` or `~/.ssh` in read-only greps.
  if (/\bssh\s+(-\w|[\w.-]+@)/.test(cmd)) return true;

  // scp
  if (/\bscp\s+\S/.test(cmd)) return true;

  // docker mutating subcommands (ps/logs/inspect/images/--version do NOT match).
  // Requires command-start/post-separator/post-heredoc-newline so the string
  // "docker exec" appearing INSIDE a read-only grep pattern does NOT match.
  if (/(^|[\n;&(]|&&|\|\|)\s*docker\s+(compose\s+(up|down|restart|start|stop)|exec|run|rm|stop|start|restart|kill)\b/.test(cmd)) return true;

  // git mutating verbs (status/diff/log/branch/show/cat-file do NOT match). The
  // lookahead (?![\w-]) stops `git merge-base` (read-only) from matching `merge`.
  if (/\bgit\s+(commit|push|merge|rebase|reset|cherry-pick|revert)(?![\w-])/.test(cmd)) return true;
  if (/\bgit\s+checkout\s+-b\b/.test(cmd)) return true;

  // SQL DML/DDL — only counts if there is psql/SQL context in the command
  // (avoids matching a bare "CREATE"/"UPDATE" in prose/grep). Accepts
  // heredoc/`-c "..."`.
  if (/\bpsql\b/.test(cmd) && /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT)\b/i.test(cmd)) return true;

  // sed in-place
  if (/\bsed\s+-i\b/.test(cmd)) return true;

  // rm / mv / cp as a command (start, or after a separator ; && || | ( )
  if (/(^|[\n;&|(])\s*(rm|mv|cp)\s+-?\S/.test(cmd)) return true;

  // curl mutating (POST/PUT/DELETE/PATCH or a body). GET does not count.
  if (/\bcurl\b/.test(cmd) && /(-X\s*(POST|PUT|DELETE|PATCH)\b|--data\b|--data-\w+|(^|\s)-d\s|\s--upload-file\b)/i.test(cmd)) return true;

  return false;
}

// Exported for the dogfood/test. When require()d, the hook body does NOT run.
if (require.main !== module) {
  module.exports = { isMutating, THRESHOLD, STEP };
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
    const toolName = (input.tool_name || '').toLowerCase();
    if (toolName !== 'bash') process.exit(0);

    const cmd = (input.tool_input && input.tool_input.command) || '';
    if (!isMutating(cmd)) process.exit(0); // read-only → silent no-op

    // A sub-agent already IS the dispatch — do not count (nudge would be noise).
    if (isSubagentContext(input)) process.exit(0);

    // Session key: prefer the event's session_id (always present in the hook
    // payload); fall back to the runtime-exported ENGRAM_SESSION_ID. No key at
    // all → off (fail-open).
    const sessionId = input.session_id || process.env.ENGRAM_SESSION_ID;
    if (!sessionId) process.exit(0);

    const file = stateFile(sessionId);
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

// ─── subagent detection (best-effort) ────────────────────────────────────────────

function isSubagentContext(input) {
  // Possible signals: an agent-name env, or a transcript_path under .../subagents/.
  if (process.env.CLAUDE_AGENT_NAME) return true;
  const tp = String(input.transcript_path || '');
  if (/[\\/]subagents[\\/]/.test(tp)) return true;
  return false;
}

// ─── per-session state ──────────────────────────────────────────────────────────

function stateFile(sessionId) {
  const dir = process.env.TMPDIR || os.tmpdir() || '/tmp';
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dir, `hivemind-dispatch-${safe}.json`);
}

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
  process.stdout.write(
    `\n⚠ ${count} hands-on/mutating commands in this session (foreground).\n` +
    `   You're running a lot of hands-on work in the foreground. If this is a FLOW\n` +
    `   (not short one-off diagnostics), the discipline is non-blocking: push the\n` +
    `   long/hands-on work to the background (run_in_background) and stay responsive.\n` +
    `   Non-blocking nudge — you decide.\n\n`
  );
}
