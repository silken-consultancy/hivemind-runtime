// pid-watcher.ts — monitors an external pid (not a Unix child of this process).
//
// Design rationale: the interactive Claude process is not a Unix child of
// this daemon — bin/hivemind's cmd_open `exec`s claude in the terminal, so
// child.on('exit') does not apply. Instead, poll process.kill(pid, 0) every
// 2s. When it throws ESRCH ("no such process"), the pid has died.
//
// pid reuse safety: onExit fires on the FIRST ESRCH, then the interval is
// cleared immediately. This prevents false positives from a recycled pid.
//
// The returned cleanup function cancels the polling WITHOUT triggering onExit.
//
// Cross-platform flag (see docs/ARCHITECTURE.md): process.kill(pid, 0)
// under Bun/Node on NATIVE Windows (not WSL) has different semantics — no
// real POSIX signal 0 delivery, the implementation maps it to a different
// existence check. Reconfirm this when/if Windows support is scheduled;
// not a blocker today (this daemon only runs on Linux/macOS/WSL).

import { readFileSync } from 'node:fs';

type ExitReason = 'exit' | 'kill';

/**
 * Linux only: true when /proc/<pid>/stat reports state `Z` (zombie: exited,
 * not yet reaped). kill(pid, 0) succeeds on a zombie, so it reads as alive.
 * Any read/parse failure -> false (fall back to the kill(0) answer).
 */
function isZombie(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // "<pid> (<comm>) <state> ..." — comm may contain ')' so cut at the LAST one.
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z';
  } catch {
    return false;
  }
}

/**
 * Shared liveness check. ESRCH -> dead; EPERM (exists, no permission) -> alive;
 * on Linux a zombie (state Z) -> dead. Windows/macOS keep kill(pid, 0) semantics.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
  return !isZombie(pid);
}

/**
 * Watch an external pid by polling every 2 seconds.
 * Calls onExit('kill') when the process is no longer found (ESRCH).
 * Returns a cleanup function that stops the poll without triggering onExit.
 */
export function watchPid(pid: number, onExit: (reason: ExitReason) => void): () => void {
  let closed = false;

  const timer = setInterval(() => {
    if (closed) return;

    // ESRCH or a Linux zombie = gone; EPERM/other errors = still alive.
    if (!pidAlive(pid)) {
      closed = true;
      clearInterval(timer);
      try {
        onExit('kill');
      } catch (cbErr) {
        console.error('[pid-watcher] onExit callback threw:', cbErr);
      }
    }
  }, 2_000);

  // Return cleanup: cancels polling without triggering onExit.
  return () => {
    if (!closed) {
      closed = true;
      clearInterval(timer);
    }
  };
}
