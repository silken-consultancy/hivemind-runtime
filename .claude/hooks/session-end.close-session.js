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
//   window is still live, which breaks any later in-window continuity that
//   assumes the session is still open, and marks a still-active lane as
//   closed/handed-off before it truly ended. (Historically this comment also
//   cited a per-slug open() lock freed too early; that harness slug-lock was
//   removed in P4 / impl 989cb79b — concurrent sessions per slug are now
//   intended and made safe by the engram's lane-safe open() guard — so that
//   particular rationale no longer applies, but the continuity one still
//   does.) This is a
//   deliberate, flagged omission — see the delivery report for this phase —
//   not an oversight. If a Stop-based safety net is still wanted, it needs a
//   DIFFERENT design (Claude Code's Stop hook input carries no "is this
//   really the last turn" signal to build one safely on).
//
// SessionEnd `reason` filtering (also load-bearing): SessionEnd fires for
// reasons OTHER than real termination too. Claude Code's reason enum (read
// from the 2.1.281/282 binary) is
// ["clear","resume","logout","prompt_input_exit","other"]. "clear" (/clear)
// and "resume" (/resume) swap the conversation IN-PROCESS — SessionEnd fires
// for the conversation being left while the window, the process and the
// product session are all still alive; "logout" is re-auth, not necessarily
// process exit. Closing the real fos_session on those reproduces the exact
// Stop problem above through a side door — MEASURED: session 82f9f738 closed
// 1 s after the founder typed /resume (history 10:29:24.361 UTC → closed_at
// 10:29:25) under the old skip-list, which only knew clear/logout.
//
// Hence an ALLOWLIST, not a skip-list: only "prompt_input_exit" and "other"
// close the session. Everything else — clear, resume, logout, any reason a
// future Claude Code adds, or an empty/missing reason — exits 0 with NO
// network call. An unknown future in-process reason must fail toward leaving
// the session OPEN: a real orphan is reclaimed by the engram's server-side
// watchdog (WatchdogService, ~60 min idle), whereas closing a live window's
// session is silent corruption of continuity with no backstop.
//
// The raw reason is forwarded to the engram as
// `session-end-hook:<reason>` (close_reason), so a close can be attributed
// to the exact SessionEnd reason that triggered it.
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

// Allowlist — see "SessionEnd `reason` filtering" above. Anything not in this
// set (including unknown/future reasons and an empty reason) never closes.
const CLOSE_REASONS = new Set(['prompt_input_exit', 'other']);

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
    if (!CLOSE_REASONS.has(reason)) {
      process.exit(0); // clear/resume/logout/unknown/empty — window may be alive, do not close.
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
        // No valid WIP:/NEXT:/LANE: note exists anywhere for this session — retry
        // with a distinct, machine-attributable floor note (mirrors the
        // watchdog's floor format/spirit + buildFloorNextNote's synthetic LANE),
        // shaped to satisfy validateNextNote's WIP:/NEXT:/LANE: requirement
        // directly (no force:true needed). The 'LANE: <auto:hook>' marks a
        // machine-closer (no vessel/model in the loop) for signed-lane rehydration —
        // REQUIRED since the engram backend now enforces a LANE: line (impl 989cb79b
        // P3.8); without it this auto-close would be rejected and continuity break.
        const floor =
          'WIP: [auto-close: SessionEnd hook — no explicit /end-session handoff was recorded]\n' +
          'NEXT: run /end-session at the start of the next session for a deliberate handoff note\n' +
          'LANE: <auto:hook>';
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
  // Forward the raw SessionEnd reason (both attempts, incl. the floor-note
  // retry) so close_reason attributes the close to what triggered it.
  const args = {
    action: 'close',
    session_id: sessionId,
    reason: `session-end-hook:${reason}`, // reason is always in CLOSE_REASONS here
  };
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
