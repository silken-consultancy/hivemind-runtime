// HiveMind — SessionEnd close-session REASON ALLOWLIST regression test.
// .claude/hooks/test/session-end-reasons.regression.test.js
//
// WHY THIS FILE EXISTS:
//   session-end.close-session.js used a SKIP-list (clear, logout). Claude
//   Code's SessionEnd reason enum also carries "resume": /resume swaps the
//   conversation IN-PROCESS and fires SessionEnd for the one being left. The
//   skip-list let it through, and the hook closed a LIVE window's fos_session
//   — measured: session 82f9f738 closed 1 s after the founder typed /resume.
//   The fix is an ALLOWLIST (close only on prompt_input_exit / other) plus
//   forwarding the raw reason as `session-end-hook:<reason>`.
//
//   This test runs the REAL hook as a child process against a local stub
//   HTTPS server (throwaway self-signed CA written into a temp HOME at
//   ~/.engram/mtls/local-https/ca.cert.pem — the path the hook reads) and
//   counts the requests it receives. All env is FAKE and built from scratch:
//   nothing from the caller's environment (ENGRAM_*, FOS_API_KEY, ...) leaks
//   into the child.
//
//   GATE (proven on the fix's delivery): restoring the old skip-list turns the
//   resume/unknown/empty rows red; dropping the reason forwarding turns the
//   close rows red.
//
//   Needs `openssl` on PATH (present on ubuntu-latest CI) to mint the cert.
//
// Run: node --test .claude/hooks/test/   (or this file directly).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn, execFileSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'session-end.close-session.js');

// ── Throwaway TLS material: one self-signed cert with IP SAN 127.0.0.1, used
// both as the server cert and as the hook's trust anchor (ca.cert.pem).
function mintTls() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'se-reasons-'));
  const dir = path.join(home, '.engram', 'mtls', 'local-https');
  fs.mkdirSync(dir, { recursive: true });
  const cert = path.join(dir, 'ca.cert.pem');
  const key = path.join(home, 'server.key.pem');
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1',
      '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  return { home, cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
}

function sse(obj) {
  const envelope = {
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(obj) }] },
  };
  return `event: message\ndata: ${JSON.stringify(envelope)}\n\n`;
}

// Start a stub server that answers each request with the next queued tool
// result (default {ok:true}) and records every parsed request body.
function startStub(tls, replies = []) {
  const requests = [];
  const server = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      requests.push({ path: req.url, headers: req.headers, body });
      const reply = replies.shift() || { ok: true };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse(reply));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }));
  });
}

// Run the real hook with a scratch env. `stdin` null → empty stdin.
function runHook({ home, port, stdin }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        ENGRAM_SESSION_ID: '00000000-fake-fake-fake-000000000000',
        MTLS_PROXY_PORT: String(port),
        FOS_API_KEY: 'fake-fos-key-for-test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('hook timed out'));
    }, 15000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    child.stdin.end(stdin == null ? '' : stdin);
  });
}

let tls;
test.before(() => {
  tls = mintTls();
});
test.after(() => {
  if (tls) fs.rmSync(tls.home, { recursive: true, force: true });
});

async function withStub(replies, fn) {
  const stub = await startStub(tls, replies);
  try {
    return await fn(stub);
  } finally {
    await new Promise((r) => stub.server.close(r));
  }
}

// ── Reasons that MUST close: exactly one close call, raw reason forwarded.
for (const reason of ['prompt_input_exit', 'other']) {
  test(`reason=${reason} → exactly one close, reason forwarded`, async () => {
    await withStub([], async ({ port, requests }) => {
      const { code } = await runHook({ home: tls.home, port, stdin: JSON.stringify({ reason }) });
      assert.equal(code, 0);
      assert.equal(requests.length, 1, 'expected exactly one close request');
      const r = requests[0];
      assert.equal(r.path, '/v1/mcp');
      assert.equal(r.headers['x-fos-key'], 'fake-fos-key-for-test');
      assert.equal(r.body.params.name, 'fos_session');
      const args = r.body.params.arguments;
      assert.equal(args.action, 'close');
      assert.equal(args.session_id, '00000000-fake-fake-fake-000000000000');
      assert.equal(args.reason, `session-end-hook:${reason}`);
      assert.equal(args.next_note, undefined, 'first attempt carries no inline note');
    });
  });

  test(`reason=${reason} → next_note_required retries once with floor note, reason forwarded`, async () => {
    await withStub([{ _err: 'next_note_required' }, { ok: true }], async ({ port, requests }) => {
      const { code } = await runHook({ home: tls.home, port, stdin: JSON.stringify({ reason }) });
      assert.equal(code, 0);
      assert.equal(requests.length, 2, 'expected first close + one floor-note retry');
      const [first, retry] = requests.map((r) => r.body.params.arguments);
      assert.equal(first.reason, `session-end-hook:${reason}`);
      assert.equal(first.next_note, undefined);
      assert.equal(retry.action, 'close');
      assert.equal(retry.reason, `session-end-hook:${reason}`);
      assert.match(retry.next_note, /^WIP: \[auto-close: SessionEnd hook/m);
      assert.match(retry.next_note, /^NEXT: /m);
      assert.match(retry.next_note, /^LANE: <auto:hook>$/m);
    });
  });
}

// ── Reasons that MUST NOT close: zero requests, clean exit.
const NO_CLOSE = [
  ['clear', JSON.stringify({ reason: 'clear' })],
  ['resume (the measured incident)', JSON.stringify({ reason: 'resume' })],
  ['logout', JSON.stringify({ reason: 'logout' })],
  ['unknown future reason', JSON.stringify({ reason: 'foo' })],
  ['missing reason field', JSON.stringify({ session_id: 'x' })],
  ['empty stdin', null],
];

for (const [label, stdin] of NO_CLOSE) {
  test(`${label} → zero requests`, async () => {
    await withStub([], async ({ port, requests }) => {
      const { code } = await runHook({ home: tls.home, port, stdin });
      assert.equal(code, 0);
      assert.equal(requests.length, 0, `expected no network call, got ${requests.length}`);
    });
  });
}
