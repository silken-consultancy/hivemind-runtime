// hivemind-runtime server — thin: /healthz + /setup (first-login popup) + mTLS proxy.
//
// Intentionally minimal: no agent management, no session tracking, no lab tooling.
// Everything app-level is served by the engram backend via the mTLS proxy.
//
// Modes:
//   Normal:     mTLS proxy starts (cert present in env), serves /healthz + /setup
//   Setup-only: proxy skipped (no cert yet), serves /healthz + /setup for enrollment
//               Activated by --setup-only argv flag (bin/hivemind first-login flow).

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env } from './lib/env.ts';
import { health } from './routes/health.ts';
import { setupRouter } from './routes/setup.ts';
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

// Graceful shutdown: stop mTLS proxy before exiting.
async function shutdown(signal: string): Promise<void> {
  console.log(`[hivemind-runtime] ${signal} — shutting down`);
  if (mtlsServer) mtlsServer.stop(true);
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT',  () => { void shutdown('SIGINT'); });
// SIGHUP = controlling terminal closed (abrupt Claude Code close). Without this
// handler the runtime is left ORPHANED with the mTLS proxy port (7779) still
// bound — the exact state that forced a manual `hivemind stop` before a reopen.
// Route it through the same graceful shutdown so the proxy releases its port on
// terminal close. (Default SIGHUP disposition terminates the process WITHOUT
// running this cleanup; the runtime-side auto-heal in bin/hivemind:_start_proxy
// is the belt-and-suspenders for any case where the signal never arrives.)
process.on('SIGHUP',  () => { void shutdown('SIGHUP'); });

export { app };
