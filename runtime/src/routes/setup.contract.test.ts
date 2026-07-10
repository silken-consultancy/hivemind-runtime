// setup.contract.test.ts — proves the /ca/issue contract fix (P0, hivemind-runtime
// refinement plan, item 1.3): client request body + response destructure match the
// REAL server (engram apps/auth-service/src/ca/ca.controller.ts ENROLLMENT branch),
// not the old/never-existed { token, csr_pem } / { cert_pem, ca_cert_pem } shape.
//
// SANDBOX SAFETY: setup.ts derives the mTLS material path from `homedir()` (node:os),
// which is NOT overridable via env — only $HIVEMIND_HOME is. Without mocking
// node:os, this test would write (and OVERWRITE) real cert material into the
// developer's actual ~/.fos/mtls/ca.cert.pem. We mock node:os to redirect
// homedir() into an ephemeral tmp dir BEFORE importing setup.ts, and mock
// globalThis.fetch to intercept the /ca/issue call instead of a real network call.
import { test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
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
    body: JSON.stringify({ token: PLAINTEXT_TOKEN, owner_id: OWNER_ID }),
  });

  const data = (await res.json()) as { ok: boolean; owner_id?: string; message?: string };
  expect(data.ok).toBe(true);
  expect(data.owner_id).toBe(OWNER_ID);

  // Contract fix under test: NOT { token, csr_pem } (the old/never-real shape).
  expect(capturedUrl).toBe(`https://${process.env.HIVEMIND_ENDPOINT}/ca/issue`);
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
    body: JSON.stringify({ token: 'another-token', owner_id: ownerId }),
  });
  const data = (await res.json()) as { ok: boolean };
  expect(data.ok).toBe(true);

  const mtlsDir = join(testHome, '.fos', 'mtls');
  const certPath = join(mtlsDir, `${ownerId}.cert.pem`);
  const caPath = join(mtlsDir, 'ca.cert.pem');

  expect(existsSync(certPath)).toBe(true);
  expect(existsSync(caPath)).toBe(true);
  // Contract fix under test: destructure reads `cert`/`ca_cert_pem`, NOT the
  // old `cert_pem` field (which the server never actually returned).
  expect(readFileSync(certPath, 'utf8')).toBe(FAKE_CLIENT_CERT_PEM);
  expect(readFileSync(caPath, 'utf8')).toBe(FAKE_CA_CERT_PEM);
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
      body: JSON.stringify({ token: 'tok', owner_id: 'contract-test-owner-3' }),
    });
    expect(res.status).toBe(502);
    const data = (await res.json()) as { ok: boolean; message?: string };
    expect(data.ok).toBe(false);
    expect(data.message).toContain('cert or ca_cert_pem');
  } finally {
    globalThis.fetch = savedFetch;
  }
});
