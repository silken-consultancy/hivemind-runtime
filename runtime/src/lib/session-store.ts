// session-store.ts — persistent mirror of the in-memory session store.
//
// The store lives under ~/.engram (this product's own
// hidden dir, same isolation bin/hivemind
// already keeps for pid/log/cert files).
//
// MODEL (load-bearing, not cosmetic): under
// revive-on-return, this file is NEVER the primary source that
// decides whether a session survives a daemon restart — the backend
// (`fos_session(action:list_active)`) is. This JSON is only a boot-degrade
// fallback for the rare case the backend is unreachable at startup, plus a
// best-effort snapshot written on every adopt/shutdown so that fallback has
// something recent to read.
//
// Design invariants:
//   - The JSON file is NEVER the source of truth — it is a snapshot of the Map.
//   - Writes are atomic (tmp + rename) to avoid corrupt reads after a crash mid-write.
//   - load() is best-effort: never throws, returns [] on any error.
//   - All I/O is synchronous on the hot path (persist/load called rarely).

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface PersistedSessionEntry {
  session_id: string;
  pid: number;
  slug: string;
  device_id: string;
  started_at: string; // ISO-8601
}

// ---------------------------------------------------------------
// Paths
// ---------------------------------------------------------------

function storePath(): string {
  return join(homedir(), '.engram', 'cache', 'hivemind-runtime-sessions.json');
}

function tmpPath(): string {
  return storePath() + '.tmp';
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Persist the current set of tracked entries to disk atomically.
 * Called after every adoptPid / onExit mutation so the file stays in sync.
 * Never throws.
 */
export function persist(entries: PersistedSessionEntry[]): void {
  const path = storePath();
  const tmp = tmpPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    console.warn('[session-store] persist failed (non-fatal):', err);
    // Best-effort: cleanup tmp if it exists
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * Load persisted entries from disk.
 * Returns [] on any error (missing file, corrupt JSON, schema mismatch).
 * Never throws.
 */
export function load(): PersistedSessionEntry[] {
  const path = storePath();
  try {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    // Validate shape: filter out entries missing required fields.
    return data.filter(
      (e): e is PersistedSessionEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as Record<string, unknown>).session_id === 'string' &&
        typeof (e as Record<string, unknown>).pid === 'number' &&
        typeof (e as Record<string, unknown>).slug === 'string' &&
        typeof (e as Record<string, unknown>).device_id === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Remove the store file entirely (called on clean shutdown after all sessions closed).
 * Never throws.
 */
export function clear(): void {
  try {
    unlinkSync(storePath());
  } catch {
    // Ignore: file may not exist
  }
}
