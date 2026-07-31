// setup.contract.test.ts — proves the /ca/issue contract fix:
// client request body + response destructure match the
// REAL server's enrollment contract,
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

// A REAL, parseable certificate — needed by the CN-fallback tests below, which
// assert on what `openssl x509 -noout -subject` reads back. The PEM above is a
// placeholder string with no ASN.1 in it, so it deliberately CANNOT stand in
// here: it is what the "both sources unusable" test uses to prove the hard
// failure still exists. Self-signed and generated on the fly (openssl is
// already a hard dependency of the handler under test, which shells out to it
// for the keypair/CSR) — nothing verifies this chain, only its subject is read.
const CN_TENANT = 'cn-derived-tenant';
let fixtureSeq = 0;
function makeCert(subj: string): string {
  const id = `cn-fixture-${fixtureSeq++}`;
  const certPath = join(testHome, `${id}.cert.pem`);
  const res = Bun.spawnSync([
    'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(testHome, `${id}.key.pem`), '-out', certPath, '-days', '1',
    '-subj', subj,
  ], { stdout: 'ignore', stderr: 'pipe' });
  if (res.exitCode !== 0) {
    throw new Error(`fixture cert generation failed for '${subj}': ${res.stderr?.toString()}`);
  }
  return readFileSync(certPath, 'utf8');
}

// Multi-RDN subject → openssl 3.x renders `subject=C = BR, O = Silken, CN = x`.
const REAL_CERT_PEM = makeCert(`/C=BR/O=Silken/CN=${CN_TENANT}`);
// Bare-CN subject → `subject=CN = x`, i.e. the label's own `=` sits immediately
// before the CN. A separate fixture because that one character is the whole
// difference: an RDN-boundary match that does not strip the `subject=` label
// first reads the multi-RDN form fine and misses this one entirely (it did, in
// review). This is also the likelier shape for a CA that sets only the CN.
const BARE_CN_CERT_PEM = makeCert(`/CN=${CN_TENANT}`);
const API_KEY = 'test-api-key-1234567890';
// The CA response now RESOLVES identity server-side — the client no longer
// types/asserts an owner_id at all, only the api_key. Each test that needs a
// distinct on-disk identity sets FAKE_TENANT before calling /enroll (the
// mocked fetch below reads it live, not a snapshot at module-load time).
let FAKE_TENANT = 'contract-test-tenant';

let capturedUrl: string | undefined;
let capturedBody: unknown;
const originalFetch = globalThis.fetch;

// Intercept ONLY the /ca/issue call — everything else falls through to the
// real fetch (unused in this test, but keeps the mock honest/scoped).
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
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
        tenant: FAKE_TENANT,
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

test('POST /enroll sends the REAL server request shape: { csr, api_key } — NO client-typed identity', async () => {
  FAKE_TENANT = 'contract-test-tenant-1';
  const res = await setupRouter.request('/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: API_KEY }),
  });

  const data = (await res.json()) as { ok: boolean; tenant?: string; message?: string };
  expect(data.ok).toBe(true);
  // Identity is server-resolved: the response's `tenant` — never client-asserted.
  expect(data.tenant).toBe(FAKE_TENANT);

  // Contract under test: key-as-bootstrap. enrollment_token is RETIRED — the
  // api_key resolves the tenant server-side (cert CN = the key's tenant), so the
  // body carries NO `owner_id`, NO `tenant`, NO `enrollment_token`, only { csr, api_key }.
  // Enrollment goes over 443/LE — the host WITHOUT the :4443 MCP port (see ENROLL_HOST in setup.ts).
  expect(capturedUrl).toBe(`https://${process.env.HIVEMIND_ENDPOINT!.split(':')[0]}/ca/issue`);
  expect(capturedBody).toEqual({
    csr: expect.any(String),
    api_key: API_KEY,
  });
  expect((capturedBody as { csr: string }).csr).toContain('BEGIN CERTIFICATE REQUEST');
});

test('POST /enroll destructures the REAL server response shape and persists cert + CA cert under the TENANT name', async () => {
  FAKE_TENANT = 'contract-test-tenant-2';
  const res = await setupRouter.request('/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: API_KEY }),
  });
  const data = (await res.json()) as { ok: boolean };
  expect(data.ok).toBe(true);

  const mtlsDir = join(testHome, '.engram', 'mtls');
  // File-rename mechanic: written under a temp id, then renamed to
  // `${tenant}.{key,cert}.pem` once the response's tenant is known — so the
  // FINAL on-disk name is the server-resolved tenant, not anything typed.
  const keyPath = join(mtlsDir, `${FAKE_TENANT}.key.pem`);
  const certPath = join(mtlsDir, `${FAKE_TENANT}.cert.pem`);
  const caPath = join(mtlsDir, 'ca.cert.pem');

  expect(existsSync(keyPath)).toBe(true);
  expect(existsSync(certPath)).toBe(true);
  expect(existsSync(caPath)).toBe(true);
  // Contract fix under test: destructure reads `cert`/`ca_cert_pem`, NOT the
  // old `cert_pem` field (which the server never actually returned).
  expect(readFileSync(certPath, 'utf8')).toBe(FAKE_CLIENT_CERT_PEM);
  expect(readFileSync(caPath, 'utf8')).toBe(FAKE_CA_CERT_PEM);
});

test('POST /enroll writes $HIVEMIND_HOME/.claude/.claude.json merge-safely (item 5.1/F1, P1)', async () => {
  FAKE_TENANT = 'contract-test-tenant-p1';
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
      body: JSON.stringify({ api_key: API_KEY }),
    });

  // Run 1.
  const res1 = await enroll();
  expect((await res1.json() as { ok: boolean }).ok).toBe(true);
  const configAfterRun1 = JSON.parse(readFileSync(claudeConfigPath, 'utf8'));
  expect(configAfterRun1.someArbitraryKey).toBe('keep-me');
  expect(configAfterRun1.mcpServers.otherServer).toEqual({ type: 'stdio', command: 'some-other-mcp' });
  // https:// + no headers (atomic-flip, round-2 2026-07-30): the loopback
  // listener is HTTPS-only now (mtls-proxy.ts item 1.1(B)) and injects
  // x-fos-key server-side (item 1.1(A)) — Claude Code's own config carries
  // zero secret material.
  expect(configAfterRun1.mcpServers.engram).toEqual({
    type: 'http',
    url: 'https://127.0.0.1:7779/v1/mcp',
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
  FAKE_TENANT = 'contract-test-tenant-null-guard';
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
    body: JSON.stringify({ api_key: API_KEY }),
  });

  expect(res.status).toBe(200);
  const data = (await res.json()) as { ok: boolean };
  expect(data.ok).toBe(true);

  const config = JSON.parse(readFileSync(claudeConfigPath, 'utf8'));
  expect(config.mcpServers.engram).toEqual({
    type: 'http',
    url: 'https://127.0.0.1:7779/v1/mcp',
  });
});

test('POST /enroll fails cleanly (502) if the CA response is missing cert or ca_cert_pem', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ serial: 'x', token: 'y' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

  try {
    const res = await setupRouter.request('/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: API_KEY }),
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

// ── CN fallback (2026-07-31) ─────────────────────────────────────────────────
// A missing `tenant` in the /ca/issue response used to hard-fail enrollment
// (502) and throw away a validly-issued certificate. It now falls back to the
// CN of that very certificate — the CA sets CN = tenant, so the identity was
// always present in a second place the client already held. Only BOTH sources
// being unusable is fatal.

// enrollWithCaResponse — run one /enroll against a stubbed CA response body,
// restoring the shared fetch mock afterwards. The CN-fallback cases all differ
// only in that body, so they share this instead of re-stubbing by hand.
async function enrollWithCaResponse(caBody: Record<string, unknown>) {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(caBody), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  try {
    const res = await setupRouter.request('/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: API_KEY }),
    });
    return { res, data: (await res.json()) as { ok: boolean; tenant?: string; message?: string } };
  } finally {
    globalThis.fetch = savedFetch;
  }
}

test('POST /enroll derives the tenant from the issued cert CN when the CA response omits `tenant`', async () => {
  const { res, data } = await enrollWithCaResponse({
    cert: REAL_CERT_PEM,
    serial: 'x',
    token: 'y',
    ca_cert_pem: FAKE_CA_CERT_PEM,
    // no `tenant` — exactly the stale-server response that broke enrollment.
  });

  expect(res.status).toBe(200);
  expect(data.ok).toBe(true);
  expect(data.tenant).toBe(CN_TENANT);

  // The derived identity is used everywhere the response field would have
  // been: the on-disk cert/key names, and HIVEMIND_OWNER in .env — i.e. the
  // enrollment is COMPLETE, not merely non-fatal.
  const mtlsDir = join(testHome, '.engram', 'mtls');
  expect(existsSync(join(mtlsDir, `${CN_TENANT}.key.pem`))).toBe(true);
  expect(existsSync(join(mtlsDir, `${CN_TENANT}.cert.pem`))).toBe(true);
  expect(readFileSync(join(process.env.HIVEMIND_HOME!, '.env'), 'utf8'))
    .toContain(`HIVEMIND_OWNER=${CN_TENANT}`);
});

test('POST /enroll reads the CN from a bare-CN subject too, not only a multi-RDN one', async () => {
  const { res, data } = await enrollWithCaResponse({
    cert: BARE_CN_CERT_PEM,
    serial: 'x',
    token: 'y',
    ca_cert_pem: FAKE_CA_CERT_PEM,
  });

  expect(res.status).toBe(200);
  expect(data.ok).toBe(true);
  expect(data.tenant).toBe(CN_TENANT);
});

test('POST /enroll refuses a cert whose CN would escape the cert directory (502, no traversal)', async () => {
  // The derived CN lands in join(mtlsDir, `${tenant}.cert.pem`), so the shape
  // check is what stands between a hostile CN and a write outside ~/.engram/mtls.
  // A CA would have to be compromised to sign this, but the fallback must not be
  // the reason a compromised CA gets a filesystem write — it validates the CN by
  // the SAME rule the response field has always been held to.
  const { res, data } = await enrollWithCaResponse({
    cert: makeCert('/CN=..\\/..\\/..\\/etc\\/passwd'),
    serial: 'x',
    token: 'y',
    ca_cert_pem: FAKE_CA_CERT_PEM,
  });

  expect(res.status).toBe(502);
  expect(data.ok).toBe(false);
  expect(existsSync(join(testHome, '.engram', 'mtls', '..', '..', '..', 'etc', 'passwd.cert.pem'))).toBe(false);
});

test('POST /enroll falls back to the cert CN when the CA response `tenant` is present but malformed', async () => {
  // A shape-invalid tenant is as unusable as an absent one (it would land in a
  // filesystem path) — it must take the SAME fallback, not be trusted and not
  // hard-fail while a usable CN is right there.
  const { res, data } = await enrollWithCaResponse({
    cert: REAL_CERT_PEM,
    serial: 'x',
    token: 'y',
    ca_cert_pem: FAKE_CA_CERT_PEM,
    tenant: '../../etc/passwd',
  });

  expect(res.status).toBe(200);
  expect(data.ok).toBe(true);
  expect(data.tenant).toBe(CN_TENANT);
});

test('POST /enroll still prefers the CA response `tenant` over the cert CN when both are usable', async () => {
  // The fallback must not become the primary path: when the server sends a
  // valid tenant it stays authoritative, even against a cert whose CN differs.
  const { res, data } = await enrollWithCaResponse({
    cert: REAL_CERT_PEM,
    serial: 'x',
    token: 'y',
    ca_cert_pem: FAKE_CA_CERT_PEM,
    tenant: 'response-tenant-wins',
  });

  expect(res.status).toBe(200);
  expect(data.ok).toBe(true);
  expect(data.tenant).toBe('response-tenant-wins');
  expect(data.tenant).not.toBe(CN_TENANT);
});

test('POST /enroll fails cleanly (502) only when BOTH the response tenant AND the cert CN are unusable', async () => {
  // FAKE_CLIENT_CERT_PEM is a placeholder string, not a parseable certificate,
  // so openssl cannot read a subject from it — no tenant from either source.
  const { res, data } = await enrollWithCaResponse({
    cert: FAKE_CLIENT_CERT_PEM,
    serial: 'x',
    token: 'y',
    ca_cert_pem: FAKE_CA_CERT_PEM,
  });

  expect(res.status).toBe(502);
  expect(data.ok).toBe(false);
  expect(data.message).toMatch(/tenant/);
  // The message must now name the fallback it also tried — a bare "no tenant"
  // would send the next debugger back down the wrong path.
  expect(data.message).toMatch(/CN/);
});

// ── Item 6.1 (Fase 6) — auth cert+chave: API Key field ───────────────────────
// (the x-fos-key HEADER half of item 6.1 was superseded by the round-2
// atomic-flip, 2026-07-30 — see the dedicated test below.)

test('POST /enroll rejects a body missing api_key (400)', async () => {
  const res = await setupRouter.request('/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
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
    body: JSON.stringify({ api_key: 'short' }),
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
    body: JSON.stringify({ api_key: 'x'.repeat(513) }),
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
    body: JSON.stringify({ api_key: 'valid-looking\nkey-with-newline' }),
  });
  expect(res.status).toBe(400);
  const data = (await res.json()) as { ok: boolean; message?: string };
  expect(data.ok).toBe(false);
  expect(data.message).toMatch(/API Key/);
});

test('POST /enroll writes mergedConfig.mcpServers.engram with NO headers — zero secret material (atomic-flip, round-2 2026-07-30)', async () => {
  FAKE_TENANT = 'contract-test-tenant-fos-key';
  const res = await setupRouter.request('/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: API_KEY }),
  });
  expect((await res.json() as { ok: boolean }).ok).toBe(true);

  const claudeConfigPath = join(process.env.HIVEMIND_HOME!, '.claude', '.claude.json');
  const config = JSON.parse(readFileSync(claudeConfigPath, 'utf8'));
  // Supersedes the old item 6.1 headers['x-fos-key']:'${FOS_API_KEY}' template
  // (+ its OPEN-cfg-A live-expansion proof) — the proxy now injects the
  // credential server-side (mtls-proxy.ts item 1.1(A)), so this file must
  // carry no `headers` key at all, and definitely no reference to the key.
  expect(config.mcpServers.engram.headers).toBeUndefined();
  expect(JSON.stringify(config.mcpServers.engram)).not.toContain('FOS_API_KEY');
});

test('POST /enroll writes FOS_API_KEY=<pasted value> + HIVEMIND_OWNER=<tenant> into $HIVEMIND_HOME/.env, mode 0600 (item 6.1)', async () => {
  FAKE_TENANT = 'contract-test-tenant-envkey';
  const res = await setupRouter.request('/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: API_KEY }),
  });
  expect((await res.json() as { ok: boolean }).ok).toBe(true);

  const envPath = join(process.env.HIVEMIND_HOME!, '.env');
  const envContent = readFileSync(envPath, 'utf8');
  expect(envContent).toContain(`FOS_API_KEY=${API_KEY}`);
  // HIVEMIND_OWNER is now the server-resolved tenant — never a client-typed value.
  expect(envContent).toContain(`HIVEMIND_OWNER=${FAKE_TENANT}`);
  expect(statSync(envPath).mode & 0o777).toBe(0o600);
});
