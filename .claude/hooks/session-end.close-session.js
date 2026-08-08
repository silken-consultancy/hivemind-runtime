// HiveMind — auto-close the product session — SessionEnd hook
// session-end.close-session.js
//
// Triggered by: SessionEnd (see .claude/settings.json). NOT registered under
// Stop — see the "WHY NOT Stop" section below, it is load-bearing.
//
// PURPOSE:
//   `bin/hivemind` opens a real fos_session before `exec claude` and exports
//   its id as ENGRAM_SESSION_ID (see `_open_session_spine` in bin/hivemind).
//   Historically the ONLY way that session closed was the founder typing
//   `/end-session` by hand — no Stop hook, no SessionEnd hook, and neither
//   the product CLAUDE.md nor /boot even mentioned it. That is how orphan
//   sessions were born (P1 of the same implementation measured the server
//   watchdog could not reliably reclaim them either — see end-session.md's
//   corrected fallback text). This hook is the client-side half of the fix:
//   it closes the session automatically the moment the window really ends,
//   without the founder needing to type anything.
//
// WHY NOT Stop (measured, load-bearing — do not "fix" by adding Stop here):
//   `Stop` fires at the end of EVERY assistant turn, not at session end —
//   measured directly on this repo (see project memory
//   pattern_hivemind-runtime-updater-settings-from-source-self-heals-dangling-hook-removal,
//   which documents the SAME empirical fact about the prior stop.* hook: "the
//   hook's own header comment mis-says 'session end'" — it does not mean
//   that). `hivemind` execs `claude` INTERACTIVELY (bin/hivemind: `exec claude
//   --setting-sources user "$@"`, no --print) — a session normally spans many
//   turns. Wiring this same close() call to Stop would close the REAL
//   fos_session after the FIRST assistant response, while the process (and
//   the conversation) keeps going for every turn after that. That is not a
//   cosmetic bug: `active_sessions` would show `closed_at` set while the
//   window is still live, which (a) frees the DR-7.A per-slug lock early,
//   letting a second `hivemind open` for the same slug run CONCURRENTLY
//   against a session that is actually still in use, and (b) breaks any later
//   in-window continuity that assumes the session is still open. This is a
//   deliberate, flagged omission — see the delivery report for this phase —
//   not an oversight. If a Stop-based safety net is still wanted, it needs a
//   DIFFERENT design (Claude Code's Stop hook input carries no "is this
//   really the last turn" signal to build one safely on).
//
// SessionEnd `reason` filtering (also load-bearing): SessionEnd fires for
// reasons OTHER than real termination too — specifically "clear" (the user
// ran /clear; the process and the product session are still very much alive)
// and, to be conservative, "logout" (re-auth, not necessarily process exit).
// Closing the real fos_session on those would reproduce the exact Stop
// problem above through a side door. Only "prompt_input_exit" and "other"
// (and anything unrecognized, fail-open toward the plan's actual goal) close
// the session; "clear" and "logout" are explicitly skipped.
//
// MANDATORY DISCIPLINES (fail-open, same posture as the other 3 hooks here):
//   - Any error (parse, missing env, network) → exit 0, NEVER blocks/errors
//     the session teardown.
//   - Best-effort only: a missing ENGRAM_SESSION_ID (session never opened
//     this window — see `_open_session_spine`'s own best-effort posture) is a
//     silent no-op, not a failure.
//   - Idempotent by construction: fos_session(action:'close') on an
//     already-closed session returns {already_closed:true} server-side
//     (engram apps/backend/src/modules/sessions/sessions.service.ts) — safe
//     to fire even if the founder already ran /end-session.
//   - Reuses the SAME local mTLS-proxy call shape bin/hivemind itself uses
//     (`_mcp_call`/`_open_session_spine`): POST a JSON-RPC tools/call to
//     http://127.0.0.1:${MTLS_PROXY_PORT}/v1/mcp with header
//     `x-fos-key: ${FOS_API_KEY}`. Both env vars are already exported into
//     this process's environment by `bin/hivemind` (`set -a; . .env; set +a`
//     before `exec claude`), so no new credential plumbing is needed.
//
// Input (stdin): SessionEnd event JSON — { session_id, transcript_path, cwd,
// reason, ... } (session_id here is Claude Code's OWN session id, not ours —
// we use ENGRAM_SESSION_ID from the environment for the real close call).

'use strict';

const https = require('node:https');

const SKIP_REASONS = new Set(['clear', 'logout']);

main();

function main() {
  let input = {};
  try {
    const raw = require('node:fs').readFileSync(0, 'utf8');
    if (raw) input = JSON.parse(raw);
  } catch {
    // stdin is optional/best-effort for this hook; proceed with input = {}.
  }

  try {
    const reason = String(input.reason || '');
    if (SKIP_REASONS.has(reason)) {
      process.exit(0); // /clear or /logout — process still alive, do not close.
    }

    const sessionId = process.env.ENGRAM_SESSION_ID || '';
    if (!sessionId) {
      process.exit(0); // no spine opened this window — nothing to close.
    }

    const port = process.env.MTLS_PROXY_PORT;
    if (!port) {
      process.exit(0); // proxy not configured this window — never guess a port number.
    }
    const apiKey = process.env.FOS_API_KEY || '';
    if (!apiKey) {
      process.exit(0); // enrollment incomplete — same degrade posture as bin/hivemind.
    }

    // First attempt: no inline next_note. Lets a real note set earlier this
    // window (fos_session action:'update', or a partially-run /end-session
    // step 2) win, per sessions.service.ts's own precedence rules.
    closeSession(port, apiKey, sessionId, reason, undefined, (result) => {
      if (result && result._err === 'next_note_required') {
        // No valid WIP:/NEXT: note exists anywhere for this session — retry
        // with a distinct, machine-attributable floor note (mirrors the
        // watchdog's '[watchdog-orphan: ...]' floor format/spirit), shaped to
        // satisfy validateNextNote's WIP:/NEXT: requirement directly (no
        // force:true needed).
        const floor =
          'WIP: [auto-close: SessionEnd hook — no explicit /end-session handoff was recorded]\n' +
          'NEXT: run /end-session at the start of the next session for a deliberate handoff note';
        closeSession(port, apiKey, sessionId, reason, floor, () => process.exit(0));
        return;
      }
      process.exit(0);
    });
  } catch (err) {
    process.stderr.write(`[session-end.close-session] WARN: ${err.message}\n`);
    process.exit(0);
  }
}

// closeSession: POST a JSON-RPC tools/call for fos_session(action:'close')
// through the local mTLS proxy — same shape as bin/hivemind's `_mcp_call`.
// Fail-open on any network/parse error (calls `done(null)`); never throws.
function closeSession(port, apiKey, sessionId, reason, nextNote, done) {
  const args = { action: 'close', session_id: sessionId, reason: 'session-end-hook' };
  if (nextNote) args.next_note = nextNote;

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'fos_session', arguments: args },
  });

  // mtls-proxy ALWAYS terminates TLS (bindProxyListener sets `tls:{cert,key}`
  // unconditionally — runtime/src/lib/mtls-proxy.ts:307-310), so this MUST be
  // https, verified against the same local trust anchor bin/hivemind computes
  // (_trust_local_ca / LOCAL_HTTPS_CA — bin/hivemind:54). Never
  // rejectUnauthorized:false — that would reopen a MITM-able hop for
  // x-fos-key on loopback.
  let ca;
  try {
    ca = require('node:fs').readFileSync(
      require('node:path').join(
        require('node:os').homedir(),
        '.engram',
        'mtls',
        'local-https',
        'ca.cert.pem',
      ),
    );
  } catch {
    done(null); // fail-open — no CA available, cannot verify, do not proceed insecurely.
    return;
  }

  const req = https.request(
    {
      host: '127.0.0.1',
      port: Number(port),
      path: '/v1/mcp',
      method: 'POST',
      ca,
      headers: {
        'x-fos-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 5000,
    },
    (res) => {
      let raw = '';
      res.on('data', (d) => {
        raw += d;
      });
      res.on('end', () => {
        done(parseToolResult(raw));
      });
    },
  );
  req.on('error', () => done(null)); // fail-open
  req.on('timeout', () => {
    req.destroy();
    done(null); // fail-open
  });
  req.write(body);
  req.end();
}

// parseToolResult: pull the SSE "data:" line (same convention as
// bin/hivemind's `_mcp_call`/`_mcp_result_field`) and JSON.parse the two hops
// (JSON-RPC envelope, then the tool's own JSON in result.content[0].text).
// Returns null on any parse failure — callers treat that as "no signal, move
// on" (fail-open), never as an error to surface.
function parseToolResult(raw) {
  try {
    const line = String(raw)
      .split('\n')
      .find((l) => l.startsWith('data:'));
    if (!line) return null;
    const envelope = JSON.parse(line.slice('data:'.length).trim());
    return JSON.parse(envelope.result.content[0].text);
  } catch {
    return null;
  }
}
