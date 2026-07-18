// HiveMind — build/long-op foreground nudge — PreToolUse hook (matcher: Bash)
// pre-tool-use.build-nudge.js
//
// Triggered by: PreToolUse, matcher "Bash" (see .claude/settings.json).
//
// PURPOSE:
//   The count-based dispatch-nudge (post-tool-use.dispatch-nudge.js) catches the
//   "many small hands-on commands" slide. It does NOT catch the OTHER foreground
//   trap: a SINGLE long build/test command run in the foreground (tsc, prisma
//   generate, docker build, a test suite) that freezes the session for minutes
//   while the model waits. This hook is the TYPE-based complement: it looks at
//   the COMMAND TYPE (not a running count) and, before a build/long-op runs in
//   the foreground, emits a non-blocking advisory to re-run it in the background.
//
// FOUNDER CALIBRATION — NUDGE, NOT A GATE:
//   This NEVER blocks, denies, or delays the command. It is a pure advisory:
//   permissionDecision is ALWAYS "allow"; the command runs regardless; the model
//   decides whether to heed it. No exit 2, ever. Caging is explicitly rejected.
//
// THE RULE:
//   - Build/test/long-op class command + NOT already run_in_background
//       → emit a non-blocking nudge (the model sees it via additionalContext).
//   - Already run_in_background: true            → silent pass (discipline met).
//   - Anything else (read-only, short one-offs, ambiguous) → silent no-op.
//   - CONSERVATIVE by design: ambiguous → do NOT nudge (noise > a missed nudge).
//
// WHY additionalContext (and not stderr):
//   On a PreToolUse hook that exits 0, plain stderr/stdout does NOT reach the
//   model — it only lands in the transcript as a hook line. The channel the model
//   actually reads, non-blockingly, is hookSpecificOutput.additionalContext with
//   permissionDecision "allow". So the nudge is emitted there (and mirrored to
//   stderr for transcript/debug visibility). This is a non-blocking nudge, not a
//   gate — exactly the founder calibration.
//
// SUB-AGENTS DO NOT NUDGE (only the main loop freezes the user's session):
//   inside a sub-agent the work is ALREADY dispatched, so a background nudge would
//   be noise. Detected best-effort via env/transcript; on detection → silent pass.
//
// MANDATORY DISCIPLINES (ABSOLUTE fail-open):
//   - Any error (parse, missing field) → exit 0, allow, NEVER blocks the command.
//   - NEVER calls MCP or the network. Stateless. Reads stdin, writes stdout/stderr.
//   - Not a log-everything: a non-build command → silent no-op (no output at all).
//
// Input (stdin): PreToolUse event JSON —
//   { tool_name, tool_input: { command, run_in_background?, ... }, transcript_path?, ... }

'use strict';

const fs = require('node:fs');

// ─── classifier: buildClassLabel(cmd) ───────────────────────────────────────────
//
// LIST-AS-DATA classifier — each row is { label, re }. A command is "build/long
// op" class if ANY row's regex matches. Deliberately CONSERVATIVE: it only names
// well-known build/test/compile/image operations; ambiguous or short one-offs do
// NOT match (a false nudge is worse than a missed one). Extending it = add a row.
//
// COMMAND-POSITION ANCHORING (false-positive fix): a build verb only counts when
// it sits at COMMAND POSITION — the start of the command, or right after a shell
// separator ( ; | & && || ( or a newline ) — optionally behind a package runner
// (npx/bunx/pnpm dlx/…). This is what stops build words appearing as ARGUMENTS
// from tripping the nudge: `grep tsc`, `echo 'npm run build'`, `cat x | grep tsc`,
// `grep -E 'tsc|prisma|npm'` are searches OVER those words, not runs OF them.
// (A plain space is NOT a separator here — only ; | & ( newline — precisely so an
// argument after a space does not read as a new command.)
//
// Compound commands (`cd x && npm run build`, `docker build … && …`) still match:
// the segment after `&&` is at command position. It is pure STRING analysis (runs
// nothing). Exported so a dogfood/test reuses EXACTLY this logic.

// Start-of-command anchor: line start, or immediately after a shell separator.
const CMD_POS = '(?:^|[|&;\\n(])\\s*';
// Optional package-runner prefix (npx prisma generate, bunx tsc, pnpm dlx …).
const RUNNER = '(?:(?:npx|bunx|pnpm\\s+dlx|pnpm\\s+exec|yarn\\s+dlx|bun\\s+x)\\s+)?';
// Build a command-position-anchored, case-insensitive matcher from a verb body.
const at = (body) => new RegExp(CMD_POS + RUNNER + body, 'i');

// Belt-and-suspenders: if the WHOLE command's leading token is a read-only wrapper,
// never classify build-class, regardless of build words in its arguments. This
// backstops the anchor for the pipe case (`grep -E 'tsc|npm install'` — where a
// `|` inside the quoted pattern would otherwise read as a command separator).
const READONLY_LEAD = /^\s*(grep|rg|ag|cat|echo|ls|head|tail|less|awk|sed|find)\b/;

const BUILD_CLASSIFIERS = [
  // Node package managers — install / ci (dependency resolution: usually long).
  { label: 'pkg-install', re: at('(npm|pnpm|yarn)\\s+(install|ci)\\b') },
  // Node package managers — build / test (with or without an explicit `run`).
  { label: 'pkg-build-test', re: at('(npm|pnpm|yarn|bun)\\s+(run\\s+)?(build|test)\\b') },
  // TypeScript compile (a bare `tsc`); --version/-v/--help/--init do NOT count.
  { label: 'tsc', re: at('tsc\\b(?!\\s+(--version|-v|--help|-h|--init)\\b)') },
  // Prisma schema ops — generate / migrate / db push (codegen + DB work).
  { label: 'prisma', re: at('prisma\\s+(generate|migrate|db\\s+push)\\b') },
  // Test runners invoked directly.
  { label: 'test-runner', re: at('(jest|vitest)\\b') },
  { label: 'e2e-runner', re: at('(playwright|cypress)\\s+(test|run|open)\\b') },
  // Python test runners — pytest / python -m pytest|unittest / tox.
  { label: 'pytest', re: at('(pytest|python3?\\s+-m\\s+(pytest|unittest)|tox)\\b') },
  // Container image builds (build / buildx / compose build). ps/logs/exec are not
  // here — those are handled by the count-based dispatch-nudge, not this hook.
  { label: 'docker-build', re: at('docker\\s+(build|buildx\\b|compose\\s+build)\\b') },
  // Make targets (command-position anchored so `cmake`/substrings do not match).
  { label: 'make', re: at('make\\b(?!\\s+(--version|-v)\\b)') },
  // Rust / Go / JVM build+test toolchains.
  { label: 'cargo', re: at('cargo\\s+(build|test|check|bench)\\b') },
  { label: 'go-build', re: at('go\\s+(build|test)\\b') },
  { label: 'jvm-build', re: at('(\\./gradlew|gradle|mvn)\\b(?!\\s+(--version|-v)\\b)') },
  // Web bundlers / framework build steps.
  { label: 'bundler-build', re: at('(webpack|vite|next|nuxt|turbo|ng|rollup|esbuild)\\s+build\\b') },
];

function buildClassLabel(rawCmd) {
  let cmd = String(rawCmd || '');
  if (!cmd.trim()) return null;
  // Strip leading env-var assignments (`NODE_ENV=production npm run build`,
  // `FOO=bar npm test`) so the real verb lands at command position — otherwise the
  // `VAR=val ` prefix defeats the CMD_POS anchor. Re-check the read-only-wrapper
  // guard AFTER stripping (so `FOO=bar grep tsc` still stays silent).
  cmd = cmd.replace(/^\s*(\w+=\S+\s+)+/, '');
  if (!cmd.trim()) return null;
  // Belt-and-suspenders: a read-only wrapper as the leading token never counts.
  if (READONLY_LEAD.test(cmd)) return null;
  for (const { label, re } of BUILD_CLASSIFIERS) {
    if (re.test(cmd)) return label;
  }
  return null;
}

// ─── self-test (node pre-tool-use.build-nudge.js --selftest) ──────────────────────
// Asserts the classifier: build-class commands match, and the false-positive cases
// (build verbs as ARGUMENTS to a read-only command) do NOT. Run in DoD/CI.
function selftest() {
  const SHOULD = [
    'tsc', 'tsc -p .', 'npm install', 'pnpm install', 'npm run build',
    'npm test', 'prisma generate', 'npx prisma generate', 'prisma migrate deploy',
    'docker build -t x .', 'vitest run', 'make all', 'cargo test',
    'playwright test', 'cd web && npm run build', 'foo; npm install',
    // env-prefixed builds (leading VAR=val must not defeat the anchor)
    'NODE_ENV=production npm run build', 'FOO=bar npm test',
    'NODE_ENV=test FOO=1 npx vitest run',
    // python test runners
    'pytest', 'pytest -q tests/', 'python -m pytest', 'python3 -m unittest', 'tox',
    // npx-fronted tools
    'npx tsc', 'npx playwright test',
  ];
  const SHOULD_NOT = [
    "grep 'tsc'", "echo 'npm run build'", "cat x | grep tsc",
    "grep -E 'tsc|prisma|npm'", 'grep -r prisma src', 'ls tsc-out',
    'cat package.json', 'git status', 'tsc --version', 'echo cmake build',
    // --version nits must stay silent
    'mvn --version', 'gradle --version',
    // env-strip must NOT re-open the read-only-wrapper false positives
    'FOO=bar grep tsc',
  ];
  let fail = 0;
  for (const c of SHOULD) {
    if (!buildClassLabel(c)) { fail++; console.error(`  FAIL (expected nudge):    ${c}`); }
  }
  for (const c of SHOULD_NOT) {
    const l = buildClassLabel(c);
    if (l) { fail++; console.error(`  FAIL (unexpected nudge=${l}): ${c}`); }
  }
  if (fail) { console.error(`selftest: ${fail} FAILED`); process.exit(1); }
  console.log(`selftest: OK (${SHOULD.length} nudge + ${SHOULD_NOT.length} silent)`);
  process.exit(0);
}

// Exported for the dogfood/test. When require()d, the hook body does NOT run.
if (require.main !== module) {
  module.exports = { buildClassLabel, BUILD_CLASSIFIERS, READONLY_LEAD };
} else if (process.argv.includes('--selftest')) {
  selftest();
} else {
  main();
}

// ─── hook body ──────────────────────────────────────────────────────────────────

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0); // fail-open: cannot parse → allow, no output
  }

  try {
    const toolName = (input.tool_name || '').toLowerCase();
    if (toolName !== 'bash') process.exit(0);

    const ti = input.tool_input || {};
    const cmd = ti.command || '';

    // Already background → the discipline is met, silent pass. `run_in_background`
    // is present in tool_input ONLY when the model set it; absent === foreground
    // (Bash default), which is exactly the case we may nudge.
    if (ti.run_in_background === true) process.exit(0);

    // A sub-agent already IS the dispatch — a background nudge would be noise.
    if (isSubagentContext(input)) process.exit(0);

    const label = buildClassLabel(cmd);
    if (!label) process.exit(0); // not build-class → silent no-op

    emitNudge(label);
  } catch (err) {
    // Fail-open: any unexpected error must never block the command.
    process.stderr.write(`[build-nudge] WARN: ${err.message}\n`);
  }

  process.exit(0);
}

// ─── subagent detection (best-effort) ────────────────────────────────────────────

function isSubagentContext(input) {
  if (process.env.CLAUDE_AGENT_NAME) return true;
  const tp = String(input.transcript_path || '');
  if (/[\\/]subagents[\\/]/.test(tp)) return true;
  return false;
}

// ─── nudge ────────────────────────────────────────────────────────────────────

function emitNudge(label) {
  const advisory =
    'This looks like a build/long operation running in the foreground ' +
    `(${label}). The discipline is non-blocking — consider re-running with ` +
    'run_in_background: true and staying responsive, unless it truly finishes ' +
    'in seconds. Non-blocking nudge — you decide; the command runs either way.';

  // Primary channel: additionalContext, which the model actually reads on
  // PreToolUse. permissionDecision "allow" = never blocks (NUDGE, not a gate).
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: advisory,
    },
  };
  process.stdout.write(JSON.stringify(out) + '\n');

  // Mirror to stderr for transcript/debug visibility (does not reach the model).
  process.stderr.write(`[build-nudge] ${advisory}\n`);
}
