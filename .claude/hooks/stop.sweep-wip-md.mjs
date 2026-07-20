#!/usr/bin/env node
// HiveMind — Stop hook: WIP sweep (product port of the 4tuenyOS lab hook).
// stop.sweep-wip-md.mjs
//
// Triggered by: Claude Code Stop event (registered in .claude/settings.json,
// installed into $HIVEMIND_HOME/.claude/hooks/ by install.sh — see the
// __HIVEMIND_HOME__ templating in that script).
//
// PURPOSE: sweep <project>/docs/wip/*.md into the backend (fos_sketchpad) and
// delete the local file after a confirmed write — WIP/plans/outputs should
// live in the backend, not sit as an uncommitted local file. Ports the same
// materialize-then-delete LOGIC as the lab's
// kernel/hooks/stop.sweep-wip-md.mjs (4tuenyOS repo) — same sweep semantics,
// same fail-safe posture — but talks to the backend over mTLS, not FOS_API_KEY
// bearer + REST.
//
// ── VERIFIED, NOT PRESUMED (2026-07-20): no product-prescribed docs/wip
// convention exists in hivemind-runtime ──
// The lab (4tuenyOS) is a single fixed self-hosting repo whose tech-architect
// contract prescribes `docs/wip/<slug>.md` as the working surface. HiveMind is
// a generic product installed into arbitrary end-user projects — there is no
// equivalent prescribed directory (grepped this repo's README.md, CLAUDE.md,
// .claude/commands/{boot,end-session}.md: the product's own "WIP" concept is
// the `next_note` field captured in project_state at /end-session and
// recalled at /boot — not a local .md file at all). So this hook does NOT
// assume parity: it opportunistically sweeps `<project_cwd>/docs/wip/*.md`
// (project_cwd = the Stop event's `cwd` field, i.e. the directory Claude Code
// is running in for THIS session — not $HIVEMIND_HOME, which is fixed
// per-machine config, not a user project) as a generic scratch-file safety
// net for any project that happens to use that convention. Existence-guarded
// exactly like the lab hook (WIP_DIR absent → skip cleanly, exit 0) — a no-op
// for the common case where a project does not use docs/wip/.
//
// SCOPE: non-recursive — only *.md directly under docs/wip/. Nested
// directories are NOT swept (mirrors the lab hook).
//
// SCOPE CUT (v1, same judgment call as the lab hook): no interactive
// "keep-live-WIP" path. Always materialize-then-delete. Claude Code's
// Stop-hook block semantics (exit 2 = block stop, re-run hook) are a known
// infinite-loop footgun if the re-entry condition isn't airtight — not
// introduced here.
//
// ── AUTH — mTLS, NOT the lab's X-FOS-Key bearer (measured, do not copy the
// lab's fetch/auth code) ──
// hivemind-runtime authenticates to the backend via client-cert mTLS
// (MTLS_CERT_PATH/MTLS_KEY_PATH/MTLS_CA_PATH, written into $HIVEMIND_HOME/.env
// by runtime/src/routes/setup.ts at enrollment). This hook mirrors
// runtime/src/lib/backend-mcp-client.ts's `callMcpTool`: connect DIRECTLY to
// the mTLS upstream (MTLS_UPSTREAM, derived from HIVEMIND_ENDPOINT — the
// product's dedicated MCP HTTPS listener, mTLS strict, serves the FULL
// backend app including the MCP JSON-RPC surface), never the daemon's own
// local loopback proxy (mtls-proxy.ts) — same reasoning
// backend-mcp-client.ts's header documents: administrative/hook-initiated
// calls must not be coupled to whether the daemon's proxy happens to be up.
// Two-layer auth (architecture_mtls-is-defense-in-depth-envelope-over-fos-key):
// the mTLS handshake is the envelope; FOS_API_KEY (x-fos-key header) is still
// required on top of it.
//
// Rather than REST POST /v1/sketchpads (the lab's REST path, also reachable
// on this listener since it serves the whole AppModule), this hook uses the
// JSON-RPC `tools/call` envelope against fos_sketchpad (action:"create") —
// the SAME already-proven, already-tested call convention this codebase uses
// for every other daemon→backend call (bin/hivemind's `_mcp_call`,
// backend-mcp-client.ts's `callMcpTool`). Reusing that convention here avoids
// introducing a second, divergent HTTP contract for a one-off hook.
//
// HTTP client: node:https directly (not fetch+undici Agent — `node:undici` is
// not a reliably available builtin across Node runtimes in this fleet,
// verified 2026-07-20). https.request's native `cert`/`key`/`ca` TLS options
// are the always-available equivalent.
//
// FAIL-SAFE (same posture as the lab hook — never blocks session close):
//   - Cert material not configured (not enrolled yet) → skip entirely, stderr, exit 0.
//   - Non-2xx / RPC error / network failure → file stays in place, logged to
//     stderr, next file is processed, hook still exits 0.
//   - On ANY error: catch it, log to stderr (never silently swallow), exit 0.
//   - This hook NEVER exits non-zero — it must never block session close.
//
// PF-8-style write order: never delete the local .md before the backend
// write is confirmed successful (mirrors the lab hook + push.ts's rule).
//
// Env vars (loaded from $HIVEMIND_HOME/.env if not already set — mirrors
// runtime/src/lib/env.ts's loadHivemindEnv):
//   HIVEMIND_HOME       — default ~/.hivemind
//   MTLS_CERT_PATH / MTLS_KEY_PATH / MTLS_CA_PATH — client cert material (~ expanded)
//   MTLS_UPSTREAM       — https://<host>/v1/mcp (derived from HIVEMIND_ENDPOINT if unset)
//   HIVEMIND_ENDPOINT   — host:port fallback when MTLS_UPSTREAM is unset
//   FOS_API_KEY         — sent as x-fos-key header (required alongside the cert)
//   HIVEMIND_DEVICE_ID  — device_id sent to fos_sketchpad; falls back to hook-<hostname>

import { readFileSync, readdirSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir, hostname } from 'node:os';
import { request as httpsRequest } from 'node:https';

// ─── load $HIVEMIND_HOME/.env ──────────────────────────────────────────────────
// Mirrors runtime/src/lib/env.ts's loadHivemindEnv() exactly (same resolution
// order, same quote-stripping, same "do not override an already-set var").

const HIVEMIND_HOME =
  process.env.HIVEMIND_HOME ?? process.env.FOS_ROOT ?? join(homedir(), '.hivemind');

const envPath = join(HIVEMIND_HOME, '.env');
if (existsSync(envPath)) {
  try {
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* best-effort */
  }
}

// ─── expand leading ~ ───────────────────────────────────────────────────────────
function expandPath(p) {
  return p && p.startsWith('~') ? homedir() + p.slice(1) : p;
}

// ─── guard: skip if mTLS is not configured (not enrolled yet) ─────────────────

const CERT_PATH = expandPath(process.env.MTLS_CERT_PATH ?? '');
const KEY_PATH = expandPath(process.env.MTLS_KEY_PATH ?? '');
const CA_PATH = expandPath(process.env.MTLS_CA_PATH ?? '');
const API_KEY = process.env.FOS_API_KEY ?? '';
const DEVICE_ID = process.env.HIVEMIND_DEVICE_ID ?? `hook-${hostname()}`;

let UPSTREAM = process.env.MTLS_UPSTREAM ?? '';
if (!UPSTREAM) {
  const endpoint = process.env.HIVEMIND_ENDPOINT ?? 'hivemind.silken.ia.br:4443';
  UPSTREAM = `https://${endpoint}/v1/mcp`;
}

if (!CERT_PATH || !KEY_PATH || !CA_PATH) {
  process.stderr.write(
    '[sweep-wip-md] MTLS_CERT_PATH/MTLS_KEY_PATH/MTLS_CA_PATH not configured (not enrolled yet?) — skipping sweep\n',
  );
  process.exit(0);
}

let CERT, KEY, CA;
try {
  CERT = readFileSync(CERT_PATH);
  KEY = readFileSync(KEY_PATH);
  CA = readFileSync(CA_PATH);
} catch (err) {
  // Generic message only — err.message embeds the absolute local filesystem
  // path of the mTLS material (not a secret-byte leak, but avoid disclosing
  // it on stderr). At most a basename, never the full path.
  const badPath = err && typeof err.path === 'string' ? basename(err.path) : undefined;
  process.stderr.write(
    `[sweep-wip-md] mTLS material unreadable${badPath ? ` (${badPath})` : ''} — check MTLS_CERT_PATH/KEY_PATH/CA_PATH — skipping sweep\n`,
  );
  process.exit(0);
}

// ─── resolve the project directory for THIS session ────────────────────────────
// Stop event stdin carries { session_id, transcript_path, cwd, hook_event_name,
// stop_hook_active }. `cwd` is the directory Claude Code is running the session
// in (the user's project) — best-effort read; falls back to process.cwd() (the
// hook subprocess inherits the session's cwd from Claude Code regardless).

let PROJECT_DIR = process.cwd();
try {
  const raw = readFileSync(0, 'utf8');
  if (raw) {
    const input = JSON.parse(raw);
    if (input && typeof input.cwd === 'string' && input.cwd) {
      PROJECT_DIR = input.cwd;
    }
  }
} catch {
  /* best-effort — stdin optional/unparseable, fall back to process.cwd() */
}

const WIP_DIR = join(resolve(PROJECT_DIR), 'docs/wip');

if (!existsSync(WIP_DIR)) {
  // Expected common case — this product has no prescribed docs/wip convention
  // (see header). Silent, cheap no-op.
  process.exit(0);
}

// ─── mTLS JSON-RPC call: tools/call fos_sketchpad(action:"create") ─────────────
// Mirrors runtime/src/lib/backend-mcp-client.ts's callMcpTool: POST the
// JSON-RPC envelope to MTLS_UPSTREAM presenting the client cert; response is
// SSE, one "data: <json>" line carries the JSON-RPC envelope.

function sketchpadCreate(title, content) {
  return new Promise((resolvePromise) => {
    let url;
    try {
      url = new URL(UPSTREAM);
    } catch (err) {
      resolvePromise({ ok: false, error: `invalid MTLS_UPSTREAM: ${err.message}` });
      return;
    }

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'fos_sketchpad',
        arguments: {
          action: 'create',
          title,
          content,
          device_id: DEVICE_ID,
          pinned: false,
        },
      },
    });

    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        cert: CERT,
        key: KEY,
        ca: CA,
        rejectUnauthorized: true,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-fos-key': API_KEY,
          'content-length': Buffer.byteLength(payload),
        },
        timeout: 15000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            resolvePromise({ ok: false, error: `HTTP ${status} ${body.slice(0, 200)}` });
            return;
          }
          const dataLine = body.split('\n').find((line) => line.startsWith('data:'));
          if (!dataLine) {
            resolvePromise({ ok: false, error: `no SSE data line in response (status=${status})` });
            return;
          }
          let envelope;
          try {
            envelope = JSON.parse(dataLine.slice('data:'.length).trim());
          } catch (err) {
            resolvePromise({ ok: false, error: `malformed JSON-RPC envelope: ${err.message}` });
            return;
          }
          if (envelope.error) {
            resolvePromise({ ok: false, error: `tool error: ${JSON.stringify(envelope.error)}` });
            return;
          }
          resolvePromise({ ok: true });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('request timed out'));
    });
    req.on('error', (err) => {
      resolvePromise({ ok: false, error: err.message });
    });

    req.write(payload);
    req.end();
  });
}

// ─── sweep cycle ──────────────────────────────────────────────────────────────

async function main() {
  let entries;
  try {
    entries = readdirSync(WIP_DIR);
  } catch (err) {
    process.stderr.write(`[sweep-wip-md] failed to list ${WIP_DIR}: ${err.message}\n`);
    return;
  }

  const mdFiles = entries.filter((name) => {
    if (!name.toLowerCase().endsWith('.md')) return false;
    const full = join(WIP_DIR, name);
    try {
      return statSync(full).isFile();
    } catch {
      return false;
    }
  });

  if (mdFiles.length === 0) {
    process.exit(0);
  }

  let sweptCount = 0;
  let deletedEmptyCount = 0;
  let failedCount = 0;

  for (const fileName of mdFiles) {
    const filePath = join(WIP_DIR, fileName);
    const title = fileName.replace(/\.md$/i, '');

    let content;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (err) {
      process.stderr.write(`[sweep-wip-md] failed to read ${filePath}: ${err.message}\n`);
      failedCount++;
      continue;
    }

    // Empty/whitespace-only file → delete, no backend write (nothing to materialize).
    if (content.trim().length === 0) {
      try {
        unlinkSync(filePath);
        deletedEmptyCount++;
        process.stderr.write(`[sweep-wip-md] deleted empty ${fileName} (no backend write)\n`);
      } catch (err) {
        process.stderr.write(`[sweep-wip-md] failed to delete empty ${filePath}: ${err.message}\n`);
        failedCount++;
      }
      continue;
    }

    // Non-empty file → fos_sketchpad(action:"create") over mTLS JSON-RPC.
    // Per-file try/catch: a synchronous throw (e.g. malformed cert material
    // rejected by tls.connect before any 'error' event can attach) must NOT
    // abort the remaining files in this run — same "continue to next file"
    // contract as the lab hook.
    let result;
    try {
      result = await sketchpadCreate(title, content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { ok: false, error: msg };
    }

    // Confirmed success → delete the local .md. Never delete before this point
    // (PF-8-style ordering — never lose data on a failed/partial write).
    if (result.ok) {
      try {
        unlinkSync(filePath);
        sweptCount++;
        process.stderr.write(`[sweep-wip-md] swept ${fileName} → fos_sketchpad, deleted local file\n`);
      } catch (err) {
        // Materialized in the backend but failed to delete locally — not data
        // loss, but flag it (will be re-swept as a duplicate next session).
        process.stderr.write(
          `[sweep-wip-md] swept ${fileName} but failed to delete local file: ${err.message}\n`,
        );
        failedCount++;
      }
    } else {
      process.stderr.write(`[sweep-wip-md] failed to sweep ${fileName}: ${result.error}\n`);
      failedCount++;
    }
  }

  process.stderr.write(
    `[sweep-wip-md] done — swept=${sweptCount} deleted_empty=${deletedEmptyCount} failed=${failedCount}\n`,
  );
}

try {
  await main();
} catch (err) {
  // Catch-all fail-safe: NEVER block session close, NEVER swallow silently.
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[sweep-wip-md] ERROR (fail-safe, session close NOT blocked): ${msg}\n`);
}

// Always exit 0 — never block session close.
process.exit(0);
