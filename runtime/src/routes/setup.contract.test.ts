// setup.contract.test.ts — proves the /ca/issue contract fix (P0, hivemind-runtime
// refinement plan, item 1.3): client request body + response destructure match the
// REAL server (engram apps/auth-service/src/ca/ca.controller.ts ENROLLMENT branch),
// not the old/never-existed { token, csr_pem } / { cert_pem, ca_cert_pem } shape.
//
// SANDBOX SAFETY: setup.ts derives the mTLS material path from `homedir()` (node:os),
// which is NOT overridable via env — only $HIVEMIND_HOME is. Without mocking
// node:os, this test would write (and OVERWRITE) real cert material into the
// developer's actual ~/.engram/mtls/ca.cert.pem. We mock node:os to redirect
// homedir() into an ephemeral tmp dir BEFORE importing setup.ts, and mock
// globalThis.fetch to intercept the /ca/issue call instead of a real network call.
import { test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testHome = mkdtempSync(join(tmpdir(), 'hivemind-setup-contract-'));

mock.module('node:os', () => ({
  homedir: () => testHome,
  tmpdir: () => tmpdir(),
}));

process.env.HIVEMIND_HOME = join(testHome, '.hivemind');
process.env.HIVEMIND_ENDPOINT = 'ca-test.invalid:4443';

const FAKE_CA_CERT_PEM = '-----BEGIN CERTIFICATE-----\nFAKE-CA-CERT\n-----END CERTIFICATE-----\n';
const FAKE_CLIENT_CERT_PEM = '-----BEGIN CERTIFICATE-----\nFAKE-CLIENT-CERT\n-----END CERTIFICATE-----\n';
const PLAINTEXT_TOKEN = 'plaintext-enrollment-token-xyz';
const OWNER_ID = 'contract-test-owner';
const API_KEY = 'test-api-key-1234567890';

let capturedUrl: string | undefined;
let capturedBody: unknown;
const originalFetch = globalThis.fetch;

// Intercept ONLY the /ca/issue call — everything else falls through to the
// real fetch (unused in this test, but keeps the mock honest/scoped).
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/ca/issue')) {
    capturedUrl = url;
    capturedBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        cert: FAKE_CLIENT_CERT_PEM,
        serial: 'deadbeef',
        token: 'fake.jwt.token',
        ca_cert_pem: FAKE_CA_CERT_PEM,
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  }
  return originalFetch(input, init);
}) as typeof fetch;

// Import AFTER the node:os mock + fetch mock are installed — setup.ts's
// module-level `const ENDPOINT = process.env.HIVEMIND_ENDPOINT ?? ...` reads
// the env var set above at import time.
const { setupRouter } = await import('./setup.js');

afterAll(() => {
  globalThis.fetch = originalFetch;
  rmSync(testHome, { recursive: true, force: true });
});

test('POST /enroll sends the REAL server request shape: { tenant, enrollment_token, csr }', async () => {
  const res = await setupRouter.request('/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: PLAINTEXT_TOKEN, owner_id: OWNER_ID, api_key: API_KEY }),
  });

  const data = (await res.json()) as { ok: boolean; owner_id?: string; message?: string };
  expect(data.ok).toBe(true);
  expect(data.owner_id).toBe(OWNER_ID);

  // Contract fix under test: NOT { token, csr_pem } (the old/never-real shape).
  // Enrollment goes over 443/LE — the host WITHOUT the :4443 MCP port (see ENROLL_HOST in setup.ts).
  expect(capturedUrl).toBe(`https://${process.env.HIVEMIND_ENDPOINT!.split(':')[0]}/ca/issue`);
  expect(capturedBody).toEqual({
    tenant: OWNER_ID,
    enrollment_token: PLAINTEXT_TOKEN,
    csr: expect.any(String),
  });
  expect((capturedBody as { csr: string }).csr).toContain('BEGIN CERTIFICATE REQUEST');
});

test('POST /enroll destructures the REAL server response shape and persists cert + CA cert', async () => {
  const ownerId = 'contract-test-owner-2';
  const res = await setupRouter.request('/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'another-token', owner_id: ownerId, api_key: API_KEY }),
  });
  const data = (await res.json()) as { ok: boolean };
  expect(data.ok).toBe(true);

  const mtlsDir = join(testHome, '.engram', 'mtls');
  const certPath = join(mtlsDir, `${ownerId}.cert.pem`);
  const caPath = join(mtlsDir, 'ca.cert.pem');

  expect(existsSync(certPath)).toBe(true);
  expect(existsSync(caPath)).toBe(true);
  // Contract fix under test: destructure reads `cert`/`ca_cert_pem`, NOT the
  // old `cert_pem` field (which the server never actually returned).
  expect(readFileSync(certPath, 'utf8')).toBe(FAKE_CLIENT_CERT_PEM);
  expect(readFileSync(caPath, 'utf8')).toBe(FAKE_CA_CERT_PEM);
});

test('POST /enroll writes $HIVEMIND_HOME/.claude/.claude.json merge-safely (item 5.1/F1, P1)', async () => {
  const ownerId = 'contract-test-owner-p1';
  const claudeDir = join(process.env.HIVEMIND_HOME!, '.claude');
  const claudeConfigPath = join(claudeDir, '.claude.json');

  // Pre-existing .claude.json with an arbitrary top-level key + another
  // mcpServers.* entry — both must survive the merge (P1 pitfall).
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    claudeConfigPath,
    JSON.stringify({
      someArbitraryKey: 'keep-me',
      mcpServers: { otherServer: { type: 'stdio', command: 'some-other-mcp' } },
    }),
  );

  const enroll = () =>
    setupRouter.request('/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'p1-token', owner_id: ownerId, api_key: API_KEY }),
    });

  // Run 1.
  const res1 = await enroll();
  expect((await res1.json() as { ok: boolean }).ok).toBe(true);
  const configAfterRun1 = JSON.parse(readFileSync(claudeConfigPath, 'utf8'));
  expect(configAfterRun1.someArbitraryKey).toBe('keep-me');
  expect(configAfterRun1.mcpServers.otherServer).toEqual({ type: 'stdio', command: 'some-other-mcp' });
  expect(configAfterRun1.mcpServers.engram).toEqual({
    type: 'http',
    url: 'http://127.0.0.1:7779/v1/mcp',
    headers: { 'x-fos-key': '${FOS_API_KEY}' },
  });

  // Run 2 (idempotency — re-running enrollment must not clobber the survivors).
  const res2 = await enroll();
  expect((await res2.json() as { ok: boolean }).ok).toBe(true);
  const configAfterRun2 = JSON.parse(readFileSync(claudeConfigPath, 'utf8'));
  expect(configAfterRun2).toEqual(configAfterRun1);

  // File mode: 0600, not 0644 (code-review hardening — the merge preserves
  // pre-existing Claude Code account metadata and rewrites the whole file).
  expect(statSync(claudeConfigPath).mode & 0o777).toBe(0o600);
});

test('POST /enroll self-heals a top-level `null` .claude.json instead of throwing (code-review hardening)', async () => {
  const ownerId = 'contract-test-owner-null-guard';
  const claudeDir = join(process.env.HIVEMIND_HOME!, '.claude');
  const claudeConfigPath = join(claudeDir, '.claude.json');

  // A syntactically-valid JSON document that is NOT a plain object: parses
  // fine (no try/catch trip), but `null.mcpServers` would throw if not
  // guarded — this must self-heal to {} per the declared contract
  // ("corrompido → {}, nunca aborta o enrollment"), not 500.
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(claudeConfigPath, 'null');

  const res = await setupRouter.request('/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'null-guard-token', owner_id: ownerId, api_key: API_KEY }),
  });

  expect(res.status).toBe(200);
  const data = (await res.json()) as { ok: boolean };
  expect(data.ok).toBe(true);

  const config = JSON.parse(readFileSync(claudeConfigPath, 'utf8'));
  expect(config.mcpServers.engram).toEqual({
    type: 'http',
    url: 'http://127.0.0.1:7779/v1/mcp',
    headers: { 'x-fos-key': '${FOS_API_KEY}' },
  });
});

test('POST /enroll fails cleanly (502) if the CA response is missing cert or ca_cert_pem', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ serial: 'x', token: 'y' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  try {
    const res = await setupRouter.request('/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'tok', owner_id: 'contract-test-owner-3', api_key: API_KEY }),
    });
    expect(res.status).toBe(502);
    const data = (await res.json()) as { ok: boolean; message?: string };
    expect(data.ok).toBe(false);
    // Message is pt-br copy — assert on the (untranslated) field names it
    // names, not a hardcoded English phrase. Word-boundary match on 'cert'
    // (not .toContain) — 'ca_cert_pem' also contains the substring 'cert',
    // so a plain .toContain('cert') would pass even if the standalone word
    // vanished from the message.
    expect(data.message).toMatch(/\bcert\b/);
    expect(data.message).toContain('ca_cert_pem');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

// ── Item 6.1 (Fase 6) — auth cert+chave: API Key field + x-fos-key header ────

test('POST /enroll rejects a body missing api_key (400)', async () => {
  const res = await setupRouter.request('/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'tok', owner_id: 'contract-test-owner-noapikey' }),
  });
  expect(res.status).toBe(400);
  const data = (await res.json()) as { ok: boolean; message?: string };
  expect(data.ok).toBe(false);
  expect(data.message).toMatch(/API Key/);
});

test('POST /enroll rejects an api_key shorter than 8 chars (400)', async () => {
  const res = await setupRouter.request('/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'tok', owner_id: 'contract-test-owner-shortkey', api_key: 'short' }),
  });
  expect(res.status).toBe(400);
  const data = (await res.json()) as { ok: boolean; message?: string };
  expect(data.ok).toBe(false);
  expect(data.message).toMatch(/API Key/);
});

test('POST /enroll rejects an api_key longer than 512 chars (400)', async () => {
  const res = await setupRouter.request('/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'tok', owner_id: 'contract-test-owner-longkey', api_key: 'x'.repeat(513) }),
  });
  expect(res.status).toBe(400);
  const data = (await res.json()) as { ok: boolean; message?: string };
  expect(data.ok).toBe(false);
  expect(data.message).toMatch(/API Key/);
});

test('POST /enroll rejects an api_key containing a newline (400, P-b guard against env.ts parser corruption)', async () => {
  const res = await setupRouter.request('/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'tok', owner_id: 'contract-test-owner-newlinekey', api_key: 'valid-looking\nkey-with-newline' }),
  });
  expect(res.status).toBe(400);
  const data = (await res.json()) as { ok: boolean; message?: string };
  expect(data.ok).toBe(false);
  expect(data.message).toMatch(/API Key/);
});

test('POST /enroll writes headers[\'x-fos-key\'] into mergedConfig.mcpServers.engram (item 6.1)', async () => {
  const ownerId = 'contract-test-owner-fos-key';
  const res = await setupRouter.request('/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'fos-key-token', owner_id: ownerId, api_key: API_KEY }),
  });
  expect((await res.json() as { ok: boolean }).ok).toBe(true);

  const claudeConfigPath = join(process.env.HIVEMIND_HOME!, '.claude', '.claude.json');
  const config = JSON.parse(readFileSync(claudeConfigPath, 'utf8'));
  // Literal template string, NOT the raw secret value — relies on the Claude
  // Code CLI http transport's ${VAR} expansion from the process env (measured
  // live, CLI v2.1.207: confirmed the header value IS expanded — see the
  // OPEN-cfg-A probe in the delivery report).
  expect(config.mcpServers.engram.headers).toEqual({ 'x-fos-key': '${FOS_API_KEY}' });
});

test('POST /enroll writes FOS_API_KEY=<pasted value> into $HIVEMIND_HOME/.env, mode 0600 (item 6.1)', async () => {
  const ownerId = 'contract-test-owner-envkey';
  const res = await setupRouter.request('/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'env-key-token', owner_id: ownerId, api_key: API_KEY }),
  });
  expect((await res.json() as { ok: boolean }).ok).toBe(true);

  const envPath = join(process.env.HIVEMIND_HOME!, '.env');
  const envContent = readFileSync(envPath, 'utf8');
  expect(envContent).toContain(`FOS_API_KEY=${API_KEY}`);
  expect(statSync(envPath).mode & 0o777).toBe(0o600);
});
