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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
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

// ── P2: `hivemind install` — dispatcher wiring + guided flow (mocked prompts) ──
// bin/hivemind's dispatcher gained a new `install [<target>]` case arm
// (30e3e435) that runs `cmd_install`, a thin TTY gate wrapping `_install_run`
// — the actual guided logic (detect candidates, ask scope, confirm the exact
// path, write via the shared `_write_generic_mcp_config` carrier; 6ea3a95d/
// ef1c9385). The gate lives in `cmd_install`, not `_install_run`, specifically
// so these tests can drive `_install_run` directly with piped stdin ("mock
// the interactive prompts") without a `[ -t 0 ]` check a pipe can never pass.

// runInstallRun: sources the stripped script (same technique as sh()/shRaw()
// above) into an isolated $HOME/cwd, optionally pre-seeds a `~/.cursor` dir
// and/or a fake Windows-users tree (via ANTIGRAVITY_WINDOWS_USERS_ROOT, the
// override added alongside the feature for exactly this reason), feeds
// `opts.stdin` to `_install_run <targetArg>`, and reports back the exit code
// (via a marker file — stdout/stderr from the case carry the guided-flow
// prompts themselves, not a clean return value) plus the resolved paths a
// test needs to assert against.
function runInstallRun(
  name: string,
  opts: { stdin: string; targetArg?: string; seedCursor?: boolean; antigravityUsers?: string[] },
): { rc: number; home: string; cwd: string; antigravityRoot: string } {
  const dir = join(testRoot, name);
  const home = join(dir, 'home');
  const cwd = join(dir, 'cwd');
  const antigravityRoot = join(dir, 'winusers');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (opts.seedCursor) mkdirSync(join(home, '.cursor'), { recursive: true });
  for (const u of opts.antigravityUsers ?? []) {
    mkdirSync(join(antigravityRoot, u, '.gemini', 'config'), { recursive: true });
  }

  const libPath = join(dir, 'lib.sh');
  const strip = Bun.spawnSync(['bash', '-c', `sed '/^# ── Entry point/,$d' "${HIVEMIND_BIN}" > "${libPath}"`]);
  if (strip.exitCode !== 0) throw new Error(`failed to strip entry point: ${strip.stderr.toString()}`);

  const scriptPath = join(dir, 'case.sh');
  const stdinLiteral = opts.stdin.replace(/'/g, `'\\''`);
  const targetLiteral = (opts.targetArg ?? '').replace(/'/g, `'\\''`);
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
export HOME="${home}"
export HIVEMIND_HOME="${home}/.hivemind"
export ANTIGRAVITY_WINDOWS_USERS_ROOT="${antigravityRoot}"
unset MTLS_PROXY_PORT
cd "${cwd}"
# shellcheck disable=SC1090
source "${libPath}"

_rc=0
printf '%s' '${stdinLiteral}' | _install_run '${targetLiteral}' || _rc=\$?
printf '%s' "\${_rc}" > "${dir}/rc"
`,
  );
  const res = Bun.spawnSync(['bash', scriptPath], { stdout: 'pipe', stderr: 'pipe' });
  const rcPath = join(dir, 'rc');
  if (!existsSync(rcPath)) {
    throw new Error(`case '${name}' never wrote an rc marker (script aborted?).\nstdout:\n${res.stdout.toString()}\nstderr:\n${res.stderr.toString()}`);
  }
  return { rc: Number(readFileSync(rcPath, 'utf8')), home, cwd, antigravityRoot };
}

test('the dispatcher routes `install` to cmd_install, and a non-interactive invocation fails closed — with or without a target arg', () => {
  // Real (unstripped) script, isolated $HOME, default spawn stdin (never a
  // TTY under the test runner) — proves the dispatcher wiring end-to-end
  // AND the "no TTY, no default path" fail-closed acceptance gate (30e3e435)
  // in one shot, safely: cmd_install's TTY check is the very first thing it
  // does, before any daemon/network/proxy work.
  const home = mkdtempSync(join(tmpdir(), 'hivemind-install-noninteractive-'));

  const helpRes = Bun.spawnSync(['bash', HIVEMIND_BIN, '--help'], { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' });
  expect(helpRes.stdout.toString()).toContain('install [<target>]');

  const noArgRes = Bun.spawnSync(['bash', HIVEMIND_BIN, 'install'], { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' });
  expect(noArgRes.exitCode).toBe(1);
  expect(noArgRes.stderr.toString()).toContain('terminal');

  // A target arg is NOT a bypass — the scope/path confirmation downstream
  // still needs a real terminal.
  const withArgRes = Bun.spawnSync(['bash', HIVEMIND_BIN, 'install', 'cursor'], { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' });
  expect(withArgRes.exitCode).toBe(1);
  expect(withArgRes.stderr.toString()).toContain('terminal');
});

test('_install_run — no target arg: guided menu → Cursor → global scope → confirmed write', () => {
  const { rc, home } = runInstallRun('install-cursor-global', {
    stdin: '1\n1\ny\n', // menu #1 = cursor, scope #1 = global, confirm = y
    seedCursor: true,
  });
  expect(rc).toBe(0);
  const written = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
  expect(written.mcpServers.engram).toEqual({ type: 'http', url: 'https://127.0.0.1:7780/v1/mcp' });
});

test('_install_run — declining the final confirmation writes nothing (code-review fix: no port-map entry, no reserved port either)', () => {
  const { rc, home } = runInstallRun('install-cursor-decline', {
    stdin: '1\n1\nn\n',
    seedCursor: true,
  });
  expect(rc).not.toBe(0);
  expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false);
  // The old behaviour allocated + persisted a port-map entry (minted
  // device_id, reserved port) BEFORE the confirmation prompt, so declining
  // still left an entry behind. The allocate+write now happens strictly
  // AFTER confirmation, so declining must leave port-map.json completely
  // untouched — not even created.
  expect(existsSync(join(home, '.engram', 'mtls', 'port-map.json'))).toBe(false);
});

test('_install_run — target arg supplied: skips the candidate menu but still asks scope and confirms (project scope)', () => {
  const { rc, cwd } = runInstallRun('install-cursor-project', {
    stdin: '2\ny\n', // scope #2 = project, confirm = y (no menu prompt consumed — target arg given)
    targetArg: 'cursor',
    seedCursor: true,
  });
  expect(rc).toBe(0);
  const written = JSON.parse(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8'));
  expect(written.mcpServers.engram.url).toBe('https://127.0.0.1:7780/v1/mcp');
});

test('_install_run — antigravity: global-only, single Windows user detected, never asks scope', () => {
  const { rc, antigravityRoot } = runInstallRun('install-antigravity-single', {
    stdin: 'y\n', // only the final confirmation — no scope prompt, no path-picker (one candidate)
    targetArg: 'antigravity',
    antigravityUsers: ['alice'],
  });
  expect(rc).toBe(0);
  const written = JSON.parse(readFileSync(join(antigravityRoot, 'alice', '.gemini', 'config', 'mcp_config.json'), 'utf8'));
  expect(written.mcpServers.engram).toEqual({ type: 'http', url: 'https://127.0.0.1:7780/v1/mcp' });
});

test('_install_run — antigravity: multiple Windows users found → guided path picker, exactly one candidate written', () => {
  const { rc, antigravityRoot } = runInstallRun('install-antigravity-multi', {
    stdin: '2\ny\n', // path-picker #2, confirm = y
    targetArg: 'antigravity',
    antigravityUsers: ['alice', 'bob'],
  });
  expect(rc).toBe(0);
  const aliceWritten = existsSync(join(antigravityRoot, 'alice', '.gemini', 'config', 'mcp_config.json'));
  const bobWritten = existsSync(join(antigravityRoot, 'bob', '.gemini', 'config', 'mcp_config.json'));
  // Exactly one of the two candidates was written — never both, never neither
  // — the specific one depends on glob ordering, which this test does not pin.
  expect(aliceWritten !== bobWritten).toBe(true);
});

test('_install_run — manual target: free-text path, merge-safe write (shared carrier proven against a non-Claude path)', () => {
  const dir = join(testRoot, 'install-manual-merge-safe');
  mkdirSync(dir, { recursive: true });
  const manualPath = join(dir, 'some-other-client', 'mcp.json');
  mkdirSync(dirname(manualPath), { recursive: true });
  writeFileSync(manualPath, JSON.stringify({ keepMe: true, mcpServers: { other: { command: 'x' } } }));

  const { rc } = runInstallRun('install-manual-merge-safe', {
    stdin: `${manualPath}\ny\n`,
    targetArg: 'manual',
  });
  expect(rc).toBe(0);
  const written = JSON.parse(readFileSync(manualPath, 'utf8'));
  expect(written.keepMe).toBe(true);
  expect(written.mcpServers.other).toEqual({ command: 'x' });
  expect(written.mcpServers.engram).toEqual({ type: 'http', url: 'https://127.0.0.1:7780/v1/mcp' });
});

test('_install_run — unknown target arg fails without prompting or writing anything', () => {
  const { rc } = runInstallRun('install-unknown-target', {
    stdin: '',
    targetArg: 'does-not-exist',
  });
  expect(rc).toBe(1);
});

// ── Option 2 (fos_decision 1caee6a7, item 18cff9b7) — dedicated per-target
// port allocation + port-map.json persistence ───────────────────────────────
// Full design: fos_sketchpad 4f8142e3 § ADDENDUM 3. `hivemind install`
// no longer writes every foreign client onto the shared PROXY_PORT — each
// install allocates its OWN loopback port + device_id, persisted to
// ~/.engram/mtls/port-map.json (read by runtime/src/lib/mtls-proxy.ts's
// startAllMtlsProxies() at daemon boot).

test('_allocate_target_port picks the lowest free port in the configured range, skipping already-used ports', () => {
  const out = sh('allocate-port-lowest-free', `
export MTLS_INSTALL_PORT_RANGE_START=9500
export MTLS_INSTALL_PORT_RANGE_END=9510
mkdir -p "\$(dirname "\${PORT_MAP_FILE}")"
cat > "\${PORT_MAP_FILE}" <<'JSON'
{"version":1,"entries":[{"path":"/a","port":9500,"device_id":"d1"},{"path":"/b","port":9501,"device_id":"d2"}]}
JSON
_got="\$(_allocate_target_port)"
_assert lowest-free-port "\${_got}" 9502
`);
  expect(out).toContain('ok lowest-free-port');
  expect(out).not.toContain('not ok');
});

test('_allocate_target_port fails clearly (empty stdout, non-zero rc) when the range is fully used — never silently collides', () => {
  const out = sh('allocate-port-exhausted', `
export MTLS_INSTALL_PORT_RANGE_START=9600
export MTLS_INSTALL_PORT_RANGE_END=9601
mkdir -p "\$(dirname "\${PORT_MAP_FILE}")"
cat > "\${PORT_MAP_FILE}" <<'JSON'
{"version":1,"entries":[{"path":"/a","port":9600,"device_id":"d1"},{"path":"/b","port":9601,"device_id":"d2"}]}
JSON
_rc=0
_got="\$(_allocate_target_port 2>/dev/null)" || _rc=\$?
_assert alloc-exhausted-fails "\${_rc}" 1
_assert alloc-exhausted-empty-stdout "\${_got}" ""
`);
  expect(out).toContain('ok alloc-exhausted-fails');
  expect(out).toContain('ok alloc-exhausted-empty-stdout');
  expect(out).not.toContain('not ok');
});

test('_resolve_target_port_and_device_id: idempotent for the SAME path, mints a DISTINCT port+device_id for a DIFFERENT path', () => {
  const out = sh('resolve-idempotent', `
_first="\$(_resolve_target_port_and_device_id /a/config.json cursor global)"
_second="\$(_resolve_target_port_and_device_id /a/config.json cursor global)"
_assert same-path-reused "\${_first}" "\${_second}"

_third="\$(_resolve_target_port_and_device_id /b/config.json cursor project)"
_assert different-path-distinct "\$([ "\${_first}" != "\${_third}" ] && echo distinct || echo same)" distinct
`);
  expect(out).toContain('ok same-path-reused');
  expect(out).toContain('ok different-path-distinct');
  expect(out).not.toContain('not ok');
});

test('_port_map_write_entry persists a well-shaped, chmod-0600 entry; _port_map_lookup finds it back by path', () => {
  const configPath = join(caseHome('port-map-shape'), '.engram', 'mtls', 'port-map.json');
  shRaw('port-map-shape', `
_port_map_write_entry "/some/config.json" "cursor" "global" "7780" "device-abc"
`);
  const doc = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(doc.version).toBe(1);
  expect(doc.entries).toHaveLength(1);
  expect(doc.entries[0]).toMatchObject({
    path: '/some/config.json',
    target_id: 'cursor',
    scope: 'global',
    port: 7780,
    device_id: 'device-abc',
  });
  expect(typeof doc.entries[0].created_at).toBe('string');
  expect(typeof doc.entries[0].updated_at).toBe('string');
  expect(statSync(configPath).mode & 0o777).toBe(0o600);
});

// runInstallRunSequence: like runInstallRun above, but drives `_install_run`
// MULTIPLE times in ONE bash process against the SAME $HOME — needed here
// because port-map.json state must persist ACROSS invocations within a
// single "install session" (idempotent re-install, two distinct targets
// getting two distinct ports) — runInstallRun's isolated-$HOME-per-call
// contract can't express that on its own.
function runInstallRunSequence(
  name: string,
  calls: Array<{ stdin: string; targetArg?: string }>,
  opts: { seedCursor?: boolean } = {},
): { rcs: number[]; home: string; cwd: string; portMapPath: string } {
  const dir = join(testRoot, name);
  const home = join(dir, 'home');
  const cwd = join(dir, 'cwd');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (opts.seedCursor) mkdirSync(join(home, '.cursor'), { recursive: true });

  const libPath = join(dir, 'lib.sh');
  const strip = Bun.spawnSync(['bash', '-c', `sed '/^# ── Entry point/,$d' "${HIVEMIND_BIN}" > "${libPath}"`]);
  if (strip.exitCode !== 0) throw new Error(`failed to strip entry point: ${strip.stderr.toString()}`);

  const lines: string[] = [
    '#!/usr/bin/env bash',
    `export HOME="${home}"`,
    `export HIVEMIND_HOME="${home}/.hivemind"`,
    'unset MTLS_PROXY_PORT',
    `cd "${cwd}"`,
    '# shellcheck disable=SC1090',
    `source "${libPath}"`,
    '',
    `: > "${dir}/rcs"`,
  ];
  calls.forEach((c, i) => {
    const stdinLiteral = c.stdin.replace(/'/g, `'\\''`);
    const targetLiteral = (c.targetArg ?? '').replace(/'/g, `'\\''`);
    lines.push(
      `_rc${i}=0`,
      `printf '%s' '${stdinLiteral}' | _install_run '${targetLiteral}' || _rc${i}=\$?`,
      `printf '%s\\n' "\${_rc${i}}" >> "${dir}/rcs"`,
    );
  });

  writeFileSync(join(dir, 'case.sh'), lines.join('\n') + '\n');
  const res = Bun.spawnSync(['bash', join(dir, 'case.sh')], { stdout: 'pipe', stderr: 'pipe' });
  const rcsPath = join(dir, 'rcs');
  if (!existsSync(rcsPath)) {
    throw new Error(`case '${name}' never wrote an rcs marker (script aborted?).\nstdout:\n${res.stdout.toString()}\nstderr:\n${res.stderr.toString()}`);
  }
  const rcs = readFileSync(rcsPath, 'utf8').trim().split('\n').filter(Boolean).map(Number);
  return { rcs, home, cwd, portMapPath: join(home, '.engram', 'mtls', 'port-map.json') };
}

test('_install_run — idempotent re-install: running install AGAIN against the same resolved path reuses the same port+device_id (one port-map entry, not two)', () => {
  const { rcs, home, portMapPath } = runInstallRunSequence('install-idempotent-reinstall', [
    { stdin: '1\ny\n', targetArg: 'cursor' }, // scope #1 = global, confirm = y
    { stdin: '1\ny\n', targetArg: 'cursor' }, // same target/scope again
  ], { seedCursor: true });
  expect(rcs).toEqual([0, 0]);

  const written = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
  expect(written.mcpServers.engram.url).toBe('https://127.0.0.1:7780/v1/mcp');

  const map = JSON.parse(readFileSync(portMapPath, 'utf8'));
  // Exactly ONE entry — the second install call REUSED it, never allocated
  // a second one for the same resolved config path.
  expect(map.entries).toHaveLength(1);
  expect(map.entries[0].port).toBe(7780);
});

test('_install_run — two DIFFERENT installs (cursor global, then cursor project) get two DIFFERENT dedicated ports, both persisted', () => {
  const { rcs, home, cwd, portMapPath } = runInstallRunSequence('install-two-distinct-targets', [
    { stdin: '1\ny\n', targetArg: 'cursor' }, // scope #1 = global
    { stdin: '2\ny\n', targetArg: 'cursor' }, // scope #2 = project (different resolved path -> different port-map key)
  ], { seedCursor: true });
  expect(rcs).toEqual([0, 0]);

  const globalWritten = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
  const projectWritten = JSON.parse(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8'));
  expect(globalWritten.mcpServers.engram.url).not.toBe(projectWritten.mcpServers.engram.url);

  const map = JSON.parse(readFileSync(portMapPath, 'utf8'));
  expect(map.entries).toHaveLength(2);
  const ports: number[] = map.entries.map((e: { port: number }) => e.port);
  expect(new Set(ports).size).toBe(2); // two distinct ports, no collision
  const deviceIds: string[] = map.entries.map((e: { device_id: string }) => e.device_id);
  expect(new Set(deviceIds).size).toBe(2); // two distinct device_ids too
});

// code-review FIX (TOCTOU): _resolve_target_port_and_device_id used to
// read the "used ports" snapshot and persist its pick with NO cross-process
// lock, so N truly concurrent callers (N parallel `hivemind install`s, or
// N parallel MCP-client bootstraps hitting this at once) could all read the
// SAME snapshot before any of them wrote — measured before the fix: 8
// concurrent installs all minted port 7780, and 3 of the 8 port-map entries
// were lost outright (a read-merge-write race clobbering another writer's
// unflushed entry). The fix wraps the whole read+allocate+write critical
// section in `flock -x` on port-map.json.lock. This test drives that
// directly (not through the interactive `_install_run` TTY flow, which
// isn't meaningfully "concurrent" for N real terminals) — N bash processes,
// each sourcing the SAME stripped bin/hivemind against the SAME $HOME,
// spawned together and calling _resolve_target_port_and_device_id for N
// DISTINCT paths (N distinct installs) at once.
test('_resolve_target_port_and_device_id: N concurrent installs get N distinct ports, N entries, zero loss (TOCTOU regression)', async () => {
  const name = 'resolve-concurrent';
  const dir = join(testRoot, name);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });

  const libPath = join(dir, 'lib.sh');
  const strip = Bun.spawnSync(['bash', '-c', `sed '/^# ── Entry point/,$d' "${HIVEMIND_BIN}" > "${libPath}"`]);
  if (strip.exitCode !== 0) throw new Error(`failed to strip entry point: ${strip.stderr.toString()}`);

  const N = 8;
  const procs = Array.from({ length: N }, (_, i) => {
    const scriptPath = join(dir, `run-${i}.sh`);
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash
set -euo pipefail
export HOME="${home}"
export HIVEMIND_HOME="${home}/.hivemind"
unset MTLS_PROXY_PORT
# shellcheck disable=SC1090
source "${libPath}"
_resolve_target_port_and_device_id "/concurrent-target-${i}/config.json" "cursor" "global"
`,
    );
    return Bun.spawn(['bash', scriptPath], { stdout: 'pipe', stderr: 'pipe' });
  });

  const results = await Promise.all(
    procs.map(async (p) => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { stdout: stdout.trim(), stderr, exitCode };
    }),
  );

  for (const r of results) {
    if (r.exitCode !== 0) {
      throw new Error(`a concurrent _resolve_target_port_and_device_id call failed (rc=${r.exitCode}).\nstderr:\n${r.stderr}`);
    }
  }

  // N distinct ports handed back to the N callers — zero collisions.
  const ports = results.map((r) => Number(r.stdout.split('\t')[0]));
  expect(ports).toHaveLength(N);
  expect(new Set(ports).size).toBe(N);

  // N distinct device_ids too.
  const deviceIds = results.map((r) => r.stdout.split('\t')[1]);
  expect(new Set(deviceIds).size).toBe(N);

  // N entries actually persisted to port-map.json — zero lost writes.
  const portMapPath = join(home, '.engram', 'mtls', 'port-map.json');
  const map = JSON.parse(readFileSync(portMapPath, 'utf8'));
  expect(map.entries).toHaveLength(N);
  const persistedPorts: number[] = map.entries.map((e: { port: number }) => e.port);
  expect(new Set(persistedPorts).size).toBe(N);
  expect([...persistedPorts].sort((a, b) => a - b)).toEqual([...ports].sort((a, b) => a - b));
}, 30000);

test('_install_run — the CLI\'s own self-seed (_seed_engram_mcp_config) stays on the shared PROXY_PORT, untouched by install\'s dedicated-port allocation', () => {
  // Migration/non-breaking guarantee: item 18cff9b7 changes ONLY the
  // `hivemind install` carrier's port; _seed_engram_mcp_config (Claude
  // Code's own entry, written by cmd_open on every launch) must keep using
  // the implicit shared PROXY_PORT exactly as before this item.
  const configPath = caseClaudeConfig('seed-still-shared-port-after-install-change');
  shRaw('seed-still-shared-port-after-install-change', `
export MTLS_PROXY_PORT=7779
_seed_engram_mcp_config
`);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(config.mcpServers.engram).toEqual({ type: 'http', url: 'https://127.0.0.1:7779/v1/mcp' });
});
