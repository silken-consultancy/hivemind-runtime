// HiveMind — execute-boundary OVERRIDE round-trip regression test (item B2.4).
// .claude/hooks/test/override-roundtrip.regression.test.mjs
//
// WHY THIS IS THE HIGHEST-VALUE TEST IN THE ARC: the session-key mismatch was
// invisible to every static guard AND to careful code reading — a subagent
// read the CLI and correctly reported the mechanism "as documented"; only
// RUNNING it revealed the gate and the CLI keyed on DIFFERENT session ids, so
// a grant was written where the gate never looked (the CLI reported "granted"
// while the very next mutating call was denied identically). A round-trip that
// is never executed end-to-end is an assumption wearing a test's clothes. So
// this test drives the REAL gate hook and the REAL override CLI as subprocesses
// against isolated state files.
//
// SCOPE (deliberate — see lib/execute-boundary-override.mjs's selftest header):
// UNIT / process level. The true live-fire (grant from a real conversational
// turn, gate's NEXT turn re-denies) is NOT dispatchable — a subagent is
// structurally denied the override at the gate. Those live-fire items stay
// pending; this proves everything a spawned process CAN prove.
//
// COVERS BOTH FAILURE HALVES the fix (resolveSessionId --session preference,
// threading the resolved sessionId through BOTH the turn_seq read and the
// grant write) closes:
//   (a) SESSION-KEY MISMATCH — grant written under a key the gate never reads.
//   (b) STALE turn_seq STAMP — grant found but rejected by the turn_seq
//       equality check (a grant born under turn_seq 0).
// Reverting resolveSessionId to `ENGRAM_SESSION_ID` alone reproduces (a) for
// the positive round-trip below (the --session grant lands under the wrong
// key) and takes the turn_seq read down with it — the test goes red.
//
// Run: node --test .claude/hooks/test/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.resolve(__dirname, '..');
const GATE = path.join(HOOKS, 'pre-tool-use.execute-boundary-gate.js');
const CLI = path.join(HOOKS, 'lib', 'execute-boundary-override.mjs');

const require = createRequire(import.meta.url);
const { CEILING, stateFile } = require(path.join(HOOKS, 'lib', 'execute-boundary-classifier.js'));
const { resolveSessionId } = await import(CLI);

// Each test run gets its own TMPDIR so the state files (hivemind-*-<session>.json)
// never collide with a real session's or with a sibling case.
function freshTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hm-eb-roundtrip-'));
}

// Base env for spawned processes: isolated TMPDIR, gate enforcing, and NO
// CLAUDE_AGENT_NAME (the CLI structurally refuses when that is set — this test
// exercises the messenger path, not a subagent).
function childEnv(tmp, extra = {}) {
  const env = { ...process.env, TMPDIR: tmp, ENGRAM_EXECUTE_BOUNDARY_GATE: 'enforce', ...extra };
  delete env.CLAUDE_AGENT_NAME;
  return env;
}

function stateIn(tmp, kind, sessionId) {
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = tmp; // stateFile() reads process.env.TMPDIR at call time
  try {
    return stateFile(kind, sessionId);
  } finally {
    if (prev === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prev;
  }
}

function auditFileFor(tmp, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(tmp, `hivemind-execute-override-audit-${safe}.jsonl`);
}

// Run the override CLI directly (messenger path). Returns {ok, stderr}.
function runCli(args, env) {
  try {
    execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    return { ok: true, stderr: '' };
  } catch (err) {
    return { ok: false, stderr: String(err.stderr || err.message || '') };
  }
}

// Run the gate hook with crafted PreToolUse stdin. Returns {denied, reason, stdout}.
function runGate(stdinObj, env) {
  const stdout = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(stdinObj),
    env,
    encoding: 'utf8',
  });
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch { /* silent-allow → empty stdout */ }
  const denied = !!(parsed && parsed.hookSpecificOutput &&
    parsed.hookSpecificOutput.permissionDecision === 'deny');
  const reason = (parsed && parsed.hookSpecificOutput &&
    parsed.hookSpecificOutput.permissionDecisionReason) || '';
  return { denied, reason, stdout };
}

const editCall = (sessionId) => ({
  tool_name: 'Edit',
  tool_input: { file_path: '/tmp/does-not-matter' },
  session_id: sessionId,
});

// ─── resolveSessionId precedence — the reconciliation fix, unit level ───────
test('resolveSessionId prefers --session over ENGRAM_SESSION_ID', () => {
  assert.equal(
    resolveSessionId(['--ok', 'x', '--session', 'gate-key'], { ENGRAM_SESSION_ID: 'env-key' }),
    'gate-key',
  );
  assert.equal(
    resolveSessionId(['--ok', 'x'], { ENGRAM_SESSION_ID: 'env-key' }),
    'env-key',
    'no --session → env fallback',
  );
  assert.equal(
    resolveSessionId(['--ok', 'x', '--session', '   '], { ENGRAM_SESSION_ID: 'env-key' }),
    'env-key',
    'whitespace --session → env fallback, not empty',
  );
  assert.equal(resolveSessionId(['--ok', 'x'], {}), '', 'neither present → empty (caller refuses)');
});

// ─── the gate embeds its OWN resolved --session in the deny reason ──────────
test('deny reason embeds --session <resolved sessionId> for CLI reconciliation', () => {
  const tmp = freshTmp();
  const sessionId = `rt-embed-${process.pid}-${Date.now()}`;
  fs.writeFileSync(stateIn(tmp, 'dispatch', sessionId), JSON.stringify({ count: CEILING }));

  const { denied, reason } = runGate(editCall(sessionId), childEnv(tmp));
  assert.equal(denied, true, 'at CEILING with no grant → DENY');
  assert.ok(
    reason.includes(`--session ${sessionId}`),
    `deny reason must hand the CLI this gate's key: ${reason}`,
  );
});

// ─── POSITIVE round-trip: grant via --session → gate FINDS + CONSUMES ───────
test('grant via --session then gate allows and audits the consume (same session id)', () => {
  const tmp = freshTmp();
  const sessionId = `rt-ok-${process.pid}-${Date.now()}`;
  const turnSeq = 3;

  fs.writeFileSync(stateIn(tmp, 'turn', sessionId), JSON.stringify({ turn_seq: turnSeq }));
  fs.writeFileSync(stateIn(tmp, 'dispatch', sessionId), JSON.stringify({ count: CEILING }));

  // ENGRAM_SESSION_ID is set to a DIFFERENT id on purpose — --session must win,
  // or the grant lands under the wrong key (the original bug).
  const cli = runCli(
    ['--ok', 'founder said go', '--session', sessionId],
    childEnv(tmp, { ENGRAM_SESSION_ID: 'a-different-messenger-env-id' }),
  );
  assert.equal(cli.ok, true, `CLI should grant: ${cli.stderr}`);

  const grant = JSON.parse(fs.readFileSync(stateIn(tmp, 'execute-override', sessionId), 'utf8'));
  assert.equal(grant.granted, true);
  assert.equal(grant.turn_seq, turnSeq, 'grant stamped with the CURRENT turn_seq, not 0');
  assert.equal(grant.ok_ref, 'founder said go');

  const { denied } = runGate(editCall(sessionId), childEnv(tmp));
  assert.equal(denied, false, 'valid grant on the SAME session id → gate allows (consumes)');

  const audit = fs.readFileSync(auditFileFor(tmp, sessionId), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const granted = audit.find((e) => e.event === 'granted');
  const consumed = audit.find((e) => e.event === 'consumed');
  assert.ok(granted && granted.ok_ref === 'founder said go', 'audit records the grant');
  assert.ok(consumed && consumed.ok_ref === 'founder said go', 'audit records the consume');
  assert.equal(consumed.turn_seq, turnSeq, 'consume recorded under the matching turn_seq');
});

// ─── FAILURE HALF (a): SESSION-KEY MISMATCH — grant where the gate never looks ──
test('half (a): grant under the wrong session key is invisible to the gate → DENY', () => {
  const tmp = freshTmp();
  const gateSession = `rt-mismatch-gate-${process.pid}-${Date.now()}`;

  fs.writeFileSync(stateIn(tmp, 'turn', gateSession), JSON.stringify({ turn_seq: 2 }));
  fs.writeFileSync(stateIn(tmp, 'dispatch', gateSession), JSON.stringify({ count: CEILING }));

  // Grant WITHOUT --session and with ENGRAM_SESSION_ID pointing elsewhere: this
  // is exactly what the pre-fix CLI did — the grant lands under the env id, not
  // the gate's session. The CLI reports success...
  const cli = runCli(
    ['--ok', 'go'],
    childEnv(tmp, { ENGRAM_SESSION_ID: 'some-other-key-entirely' }),
  );
  assert.equal(cli.ok, true, `CLI still writes SOMETHING: ${cli.stderr}`);
  assert.ok(
    !fs.existsSync(stateIn(tmp, 'execute-override', gateSession)),
    'no grant exists under the gate’s session key',
  );

  // ...but the gate, keyed on its own session, sees no valid grant → DENY.
  const { denied } = runGate(editCall(gateSession), childEnv(tmp));
  assert.equal(denied, true, 'grant under a different key must NOT unlock this session');
});

// ─── FAILURE HALF (b): STALE turn_seq STAMP — grant found but rejected ──────
test('half (b): a grant stamped turn_seq 0 against a later turn is rejected → DENY', () => {
  const tmp = freshTmp();
  const sessionId = `rt-staleturn-${process.pid}-${Date.now()}`;

  fs.writeFileSync(stateIn(tmp, 'turn', sessionId), JSON.stringify({ turn_seq: 7 }));
  fs.writeFileSync(stateIn(tmp, 'dispatch', sessionId), JSON.stringify({ count: CEILING }));

  // A grant born under turn_seq 0 (the exact stale-stamp half of the original
  // bug) written under the RIGHT session key — so the gate FINDS it, then the
  // turn_seq equality check (0 !== 7) rejects it.
  fs.writeFileSync(
    stateIn(tmp, 'execute-override', sessionId),
    JSON.stringify({ granted: true, turn_seq: 0, ok_ref: 'stale', granted_at: new Date().toISOString() }),
  );

  const { denied } = runGate(editCall(sessionId), childEnv(tmp));
  assert.equal(denied, true, 'a grant whose turn_seq does not match the current turn is not honored');
});
