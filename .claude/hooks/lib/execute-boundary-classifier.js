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
//   below was originally moved here verbatim; isMutatingToolCall() is the
//   entry point that also counts Edit/Write/MultiEdit unconditionally.
//
// WIDENED AGAIN (2026-08-27, MEASURED counted-set hole): isMutatingBash() was
// pattern-matching the command string for known mutating SHAPES (ssh/scp/
// docker/git/psql/sed -i/rm-mv-cp/curl) but had NO rule at all for plain file
// writes — `>`/`>>` redirection, `tee`, or an interpreter (python/node/perl/
// ruby) writing a file from inline code or a heredoc. Measured firsthand this
// session: seven real file mutations via `python3 - <<'EOF' ...
// open(p,'w').write(...) ... EOF` heredocs went uncounted while a `sed -i` in
// the same turn counted correctly. See the bias note above isMutatingBash's
// definition for why the added rules deliberately invert the function's
// original noise-conservative default.
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
//
// BIAS RE-EXAMINED (2026-08-27, MEASURED — not theoretical): that "when in
// doubt, don't count" bias was written against NOISE (an over-eager gate
// nagging on harmless reads). It was never examined against the failure this
// session actually measured firsthand: seven real source-file mutations in
// one turn — via `python3 - <<'EOF' ... open(p,'w').write(...) ... EOF`
// heredocs — landed ZERO counted hits, while a single `sed -i` in the same
// turn correctly counted as 1. The gate is a COUNTED ceiling (CEILING=15);
// an uncounted mutation doesn't just under-report, it silently VOIDS the
// gate for exactly the shapes most likely to be used, because this harness's
// own guidance tells the operator to prefer Bash/heredocs over Edit/Write.
// That is under-counting, not noise, and under-counting a security-relevant
// counter is strictly worse than over-counting one (a false nudge costs a
// dispatch; a missed one costs the whole boundary). So for the WRITE-SHAPED
// rules added below (redirection, tee, interpreter-inline-code/heredoc,
// truncate/dd/install) the bias is DELIBERATELY INVERTED: when a command
// plausibly writes a file, COUNT it, even at the cost of occasional
// over-counting (e.g. a literal `>` inside a quoted string this classifier
// can't fully parse). The pre-existing rules above (ssh/scp/docker/git/
// psql/sed -i/rm-mv-cp/curl) are UNCHANGED and keep their original
// noise-conservative bias — only the new write-shaped rules invert it.
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

  // ── WRITE-SHAPED RULES (2026-08-27, item: execute-boundary counted-set
  // hole) — bias INVERTED here vs. the rules above (see header note): count
  // when a command PLAUSIBLY writes a file, accepting some over-counting.

  // Shell redirection to a file: `>` / `>>` used as an actual redirect
  // operator. Excludes stderr-merge forms (`2>&1`, `&>`, `>&2`) and
  // /dev/null sinks — those don't write a real file. Known limitation
  // (accepted, not "fixed" — see bias note): a literal `>` inside a quoted
  // string or a `[[ a > b ]]` comparison is not distinguished from a real
  // redirect and WILL over-count; that's the accepted tradeoff for closing
  // the under-counting hole.
  if (/(?<![\d&>])>{1,2}(?!&|\s*\/dev\/null\b)/.test(cmd)) return true;

  // tee — writes stdin to a file (with or without -a/--append).
  if (/\btee\b/.test(cmd)) return true;

  // Interpreter invoked with inline code or fed via stdin/heredoc:
  // python/python3/node/perl/ruby with -c/-e, a bare trailing `-` (read
  // script from stdin), or any heredoc (`<<`) in the command line. This is
  // the exact shape measured this session (`python3 - <<'EOF' ...
  // open(p,'w').write(...) ... EOF`) — the file write happens INSIDE the
  // interpreted script, invisible to any redirect-based rule.
  if (/\b(python3?|node|perl|ruby)\b/.test(cmd) &&
      (/(^|\s)-[ce](\s|$)/.test(cmd) ||
       /(^|\s)-(\s|$)/.test(cmd) ||
       /<<[-~]?\s*['"]?\w+/.test(cmd))) return true;

  // truncate / dd with an output file / install — direct file-write utilities.
  if (/\btruncate\b/.test(cmd)) return true;
  if (/\bdd\b/.test(cmd) && /\bof=/.test(cmd)) return true;
  if (/\binstall\b/.test(cmd)) return true;

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

// ─── isOverrideCliInvocation(toolName, toolInput) — closes the gap the measurement found ──
//
// lib/execute-boundary-override.mjs's own CLAUDE_AGENT_NAME refusal is
// UNRELIABLE for subagents (env is empty for them — see isSubagentContext
// above). The REAL protection lives at the GATE: it denies a subagent's Bash
// call outright when that call would run the override CLI, using the
// reliable agent_id signal instead. The CLAUDE_AGENT_NAME check inside
// override.mjs remains as belt-and-suspenders (harmless, just not sufficient
// alone). READONLY_LEAD guards against a false deny on a command that only
// MENTIONS the file (grep/cat of the script), not one that RUNS it.
//
// ARITY — reconciled 2026-08-27 (item A2.3, follow-up to 5.1): this used to
// take a single `rawCmd` string, with the caller (the gate) responsible for
// checking `toolName === 'Bash'` first. The lab twin
// (kernel/hooks/lib/execute-boundary-classifier.js) always took
// `(toolName, toolInput)` and did the Bash-check internally — the same shape
// every other exported classifier here uses (isMutatingToolCall). Reconciled
// to that 2-arg shape so both twins now have an IDENTICAL signature and an
// IDENTICAL call-site pattern (`isOverrideCliInvocation(toolName, toolInput)`)
// — a future arity drift is caught by the parity guard
// (kernel/hooks/.test-fixtures/execute-boundary-parity.js, Function.length
// check). This is a calling-convention fix ONLY — the classification RESULT
// for every existing input is unchanged (verify: for a Bash command string
// `cmd`, old `isOverrideCliInvocation(cmd)` === new
// `isOverrideCliInvocation('Bash', {command: cmd})`; any non-Bash tool now
// correctly returns false, which the old signature could never even express).
//
// DELIBERATE, DOCUMENTED DIVERGENCE FROM THE LAB TWIN (kept, not "fixed"
// here — SENSITIVITY: do not change enforcement behavior, contract_ship §5):
// READONLY_LEAD is PRODUCT-ONLY. The lab's isOverrideCliInvocation has no
// such exemption — a subagent Bash call that only MENTIONS the override CLI
// (e.g. `grep execute-boundary-override.mjs settings.json`) is DENIED on the
// lab side, ALLOWED on the product side. Pinned explicitly by the parity
// guard's DOCUMENTED_DIVERGENCES table so this doesn't silently drift further
// (either side "fixed" without the guard being updated) — see the guard file
// for the recorded rationale.
const READONLY_LEAD = /^\s*(grep|rg|ag|cat|echo|ls|head|tail|less|awk|sed|find)\b/;
function isOverrideCliInvocation(toolName, toolInput) {
  if (String(toolName || '') !== 'Bash') return false;
  const cmd = String((toolInput && toolInput.command) || '');
  if (!/execute-boundary-override\.mjs/.test(cmd)) return false;
  if (READONLY_LEAD.test(cmd)) return false; // mentions it, doesn't run it — PRODUCT-ONLY, see above
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
    // ── write-shaped rules (2026-08-27, MEASURED counted-set hole) — each of
    // these 4 is a real command shape from the session that measured the
    // hole first-hand.
    "python3 - <<'EOF'\np='x.ts'\nopen(p,'w').write(s)\nEOF",
    'echo "x" > file.txt',
    'cat file | tee out.txt',
    `node -e "require('fs').writeFileSync('a','b')"`,
    // ── PORTED (item B1.10 — single-harness port of the retired
    // kernel/hooks/.test-fixtures/execute-boundary-parity.js §5, whose
    // comparative corpus never exercised -c/truncate/dd/install or >>): the
    // rest of the counted-set's write shapes, so this selftest — the only
    // place isMutatingBash is exercised now that the second harness is
    // gone — actually covers the FULL rule set, not just the 4 shapes that
    // motivated the widening.
    'python3 -c "print(1)"',
    'echo "x" >> file.txt',
    'truncate -s 0 file.txt',
    'dd if=/dev/zero of=file.txt bs=1M count=1',
    'install -m 644 file.txt /usr/local/bin/thing',
  ];
  const BASH_SHOULD_NOT = [
    'ls -la', 'cat file.txt', 'git status', 'git diff', 'git log',
    'docker ps', 'docker logs foo', 'grep -r ssh src',
    'psql -c "SELECT * FROM foo"', 'curl https://x',
    // the override CLI invocation itself must never self-block (pitfall from
    // items 3.3/4.3: a bare `node <path>` must not match any classifier row).
    'node .claude/hooks/lib/execute-boundary-override.mjs --ok "founder said go"',
    // ── noise guards for the write-shaped rules above — must NOT count.
    'grep -rn "foo" src/ 2>/dev/null',
    'ls -la > /dev/null',
    'git status --short',
    'cat file.txt',
    // ── PORTED (item B1.10, §5): stderr-merge (2>&1) must NOT be mistaken
    // for a file-write redirect — the digit-lookbehind exclusion in the `>`
    // rule was previously untested by this selftest (only the /dev/null
    // exclusion above was covered).
    'echo hi 2>&1',
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

  // isOverrideCliInvocation(toolName, toolInput) — must catch a real Bash run,
  // not a mention, and must not fire for a non-Bash tool (arity reconciled
  // 2026-08-27, item A2.3 — see the function's header comment).
  //
  // This table already carries the substance of §3 (isOverrideCliInvocation
  // behavior parity) from the retired kernel/hooks/.test-fixtures/
  // execute-boundary-parity.js — the real-invocation vs. mere-mention
  // (READONLY_LEAD) distinction below, product-only, is that guard's
  // DOCUMENTED_DIVERGENCES case with the lab side dropped (item B1.10: no
  // lab twin left to diverge from — this repo's own behavior is now the
  // whole contract). No new cases were needed here.
  const OVERRIDE_CLI_CASES = [
    ['Bash', 'node .claude/hooks/lib/execute-boundary-override.mjs --ok "x"', true],
    ['Bash', 'node __HIVEMIND_HOME__/.claude/hooks/lib/execute-boundary-override.mjs --ok "x"', true],
    ['Bash', 'grep execute-boundary-override.mjs settings.json', false],
    ['Bash', 'cat .claude/hooks/lib/execute-boundary-override.mjs', false],
    ['Bash', 'git status', false],
    // non-Bash tool never counts, even if the path matches (only the 2-arg
    // shape can express this — the old 1-arg shape had no toolName to check).
    ['Edit', '.claude/hooks/lib/execute-boundary-override.mjs', false],
  ];
  for (const [toolName, cmd, expected] of OVERRIDE_CLI_CASES) {
    const got = isOverrideCliInvocation(toolName, { command: cmd, file_path: cmd });
    if (got !== expected) {
      fail++;
      console.error(`  FAIL isOverrideCliInvocation(${toolName}, ${cmd}): expected ${expected}, got ${got}`);
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
