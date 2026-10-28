// proxy-activity.ts — liveness signal aggregated over EVERY proxy listener
// (the shared default port AND each port-map target). `hivemind update` reads
// it from GET /sessions to decide whether restarting the daemon would cut a
// client that never went through the launcher (an IDE on a target port).
//
// Dependency-free on purpose: imported by mtls-proxy.ts (writer) and
// routes/sessions.ts (reader) without dragging env/TLS into either side.

export interface ActivityServer {
  /** Bun.Server#pendingRequests: in-flight requests incl. streaming (SSE) bodies. */
  pendingRequests: number;
}

const servers = new Set<ActivityServer>();
let lastRequestAtMs = 0;

/** A listener was bound: count its in-flight requests from now on. */
export function registerActivityServer(server: ActivityServer): void {
  servers.add(server);
}

/** The CLI's own health probe (`hivemind status/start`): not client activity. */
export const PROBE_HEADER = 'x-hivemind-probe';
export function isLivenessProbe(headers: { get(name: string): string | null }): boolean {
  return headers.get(PROBE_HEADER) !== null;
}

/** A request arrived on any listener. */
export function noteProxyRequest(nowMs: number = Date.now()): void {
  lastRequestAtMs = nowMs;
}

export interface ProxyActivitySnapshot {
  /** In-flight requests summed over every registered listener. */
  active_connections: number;
  /** Seconds since the last request on any listener; null = none since boot. */
  last_request_age_s: number | null;
}

export function snapshotProxyActivity(
  nowMs: number = Date.now(),
  list: Iterable<ActivityServer> = servers,
): ProxyActivitySnapshot {
  let active = 0;
  for (const s of list) {
    const n = Number(s.pendingRequests);
    if (Number.isFinite(n) && n > 0) active += n;
  }
  const age = lastRequestAtMs > 0 ? Math.max(0, Math.floor((nowMs - lastRequestAtMs) / 1000)) : null;
  return { active_connections: active, last_request_age_s: age };
}

/** Test seam only. */
export function resetProxyActivityForTests(): void {
  servers.clear();
  lastRequestAtMs = 0;
}
