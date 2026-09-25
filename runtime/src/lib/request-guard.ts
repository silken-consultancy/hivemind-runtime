// request-guard.ts — F2 (security impl 9658277f, R1): the daemon's global
// browser-facing boundary.
//
// THREAT MODEL — what this daemon (127.0.0.1:<AR_PORT>) defends against, and
// what it deliberately does not:
//   IN SCOPE
//   - Web pages in the user's own browser, any origin: blocked by the
//     Origin + Content-Type rules below and by the absence of any CORS grant.
//   - DNS rebinding (an attacker hostname re-pointed at 127.0.0.1): blocked
//     by the Host rule below, GETs included.
//   - Other local processes running as the SAME OS user, for enrollment
//     only: /setup/enroll needs the launcher's one-shot nonce (R2,
//     routes/setup.ts). The other mutating routes (/sessions/adopt,
//     /internal/proxy/reload) are NOT yet authenticated against same-user
//     processes — open as blocker 53b6455c (AR_API_TOKEN bearer, whole-server).
//   OUT OF SCOPE (pending a founder decision — a DIFFERENT local OS user on a
//   shared host):
//   - nonce in argv: the daemon gets it via env (not readable across users),
//     but the setup URL carrying it is an argument to xdg-open/open and to
//     the browser process, which `ps` shows to every user on the host until
//     the nonce is burned;
//   - the mTLS proxy listener (MTLS_PROXY_PORT) has no local auth of its own:
//     any local user that can connect to it rides this user's client cert;
//   - port squatting: another user binding AR_PORT/MTLS_PROXY_PORT first and
//     impersonating the daemon (bin/hivemind now fails fast when its own setup
//     daemon dies, but does not authenticate the process it talks to).
//
// The loopback bind (AR_BIND=127.0.0.1) keeps OTHER MACHINES out; it does
// nothing about a web page open in the user's own browser, which can fire
// requests at http://127.0.0.1:<AR_PORT> from any origin. Before this guard,
// a cross-origin `fetch(..., {method:'POST', headers:{'Content-Type':
// 'text/plain'}, body: JSON})` was a CORS "simple request" (no preflight),
// Hono's c.req.json() parsed it regardless of Content-Type, and the old
// wildcard CORS (`origin: '*'`) even let the attacker read the response.
//
// Three rules, applied to every route (GETs included):
//  0. Host — must be exactly 127.0.0.1:<port> or localhost:<port>, else 403
//     forbidden_host. This closes DNS rebinding: a page on evil.example whose
//     DNS is rebound to 127.0.0.1 is same-origin WITH ITSELF, so its GETs carry
//     no Origin and rule 1 cannot see them (e.g. GET /sessions, or the
//     nonce-bearing GET /setup page) — but the browser still sends
//     `Host: evil.example[:port]`, which it cannot forge. Every legit client
//     already matches: bin/hivemind curls http://127.0.0.1:<port>/… (curl
//     derives Host from the URL) and opens http://localhost:<port>/setup in
//     the browser; the page's own fetches are relative, so same Host. A
//     missing Host (HTTP/1.0 with none) is refused too.
//  1. Origin — browsers attach it to every cross-origin request and to every
//     POST. If present, it must be this daemon's own origin
//     (http://127.0.0.1:<port> or http://localhost:<port>, the two hosts
//     bin/hivemind uses). Anything else — including the opaque `null` origin
//     of sandboxed iframes / file:// pages — gets 403 forbidden_origin.
//     Absent Origin = a non-browser client (bin/hivemind's curl), allowed.
//  2. Content-Type — a POST must declare application/json. That forces any
//     cross-origin browser POST into a CORS preflight, which this daemon no
//     longer grants (no CORS middleware at all: the setup page is served
//     same-origin by the daemon itself, so it never needed CORS).
//
// This is NOT authentication of non-browser local processes — anything that
// can run curl as this user can still omit Origin. The setup enroll route
// adds its own one-shot nonce for that (R2, routes/setup.ts).
import type { MiddlewareHandler } from 'hono';

export function localOriginGuard(port: number): MiddlewareHandler {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  return async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase();
    if (!allowedHosts.has(host)) {
      return c.json({ error: 'forbidden_host' }, 403);
    }
    const origin = c.req.header('origin');
    if (origin !== undefined && !allowed.has(origin)) {
      return c.json({ error: 'forbidden_origin' }, 403);
    }
    if (c.req.method === 'POST') {
      const ct = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') {
        return c.json({ error: 'unsupported_media_type', expected: 'application/json' }, 415);
      }
    }
    await next();
  };
}
