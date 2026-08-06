// mtls-proxy.test.ts — unit tests for the Option 2 N-listener proxy
// (fos_decision 1caee6a7, item 46d0eeed): port-map parsing, the
// x-fos-device-id force-set/strip injection logic, and the bind/reload
// orchestration (default port + one pinned listener per port-map entry,
// EADDRINUSE-per-port isolation, additive hot-reload).
//
// SANDBOX SAFETY: mtls-proxy.ts's readPortMap/bindDefaultAndMappedListeners/
// bindNewMappedListeners all take an explicit `stateDir` parameter
// (defaulting to the real ~/.engram/mtls) instead of reading a module-level
// homedir()-derived constant — so this file can point every case at an
// ephemeral tmp dir via a PLAIN static import + explicit argument, with NO
// env-var override, NO mock.module('node:os', ...), and NO dynamic import.
//
// FILE LOCATION IS DELIBERATE — top-level src/, NOT src/lib/ alongside the
// module under test. Measured live: this file, byte-for-byte, hangs `bun
// test` entirely (no output at all, not even the banner) whenever run
// together with src/routes/setup.contract.test.ts IF placed in src/lib/
// (co-located with mtls-proxy.ts/env.ts, both of which setup.contract.test.ts
// also transitively imports via setup.ts) — reproduced independent of
// import style (dynamic vs static) and independent of mock.module usage
// (mock.module('node:os', ...) was tried first and separately rejected: it
// is process-global for the whole `bun test` run, and this file's own
// mock collided with setup.contract.test.ts's INDEPENDENT node:os mock,
// corrupting/racing each other's openssl-generated cert material). The SAME
// content at src/ top level (this file's actual location — matching where
// hivemind-cli.test.ts/merge-settings-json.test.ts already live in this
// repo) runs cleanly every time. Looks like a Bun bundler/watcher quirk tied
// to a test file sharing a directory with actively cross-imported modules,
// not a bug in either module's own logic — moving the file, plus
// parameterizing mtls-proxy.ts's functions (see its DEFAULT_MTLS_STATE_DIR
// comment) so no env-var/mock trick is needed at all, is the fix.
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPortMap,
  buildUpstreamRequestHeaders,
  bindDefaultAndMappedListeners,
  bindNewMappedListeners,
  type MtlsProxyCfg,
} from './lib/mtls-proxy.ts';

const testHome = mkdtempSync(join(tmpdir(), 'mtls-proxy-test-'));
const STATE_DIR = join(testHome, '.engram', 'mtls');

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

const PORT_MAP_PATH = join(STATE_DIR, 'port-map.json');

function writePortMap(entries: unknown[]): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PORT_MAP_PATH, JSON.stringify({ version: 1, entries }));
}

// Dummy outbound (proxy→engram) cert material — bindProxyListener only ever
// reads these as raw bytes (readFileSync) for the OUTBOUND fetch() tls
// option, which none of these bind/reload tests actually exercise (no real
// request is made through the listeners). Only the INBOUND local-https
// listener cert must be real, parseable TLS material — and that one is
// generated for real via openssl (ensureLocalHttpsCert, unchanged) into
// STATE_DIR/local-https, passed explicitly via cfgFor's callers below.
const outboundCertDir = join(testHome, 'outbound-certs');
mkdirSync(outboundCertDir, { recursive: true });
const certPath = join(outboundCertDir, 'client.cert.pem');
const keyPath = join(outboundCertDir, 'client.key.pem');
const caPath = join(outboundCertDir, 'ca.cert.pem');
writeFileSync(certPath, 'dummy-cert-bytes');
writeFileSync(keyPath, 'dummy-key-bytes');
writeFileSync(caPath, 'dummy-ca-bytes');

let _nextPort = 19100;
// Ports climb monotonically across the whole test file so no two cases ever
// contend for the same port, even though every server.stop(true) call below
// is best-effort-immediate (no explicit wait-for-close).
function allocPorts(n: number): number[] {
  const start = _nextPort;
  _nextPort += n + 3;
  return Array.from({ length: n }, (_, i) => start + i);
}

function cfgFor(port: number): MtlsProxyCfg {
  return { port, upstream: 'https://127.0.0.1:1/v1/mcp', certPath, keyPath, caPath };
}

function stopAll(servers: Array<{ stop: (force: boolean) => void }>): void {
  for (const s of servers) s.stop(true);
}

// ── readPortMap ──────────────────────────────────────────────────────────────

test('readPortMap returns [] when port-map.json does not exist', () => {
  // Runs before any other case in this file writes PORT_MAP_PATH under the
  // shared STATE_DIR (bun:test runs a file's top-level `test()` cases in
  // declaration order) — so the file is genuinely absent here.
  expect(readPortMap(STATE_DIR)).toEqual([]);
});

test('readPortMap parses a valid file', () => {
  writePortMap([
    { path: '/home/u/.cursor/mcp.json', target_id: 'cursor', scope: 'global', port: 7780, device_id: 'dev-1' },
    { path: '/home/u/proj/.cursor/mcp.json', target_id: 'cursor', scope: 'project', port: 7781, device_id: 'dev-2' },
  ]);
  const entries = readPortMap(STATE_DIR);
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({ port: 7780, device_id: 'dev-1' });
  expect(entries[1]).toMatchObject({ port: 7781, device_id: 'dev-2' });
});

test('readPortMap degrades to [] on a corrupted (unparseable) file — never throws', () => {
  writePortMap([]); // reset via valid write first
  writeFileSync(PORT_MAP_PATH, '{not valid json');
  expect(readPortMap(STATE_DIR)).toEqual([]);
});

test('readPortMap degrades to [] when `entries` is missing or not an array', () => {
  writeFileSync(PORT_MAP_PATH, JSON.stringify({ version: 1 }));
  expect(readPortMap(STATE_DIR)).toEqual([]);
  writeFileSync(PORT_MAP_PATH, JSON.stringify({ version: 1, entries: 'not-an-array' }));
  expect(readPortMap(STATE_DIR)).toEqual([]);
});

test('readPortMap filters out entries missing a numeric port or a string device_id', () => {
  writePortMap([
    { path: '/a', port: 7780, device_id: 'dev-ok' },
    { path: '/b', port: 'not-a-number', device_id: 'dev-bad-port' },
    { path: '/c', device_id: 'dev-missing-port' },
    { path: '/d', port: 7781 }, // missing device_id
    'not-even-an-object',
  ]);
  const entries = readPortMap(STATE_DIR);
  expect(entries).toEqual([{ path: '/a', port: 7780, device_id: 'dev-ok' }]);
});

test('readPortMap defaults to the real ~/.engram/mtls when called with no argument', () => {
  // Not exercised against the real filesystem (would touch the developer's
  // actual home dir) — just proves the parameter is truly optional at the
  // type level and the function does not throw when omitted.
  expect(() => readPortMap()).not.toThrow();
});

// ── buildUpstreamRequestHeaders — the force-set/strip injection logic ───────
// Mirrors the existing, already-shipped x-fos-key pattern EXACTLY for the new
// x-fos-device-id header: this is the actual unspoofability mechanism (item
// 46d0eeed's acceptance gate) — proxy is the SOLE writer on every port.

test('pinned port: ALWAYS sets x-fos-device-id to the pinned id, overwriting whatever the client sent', () => {
  const reqHeaders = new Headers({ 'x-fos-device-id': 'client-supplied-spoof-attempt' });
  const out = buildUpstreamRequestHeaders(reqHeaders, {
    upstreamHost: 'engram.example:4443',
    pinnedDeviceId: 'real-pinned-device-id',
  });
  expect(out.get('x-fos-device-id')).toBe('real-pinned-device-id');
});

test('pinned port: sets x-fos-device-id even when the client sent none at all', () => {
  const out = buildUpstreamRequestHeaders(new Headers(), {
    upstreamHost: 'engram.example:4443',
    pinnedDeviceId: 'real-pinned-device-id',
  });
  expect(out.get('x-fos-device-id')).toBe('real-pinned-device-id');
});

test('shared/default port: ALWAYS strips x-fos-device-id even if the client tried to send one', () => {
  const reqHeaders = new Headers({ 'x-fos-device-id': 'client-supplied-spoof-attempt' });
  const out = buildUpstreamRequestHeaders(reqHeaders, {
    upstreamHost: 'engram.example:4443',
    // pinnedDeviceId absent — shared/default port.
  });
  expect(out.has('x-fos-device-id')).toBe(false);
});

test('shared/default port: stays absent when the client sent none either', () => {
  const out = buildUpstreamRequestHeaders(new Headers(), { upstreamHost: 'engram.example:4443' });
  expect(out.has('x-fos-device-id')).toBe(false);
});

test('x-fos-key credential injection is untouched by this change (mirrors the pinned-device pattern 1:1)', () => {
  const withKey = buildUpstreamRequestHeaders(new Headers({ 'x-fos-key': 'client-spoof' }), {
    upstreamHost: 'engram.example:4443',
    fosApiKey: 'real-server-key',
  });
  expect(withKey.get('x-fos-key')).toBe('real-server-key');

  const withoutKey = buildUpstreamRequestHeaders(new Headers({ 'x-fos-key': 'client-spoof' }), {
    upstreamHost: 'engram.example:4443',
  });
  expect(withoutKey.has('x-fos-key')).toBe(false);
});

test('host header is always overwritten to the upstream host, and the inbound host is dropped', () => {
  const out = buildUpstreamRequestHeaders(new Headers({ host: '127.0.0.1:7780' }), {
    upstreamHost: 'engram.example:4443',
  });
  expect(out.get('host')).toBe('engram.example:4443');
});

// ── bindDefaultAndMappedListeners / bindNewMappedListeners ──────────────────
// Real Bun.serve() calls on real (ephemeral, high, monotonically-increasing)
// ports — the whole point of these is proving the bind/skip/hot-add
// orchestration around real EADDRINUSE behavior, not just the pure header
// logic above.

test('bindDefaultAndMappedListeners binds the default port plus one listener per port-map entry', () => {
  const [defaultPort, p1, p2] = allocPorts(3) as [number, number, number];
  writePortMap([
    { path: '/a', port: p1, device_id: 'dev-a' },
    { path: '/b', port: p2, device_id: 'dev-b' },
  ]);
  const servers = bindDefaultAndMappedListeners(cfgFor(defaultPort), STATE_DIR);
  try {
    const ports = servers.map((s) => s.port as number).sort((a, b) => a - b);
    expect(ports).toEqual([defaultPort, p1, p2].sort((a, b) => a - b));
  } finally {
    stopAll(servers);
  }
});

test('bindDefaultAndMappedListeners with no port-map file binds only the default port', () => {
  const [defaultPort] = allocPorts(1) as [number];
  writePortMap([]); // clear any leftover state from a prior case
  const servers = bindDefaultAndMappedListeners(cfgFor(defaultPort), STATE_DIR);
  try {
    expect(servers.map((s) => s.port as number)).toEqual([defaultPort]);
  } finally {
    stopAll(servers);
  }
});

test('a bind failure on ONE port-map entry (EADDRINUSE) is caught and skipped — every other listener still binds', () => {
  const [defaultPort, colliding, healthy] = allocPorts(3) as [number, number, number];
  writePortMap([
    { path: '/colliding', port: colliding, device_id: 'dev-colliding' },
    { path: '/healthy', port: healthy, device_id: 'dev-healthy' },
  ]);

  // Occupy `colliding` BEFORE the real bind attempt — any TCP listener on
  // 127.0.0.1:colliding is enough to reproduce EADDRINUSE; TLS is irrelevant
  // to the OS-level port-already-bound condition being simulated here.
  const occupier = Bun.serve({ hostname: '127.0.0.1', port: colliding, fetch: () => new Response('occupied') });
  try {
    const servers = bindDefaultAndMappedListeners(cfgFor(defaultPort), STATE_DIR);
    try {
      const ports = servers.map((s) => s.port as number).sort((a, b) => a - b);
      // The colliding port never made it into the returned set...
      expect(ports).not.toContain(colliding);
      // ...but the default port AND the other, non-colliding entry did — one
      // bad port must never abort every other listener.
      expect(ports).toEqual([defaultPort, healthy].sort((a, b) => a - b));
    } finally {
      stopAll(servers);
    }
  } finally {
    occupier.stop(true);
  }
});

test('a port-map entry colliding with the default port itself is skipped, not double-bound', () => {
  const [defaultPort] = allocPorts(1) as [number];
  writePortMap([{ path: '/dup', port: defaultPort, device_id: 'dev-dup' }]);
  const servers = bindDefaultAndMappedListeners(cfgFor(defaultPort), STATE_DIR);
  try {
    // Exactly one listener on defaultPort, not an attempted second bind.
    expect(servers).toHaveLength(1);
    expect(servers[0]!.port).toBe(defaultPort);
  } finally {
    stopAll(servers);
  }
});

test('bindNewMappedListeners only binds entries NOT already in the supplied bound-ports set — additive, existing listeners untouched', () => {
  const [defaultPort, p1] = allocPorts(2) as [number, number];
  writePortMap([{ path: '/a', port: p1, device_id: 'dev-a' }]);

  const initial = bindDefaultAndMappedListeners(cfgFor(defaultPort), STATE_DIR);
  try {
    expect(initial.map((s) => s.port as number).sort((a, b) => a - b)).toEqual([defaultPort, p1].sort((a, b) => a - b));

    // Simulate `hivemind install` writing a NEW entry while the daemon is
    // already running — this is exactly what POST /internal/proxy/reload
    // (server.ts) does with the result of this call.
    const [p2] = allocPorts(1) as [number];
    writePortMap([
      { path: '/a', port: p1, device_id: 'dev-a' },
      { path: '/b', port: p2, device_id: 'dev-b' },
    ]);

    const alreadyBound = initial.map((s) => s.port as number);
    const added = bindNewMappedListeners(cfgFor(defaultPort), alreadyBound, STATE_DIR);
    try {
      // Only the NEW entry was bound — p1 (already in alreadyBound) was
      // never touched/rebound.
      expect(added).toHaveLength(1);
      expect(added[0]!.port).toBe(p2);

      // Calling it again with the now-complete port set is a true no-op.
      const noop = bindNewMappedListeners(cfgFor(defaultPort), [...alreadyBound, p2], STATE_DIR);
      expect(noop).toHaveLength(0);
    } finally {
      stopAll(added);
    }
  } finally {
    stopAll(initial);
  }
});
