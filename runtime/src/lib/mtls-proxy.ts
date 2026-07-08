// mTLS loopback proxy for hivemind-runtime.
//
// Listens on 127.0.0.1:<MTLS_PROXY_PORT> (HTTP plain) and forwards every
// request to the upstream mTLS endpoint (https://kernel.silken.ia.br:4443)
// presenting the user client certificate.
//
// STREAMING / SSE: MCP streamable-HTTP uses long-lived SSE responses.
// The proxy passes upRes.body (ReadableStream<Uint8Array>) directly to
// new Response() without buffering — Bun streams chunks to the client
// as they arrive. Drop content-length + transfer-encoding (HOP_BY_HOP) from
// the upstream response so the client does not truncate the live stream.
//
// Cert material loaded ONCE at startup. After cert renewal: restart the runtime.

import { readFileSync } from 'node:fs';
import { mtlsProxyConfig } from './env.ts';

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

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: cfg.port,

    async fetch(req: Request): Promise<Response> {
      const inUrl = new URL(req.url);

      // Fixed upstream path — proxy is purpose-built for one endpoint.
      // Preserve query params from the incoming request.
      const targetUrl = cfg.upstream + (inUrl.search || '');

      // Build upstream request headers, dropping hop-by-hop and original host.
      const upHeaders = forwardHeaders(req.headers, true);
      upHeaders.set('host', upstreamHost);

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
