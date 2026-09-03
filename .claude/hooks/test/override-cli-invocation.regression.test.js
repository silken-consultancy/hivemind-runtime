// HiveMind — isOverrideCliInvocation false-positive regression test (item B1.8).
// .claude/hooks/test/override-cli-invocation.regression.test.js
//
// THE DEFECT (measured firsthand): the gate denies a subagent's Bash call that
// RUNS the override CLI. Detection used to exempt "mere mentions" by a
// ^-ANCHORED READONLY_LEAD (grep|cat|…) — so it only exempted when a read verb
// was the FIRST token of the WHOLE command. A compound read whose lead token
// was anything else — `cd <dir> && grep … override.mjs`, `A=1 grep … override.mjs`
// — lost the exemption and a plain read-only grep was DENIED as an invocation.
// (Observed live while doing this very retrofit: a read-only grep of the CLI
// was blocked.)
//
// THE FIX is a pure-read ALLOW-LIST: split on statement separators (not the
// pipe), then DENY any segment that NAMES the override path unless it is a
// provable pure read — no pipe / substitution / find -exec, and a read verb
// (grep|cat|…) as its lead word after stripping env-assignments and benign
// wrappers. This test is the two-sided regression guard: false-positive rows
// stay ALLOWED, and the false-NEGATIVE vectors (wrapper / shell -c /
// substitution / pipe / env-prefix) — the 🔴 a runtime-enumeration attempt let
// through — are DENIED.
//
// RED ON REVERT (both directions): restore the old ^-anchored READONLY_LEAD and
// the compound-read ALLOW rows flip to denied; swap in the runtime-enumeration
// variant and the WRAPPER_SUBST_PIPE_MUST_DENY rows flip to allowed. Either
// way the suite goes red.
//
// Run: node --test .claude/hooks/test/

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { isOverrideCliInvocation } =
  require(path.join(__dirname, '..', 'lib', 'execute-boundary-classifier.js'));

const isInvocation = (cmd) => isOverrideCliInvocation('Bash', { command: cmd });

// ── FALSE POSITIVES the old ^-anchored READONLY_LEAD wrongly denied. Each is a
// PURE read that only NAMES the path — no pipe, no substitution, lead word is a
// read verb. All must be ALLOWED (isOverrideCliInvocation === false). These are
// the cures the fix must PRESERVE.
const MENTION_NOT_INVOCATION = [
  // the actual measured shape: compound read whose lead token is `cd`.
  'cd repo && grep -n founder .claude/hooks/lib/execute-boundary-override.mjs',
  // env-assignment prefix shifts the lead token off the read verb.
  'A=1 grep -n founder execute-boundary-override.mjs',
  // benign wrapper before the read verb.
  'sudo grep -n founder .claude/hooks/lib/execute-boundary-override.mjs',
  // bare reads (these passed under the old logic too — kept as anchors).
  'grep execute-boundary-override.mjs settings.json',
  'cat .claude/hooks/lib/execute-boundary-override.mjs',
  'less .claude/hooks/lib/execute-boundary-override.mjs',
  // a head of the file behind a cd.
  'cd .claude/hooks/lib && head -20 execute-boundary-override.mjs',
  // reading the path in ONE segment while an unrelated command runs in another.
  'cat .claude/hooks/lib/execute-boundary-override.mjs; node scripts/build.js',
];

// ── REAL invocations — a command actually runs the CLI. All must be DENIED
// (isOverrideCliInvocation === true).
const REAL_INVOCATION = [
  'node .claude/hooks/lib/execute-boundary-override.mjs --ok "go"',
  'node __HIVEMIND_HOME__/.claude/hooks/lib/execute-boundary-override.mjs --ok "go"',
  // compound: a later segment runs it (fix must not become permissive).
  "cd repo && node .claude/hooks/lib/execute-boundary-override.mjs --ok 'go'",
  // absolute-path runtime.
  '/usr/bin/node .claude/hooks/lib/execute-boundary-override.mjs --ok "go"',
  // other JS runtimes.
  'npx .claude/hooks/lib/execute-boundary-override.mjs --ok "go"',
  'bun .claude/hooks/lib/execute-boundary-override.mjs --ok "go"',
  // direct shebang execution (the script itself is the command word).
  './.claude/hooks/lib/execute-boundary-override.mjs --ok "go"',
];

// ── NEGATIVE SPACE — the false-NEGATIVE vectors a runtime-enumeration attempt
// let through (the 🔴 security regression). The SOLE barrier against a subagent
// self-granting is this gate, so every one of these MUST be DENIED. Five were
// regressions vs the original READONLY_LEAD code; the substitution/backtick and
// pipe rows close pre-existing gaps too. This block is what proves RED against
// the loosened (runtime-enumeration) code.
const WRAPPER_SUBST_PIPE_MUST_DENY = [
  // shell -c wrappers.
  'bash -c "node .claude/hooks/lib/execute-boundary-override.mjs --ok x"',
  'sh -c "node .claude/hooks/lib/execute-boundary-override.mjs --ok x"',
  // command wrappers whose lead word is not a runtime.
  'timeout 10 node .claude/hooks/lib/execute-boundary-override.mjs --ok x',
  'stdbuf -oL node .claude/hooks/lib/execute-boundary-override.mjs --ok x',
  // env-prefix + wrapper combined.
  'A=1 timeout 5 node .claude/hooks/lib/execute-boundary-override.mjs --ok x',
  'env FOO=bar node .claude/hooks/lib/execute-boundary-override.mjs --ok "go"',
  // command substitution and backticks.
  'echo $(node .claude/hooks/lib/execute-boundary-override.mjs --ok x)',
  'echo `node .claude/hooks/lib/execute-boundary-override.mjs --ok x`',
  // pipe splitting the path away from the executor.
  'echo .claude/hooks/lib/execute-boundary-override.mjs | xargs node',
  'echo hi | node .claude/hooks/lib/execute-boundary-override.mjs --ok "go"',
  // find -exec running it.
  'find . -name x -exec node .claude/hooks/lib/execute-boundary-override.mjs --ok x \\;',
  // executor verbs that were mistakenly on the read allow-list: awk's system()
  // and GNU sed's `e` command shell out with no pipe/$()/backtick to catch.
  `awk 'BEGIN{system("node .claude/hooks/lib/execute-boundary-override.mjs --ok x --session S")}'`,
  "sed 'e node .claude/hooks/lib/execute-boundary-override.mjs --ok x' /dev/null",
  "sed -n '1e node .claude/hooks/lib/execute-boundary-override.mjs --ok x' /dev/null",
];

test('mentions of the override path are NOT invocations (B1.8 false-positive fix)', () => {
  for (const cmd of MENTION_NOT_INVOCATION) {
    assert.equal(isInvocation(cmd), false, `must be ALLOWED (pure read, not run): ${cmd}`);
  }
});

test('real override-CLI runs are still detected as invocations', () => {
  for (const cmd of REAL_INVOCATION) {
    assert.equal(isInvocation(cmd), true, `must be DENIED (real invocation): ${cmd}`);
  }
});

test('wrapper / shell -c / substitution / pipe / env-prefix runs are DENIED (false-negative closure)', () => {
  for (const cmd of WRAPPER_SUBST_PIPE_MUST_DENY) {
    assert.equal(isInvocation(cmd), true, `must be DENIED (executes via wrapper/subst/pipe): ${cmd}`);
  }
});

test('non-Bash tool is never an invocation, even when the path matches', () => {
  assert.equal(
    isOverrideCliInvocation('Edit', { command: '.claude/hooks/lib/execute-boundary-override.mjs' }),
    false,
  );
  assert.equal(
    isOverrideCliInvocation('Write', { file_path: '.claude/hooks/lib/execute-boundary-override.mjs' }),
    false,
  );
});

test('a command with no reference to the override path is never an invocation', () => {
  assert.equal(isInvocation('git status'), false);
  assert.equal(isInvocation('node scripts/build.js'), false);
});
