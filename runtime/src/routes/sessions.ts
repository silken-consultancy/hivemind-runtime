// sessions.ts — daemon-side session pid registry (Fase 2,
// docs/wip/hivemind-runtime-lifecycle-daemon-reconcile-port.md, DR-2.1/2.2/2.3/2.4/2.5)
// + reconcile observability events (Fase 4, DR-4.1 — see lifecycle-emitter.ts
// for the corrected kind_category mapping).
//
// POST /sessions/adopt — bin/hivemind (Fase 3, DR-3.1) calls this once, after
//   _open_session_spine has already opened the session in the backend and
//   BEFORE `exec claude` replaces the script's process image — the pid it
//   sends ($$ in bash) only stays valid across that exec because exec
//   preserves the pid. Starts the pid-watcher + heartbeat for the session.
// GET  /sessions — diagnostic listing, incl. heartbeat_active (DR-2.5).
//
// REVIVE-ON-RETURN (the model this whole file implements, not a variant of
// the lab's): the daemon never decides on its own that a session is dead. A
// pid dying — whether mid-session (pid-watcher onExit) or found dead during
// reconcileOnStartup — only ever PAUSES the session in the backend, never
// closes it. Only the backend's WatchdogService (a conservative, generous
// timeout — see the plan's STATE section) closes a session nobody ever came
// back to. Sessions are tracked in a module-level Map (source of truth
// in-process); the JSON mirror (session-store.ts) is a boot-degrade fallback
// only, consulted in reconcileOnStartup() when the backend itself is
// unreachable at boot.
//
// Route is mounted public (no auth) — same localhost-only bypass as
// /healthz and /setup: this daemon binds 127.0.0.1 only, never externally
// exposed.

import { Hono } from 'hono';
import { z } from 'zod';
import { watchPid } from '../lib/pid-watcher.ts';
import { callMcpTool } from '../lib/backend-mcp-client.ts';
import { env } from '../lib/env.ts';
import { persist, load, type PersistedSessionEntry } from '../lib/session-store.ts';
import { lifecycleEmitter } from '../lib/lifecycle-emitter.ts';

export const sessions = new Hono();

// ---------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------

interface SessionEntry {
  session_id: string;
  slug: string;
  device_id: string;
  pid?: number;
  pidCleanup?: () => void;
  heartbeatTimer?: ReturnType<typeof setInterval>;
}

const sessionStore = new Map<string, SessionEntry>();

/**
 * Persist the current state of sessionStore to disk (best-effort mirror).
 * Called after every adoptPid — NOT the decision-maker for session
 * lifecycle (that's the backend), just a cache for the reconcile fallback.
 */
function persistStore(): void {
  const entries: PersistedSessionEntry[] = [];
  for (const e of sessionStore.values()) {
    if (e.pid !== undefined) {
      entries.push({
        session_id: e.session_id,
        pid: e.pid,
        slug: e.slug,
        device_id: e.device_id,
        started_at: new Date().toISOString(),
      });
    }
  }
  persist(entries);
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

/** Check pid liveness. ESRCH → dead; EPERM (exists, no permission) → alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

/** Pause the session in the backend (best-effort — never throws). */
async function pauseSessionInBackend(sessionId: string): Promise<void> {
  await callMcpTool('fos_session', { action: 'pause', session_id: sessionId });
}

/** Resume the session in the backend (best-effort, idempotent — never throws). */
async function resumeSessionInBackend(sessionId: string): Promise<void> {
  await callMcpTool('fos_session', { action: 'resume', session_id: sessionId });
}

/** Send a heartbeat for the session (best-effort — never throws). */
async function sendHeartbeat(sessionId: string): Promise<void> {
  await callMcpTool('fos_heartbeat', {
    action: 'update',
    session_id: sessionId,
    agent_type: 'claude-code',
    interface: 'cli',
  });
}

/**
 * Start pid-watcher + heartbeat for an existing session entry.
 * Idempotent: if already watching, does nothing.
 */
function adoptPid(entry: SessionEntry, pid: number): void {
  if (entry.pidCleanup) {
    // Already watching — skip.
    return;
  }

  entry.pid = pid;

  // Persist the new pid to disk immediately.
  persistStore();

  // Heartbeat every ~30s while pid is alive (DR-2.2 — Correção A: without
  // this, a silent-but-alive interactive session goes stale in the
  // backend's eyes and eventually reads as orphan to the watchdog, even
  // though nothing is actually wrong).
  entry.heartbeatTimer = setInterval(() => {
    void sendHeartbeat(entry.session_id);
  }, 30_000);

  // pid-watcher: when the pid dies, PAUSE (not close) — revive-on-return
  // (DR-2.2/2.3). The daemon is not the judge of whether the session is
  // gone for good; it only reports "no local process for this right now".
  entry.pidCleanup = watchPid(pid, (_reason) => {
    console.log(`[sessions] pid ${pid} gone — pausing session ${entry.session_id} (revive-on-return)`);

    if (entry.heartbeatTimer) {
      clearInterval(entry.heartbeatTimer);
      entry.heartbeatTimer = undefined;
    }
    entry.pidCleanup = undefined;

    // No local pid left to track — drop from the in-memory table + mirror.
    sessionStore.delete(entry.session_id);
    persistStore();

    void pauseSessionInBackend(entry.session_id);
  });

  console.log(`[sessions] pid-watcher started for pid=${pid} session=${entry.session_id}`);
}

// ---------------------------------------------------------------
// POST /sessions/adopt
// ---------------------------------------------------------------

const adoptSchema = z.object({
  session_id: z.string().min(1),
  pid: z.number().int().positive(),
  slug: z.string().min(1),
});

sessions.post('/adopt', async (c) => {
  const raw = await c.req.json().catch(() => null);
  if (!raw) return c.json({ error: 'invalid_json' }, 400);

  const parsed = adoptSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'validation_failed', issues: parsed.error.issues }, 400);
  }

  const { session_id, pid, slug } = parsed.data;

  let entry = sessionStore.get(session_id);
  if (!entry) {
    entry = { session_id, slug, device_id: env.HIVEMIND_DEVICE_ID ?? '' };
    sessionStore.set(session_id, entry);
  }
  adoptPid(entry, pid);

  return c.json({ ok: true, session_id, pid });
});

// ---------------------------------------------------------------
// reconcileOnStartup — called once at daemon startup (server.ts), before
// Bun.serve. Source of truth = the backend (fos_session action:list_active),
// filtered to THIS device — list_active is NOT device-filtered server-side
// (it returns every open session for the owner, across every machine), so
// skipping that filter would check pid liveness of an unrelated machine's
// pid against processes on THIS one — a false-positive revive. The local
// JSON mirror (session-store.ts) is consulted ONLY when the backend call
// itself fails (network/outage at boot) — a degraded fallback, never the
// primary source.
//
// For each of this device's sessions:
//   - pid alive (or EPERM) → re-adopt (pid-watcher + heartbeat) + resume
//     in the backend (idempotent even if paused_at was already NULL).
//   - pid dead (ESRCH) or null → untouched. Never closed here — that is the
//     WatchdogService's job, and only after its own conservative threshold.
//
// Fase 4, DR-4.1: emits a fire-and-forget hivemind_runtime.daemon_started
// event (revived/skipped counts) once reconcile finishes — both the normal
// (backend list_active) and degraded (local mirror) branches. Skipped only
// in the HIVEMIND_DEVICE_ID-absent guard above: that path has no
// revived/skipped count to report, not a reconcile run.
// ---------------------------------------------------------------

interface ActiveSessionRow {
  session_id: string;
  slug: string;
  device_id: string;
  pid: number | null;
}

interface ListActiveResult {
  items: ActiveSessionRow[];
  count: number;
}

export async function reconcileOnStartup(): Promise<void> {
  const deviceId = env.HIVEMIND_DEVICE_ID;
  const result = await callMcpTool<ListActiveResult>('fos_session', { action: 'list_active' });

  if (result && Array.isArray(result.items)) {
    if (!deviceId) {
      // Fail-safe: without a device_id there is nothing to filter list_active
      // by, and reconciling unfiltered risks a cross-device false revive
      // (STATE, docs/wip/hivemind-runtime-lifecycle-daemon-reconcile-port.md)
      // — skip entirely rather than guess.
      console.warn('[sessions] reconcileOnStartup: HIVEMIND_DEVICE_ID unset — skipping (would risk cross-device revive)');
      return;
    }

    const mine = result.items.filter((row) => row.device_id === deviceId);
    let revived = 0;
    let skipped = 0;

    for (const row of mine) {
      if (row.pid === null || !pidAlive(row.pid)) {
        skipped++;
        continue;
      }
      console.log(`[sessions] reconcile: pid ${row.pid} alive — re-adopting session ${row.session_id} (slug=${row.slug})`);
      const entry: SessionEntry = { session_id: row.session_id, slug: row.slug, device_id: row.device_id };
      sessionStore.set(row.session_id, entry);
      adoptPid(entry, row.pid);
      await resumeSessionInBackend(row.session_id);
      revived++;
    }

    console.log(`[sessions] reconcileOnStartup: ${revived} session(s) re-adopted, ${skipped} left untouched (dead pid or gone — watchdog decides)`);

    // Fase 4, DR-4.1 — fire-and-forget observability event, corrected
    // kind_category (see lifecycle-emitter.ts header). Never blocks/throws:
    // lifecycleEmitter.emit() only enqueues.
    lifecycleEmitter.emit('hivemind_runtime.daemon_started', { revived, skipped, degraded: false });
    return;
  }

  // Backend unreachable at boot — degrade to the local mirror, best-effort,
  // logged loudly (not silent — this is a degraded mode, not the norm).
  console.warn('[sessions] reconcileOnStartup: backend list_active unreachable — degrading to local mirror JSON');
  const entries = load();

  let revived = 0;
  for (const e of entries) {
    if (!pidAlive(e.pid)) continue;
    console.log(`[sessions] reconcile (degraded): pid ${e.pid} alive — re-adopting session ${e.session_id}`);
    const entry: SessionEntry = { session_id: e.session_id, slug: e.slug, device_id: e.device_id };
    sessionStore.set(e.session_id, entry);
    adoptPid(entry, e.pid);
    void resumeSessionInBackend(e.session_id); // best-effort — the backend may still be down
    revived++;
  }
  const skipped = entries.length - revived;
  console.log(`[sessions] reconcileOnStartup (degraded): ${revived} session(s) re-adopted from local mirror, ${skipped} left untouched`);

  lifecycleEmitter.emit('hivemind_runtime.daemon_started', { revived, skipped, degraded: true });
}

// ---------------------------------------------------------------
// shutdownSessions — called on SIGTERM/SIGINT only (server.ts's shutdown()).
// SIGHUP is a logged no-op (Fase 1, DR-1.2) and never reaches here.
//
// PAUSE every still-pid-alive tracked session in the backend (not a
// silent local-only persist, as the lab does) — the backend must actually
// reflect "no daemon locally active for this right now" via paused_at, so
// any read of list_active/state shows it correctly rather than looking
// like a normally-active session with zero daemon behind it. A pid that
// already died before shutdown was already paused by its own onExit
// (adoptPid above) — nothing left to repeat for it here.
//
// Fase 4, DR-4.1: emits a fire-and-forget hivemind_runtime.daemon_shutdown
// event (paused count) on every call, including the zero-tracked-sessions
// early return below — "0 paused" is still a real signal on the daemon's
// lifecycle timeline.
// ---------------------------------------------------------------

export async function shutdownSessions(): Promise<void> {
  const entries = [...sessionStore.values()];
  if (entries.length === 0) {
    // Fase 4, DR-4.1 — still emit: "0 sessions paused" is itself a useful
    // signal on the daemon's lifecycle timeline (e.g. a restart while no
    // session was ever adopted), not a reason to go silent.
    lifecycleEmitter.emit('hivemind_runtime.daemon_shutdown', { paused: 0 });
    return;
  }

  console.log(`[sessions] shutdownSessions: pausing ${entries.length} tracked session(s)`);

  // Stop all watchers and heartbeats immediately — no timer fires mid-shutdown.
  for (const e of entries) {
    if (e.pidCleanup) { e.pidCleanup(); e.pidCleanup = undefined; }
    if (e.heartbeatTimer) { clearInterval(e.heartbeatTimer); e.heartbeatTimer = undefined; }
  }

  const alive = entries.filter((e): e is SessionEntry & { pid: number } => e.pid !== undefined && pidAlive(e.pid));

  // Pause in parallel, best-effort — bounded by callMcpTool's own timeout
  // (8s), so a network failure never hangs shutdown waiting for retries.
  await Promise.allSettled(alive.map((e) => pauseSessionInBackend(e.session_id)));

  // Best-effort mirror snapshot for the fallback path in reconcileOnStartup
  // — not the decision-maker, just a cache to accelerate/degrade next boot.
  const liveSessions: PersistedSessionEntry[] = alive.map((e) => ({
    session_id: e.session_id,
    pid: e.pid,
    slug: e.slug,
    device_id: e.device_id,
    started_at: new Date().toISOString(),
  }));
  persist(liveSessions);

  sessionStore.clear();
  console.log(`[sessions] shutdownSessions done: ${alive.length} session(s) paused`);

  lifecycleEmitter.emit('hivemind_runtime.daemon_shutdown', { paused: alive.length });
}

// ---------------------------------------------------------------
// GET /sessions — list adopted sessions (diagnostic, DR-2.5)
// ---------------------------------------------------------------

sessions.get('/', (c) => {
  const list = [...sessionStore.values()].map((e) => ({
    session_id: e.session_id,
    pid: e.pid,
    watching: !!e.pidCleanup,
    heartbeat_active: !!e.heartbeatTimer,
  }));
  return c.json({ sessions: list, count: list.length });
});
