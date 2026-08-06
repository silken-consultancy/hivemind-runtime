// mTLS loopback proxy for hivemind-runtime.
//
// Listens on 127.0.0.1:<MTLS_PROXY_PORT> (the shared/default port) PLUS,
// per Option 2 (fos_decision 1caee6a7, B1 fix — full design in fos_sketchpad
// 4f8142e3-73c6-468c-8ec3-1b871e8bb23b § ADDENDUM 3), one ADDITIONAL loopback
// listener per installed target (`~/.engram/mtls/port-map.json`), each pinned
// to a device_id fixed at `hivemind install` time. All listeners live in this
// ONE process (N `Bun.serve()` calls, not N processes) and forward every
// request to the same upstream mTLS endpoint (the product endpoint
// (HIVEMIND_ENDPOINT)) presenting the user client certificate.
//
// The outbound hop also SETS/OVERWRITES the x-fos-key credential header from
// env.FOS_API_KEY — server-side injection, so IDE config files carry zero
// secret material regardless of what the inbound request presented. The
// SAME pattern now governs a per-port device identity: a pinned port
// UNCONDITIONALLY sets x-fos-device-id to that port's device_id; the
// shared/default (unpinned) port UNCONDITIONALLY strips any x-fos-device-id
// the inbound request carried. Neither branch ever trusts an inbound value —
// this proxy is the SOLE writer of that header on every port, which is the
// actual unspoofability guarantee (not merely "the client doesn't know a
// real id to send" — even a client that guesses/replays a header gets
// overwritten/stripped).
//
// STREAMING / SSE: MCP streamable-HTTP uses long-lived SSE responses.
// The proxy passes upRes.body (ReadableStream<Uint8Array>) directly to
// new Response() without buffering — Bun streams chunks to the client
// as they arrive. Drop content-length + transfer-encoding (HOP_BY_HOP) from
// the upstream response so the client does not truncate the live stream.
//
// Cert material loaded ONCE at startup (shared across every listener — the
// local-https leaf cert's SAN `DNS:localhost,IP:127.0.0.1` is host-scoped,
// not port-scoped, so it is valid on every 127.0.0.1 port with zero new cert
// material — confirmed non-issue, not an open question). After cert
// renewal: restart the runtime.

import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mtlsProxyConfig, env } from './env.ts';

// ── ~/.engram/mtls root ──────────────────────────────────────────────────────
// Production default. Every function below that needs it takes an explicit
// `stateDir` parameter defaulting to this constant, rather than reading it
// implicitly from a module-level singleton — this is what lets
// mtls-proxy.test.ts point bindDefaultAndMappedListeners/bindNewMappedListeners/
// readPortMap at an ephemeral tmp dir via a PLAIN static import + explicit
// argument, with zero env-var/mock/dynamic-import timing tricks involved.
// (An earlier version of this file used an env-var override read at
// module-load time, which required the test to dynamically `await import()`
// this module AFTER setting the env var. That measurably deadlocked `bun
// test` — no output at all, not even the banner — specifically when combined
// with another test file that also does its own unrelated dynamic import
// (setup.contract.test.ts's `await import('./setup.js')`), reproducing only
// when BOTH the importing file's location and the import specifier were
// relative. Parameterizing instead of overriding removes the need for a
// dynamic import in the test at all, sidestepping that Bun-resolver
// interaction entirely rather than working around it.)
const DEFAULT_MTLS_STATE_DIR = join(homedir(), '.engram', 'mtls');

export interface PortMapEntry {
  path: string;
  target_id?: string;
  scope?: string;
  port: number;
  device_id: string;
  created_at?: string;
  updated_at?: string;
}

interface PortMapFile {
  version: number;
  entries: PortMapEntry[];
}

// readPortMap: parses <stateDir>/port-map.json, never throws. Absent file,
// corrupted JSON, a non-object document, or a missing/non-array `entries`
// all degrade to an empty list — this must never abort daemon boot (mirrors
// the self-heal posture every other JSON read in this repo already uses,
// e.g. bin/hivemind's `_write_generic_mcp_config`).
//
// code-review FIX: the filter only checked `typeof port === 'number'`, which
// happily let NaN, Infinity, negative, fractional (e.g. 7780.5), or
// out-of-range (0, 65536+) values through as "valid" — a corrupted or
// hand-edited port-map.json would then reach Bun.serve({port}) downstream
// and rely on IT throwing (or worse, silently coercing) rather than being
// rejected right here at the read boundary. Now explicitly range/integer-
// validated (Number.isInteger(port) && port>0 && port<65536, the valid TCP
// port range) and an invalid entry is skipped+logged — same self-heal
// posture as the rest of this function, just per-entry instead of
// per-document: one bad entry no longer needs to be diagnosed by chasing a
// Bun.serve stack trace back to this file.
export function readPortMap(stateDir: string = DEFAULT_MTLS_STATE_DIR): PortMapEntry[] {
  const portMapPath = join(stateDir, 'port-map.json');
  if (!existsSync(portMapPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(portMapPath, 'utf8')) as Partial<PortMapFile>;
    if (parsed && Array.isArray(parsed.entries)) {
      return parsed.entries.filter((e): e is PortMapEntry => {
        if (typeof e !== 'object' || e === null) return false;
        const entry = e as PortMapEntry;
        if (typeof entry.device_id !== 'string') return false;
        const port = entry.port;
        if (!(typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536)) {
          console.error(
            `[mtls-proxy] port-map entry for path ${JSON.stringify((entry as { path?: unknown }).path ?? '<unknown>')} has an invalid port (${JSON.stringify(port)}) — skipped`,
          );
          return false;
        }
        return true;
      });
    }
  } catch {
    /* unparseable → treat as no installed targets, not a boot failure */
  }
  return [];
}

// ── ensureLocalHttpsCert ─────────────────────────────────────────────────────
// Lazily generates the local CA + leaf cert on first call, idempotent after
// that (reuses whatever is already on disk). openssl is a confirmed
// dependency already (install.sh, setup.ts enrollment) — no new dependency.
// SAN (not just CN) is required: modern TLS clients ignore CN-only matches.
// A local CA + leaf cert for 127.0.0.1/localhost, used ONLY to TLS-terminate
// the loopback hop (IDE <-> this proxy). DISTINCT from cfg.certPath/keyPath/
// caPath (mtlsProxyConfig) — those stay the client credential this daemon
// presents on the UPSTREAM leg (this proxy -> engram). Stored under a
// `local-https` subdir of stateDir so the two pairs are never confused on disk.
function ensureLocalHttpsCert(stateDir: string): { cert: Buffer; key: Buffer } {
  const localHttpsDir = join(stateDir, 'local-https');
  const caKey     = join(localHttpsDir, 'ca.key.pem');
  const caCert    = join(localHttpsDir, 'ca.cert.pem');
  const leafKey   = join(localHttpsDir, 'leaf.key.pem');
  const leafCert  = join(localHttpsDir, 'leaf.cert.pem');

  if (existsSync(leafCert) && existsSync(leafKey)) {
    return { cert: readFileSync(leafCert), key: readFileSync(leafKey) };
  }

  mkdirSync(localHttpsDir, { recursive: true, mode: 0o700 });

  // 1. Local CA — self-signed, this-machine-only, never leaves disk.
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', caKey, '-out', caCert,
    '-days', '3650',
    '-subj', '/CN=HiveMind Local HTTPS CA',
  ], { stdio: 'pipe' });
  chmodSync(caKey, 0o600);

  // 2. Leaf key + CSR (SAN written to a temp openssl config — -addext is not
  // available on all openssl 1.1.x builds still in the field, -extfile is).
  const csrPath = join(localHttpsDir, 'leaf.csr.pem');
  const sanConfPath = join(localHttpsDir, 'leaf.san.cnf');
  writeFileSync(sanConfPath, [
    '[req]',
    'distinguished_name=req',
    '[san]',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '',
  ].join('\n'), { mode: 0o600 });

  execFileSync('openssl', [
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', leafKey, '-out', csrPath,
    '-subj', '/CN=127.0.0.1',
  ], { stdio: 'pipe' });
  chmodSync(leafKey, 0o600);

  // 3. Sign the leaf with the local CA, embedding the SAN extension.
  execFileSync('openssl', [
    'x509', '-req', '-in', csrPath,
    '-CA', caCert, '-CAkey', caKey, '-CAcreateserial',
    '-out', leafCert, '-days', '825', // CA/Browser Forum leaf-lifetime cap
    '-extfile', sanConfPath, '-extensions', 'san',
  ], { stdio: 'pipe' });
  chmodSync(leafCert, 0o644); // public cert — the CA cert is what a client must trust

  // Cleanup CSR + temp SAN config (not needed after signing).
  try { unlinkSync(csrPath); } catch { /* best-effort */ }
  try { unlinkSync(sanConfPath); } catch { /* best-effort */ }

  return { cert: readFileSync(leafCert), key: readFileSync(leafKey) };
}

// ── Hop-by-hop headers ────────────────────────────────────────────────────────
// Must NEVER be forwarded between proxy and either leg.
// content-length included because SSE upstreams may set it to full body size,
// which would cause the client to truncate the stream mid-flight.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);

// Build a new Headers object from src, dropping hop-by-hop entries.
// dropHost: when forwarding request headers upstream, drop the incoming
// "host" header so we can set the correct upstream host instead.
function forwardHeaders(src: Headers, dropHost: boolean): Headers {
  const out = new Headers();
  for (const [k, v] of src.entries()) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (dropHost && lk === 'host') continue;
    out.set(k, v);
  }
  return out;
}

// buildUpstreamRequestHeaders: the credential/identity-injection core,
// extracted as a pure function so the force-set/strip behavior is directly
// unit-testable without standing up a real TLS listener. Mirrors the
// existing x-fos-key pattern EXACTLY for the new x-fos-device-id header:
//   - pinnedDeviceId present (a pinned, per-target port) → ALWAYS
//     upHeaders.set('x-fos-device-id', pinnedDeviceId), overwriting whatever
//     the inbound request carried.
//   - pinnedDeviceId absent (the shared/default port) → ALWAYS
//     upHeaders.delete('x-fos-device-id'), stripping any value the client
//     tried to send. A client on the shared port must NEVER be able to
//     inject its own device_id.
// Neither branch ever trusts an inbound value.
export function buildUpstreamRequestHeaders(
  reqHeaders: Headers,
  opts: { upstreamHost: string; fosApiKey?: string; pinnedDeviceId?: string },
): Headers {
  const upHeaders = forwardHeaders(reqHeaders, true);
  upHeaders.set('host', opts.upstreamHost);

  // Credential injection: SET/OVERWRITE x-fos-key from env.FOS_API_KEY
  // regardless of what the inbound request carried — IDE config files
  // hold zero secret material; the daemon is the only holder of the key.
  if (opts.fosApiKey) {
    upHeaders.set('x-fos-key', opts.fosApiKey);
  } else {
    upHeaders.delete('x-fos-key');
  }

  // Device-identity injection (Option 2, fos_decision 1caee6a7) — see the
  // function-level comment above for the unspoofability rationale.
  if (opts.pinnedDeviceId) {
    upHeaders.set('x-fos-device-id', opts.pinnedDeviceId);
  } else {
    upHeaders.delete('x-fos-device-id');
  }

  return upHeaders;
}

// ── Cert material, loaded once and shared across every listener ────────────
interface ProxyCertMaterial {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
  localCert: Buffer;
  localKey: Buffer;
  upstreamHost: string;
}

function loadProxyCertMaterial(
  cfg: {
    upstream: string;
    certPath: string;
    keyPath: string;
    caPath: string;
  },
  stateDir: string = DEFAULT_MTLS_STATE_DIR,
): ProxyCertMaterial | null {
  let cert: Buffer, key: Buffer, ca: Buffer;
  try {
    cert = readFileSync(cfg.certPath);
    key  = readFileSync(cfg.keyPath);
    ca   = readFileSync(cfg.caPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mtls-proxy] cert unreadable — proxy NOT started (runtime continues): ${msg}`);
    return null;
  }

  const upstreamHost = new URL(cfg.upstream).host;
  const { cert: localCert, key: localKey } = ensureLocalHttpsCert(stateDir);

  return { cert, key, ca, localCert, localKey, upstreamHost };
}

// ── bindProxyListener ────────────────────────────────────────────────────────
// Factory extracted from the original single-port startMtlsProxy() so the
// SAME fetch-handling/header-injection logic backs every listener — the
// shared/default port AND every pinned per-target port. `pinnedDeviceId`
// absent = shared/default port behavior (unchanged from before this item).
// Throws synchronously on bind failure (e.g. EADDRINUSE) — callers that bind
// more than one port (startAllMtlsProxies / reloadNewProxyListeners) MUST
// catch per-port so one bad port never aborts every other listener.
export function bindProxyListener(
  port: number,
  mat: ProxyCertMaterial,
  upstream: string,
  pinnedDeviceId?: string,
): Bun.Server<undefined> {
  const { cert, key, ca, localCert, localKey, upstreamHost } = mat;

  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    tls: { cert: localCert, key: localKey },

    async fetch(req: Request): Promise<Response> {
      const inUrl = new URL(req.url);

      // Fixed upstream path — proxy is purpose-built for one endpoint.
      // Preserve query params from the incoming request.
      const targetUrl = upstream + (inUrl.search || '');

      const upHeaders = buildUpstreamRequestHeaders(req.headers, {
        upstreamHost,
        fosApiKey: env.FOS_API_KEY,
        pinnedDeviceId,
      });

      try {
        // signal: req.signal propagates the downstream client's disconnect into
        // the upstream fetch. When the client closes the SSE connection,
        // req.signal fires → fetch aborts → :4443 TCP connection closes promptly.
        const upRes = await fetch(targetUrl, {
          method:  req.method,
          headers: upHeaders,
          // Body: omit for GET/HEAD — fetch throws if body passed to those methods.
          body:    (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined,
          tls:     { cert, key, ca },
          redirect: 'manual',
          signal:  req.signal,
        });

        // Forward status + filtered headers + body as ReadableStream.
        const respHeaders = forwardHeaders(upRes.headers, false);
        return new Response(upRes.body, {
          status:  upRes.status,
          headers: respHeaders,
        });

      } catch (err: unknown) {
        // Downstream client disconnect → AbortError. Intended — swallow silently.
        if (err instanceof Error && err.name === 'AbortError') {
          return new Response(null, { status: 499 }); // 499 = Client Closed Request
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[mtls-proxy] upstream error:', msg);
        return new Response(
          JSON.stringify({ error: 'proxy_upstream_error', detail: msg }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        );
      }
    },
  });
}

// ── startMtlsProxy ────────────────────────────────────────────────────────────
// Thin single-port wrapper over bindProxyListener — kept for back-compat and
// as the simplest possible test surface (no port-map involved). Not used by
// server.ts's normal boot path any more (see startAllMtlsProxies below), but
// left exported and functional.
// Returns a Bun.Server instance if MTLS_* config is complete, null otherwise.
export function startMtlsProxy(): Bun.Server<undefined> | null {
  const cfg = mtlsProxyConfig();
  if (!cfg) return null;

  const mat = loadProxyCertMaterial(cfg);
  if (!mat) return null;

  try {
    return bindProxyListener(cfg.port, mat, cfg.upstream);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mtls-proxy] port ${cfg.port} bind failed — proxy NOT started: ${msg}`);
    return null;
  }
}

// cfg shape shared by the two entry points below — matches mtlsProxyConfig()'s
// return type exactly. Extracted as its own name so bindDefaultAndMappedListeners
// / bindNewMappedListeners can be unit-tested with an explicitly-constructed
// cfg, with ZERO dependency on the `env` singleton (env.ts's config is parsed
// once at process start, which makes it awkward to vary per-test) — the real
// startAllMtlsProxies/reloadNewProxyListeners entry points are thin wrappers
// that supply `mtlsProxyConfig()`'s live result, so testing the parameterized
// versions below IS testing the real bind logic.
export interface MtlsProxyCfg {
  port: number;
  upstream: string;
  certPath: string;
  keyPath: string;
  caPath: string;
}

// ── bindDefaultAndMappedListeners ─────────────────────────────────────────────
// N-listener daemon boot (Option 2, item 46d0eeed): binds the default/shared
// port (cfg.port, unpinned, unchanged) PLUS one listener per
// ~/.engram/mtls/port-map.json entry (pinned to that entry's device_id).
// Rebinding every mapped port on every daemon (re)start is the ENTIRE
// persistence story — port-map.json already survives restart on disk, so no
// separate in-memory/db bookkeeping is needed.
//
// Pitfall (confirmed): Bun.serve() throws synchronously on EADDRINUSE — each
// bind is individually try/caught so one bad/colliding port only skips that
// ONE entry (logged) rather than aborting every other listener, including the
// default port.
export function bindDefaultAndMappedListeners(
  cfg: MtlsProxyCfg,
  stateDir: string = DEFAULT_MTLS_STATE_DIR,
): Bun.Server<undefined>[] {
  const mat = loadProxyCertMaterial(cfg, stateDir);
  if (!mat) return [];

  const servers: Bun.Server<undefined>[] = [];
  const boundPorts = new Set<number>();

  try {
    servers.push(bindProxyListener(cfg.port, mat, cfg.upstream));
    boundPorts.add(cfg.port);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mtls-proxy] default port ${cfg.port} bind failed — skipped: ${msg}`);
  }

  for (const entry of readPortMap(stateDir)) {
    if (boundPorts.has(entry.port)) {
      console.error(`[mtls-proxy] port-map entry for device ${entry.device_id} collides with an already-bound port ${entry.port} — skipped`);
      continue;
    }
    try {
      servers.push(bindProxyListener(entry.port, mat, cfg.upstream, entry.device_id));
      boundPorts.add(entry.port);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mtls-proxy] pinned port ${entry.port} (device ${entry.device_id}) bind failed — skipped: ${msg}`);
    }
  }

  return servers;
}

// ── startAllMtlsProxies ───────────────────────────────────────────────────────
// Thin env-coupled entry point used by server.ts's real boot path — see
// bindDefaultAndMappedListeners above for the actual logic.
export function startAllMtlsProxies(): Bun.Server<undefined>[] {
  const cfg = mtlsProxyConfig();
  if (!cfg) return [];
  return bindDefaultAndMappedListeners(cfg);
}

// ── bindNewMappedListeners ────────────────────────────────────────────────────
// Backs POST /internal/proxy/reload (server.ts) — zero-downtime pickup of a
// freshly-`install`ed target's port on an ALREADY-RUNNING daemon. Stateless
// by design: the caller (server.ts) owns the mutable list of currently-bound
// ports/servers and passes it in; this function only ever ADDS listeners for
// port-map entries not already in that set — it never touches/rebinds an
// existing listener, so no other listener's sessions are ever disrupted.
export function bindNewMappedListeners(
  cfg: MtlsProxyCfg,
  alreadyBoundPorts: number[],
  stateDir: string = DEFAULT_MTLS_STATE_DIR,
): Bun.Server<undefined>[] {
  const mat = loadProxyCertMaterial(cfg, stateDir);
  if (!mat) return [];

  const bound = new Set(alreadyBoundPorts);
  const added: Bun.Server<undefined>[] = [];

  for (const entry of readPortMap(stateDir)) {
    if (bound.has(entry.port)) continue;
    try {
      added.push(bindProxyListener(entry.port, mat, cfg.upstream, entry.device_id));
      bound.add(entry.port);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mtls-proxy] reload: pinned port ${entry.port} (device ${entry.device_id}) bind failed — skipped: ${msg}`);
    }
  }

  return added;
}

// ── reloadNewProxyListeners ───────────────────────────────────────────────────
// Thin env-coupled entry point used by server.ts's POST /internal/proxy/reload
// handler — see bindNewMappedListeners above for the actual logic.
export function reloadNewProxyListeners(alreadyBoundPorts: number[]): Bun.Server<undefined>[] {
  const cfg = mtlsProxyConfig();
  if (!cfg) return [];
  return bindNewMappedListeners(cfg, alreadyBoundPorts);
}
