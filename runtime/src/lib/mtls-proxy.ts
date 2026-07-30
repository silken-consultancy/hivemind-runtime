// mTLS loopback proxy for hivemind-runtime.
//
// Listens on 127.0.0.1:<MTLS_PROXY_PORT> over HTTPS (local-only server cert —
// see ensureLocalHttpsCert below, DISTINCT from the enrollment mTLS client
// cert) and forwards every request to the upstream mTLS endpoint (the product
// endpoint (HIVEMIND_ENDPOINT)) presenting the user client certificate.
// The outbound hop also SETS/OVERWRITES the x-fos-key credential header from
// env.FOS_API_KEY — server-side injection, so IDE config files carry zero
// secret material regardless of what the inbound request presented.
//
// STREAMING / SSE: MCP streamable-HTTP uses long-lived SSE responses.
// The proxy passes upRes.body (ReadableStream<Uint8Array>) directly to
// new Response() without buffering — Bun streams chunks to the client
// as they arrive. Drop content-length + transfer-encoding (HOP_BY_HOP) from
// the upstream response so the client does not truncate the live stream.
//
// Cert material loaded ONCE at startup. After cert renewal: restart the runtime.

import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mtlsProxyConfig, env } from './env.ts';

// ── Local HTTPS listener cert (round-2, founder 2026-07-30) ────────────────
// A local CA + leaf cert for 127.0.0.1/localhost, used ONLY to TLS-terminate
// the loopback hop (IDE <-> this proxy). DISTINCT from cfg.certPath/keyPath/
// caPath (mtlsProxyConfig) — those stay the client credential this daemon
// presents on the UPSTREAM leg (this proxy -> engram). Stored under a
// separate subdir so the two pairs are never confused on disk.
const LOCAL_HTTPS_DIR  = join(homedir(), '.engram', 'mtls', 'local-https');
const LOCAL_CA_KEY     = join(LOCAL_HTTPS_DIR, 'ca.key.pem');
const LOCAL_CA_CERT    = join(LOCAL_HTTPS_DIR, 'ca.cert.pem');
const LOCAL_LEAF_KEY    = join(LOCAL_HTTPS_DIR, 'leaf.key.pem');
const LOCAL_LEAF_CERT   = join(LOCAL_HTTPS_DIR, 'leaf.cert.pem');

// ── ensureLocalHttpsCert ─────────────────────────────────────────────────────
// Lazily generates the local CA + leaf cert on first call, idempotent after
// that (reuses whatever is already on disk). openssl is a confirmed
// dependency already (install.sh, setup.ts enrollment) — no new dependency.
// SAN (not just CN) is required: modern TLS clients ignore CN-only matches.
function ensureLocalHttpsCert(): { cert: Buffer; key: Buffer } {
  if (existsSync(LOCAL_LEAF_CERT) && existsSync(LOCAL_LEAF_KEY)) {
    return { cert: readFileSync(LOCAL_LEAF_CERT), key: readFileSync(LOCAL_LEAF_KEY) };
  }

  mkdirSync(LOCAL_HTTPS_DIR, { recursive: true, mode: 0o700 });

  // 1. Local CA — self-signed, this-machine-only, never leaves disk.
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', LOCAL_CA_KEY, '-out', LOCAL_CA_CERT,
    '-days', '3650',
    '-subj', '/CN=HiveMind Local HTTPS CA',
  ], { stdio: 'pipe' });
  chmodSync(LOCAL_CA_KEY, 0o600);

  // 2. Leaf key + CSR (SAN written to a temp openssl config — -addext is not
  // available on all openssl 1.1.x builds still in the field, -extfile is).
  const csrPath = join(LOCAL_HTTPS_DIR, 'leaf.csr.pem');
  const sanConfPath = join(LOCAL_HTTPS_DIR, 'leaf.san.cnf');
  writeFileSync(sanConfPath, [
    '[req]',
    'distinguished_name=req',
    '[san]',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '',
  ].join('\n'), { mode: 0o600 });

  execFileSync('openssl', [
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', LOCAL_LEAF_KEY, '-out', csrPath,
    '-subj', '/CN=127.0.0.1',
  ], { stdio: 'pipe' });
  chmodSync(LOCAL_LEAF_KEY, 0o600);

  // 3. Sign the leaf with the local CA, embedding the SAN extension.
  execFileSync('openssl', [
    'x509', '-req', '-in', csrPath,
    '-CA', LOCAL_CA_CERT, '-CAkey', LOCAL_CA_KEY, '-CAcreateserial',
    '-out', LOCAL_LEAF_CERT, '-days', '825', // CA/Browser Forum leaf-lifetime cap
    '-extfile', sanConfPath, '-extensions', 'san',
  ], { stdio: 'pipe' });
  chmodSync(LOCAL_LEAF_CERT, 0o644); // public cert — the CA cert is what a client must trust

  // Cleanup CSR + temp SAN config (not needed after signing).
  try { unlinkSync(csrPath); } catch { /* best-effort */ }
  try { unlinkSync(sanConfPath); } catch { /* best-effort */ }

  return { cert: readFileSync(LOCAL_LEAF_CERT), key: readFileSync(LOCAL_LEAF_KEY) };
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

// ── startMtlsProxy ────────────────────────────────────────────────────────────
// Returns a Bun.Server instance if MTLS_* config is complete, null otherwise.
export function startMtlsProxy(): Bun.Server<undefined> | null {
  const cfg = mtlsProxyConfig();
  if (!cfg) return null;

  // Load cert material once at startup — not re-read per request.
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

  // Local HTTPS server cert — generated lazily on first proxy start, reused
  // after. Distinct from cert/key/ca above (those are the outbound leg).
  const { cert: localCert, key: localKey } = ensureLocalHttpsCert();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: cfg.port,
    tls: { cert: localCert, key: localKey },

    async fetch(req: Request): Promise<Response> {
      const inUrl = new URL(req.url);

      // Fixed upstream path — proxy is purpose-built for one endpoint.
      // Preserve query params from the incoming request.
      const targetUrl = cfg.upstream + (inUrl.search || '');

      // Build upstream request headers, dropping hop-by-hop and original host.
      const upHeaders = forwardHeaders(req.headers, true);
      upHeaders.set('host', upstreamHost);

      // Credential injection: SET/OVERWRITE x-fos-key from env.FOS_API_KEY
      // regardless of what the inbound request carried — IDE config files
      // hold zero secret material; the daemon is the only holder of the key.
      if (env.FOS_API_KEY) {
        upHeaders.set('x-fos-key', env.FOS_API_KEY);
      } else {
        upHeaders.delete('x-fos-key');
      }

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

  return server;
}
