// HiveMind — execute-boundary shared classifier — used by BOTH the advisory
// nudge (post-tool-use.dispatch-nudge.js) and the hard gate
// (pre-tool-use.execute-boundary-gate.js). One classifier, two consumers —
// so the definition of "counts as hands-on/mutating" never drifts between
// the reminder and the enforcement.
// lib/execute-boundary-classifier.js
//
// WHAT WIDENED (vs. the pre-existing Bash-only classifier in dispatch-nudge.js):
//   The advisory nudge originally counted only mutating Bash commands. The
//   hard gate's brief ("Edit/Write/Bash that mutates code or infra") requires
//   ANY file mutation to count too — a run of bare Edit/Write calls with no
//   Bash in between was previously invisible to the counter. isMutatingBash()
//   below is unchanged (moved here verbatim); isMutatingToolCall() is the new
//   entry point that also counts Edit/Write/MultiEdit unconditionally.
//
// NOT WIDENED: governed board/memory edits (fos_* tool calls — messenger
// work) and reads (Read/Grep/Glob) are NEVER counted by either consumer —
// only main-loop builder-work that mutates code or infra.
//
// This file is a pure library (no stdin, no process.exit on require) so both
// consumers — and the turn-reset hook / override CLI, via stateFile() — share
// exactly one source of truth for the policy constants and the state-file
// path convention.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ─── policy constants (shared: advisory nudge + hard gate) ─────────────────

// THRESHOLD — unchanged from the pre-existing advisory nudge: up to here is
// fluidity, past it the nudge starts firing.
const THRESHOLD = 10;
// STEP — unchanged: periodic re-nudge cadence after the first fire.
const STEP = 5;
// CEILING — NEW: the hard gate denies once the counted total reaches this.
// One cycle after the advisory THRESHOLD+STEP (10 → nudge, 15 → nudge AND deny).
const CEILING = 15;

// ─── isMutatingBash(cmd) — moved verbatim from post-tool-use.dispatch-nudge.js ──
//
// Counts a Bash command as "hands-on/mutating" if the command STRING contains
// an operation that changes state (local or remote) or runs remote work.
// Deliberately CONSERVATIVE: when in doubt, do NOT count (fluidity > noise).
function isMutatingBash(rawCmd) {
  const cmd = String(rawCmd || '');
  if (!cmd.trim()) return false;

  // remote ssh — requires a `-o`/`-i`/etc flag OR `user@host`, so it does not
  // match `.ssh/config` or `~/.ssh` in read-only greps.
  if (/\bssh\s+(-\w|[\w.-]+@)/.test(cmd)) return true;

  // scp
  if (/\bscp\s+\S/.test(cmd)) return true;

  // docker mutating subcommands (ps/logs/inspect/images/--version do NOT match).
  if (/(^|[\n;&(]|&&|\|\|)\s*docker\s+(compose\s+(up|down|restart|start|stop)|exec|run|rm|stop|start|restart|kill)\b/.test(cmd)) return true;

  // git mutating verbs (status/diff/log/branch/show/cat-file do NOT match).
  if (/\bgit\s+(commit|push|merge|rebase|reset|cherry-pick|revert)(?![\w-])/.test(cmd)) return true;
  if (/\bgit\s+checkout\s+-b\b/.test(cmd)) return true;

  // SQL DML/DDL — only counts if there is psql/SQL context in the command.
  if (/\bpsql\b/.test(cmd) && /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT)\b/i.test(cmd)) return true;

  // sed in-place
  if (/\bsed\s+-i\b/.test(cmd)) return true;

  // rm / mv / cp as a command (start, or after a separator ; && || | ( )
  if (/(^|[\n;&|(])\s*(rm|mv|cp)\s+-?\S/.test(cmd)) return true;

  // curl mutating (POST/PUT/DELETE/PATCH or a body). GET does not count.
  if (/\bcurl\b/.test(cmd) && /(-X\s*(POST|PUT|DELETE|PATCH)\b|--data\b|--data-\w+|(^|\s)-d\s|\s--upload-file\b)/i.test(cmd)) return true;

  return false;
}

// ─── isMutatingToolCall(toolName, toolInput) — the widened entry point ─────
//
// Edit|Write|MultiEdit → ALWAYS counts (any file mutation, per brief).
// Bash → delegates to isMutatingBash() (unchanged behavior).
// Anything else (Read/Grep/Glob/fos_*/…) → never counts.
function isMutatingToolCall(toolName, toolInput) {
  const name = String(toolName || '');
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') return true;
  if (name === 'Bash') return isMutatingBash((toolInput && toolInput.command) || '');
  return false;
}

// ─── isSubagentContext(input) — MEASURED discriminator (2026-07-31 live probe) ──
//
// CLAUDE_AGENT_NAME is EMPTY for subagents (they inherit the messenger's env)
// — USELESS as a signal, despite being the convention every OTHER hook in
// this dir still uses. transcript_path is the PARENT session's path in BOTH
// contexts — also USELESS. The RELIABLE discriminator, measured directly
// against a real dispatched subagent tool call: the PreToolUse/PostToolUse
// stdin carries `agent_id` (+ `agent_type`) ONLY on a subagent's tool calls,
// ABSENT on the main loop's. This supersedes CLAUDE_AGENT_NAME/transcript_path
// for the execute-boundary family specifically — out of scope here to also
// fix build-nudge.js's/dispatch-nudge.js's OWN pre-existing (unrelated)
// subagent checks elsewhere in this dir.
function isSubagentContext(input) {
  return !!(input && input.agent_id != null);
}

// ─── isOverrideCliInvocation(cmd) — closes the gap the measurement found ───
//
// lib/execute-boundary-override.mjs's own CLAUDE_AGENT_NAME refusal is
// UNRELIABLE for subagents (env is empty for them — see isSubagentContext
// above). The REAL protection lives at the GATE: it denies a subagent's Bash
// call outright when that call would run the override CLI, using the
// reliable agent_id signal instead. The CLAUDE_AGENT_NAME check inside
// override.mjs remains as belt-and-suspenders (harmless, just not sufficient
// alone). READONLY_LEAD guards against a false deny on a command that only
// MENTIONS the file (grep/cat of the script), not one that RUNS it.
const READONLY_LEAD = /^\s*(grep|rg|ag|cat|echo|ls|head|tail|less|awk|sed|find)\b/;
function isOverrideCliInvocation(rawCmd) {
  const cmd = String(rawCmd || '');
  if (!/execute-boundary-override\.mjs/.test(cmd)) return false;
  if (READONLY_LEAD.test(cmd)) return false; // mentions it, doesn't run it
  return true;
}

// ─── stateFile(kind, sessionId) — shared path-builder ──────────────────────
//
// Single naming convention for every state file this gate family touches:
// hivemind-<kind>-<safe-session>.json (or .jsonl for the audit trail, built
// separately by the override CLI). `kind` in {'dispatch','turn','execute-override'}.
function stateFile(kind, sessionId) {
  const dir = process.env.TMPDIR || os.tmpdir() || '/tmp';
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dir, `hivemind-${kind}-${safe}.json`);
}

// ─── self-test (node execute-boundary-classifier.js --selftest) ───────────
// Mirrors pre-tool-use.build-nudge.js's SHOULD/SHOULD_NOT self-test pattern.
function selftest() {
  const BASH_SHOULD = [
    'ssh -i key.pem user@host', 'ssh user@host "ls"', 'scp file.txt user@host:/tmp/',
    'docker exec -it foo bash', 'docker run -d foo', 'docker compose up -d',
    'git commit -m "x"', 'git push', 'git merge main', 'git checkout -b feat/x',
    'psql -c "INSERT INTO foo VALUES (1)"', 'sed -i "s/a/b/" file.txt',
    'rm -rf /tmp/x', 'mv a.txt b.txt', 'cp a.txt b.txt',
    'curl -X POST https://x', 'curl --data "x=1" https://x',
  ];
  const BASH_SHOULD_NOT = [
    'ls -la', 'cat file.txt', 'git status', 'git diff', 'git log',
    'docker ps', 'docker logs foo', 'grep -r ssh src',
    'psql -c "SELECT * FROM foo"', 'curl https://x',
    // the override CLI invocation itself must never self-block (pitfall from
    // items 3.3/4.3: a bare `node <path>` must not match any classifier row).
    'node .claude/hooks/lib/execute-boundary-override.mjs --ok "founder said go"',
  ];

  let fail = 0;
  for (const c of BASH_SHOULD) {
    if (!isMutatingBash(c)) { fail++; console.error(`  FAIL (expected mutating):     ${c}`); }
  }
  for (const c of BASH_SHOULD_NOT) {
    if (isMutatingBash(c)) { fail++; console.error(`  FAIL (unexpected mutating):   ${c}`); }
  }

  // isMutatingToolCall — Edit/Write/MultiEdit always true; Bash delegates;
  // everything else (Read/Grep/fos_*) never counts.
  const TOOLCALL_CASES = [
    [['Edit', {}], true],
    [['Write', {}], true],
    [['MultiEdit', {}], true],
    [['Bash', { command: 'git commit -m x' }], true],
    [['Bash', { command: 'git status' }], false],
    [['Read', {}], false],
    [['Grep', {}], false],
    [['Glob', {}], false],
    [['mcp__engram__fos_memory', {}], false],
  ];
  for (const [[name, input], expected] of TOOLCALL_CASES) {
    const got = isMutatingToolCall(name, input);
    if (got !== expected) {
      fail++;
      console.error(`  FAIL isMutatingToolCall(${name}): expected ${expected}, got ${got}`);
    }
  }

  // isSubagentContext — the MEASURED agent_id discriminator, not env/transcript.
  const SUBAGENT_CASES = [
    [{ agent_id: 'sub-123', agent_type: 'backend-builder' }, true],
    [{ agent_id: '' }, true], // present-but-empty string still != null → counts as present
    [{}, false],
    [{ tool_name: 'Edit' }, false],
    [null, false],
  ];
  for (const [input, expected] of SUBAGENT_CASES) {
    const got = isSubagentContext(input);
    if (got !== expected) {
      fail++;
      console.error(`  FAIL isSubagentContext(${JSON.stringify(input)}): expected ${expected}, got ${got}`);
    }
  }

  // isOverrideCliInvocation — must catch a real run, not a mention.
  const OVERRIDE_CLI_CASES = [
    ['node .claude/hooks/lib/execute-boundary-override.mjs --ok "x"', true],
    ['node __HIVEMIND_HOME__/.claude/hooks/lib/execute-boundary-override.mjs --ok "x"', true],
    ['grep execute-boundary-override.mjs settings.json', false],
    ['cat .claude/hooks/lib/execute-boundary-override.mjs', false],
    ['git status', false],
  ];
  for (const [cmd, expected] of OVERRIDE_CLI_CASES) {
    const got = isOverrideCliInvocation(cmd);
    if (got !== expected) {
      fail++;
      console.error(`  FAIL isOverrideCliInvocation(${cmd}): expected ${expected}, got ${got}`);
    }
  }

  if (fail) { console.error(`selftest: ${fail} FAILED`); process.exit(1); }
  console.log(
    `selftest: OK (${BASH_SHOULD.length} mutating + ${BASH_SHOULD_NOT.length} silent bash, ` +
    `${TOOLCALL_CASES.length} tool-call + ${SUBAGENT_CASES.length} subagent + ` +
    `${OVERRIDE_CLI_CASES.length} override-cli cases)`
  );
  process.exit(0);
}

// Pure library by default (module.exports). Running it directly only runs
// the self-test — it is not a hook and has no stdin-driven main().
if (require.main !== module) {
  module.exports = {
    isMutatingBash, isMutatingToolCall, isSubagentContext, isOverrideCliInvocation,
    stateFile, THRESHOLD, STEP, CEILING,
  };
} else if (process.argv.includes('--selftest')) {
  selftest();
} else {
  console.log('execute-boundary-classifier.js is a library, not a hook. Run with --selftest.');
  process.exit(0);
}
