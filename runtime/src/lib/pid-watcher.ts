// pid-watcher.ts — monitors an external pid (not a Unix child of this process).
//
// Verbatim port of services/agent-runtime/src/lib/pid-watcher.ts (Fase 2,
// DR-2.2, docs/wip/hivemind-runtime-lifecycle-daemon-reconcile-port.md) — no
// behavior change, the polling mechanics are identical.
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
// Cross-platform flag (DR-5.2, docs/ARCHITECTURE.md): process.kill(pid, 0)
// under Bun/Node on NATIVE Windows (not WSL) has different semantics — no
// real POSIX signal 0 delivery, the implementation maps it to a different
// existence check. Reconfirm this when/if Windows support is scheduled;
// not a blocker today (this daemon only runs on Linux/macOS/WSL).

type ExitReason = 'exit' | 'kill';

/**
 * Watch an external pid by polling every 2 seconds.
 * Calls onExit('kill') when the process is no longer found (ESRCH).
 * Returns a cleanup function that stops the poll without triggering onExit.
 */
export function watchPid(pid: number, onExit: (reason: ExitReason) => void): () => void {
  let closed = false;

  const timer = setInterval(() => {
    if (closed) return;

    try {
      // signal 0: check existence without sending a real signal.
      process.kill(pid, 0);
      // pid still alive — continue polling.
    } catch (err: unknown) {
      // ESRCH = no such process; EPERM = exists but no permission (treat as alive).
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        // pid is gone — fire onExit and stop polling immediately.
        closed = true;
        clearInterval(timer);
        try {
          onExit('kill');
        } catch (cbErr) {
          console.error('[pid-watcher] onExit callback threw:', cbErr);
        }
      }
      // EPERM or any other error: pid may still be alive — continue polling.
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
