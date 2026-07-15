// backend-mcp-client.ts — direct mTLS JSON-RPC client to the engram backend.
//
// New in Fase 2 (DR-2.2, docs/wip/hivemind-runtime-lifecycle-daemon-reconcile-port.md).
// Every piece of daemon-initiated backend traffic (heartbeat, pause/resume,
// list_active reconcile — this phase; lifecycle events — Fase 4) goes
// through this single helper.
//
// Deliberately targets the upstream DIRECTLY via mTLS (mtlsCredentials()'s
// cert/key/ca + upstream URL), NEVER the local loopback proxy
// (mtls-proxy.ts) that this same daemon manages — explicit founder
// instruction, same reasoning DR-2.3 already applies to close/pause/resume:
// administrative daemon→backend calls must not be coupled to the health of
// the proxy the daemon is itself responsible for.
//
// CORRECTED (Fase 2 review, measured live): this used to call
// mtlsProxyConfig(), which gates on MTLS_PROXY_PORT — a precondition for the
// LOCAL PROXY LISTENER, not for whether this process can reach the backend
// directly. That coupled every daemon→backend call to whether the proxy was
// even configured, silently no-op'ing heartbeat/reconcile/pause/resume with
// MTLS_PROXY_PORT unset despite a perfectly valid cert/key/ca — exactly the
// coupling this file's own header above says must not happen. Fixed by
// mtlsCredentials() (env.ts), which has no MTLS_PROXY_PORT precondition.
//
// Mirrors bin/hivemind's `_mcp_call` (bash, :899-908) + `_mcp_result_field`
// (:916-927) — same JSON-RPC envelope, same SSE "data:" line parse — now in
// TS for callers that live inside the daemon process itself instead of the
// bash wrapper.
//
// Best-effort by design: never throws. Any failure (not enrolled yet, cert
// unreadable, network, malformed response, tool error) resolves to
// `undefined` — every caller (heartbeat timer, pid-watcher onExit, reconcile,
// shutdown) already tolerates that.

import { readFileSync } from 'node:fs';
import { mtlsCredentials, env } from './env.ts';

const CALL_TIMEOUT_MS = 8_000;

export async function callMcpTool<T = unknown>(
  tool: string,
  args: Record<string, unknown>,
): Promise<T | undefined> {
  const cfg = mtlsCredentials();
  if (!cfg) {
    console.warn(`[backend-mcp-client] ${tool}: mTLS cert/key/ca not available (not enrolled yet?) — skipped`);
    return undefined;
  }

  // Cert material is re-read per call rather than cached: calls are
  // infrequent (~30s heartbeat cadence, once at boot/shutdown), so the cost
  // is negligible, and it sidesteps any question of a cached copy going
  // stale relative to a renewed cert (mtls-proxy.ts, by contrast, caches
  // once because it is a long-lived per-request hot path).
  let cert: Buffer, key: Buffer, ca: Buffer;
  try {
    cert = readFileSync(cfg.certPath);
    key  = readFileSync(cfg.keyPath);
    ca   = readFileSync(cfg.caPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[backend-mcp-client] ${tool}: cert unreadable — skipped: ${msg}`);
    return undefined;
  }

  try {
    const res = await fetch(cfg.upstream, {
      method: 'POST',
      headers: {
        'x-fos-key': env.FOS_API_KEY ?? '',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      tls: { cert, key, ca },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });

    const text = await res.text();
    // Response is SSE — one "data: <json>" line carries the JSON-RPC
    // envelope (the same shape bin/hivemind's _mcp_call greps for). Anything
    // else (empty body, malformed SSE, a plain error page) is "no result".
    const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) {
      console.warn(`[backend-mcp-client] ${tool}: no SSE data line in response (status=${res.status})`);
      return undefined;
    }

    const envelope = JSON.parse(dataLine.slice('data:'.length).trim()) as {
      result?: { content?: { text?: string }[] };
      error?: unknown;
    };
    if (envelope.error) {
      console.warn(`[backend-mcp-client] ${tool}: tool error:`, envelope.error);
      return undefined;
    }
    // Per mcp.service.ts convention: content:[{type:'text', text:JSON.stringify(result)}]
    // — a second JSON.parse hop unwraps the tool's own payload.
    const innerText = envelope.result?.content?.[0]?.text;
    if (typeof innerText !== 'string') return undefined;
    return JSON.parse(innerText) as T;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[backend-mcp-client] ${tool}: call failed (best-effort) — ${msg}`);
    return undefined;
  }
}
