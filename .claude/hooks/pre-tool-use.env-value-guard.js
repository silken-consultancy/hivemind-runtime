// HiveMind — env-value guard — PreToolUse hook (matcher: Bash)
// pre-tool-use.env-value-guard.js
//
// PURPOSE:
//   Refuse a Bash command that would print environment VALUES (secrets) into
//   the transcript: `docker inspect` without a names-only --format, bare
//   env / printenv / export -p / set, cat/head/sed/awk/... of an env file,
//   grep of an env file (except -c / -l / -L / -q), recursive grep for a
//   secret-like word, `docker exec <c> env`, `docker compose config`, echo of a
//   secret-like variable, inline code dumping the environment, git show/diff of
//   an env file, `cat /proc/*/environ`. The deny reason gives names-only
//   alternatives (and ops/env-names.sh where the project ships it).
//
//   The served discipline is the floor; this hook is the net behind it.
//
// SCOPE: every seat, subagents included — they run these commands too. The
//   command string is inspected as a whole, so the forms wrapped in
//   ssh '<cmd>', bash -c, a heredoc piped to ssh or docker exec <c> ... are
//   caught the same way as the local ones. The detection lives in
//   lib/env-value-classifier.js.
//
// DISCIPLINES:
//   - Ambiguous command → refuse with the reason (this domain fails closed).
//   - Unparseable hook input or an internal error → allow (a bug in this hook
//     must never wedge every Bash call).
//   - Emits through lib/emit-context (additionalContext + the deny decision).
//   - Stateless; never calls MCP or the network.
//
// Input (stdin): PreToolUse event JSON — { tool_name, tool_input: { command }, ... }

'use strict';

const fs = require('node:fs');
const { findEnvValueLeak, GUIDANCE } = require('./lib/env-value-classifier');
const { emitPreToolUseDeny } = require('./lib/emit-context');

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }
  try {
    if (String(input.tool_name || '').toLowerCase() !== 'bash') process.exit(0);
    const command = (input.tool_input && input.tool_input.command) || '';
    const leak = findEnvValueLeak(command);
    if (!leak) process.exit(0);
    emitPreToolUseDeny(`Refused: ${leak.reason}. ${GUIDANCE}`);
  } catch (err) {
    process.stderr.write(`[env-value-guard] WARN: ${err.message}\n`);
  }
  process.exit(0);
}

if (require.main === module) main();
