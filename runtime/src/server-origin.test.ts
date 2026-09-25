// server-origin.test.ts — F2 (security impl 9658277f, items R1+R2): the
// daemon on 127.0.0.1:AR_PORT must not let a web page (or a stray local
// process without the launcher's one-shot nonce) re-enroll the user's
// runtime under another tenant's api_key.
//
// WHY A SUBPROCESS, NOT app.request(): server.ts is the unit under test — its
// route wiring (is /setup mounted in normal mode?), its global middleware
// (CORS, Origin, Content-Type) and its env handling (HIVEMIND_SETUP_NONCE) are
// exactly what F2 is about, and all of it lives in the module's top-level
// code, which also calls Bun.serve(). So each case boots the REAL server.ts on
// an ephemeral port, exactly as bin/hivemind does (`bun run server.ts
// [--setup-only]`), and talks HTTP to it.
//
// SANDBOX SAFETY: HOME and HIVEMIND_HOME point into a tmp dir (node:os
// homedir() honours $HOME), so enrollment side effects land there. The CA is
// unreachable on purpose (HIVEMIND_ENDPOINT=127.0.0.1:1 → https://127.0.0.1/
// ca/issue on :443, nothing listening), so no network leaves the box and no
// real cert is ever minted.
//
// HOW "the enroll handler ran" IS OBSERVED: the handler's first side effect
// (before the CA call) is mkdir ~/.engram/mtls. A request the guards refuse
// must leave that directory absent; a request that passes them creates it
// (and then fails at the unreachable CA with a 5xx — which is the expected
// outcome for the legit-path cases here, since no real CA is available).
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER = join(import.meta.dir, 'server.ts');
const root = mkdtempSync(join(tmpdir(), 'hivemind-server-origin-'));
const NONCE = 'a'.repeat(64);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const p = s.port as number;
  s.stop(true);
  return p;
}

interface Daemon {
  base: string;
  port: number;
  home: string;
  stop: () => Promise<void>;
}

let seq = 0;
async function boot(opts: { setupOnly: boolean; nonce?: string; extraEnv?: Record<string, string> }): Promise<Daemon> {
  const home = join(root, `case-${seq++}`);
  const port = freePort();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    HIVEMIND_HOME: join(home, '.hivemind'),
    HIVEMIND_ENDPOINT: '127.0.0.1:1',
    AR_PORT: String(port),
    AR_BIND: '127.0.0.1',
  };
  if (opts.nonce !== undefined) env.HIVEMIND_SETUP_NONCE = opts.nonce;
  Object.assign(env, opts.extraEnv ?? {});
  const proc = Bun.spawn(
    ['bun', 'run', SERVER, ...(opts.setupOnly ? ['--setup-only'] : [])],
    { env, stdout: 'ignore', stderr: 'ignore' },
  );
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`server.ts did not answer /healthz on ${port} within 10s`);
    }
    await Bun.sleep(100);
  }
  return {
    base,
    port,
    home,
    stop: async () => {
      proc.kill('SIGKILL');
      await proc.exited;
    },
  };
}

const handlerRan = (d: Daemon) => existsSync(join(d.home, '.engram', 'mtls'));

// ── R1 ────────────────────────────────────────────────────────────────────────

test('R1: cross-origin text/plain POST /setup/enroll (the CSRF "simple request") is refused 403 before the handler runs', async () => {
  const d = await boot({ setupOnly: true, nonce: NONCE });
  try {
    const res = await fetch(`${d.base}/setup/enroll`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ api_key: 'attacker-tenant-key-123456' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden_origin' });
    // No wildcard CORS any more — nothing invites a cross-origin read.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(handlerRan(d)).toBe(false);
  } finally {
    await d.stop();
  }
});

test('R1: a same-origin POST without Content-Type application/json is refused 415 before the handler runs', async () => {
  const d = await boot({ setupOnly: true, nonce: NONCE });
  try {
    const res = await fetch(`${d.base}/setup/enroll`, {
      method: 'POST',
      headers: { Origin: d.base, 'Content-Type': 'text/plain', 'x-setup-nonce': NONCE },
      body: JSON.stringify({ api_key: 'attacker-tenant-key-123456' }),
    });
    expect(res.status).toBe(415);
    expect(handlerRan(d)).toBe(false);
  } finally {
    await d.stop();
  }
});

test('R1: a cross-origin CORS preflight gets no allow-origin grant', async () => {
  const d = await boot({ setupOnly: true, nonce: NONCE });
  try {
    const res = await fetch(`${d.base}/setup/enroll`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-setup-nonce',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  } finally {
    await d.stop();
  }
});

test('R1: in NORMAL mode /setup is not mounted — POST /setup/enroll and GET /setup are 404', async () => {
  const d = await boot({ setupOnly: false });
  try {
    const res = await fetch(`${d.base}/setup/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: 'attacker-tenant-key-123456' }),
    });
    expect(res.status).toBe(404);
    expect((await fetch(`${d.base}/setup`)).status).toBe(404);
    expect(handlerRan(d)).toBe(false);
  } finally {
    await d.stop();
  }
});

test('R1: POST /sessions/adopt with a foreign Origin is refused 403', async () => {
  const d = await boot({ setupOnly: false });
  try {
    const res = await fetch(`${d.base}/sessions/adopt`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'x', pid: 1, slug: 'x' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden_origin' });
  } finally {
    await d.stop();
  }
});

test('R1 (no regression): the launcher\'s curl shapes still pass — no Origin + JSON on /sessions/adopt, bare GETs on /healthz and /sessions', async () => {
  const d = await boot({ setupOnly: false });
  try {
    // Invalid body on purpose: we only care that the guard let it through to
    // the route's own validation (400), not that a session got adopted.
    const res = await fetch(`${d.base}/sessions/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await fetch(`${d.base}/healthz`)).status).toBe(200);
    expect((await fetch(`${d.base}/sessions`)).status).toBe(200);
  } finally {
    await d.stop();
  }
});

// ── Round 2: DNS rebinding (Host allowlist) ──────────────────────────────────
// A page on evil.example that rebinds its DNS to 127.0.0.1 is SAME-ORIGIN with
// itself, so the browser sends no Origin on its GETs — the Origin rule cannot
// see it. What it cannot fake is the Host header: the browser sends the
// attacker's hostname. Sent over a raw socket so the Host header is exactly
// what we write (fetch() may normalise it).
async function rawGet(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    let buf = '';
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(sock) {
          sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
        },
        data(_sock, chunk) { buf += Buffer.from(chunk).toString('utf8'); },
        close() {
          const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
          if (!m) return reject(new Error(`no HTTP status in: ${buf.slice(0, 200)}`));
          resolve({ status: Number(m[1]), body: buf.slice(buf.indexOf('\r\n\r\n') + 4) });
        },
        error(_sock, err) { reject(err); },
      },
    }).catch(reject);
  });
}

test('DNS rebinding: GET /sessions with a foreign Host (no Origin) is refused 403 forbidden_host', async () => {
  const d = await boot({ setupOnly: false });
  try {
    const res = await rawGet(d.port, '/sessions', 'evil.example');
    expect(res.status).toBe(403);
    expect(res.body).toContain('forbidden_host');
    // Right hostname, wrong port (another local service's rebinding) — also refused.
    expect((await rawGet(d.port, '/sessions', `127.0.0.1:${d.port + 1}`)).status).toBe(403);
    expect((await rawGet(d.port, '/healthz', `evil.example:${d.port}`)).status).toBe(403);
  } finally {
    await d.stop();
  }
});

test('DNS rebinding: GET /setup (the nonce-bearing page) with a foreign Host is refused 403', async () => {
  const d = await boot({ setupOnly: true, nonce: NONCE });
  try {
    const res = await rawGet(d.port, `/setup?nonce=${NONCE}`, `evil.example:${d.port}`);
    expect(res.status).toBe(403);
    expect(res.body).not.toContain(NONCE);
  } finally {
    await d.stop();
  }
});

test('Host allowlist (no regression): exactly 127.0.0.1:<port> and localhost:<port> are accepted', async () => {
  const d = await boot({ setupOnly: false });
  try {
    expect((await rawGet(d.port, '/sessions', `127.0.0.1:${d.port}`)).status).toBe(200);
    expect((await rawGet(d.port, '/healthz', `localhost:${d.port}`)).status).toBe(200);
    // What bin/hivemind's curl actually sends (curl derives Host from the URL).
    const curl = Bun.spawnSync(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${d.port}/sessions`]);
    expect(curl.stdout.toString()).toBe('200');
  } finally {
    await d.stop();
  }
});

test('round 3 edge: Origin: null (sandboxed iframe / file://) is refused 403', async () => {
  const d = await boot({ setupOnly: true, nonce: NONCE });
  try {
    const res = await fetch(`${d.base}/setup/enroll`, {
      method: 'POST',
      headers: { Origin: 'null', 'Content-Type': 'application/json', 'x-setup-nonce': NONCE },
      body: JSON.stringify({ api_key: 'attacker-tenant-key-123456' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden_origin' });
    expect(handlerRan(d)).toBe(false);
  } finally {
    await d.stop();
  }
});

test('round 3 edge: Host variants — trailing dot and [::1] are refused, an uppercase hostname is accepted (hostnames are case-insensitive)', async () => {
  const d = await boot({ setupOnly: false });
  try {
    expect((await rawGet(d.port, '/sessions', `localhost.:${d.port}`)).status).toBe(403);
    expect((await rawGet(d.port, '/sessions', `127.0.0.1.:${d.port}`)).status).toBe(403);
    expect((await rawGet(d.port, '/sessions', `[::1]:${d.port}`)).status).toBe(403);
    expect((await rawGet(d.port, '/sessions', `LOCALHOST:${d.port}`)).status).toBe(200);
  } finally {
    await d.stop();
  }
});

// ── R2 ────────────────────────────────────────────────────────────────────────

test('R2: a same-origin JSON POST /setup/enroll WITHOUT the setup nonce is refused 403 before the handler runs', async () => {
  const d = await boot({ setupOnly: true, nonce: NONCE });
  try {
    const res = await fetch(`${d.base}/setup/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: 'attacker-tenant-key-123456' }),
    });
    expect(res.status).toBe(403);
    expect(handlerRan(d)).toBe(false);
  } finally {
    await d.stop();
  }
});

test('R2: a WRONG setup nonce is refused 403 before the handler runs', async () => {
  const d = await boot({ setupOnly: true, nonce: NONCE });
  try {
    const res = await fetch(`${d.base}/setup/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-setup-nonce': 'b'.repeat(64) },
      body: JSON.stringify({ api_key: 'attacker-tenant-key-123456' }),
    });
    expect(res.status).toBe(403);
    expect(handlerRan(d)).toBe(false);
  } finally {
    await d.stop();
  }
});

test('R2: a setup daemon started WITHOUT a nonce fails closed — no enroll is possible', async () => {
  const d = await boot({ setupOnly: true });
  try {
    const res = await fetch(`${d.base}/setup/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-setup-nonce': '' },
      body: JSON.stringify({ api_key: 'attacker-tenant-key-123456' }),
    });
    expect(res.status).toBe(403);
    expect(handlerRan(d)).toBe(false);
  } finally {
    await d.stop();
  }
});

test('R1+R2 legit launcher flow: GET /setup?nonce=… embeds it, and the page\'s same-origin JSON POST with it reaches the enroll handler', async () => {
  const d = await boot({ setupOnly: true, nonce: NONCE });
  try {
    // bin/hivemind opens http://localhost:<port>/setup?nonce=<hex>.
    const page = await fetch(`http://localhost:${d.port}/setup?nonce=${NONCE}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(NONCE);
    expect(html).toContain('x-setup-nonce');

    // What the page's fetch sends: same origin (localhost), JSON, the nonce header.
    const res = await fetch(`http://localhost:${d.port}/setup/enroll`, {
      method: 'POST',
      headers: {
        Origin: `http://localhost:${d.port}`,
        'Content-Type': 'application/json',
        'x-setup-nonce': NONCE,
      },
      body: JSON.stringify({ api_key: 'legit-user-api-key-123456' }),
    });
    // Passed every guard: the handler ran (mtls dir created) and only then
    // failed at the deliberately-unreachable CA — a 5xx, not a 403/415.
    expect(handlerRan(d)).toBe(true);
    expect([500, 502]).toContain(res.status);
  } finally {
    await d.stop();
  }
});

test('R2: GET /setup never reflects a non-hex nonce into the page (no script injection via the query)', async () => {
  const d = await boot({ setupOnly: true, nonce: NONCE });
  try {
    const evil = `</script><script>alert(1)</script>`;
    const html = await (await fetch(`${d.base}/setup?nonce=${encodeURIComponent(evil)}`)).text();
    expect(html).not.toContain(evil);
    expect(html).not.toContain('alert(1)');
  } finally {
    await d.stop();
  }
});

// ── Round 3: the nonce must not leak into the enroll handler's children ──────
// server.ts deletes HIVEMIND_SETUP_NONCE from process.env, but Bun.spawnSync
// WITHOUT an explicit `env` still hands children the env snapshot the process
// started with (measured, Bun 1.4.0) — so the delete alone was not enough. A
// fake `openssl` first on PATH records the environment it actually received,
// then execs the real openssl so the enroll proceeds normally.
test('R2/round 3: the openssl child spawned by /enroll does NOT receive HIVEMIND_SETUP_NONCE', async () => {
  const realOpenssl = Bun.which('openssl');
  expect(realOpenssl).toBeTruthy();
  const shimDir = join(root, 'openssl-shim');
  mkdirSync(shimDir, { recursive: true });
  const dump = join(shimDir, 'child-env.txt');
  const shim = join(shimDir, 'openssl');
  writeFileSync(shim, `#!/bin/sh\n/usr/bin/env >> "${dump}"\necho '---' >> "${dump}"\nexec "${realOpenssl}" "$@"\n`);
  chmodSync(shim, 0o755);

  const d = await boot({
    setupOnly: true,
    nonce: NONCE,
    extraEnv: { PATH: `${shimDir}:${process.env.PATH ?? ''}` },
  });
  try {
    const res = await fetch(`${d.base}/setup/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-setup-nonce': NONCE },
      body: JSON.stringify({ api_key: 'legit-user-api-key-123456' }),
    });
    // The handler ran the keypair/CSR openssl, then failed at the unreachable CA.
    expect([500, 502]).toContain(res.status);
    expect(existsSync(dump)).toBe(true);
    const childEnv = readFileSync(dump, 'utf8');
    expect(childEnv).toContain('PATH=');            // the shim really captured an env
    expect(childEnv).not.toContain('HIVEMIND_SETUP_NONCE');
    expect(childEnv).not.toContain(NONCE);
  } finally {
    await d.stop();
  }
});
