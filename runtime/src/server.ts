// hivemind-runtime server — /healthz + /setup (first-login popup) + /sessions
// (pid registry, Fase 2) + mTLS proxy.
//
// Still minimal: no agent management, no lab tooling. Everything app-level
// beyond session pid liveness is served by the engram backend via the mTLS
// proxy — /sessions only tracks "is there a local process for this session
// right now", never inference content (see the plan's STATE section on the
// lab's /agents route, which this daemon deliberately has no equivalent of).
//
// Modes:
//   Normal:     mTLS proxy starts (cert present in env), serves /healthz +
//               /setup + /sessions, runs reconcileOnStartup()
//   Setup-only: proxy + sessions reconcile skipped (no cert yet), serves
//               /healthz + /setup for enrollment. Activated by --setup-only
//               argv flag (bin/hivemind first-login flow).

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env } from './lib/env.ts';
import { health } from './routes/health.ts';
import { setupRouter } from './routes/setup.ts';
import { sessions, reconcileOnStartup, shutdownSessions } from './routes/sessions.ts';
import { startMtlsProxy } from './lib/mtls-proxy.ts';
import { VERSION } from './version.ts';

const isSetupOnly = process.argv.includes('--setup-only');

const app = new Hono();

// CORS for all routes — server listens on 127.0.0.1 only, wildcard origin safe.
const publicCors = cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'] });
app.use('/*', publicCors);

// Routes.
app.route('/healthz', health);
app.route('/setup', setupRouter);
// Session pid registry (Fase 2) — POST /sessions/adopt + GET /sessions.
// Public, localhost-only bind — same bypass as /healthz and /setup.
app.route('/sessions', sessions);

app.onError((err, c) => {
  console.error('[server] unhandled error:', err);
  return c.json({ error: 'internal_server_error' }, 500);
});

// mTLS proxy — skipped in setup-only mode (no cert provisioned yet).
let mtlsServer: ReturnType<typeof startMtlsProxy> = null;
if (!isSetupOnly) {
  mtlsServer = startMtlsProxy();
  if (mtlsServer) {
    console.log(
      `[mtls-proxy] listening on http://127.0.0.1:${mtlsServer.port} -> ${env.MTLS_UPSTREAM}`,
    );
  } else {
    console.log('[mtls-proxy] disabled (MTLS_PROXY_PORT not set or certs absent)');
  }
}

// reconcileOnStartup (Fase 2, DR-2.3) — revive-on-return: re-adopts any of
// THIS device's sessions whose pid is still alive (source of truth =
// backend list_active, filtered by device_id; degrades to the local mirror
// only if the backend is unreachable). Best-effort — wrapped so a network
// failure here can never abort the daemon's boot. Skipped in setup-only
// mode (no cert/session traffic makes sense pre-enrollment).
if (!isSetupOnly) {
  try {
    await reconcileOnStartup();
  } catch (err) {
    console.error('[hivemind-runtime] reconcileOnStartup failed (non-fatal):', err);
  }
}

Bun.serve({
  fetch: app.fetch,
  hostname: env.AR_BIND,
  port: env.AR_PORT,
});

if (isSetupOnly) {
  console.log(
    `[hivemind-runtime] v${VERSION} setup mode — http://${env.AR_BIND}:${env.AR_PORT}/setup`,
  );
} else {
  console.log(`[hivemind-runtime] v${VERSION} listening on http://${env.AR_BIND}:${env.AR_PORT}`);
}

// Graceful shutdown: stop mTLS proxy, pause tracked sessions, then exit.
// Only reachable via SIGTERM/SIGINT (DR-2.4) — SIGHUP is a logged no-op
// below and never calls this.
async function shutdown(signal: string): Promise<void> {
  console.log(`[hivemind-runtime] ${signal} — shutting down`);
  if (mtlsServer) mtlsServer.stop(true);
  try {
    await shutdownSessions();
  } catch (err) {
    console.error('[hivemind-runtime] shutdownSessions failed (non-fatal):', err);
  }
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT',  () => { void shutdown('SIGINT'); });
// SIGHUP — Fase 1, DR-1.2 (RETIFICADA): explicit no-op, NOT a shutdown trigger.
//
// History: the Bug B fix originally routed SIGHUP through the same graceful
// shutdown() as SIGTERM/SIGINT, because the pre-Fase-1 spawn (`bun run ... &`,
// no nohup) left the daemon genuinely reachable by the kernel's SIGHUP on
// terminal close — that was the right fix for the spawn that existed then.
//
// Fase 1's `_spawn_runtime` now launches this process with nohup + disown,
// which sets SIGHUP's disposition to SIG_IGN. MEASURED (not assumed): a
// registered `process.on('SIGHUP', ...)` handler OVERRIDES that SIG_IGN — so
// keeping the old shutdown-on-SIGHUP handler here actively undid nohup's
// protection and defeated DR-1.1's whole point. Verified live: with the old
// handler, `kill -HUP <daemon-pid>` still shut the process down even though
// it was spawned via nohup; the identical spawn with NO handler at all
// survived the same signal untouched.
//
// Nothing in this repo sends SIGHUP as a legitimate shutdown signal — cmd_stop
// (bin/hivemind:475) and _reap_stale_runtime (bin/hivemind:283) both use
// SIGTERM, escalating to SIGKILL, never -HUP. This handler is an explicit,
// logged no-op rather than no handler at all: leaving SIGHUP fully unhandled
// would work too (nohup's SIG_IGN would govern), but a logged no-op is more
// observable/self-documenting than relying on the next maintainer to know
// "no handler = nohup governs."
process.on('SIGHUP', () => {
  console.log('[hivemind-runtime] SIGHUP received — ignored (daemon detached via nohup+disown, Fase 1)');
});

export { app };
