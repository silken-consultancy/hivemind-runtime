// hivemind-cli.test.ts — unit tests for the bash client's auto-heal and
// endpoint-probe helpers (bin/hivemind).
//
// WHY A TS TEST FOR A BASH FILE: `bun test` is the only runner in this repo, so
// a bash-only harness would simply never be run. Each case writes a small
// script that SOURCES bin/hivemind and calls one function directly.
//
// HOW THE SOURCE IS MADE SAFE: bin/hivemind ends in a `case "${1:-}"` dispatch
// that would run cmd_open (spawning a daemon and exec'ing claude) on a plain
// `source`. Everything from the "Entry point" banner down is stripped first, so
// only the function definitions are loaded.
//
// SANDBOX SAFETY: $HOME and $HIVEMIND_HOME are redirected into an ephemeral tmp
// dir, so RUNTIME_BIN / the pidfiles / CERT_DIR all resolve there and never
// touch a real install. NOTHING here binds a port: the stand-in daemons are
// `bun run <sleeper>.ts`, which is a faithful command line for the identity
// guard under test while listening on nothing. The endpoint tests shadow `curl`
// with a shell function, so they make no network call at all.
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const HIVEMIND_BIN = join(import.meta.dir, '..', '..', 'bin', 'hivemind');
const testRoot = mkdtempSync(join(tmpdir(), 'hivemind-cli-'));

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// A stand-in daemon: real `bun run <file>`, so its command line carries the
// absolute RUNTIME_BIN path exactly as the shipped daemon's does — which is
// what _pid_is_hivemind_runtime greps for. Sleeps, binds nothing, and is
// bounded so a crashed test cannot leave a process around for long.
function installFakeRuntime(home: string): string {
  const runtimeBin = join(home, 'runtime', 'src', 'server.ts');
  mkdirSync(dirname(runtimeBin), { recursive: true });
  writeFileSync(runtimeBin, 'await new Promise((r) => setTimeout(r, 30000));\n');
  return runtimeBin;
}

// Runs one case. The preamble strips the entry point, sources the rest, and
// defines the tiny assert helper the case bodies report through.
function sh(name: string, body: string): string {
  const caseDir = join(testRoot, name);
  mkdirSync(caseDir, { recursive: true });
  const scriptPath = join(caseDir, 'case.sh');
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
export HOME="${caseDir}/home"
export HIVEMIND_HOME="${caseDir}/home/.hivemind"
# Isolate from whatever the invoking shell happens to export — notably
# MTLS_PROXY_PORT, which a real \`hivemind\` session (like the one this repo's
# own dev box may be running under) sets to its OWN proxy port. Without this,
# bin/hivemind's top-level \`PROXY_PORT="\${MTLS_PROXY_PORT:-7779}"\` silently
# picks up the invoking shell's port instead of the deterministic 7779
# default every case here assumes (measured: this exact leak flipped
# 7779→7879 depending on which shell ran \`bun test\`).
unset MTLS_PROXY_PORT
mkdir -p "\$HOME"
sed '/^# ── Entry point/,$d' "${HIVEMIND_BIN}" > "${caseDir}/lib.sh"
# shellcheck disable=SC1090
source "${caseDir}/lib.sh"

_assert() { if [ "\$2" = "\$3" ]; then echo "ok \$1"; else echo "not ok \$1 — want='\$3' got='\$2'"; fi; }
_alive()  { if kill -0 "\$1" 2>/dev/null; then echo alive; else echo dead; fi; }

${body}
`,
  );
  const res = Bun.spawnSync(['bash', scriptPath], { stdout: 'pipe', stderr: 'pipe' });
  const out = res.stdout.toString();
  // Surface stderr on failure — the sourced script runs under `set -euo
  // pipefail`, so an unexpected abort shows up here rather than as a silent
  // missing assertion.
  if (!out.includes('ok ')) {
    throw new Error(`case '${name}' produced no assertions.\nstdout:\n${out}\nstderr:\n${res.stderr.toString()}`);
  }
  return out;
}

// caseHome/caseClaudeConfig — the exact paths `sh()`'s preamble exports as
// $HOME/$HIVEMIND_HOME for a given case name, so a test can read back files a
// case script wrote without threading them through `_assert`/stdout.
function caseHome(name: string): string {
  return join(testRoot, name, 'home');
}
function caseClaudeConfig(name: string): string {
  return join(caseHome(name), '.hivemind', '.claude', '.claude.json');
}

// Runs a case script WITHOUT requiring an `_assert` line in its output (some
// of the _seed_engram_mcp_config cases below assert on the written JSON file
// directly, in TS, rather than via the bash `_assert` helper). Surfaces
// stderr on a non-zero exit so a `set -euo pipefail` abort is visible.
function shRaw(name: string, body: string): void {
  const caseDir = join(testRoot, name);
  mkdirSync(caseDir, { recursive: true });
  const scriptPath = join(caseDir, 'case.sh');
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
export HOME="${caseDir}/home"
export HIVEMIND_HOME="${caseDir}/home/.hivemind"
# See sh()'s matching comment: isolate PROXY_PORT from whatever
# MTLS_PROXY_PORT the invoking shell happens to export.
unset MTLS_PROXY_PORT
mkdir -p "\$HOME"
sed '/^# ── Entry point/,$d' "${HIVEMIND_BIN}" > "${caseDir}/lib.sh"
# shellcheck disable=SC1090
source "${caseDir}/lib.sh"

${body}
`,
  );
  const res = Bun.spawnSync(['bash', scriptPath], { stdout: 'pipe', stderr: 'pipe' });
  if (res.exitCode !== 0) {
    throw new Error(`case '${name}' exited ${res.exitCode}.\nstdout:\n${res.stdout.toString()}\nstderr:\n${res.stderr.toString()}`);
  }
}

// ── Fix 1: stale-runtime auto-reap ───────────────────────────────────────────

test('_reap_stale_runtime reaps a leftover --setup-only daemon recorded in SETUP_PID_FILE', () => {
  // THE REGRESSION TEST for the reported bug: enrollment leaves a setup daemon
  // holding RUNTIME_PORT (setup-only mode never starts the mTLS proxy), so the
  // next `hivemind` sees "runtime up, proxy dead" and auto-heals — but the reap
  // used to look ONLY at RUNTIME_PID_FILE, found nothing, and the fresh spawn
  // then died on EADDRINUSE. The user's only way out was a manual stop+start.
  const out = sh('setup-pidfile', `
mkdir -p "\$(dirname "\${RUNTIME_BIN}")"
printf 'await new Promise((r) => setTimeout(r, 30000));\\n' > "\${RUNTIME_BIN}"
mkdir -p "\$(dirname "\${SETUP_PID_FILE}")"
bun run "\${RUNTIME_BIN}" --setup-only > /dev/null 2>&1 &
_pid=\$!
echo "\${_pid}" > "\${SETUP_PID_FILE}"
sleep 1
_assert daemon-was-running "\$(_alive "\${_pid}")" alive

_reap_stale_runtime

_assert daemon-reaped "\$(_alive "\${_pid}")" dead
_assert setup-pidfile-cleared "\$([ -f "\${SETUP_PID_FILE}" ] && echo present || echo absent)" absent
`);
  expect(out).toContain('ok daemon-was-running');
  expect(out).toContain('ok daemon-reaped');
  expect(out).toContain('ok setup-pidfile-cleared');
  expect(out).not.toContain('not ok');
});

test('_reap_stale_runtime reaps an orphan runtime that NO pidfile records', () => {
  // A daemon whose pidfile was never written (_spawn_runtime writes it only
  // after healthz answers) or was already removed is invisible to both the
  // pidfile reap and `hivemind stop`, yet still holds the port.
  const out = sh('orphan-no-pidfile', `
mkdir -p "\$(dirname "\${RUNTIME_BIN}")"
printf 'await new Promise((r) => setTimeout(r, 30000));\\n' > "\${RUNTIME_BIN}"
bun run "\${RUNTIME_BIN}" > /dev/null 2>&1 &
_pid=\$!
sleep 1
_assert orphan-was-running "\$(_alive "\${_pid}")" alive
_assert no-pidfile-exists "\$([ -f "\${RUNTIME_PID_FILE}" ] && echo present || echo absent)" absent

_reap_stale_runtime

_assert orphan-reaped "\$(_alive "\${_pid}")" dead
`);
  expect(out).toContain('ok orphan-reaped');
  expect(out).not.toContain('not ok');
});

test('_reap_stale_runtime NEVER kills a foreign PID from a stale pidfile — it only clears the pidfile', () => {
  // Fail-safe preserved: after a crash the OS may recycle the recorded PID for
  // an unrelated process. Killing it would be a far worse bug than the one the
  // auto-heal fixes.
  const out = sh('foreign-pid', `
mkdir -p "\$(dirname "\${RUNTIME_BIN}")" "\$(dirname "\${RUNTIME_PID_FILE}")"
printf 'await new Promise((r) => setTimeout(r, 30000));\\n' > "\${RUNTIME_BIN}"
sleep 30 &
_pid=\$!
echo "\${_pid}" > "\${RUNTIME_PID_FILE}"

_reap_stale_runtime

_assert foreign-pid-survived "\$(_alive "\${_pid}")" alive
_assert stale-pidfile-cleared "\$([ -f "\${RUNTIME_PID_FILE}" ] && echo present || echo absent)" absent
kill "\${_pid}" 2>/dev/null || true
`);
  expect(out).toContain('ok foreign-pid-survived');
  expect(out).toContain('ok stale-pidfile-cleared');
  expect(out).not.toContain('not ok');
});

test('the orphan sweep is scoped by identity, not by port — another install\'s runtime is untouched', () => {
  // RUNTIME_BIN is derived from HIVEMIND_HOME, and selection matches that full
  // absolute path. This is what makes it safe to sweep on a developer box,
  // where an unrelated agent-runtime routinely holds the very same default
  // port — a port-based reap would kill it.
  const out = sh('other-install', `
mkdir -p "\$(dirname "\${RUNTIME_BIN}")"
printf 'await new Promise((r) => setTimeout(r, 30000));\\n' > "\${RUNTIME_BIN}"
_other_bin="\${HOME}/.other-install/runtime/src/server.ts"
mkdir -p "\$(dirname "\${_other_bin}")"
printf 'await new Promise((r) => setTimeout(r, 30000));\\n' > "\${_other_bin}"
bun run "\${_other_bin}" > /dev/null 2>&1 &
_other_pid=\$!
sleep 1
_assert other-was-running "\$(_alive "\${_other_pid}")" alive

_reap_stale_runtime

_assert other-install-untouched "\$(_alive "\${_other_pid}")" alive
kill "\${_other_pid}" 2>/dev/null || true
`);
  expect(out).toContain('ok other-install-untouched');
  expect(out).not.toContain('not ok');
});

// ── Fix 2: endpoint probe false negative ─────────────────────────────────────
// `curl` is shadowed by a shell function in these cases (a function beats the
// binary in bash's lookup order), so the URL is asserted with no network call.

test('_endpoint_ok probes the 443 surface — it strips the :4443 mTLS port', () => {
  // The whole bug: :4443 is mutual-mTLS AND presents a product-CA server cert,
  // so a certless probe there can never succeed (measured: curl exit 60,
  // http_code 000) and every healthy install reported DEGRADED forever.
  const out = sh('endpoint-url', `
export HIVEMIND_ENDPOINT="hivemind.ia.br:4443"
curl() { echo "\$*" > "\${HOME}/curl-args"; printf '200'; }
_endpoint_ok
_url="\$(tr ' ' '\\n' < "\${HOME}/curl-args" | grep '^https://')"
_assert probes-443-host "\${_url}" "https://hivemind.ia.br/ca/crl.pem"
`);
  expect(out).toContain('ok probes-443-host');
  expect(out).not.toContain('not ok');
});

test('_endpoint_ok treats any HTTP status as reachable, and only http_code 000 as unreachable', () => {
  // Liveness, not authorization — same discipline as _proxy_ok. A 401 proves
  // DNS + TLS + a server that answered, which is exactly what the check claims;
  // the old `-sf` probe would have called that a failure.
  const out = sh('endpoint-codes', `
export HIVEMIND_ENDPOINT="hivemind.ia.br:4443"

curl() { printf '401'; }
_rc=0; _endpoint_ok || _rc=\$?
_assert 401-is-reachable "\${_rc}" 0

curl() { printf '404'; }
_rc=0; _endpoint_ok || _rc=\$?
_assert 404-is-reachable "\${_rc}" 0

curl() { printf '000'; }
_rc=0; _endpoint_ok || _rc=\$?
_assert 000-is-unreachable "\${_rc}" 1
`);
  expect(out).toContain('ok 401-is-reachable');
  expect(out).toContain('ok 404-is-reachable');
  expect(out).toContain('ok 000-is-unreachable');
  expect(out).not.toContain('not ok');
});

test('_check_health reports the endpoint reachable on a healthy install (the DEGRADED false positive)', () => {
  // End-to-end on the reported symptom: with the endpoint answering and the
  // runtime/proxy up, severity must be 0 (OK) — it used to be pinned at 1
  // (DEGRADED) by _HEALTH_ENDPOINT_OK=0 alone.
  const out = sh('health-severity', `
export HIVEMIND_ENDPOINT="hivemind.ia.br:4443"
export MTLS_PROXY_PORT=7779
# Stub curl to the MEASURED behaviour of a healthy install: anything addressed
# to the :4443 mTLS port fails the way a certless probe really does (curl exit
# 60, http_code 000, because that port is mutual-mTLS and serves a product-CA
# cert), while every other surface — the local listeners and the 443/LE host —
# answers 200. So this case fails for a probe aimed at :4443 and passes only
# for one aimed at the surface that actually answers.
curl() {
  local _a="\$*" _code=200 _rc=0
  case "\${_a}" in *":4443"*) _code=000; _rc=60 ;; esac
  case "\${_a}" in *"%{http_code}"*) printf '%s' "\${_code}" ;; esac
  return "\${_rc}"
}
_check_health
_assert endpoint-ok "\${_HEALTH_ENDPOINT_OK}" 1
_assert severity-ok "\${_HEALTH_SEVERITY}" 0
`);
  expect(out).toContain('ok endpoint-ok');
  expect(out).toContain('ok severity-ok');
  expect(out).not.toContain('not ok');
});

// ── Fix 3 (papercut d): _seed_engram_mcp_config — durable open-time reseed ──
// setup.ts writes mcpServers.engram into $HIVEMIND_HOME/.claude/.claude.json
// ONCE, at enrollment. Claude Code can clobber that file on exit (measured
// 2026-08-04), so cmd_open now re-runs the SAME merge-safe write on every
// open. These cases mirror setup.contract.test.ts's assertions for the
// enrollment-time seed 1:1, against this open-time seed instead.

test('_seed_engram_mcp_config preserves other top-level keys and other mcpServers.* entries, and is idempotent', () => {
  const configPath = caseClaudeConfig('seed-merge-safe');
  shRaw('seed-merge-safe', `
export MTLS_PROXY_PORT=7779
mkdir -p "\$(dirname "${configPath}")"
cat > "${configPath}" <<'JSON'
{
  "someArbitraryKey": "keep-me",
  "mcpServers": { "otherServer": { "type": "stdio", "command": "some-other-mcp" } }
}
JSON
_seed_engram_mcp_config
`);

  const afterRun1 = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(afterRun1.someArbitraryKey).toBe('keep-me');
  expect(afterRun1.mcpServers.otherServer).toEqual({ type: 'stdio', command: 'some-other-mcp' });
  expect(afterRun1.mcpServers.engram).toEqual({ type: 'http', url: 'https://127.0.0.1:7779/v1/mcp' });
  // NO headers, no secret material — the proxy injects x-fos-key server-side.
  expect(afterRun1.mcpServers.engram.headers).toBeUndefined();
  expect(JSON.stringify(afterRun1.mcpServers.engram)).not.toContain('FOS_API_KEY');
  expect(statSync(configPath).mode & 0o777).toBe(0o600);

  // Idempotency: calling it again (this is what every `hivemind` open does)
  // must not disturb the survivors or drift the engram entry.
  shRaw('seed-merge-safe', `
export MTLS_PROXY_PORT=7779
_seed_engram_mcp_config
`);
  const afterRun2 = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(afterRun2).toEqual(afterRun1);
});

test('_seed_engram_mcp_config self-heals a null mcpServers instead of throwing', () => {
  const configPath = caseClaudeConfig('seed-null-mcpservers');
  shRaw('seed-null-mcpservers', `
export MTLS_PROXY_PORT=7779
mkdir -p "\$(dirname "${configPath}")"
printf '{"mcpServers": null, "otherKey": "kept"}' > "${configPath}"
_seed_engram_mcp_config
`);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(config.otherKey).toBe('kept');
  expect(config.mcpServers.engram).toEqual({ type: 'http', url: 'https://127.0.0.1:7779/v1/mcp' });
});

test('_seed_engram_mcp_config self-heals an array mcpServers instead of throwing', () => {
  const configPath = caseClaudeConfig('seed-array-mcpservers');
  shRaw('seed-array-mcpservers', `
export MTLS_PROXY_PORT=7779
mkdir -p "\$(dirname "${configPath}")"
printf '{"mcpServers": ["not", "an", "object"], "otherKey": "kept"}' > "${configPath}"
_seed_engram_mcp_config
`);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(config.otherKey).toBe('kept');
  expect(config.mcpServers.engram).toEqual({ type: 'http', url: 'https://127.0.0.1:7779/v1/mcp' });
  // The stray array entries must not survive as numeric keys.
  expect(Object.keys(config.mcpServers)).toEqual(['engram']);
});

test('_seed_engram_mcp_config self-heals a top-level null document instead of throwing', () => {
  const configPath = caseClaudeConfig('seed-null-toplevel');
  shRaw('seed-null-toplevel', `
export MTLS_PROXY_PORT=7779
mkdir -p "\$(dirname "${configPath}")"
printf 'null' > "${configPath}"
_seed_engram_mcp_config
`);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(config.mcpServers.engram).toEqual({ type: 'http', url: 'https://127.0.0.1:7779/v1/mcp' });
});

test('_seed_engram_mcp_config creates .claude.json fresh when absent', () => {
  const configPath = caseClaudeConfig('seed-fresh');
  shRaw('seed-fresh', `
export MTLS_PROXY_PORT=7779
_seed_engram_mcp_config
`);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(config).toEqual({
    mcpServers: { engram: { type: 'http', url: 'https://127.0.0.1:7779/v1/mcp' } },
  });
  expect(statSync(configPath).mode & 0o777).toBe(0o600);
});

test('_seed_engram_mcp_config never blocks the caller (returns 0) even when the write fails', () => {
  // Guard-rail under test: "engram outage must not block opening Claude"
  // (the same fail-soft posture as _open_session_spine) extends to this seed
  // — a disk/permissions hiccup here must degrade the NEXT open's /mcp
  // discovery, never abort THIS one. Forced failure: a plain FILE sits where
  // the .claude directory should be, so mkdirSync(dirname(...)) inside the
  // bun snippet cannot create it.
  const out = sh('seed-never-blocks', `
mkdir -p "\$(dirname "\${HIVEMIND_HOME}")"
mkdir -p "\${HIVEMIND_HOME}"
touch "\${HIVEMIND_HOME}/.claude"
export MTLS_PROXY_PORT=7779
_rc=0
_seed_engram_mcp_config || _rc=\$?
_assert never-blocks-open "\${_rc}" 0
`);
  expect(out).toContain('ok never-blocks-open');
  expect(out).not.toContain('not ok');
});
