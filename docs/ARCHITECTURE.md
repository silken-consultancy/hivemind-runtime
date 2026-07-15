# Architecture — cross-platform seam

Design-doc only. No functional code changes; this documents where the
current implementation is Unix-specific and how a future native-Windows
port would slot in, per
`docs/wip/hivemind-runtime-lifecycle-daemon-reconcile-port.md` § Fase 5
(DR-5.1/DR-5.2) in the `4tuenyOS` kernel repo. Not scheduled — see `OPEN-5`
in that plan ("bash-now, document the seam, rewrite only when Windows is
actually calendared").

## Split: `bin/hivemind` (CLI) vs. `runtime/src/server.ts` (daemon)

The daemon (`runtime/src/server.ts` + everything under `runtime/src/lib/`)
is plain TypeScript on Bun — already portable, nothing Unix-only in it
(HTTP server, session store, mTLS client to the backend). All the
platform-specific surface lives in `bin/hivemind`, the bash CLI that
spawns and supervises that daemon. A native Windows port would keep
`server.ts` unchanged and replace only the CLI layer.

## The 4 Unix-specific primitives `bin/hivemind` depends on

1. **Process detach** — `nohup ... & disown` (Fase 1, `_spawn_runtime`) to
   launch the daemon so it survives the parent shell exiting. Windows
   equivalent not decided yet: `START /B` (simplest, but no persistence
   guarantee across parent-shell death) or a native service via `sc.exe`
   / a managed session. Whichever is picked needs the same property this
   repo relies on today — daemon outlives the CLI invocation that spawned
   it.

2. **pidfile + signal-based liveness/shutdown** — `kill -0` (liveness
   probe, used by the CLI and by `pid-watcher.ts` inside the daemon),
   `kill -TERM` (graceful stop, `cmd_stop`), `kill -9` (escalation after
   the stop timeout). Windows equivalent is `tasklist`/`taskkill`, with
   different signal semantics — there is no POSIX `SIGTERM`/graceful-vs-
   force distinction in the same shape; `taskkill /F` is closer to `-9`
   than to `-TERM`. See DR-5.2 below for the daemon-side liveness check
   specifically.

3. **`$HOME`-relative paths** — `~/.engram/...` (cert material, device-id,
   cache/pid files) and `~/.hivemind/...` (`$HIVEMIND_HOME`, the install
   tree). This is the primitive that needs the **least** work: Bun/Node
   already resolve the home directory portably via `os.homedir()`, and
   nothing in the daemon assumes a Unix path separator or a `/`-rooted
   layout — only `bin/hivemind` itself hardcodes `${HOME}`.

4. **`bin/hivemind` being a bash script** — WSL covers this today for
   Windows users (the script runs unmodified under WSL's bash). A native
   (non-WSL) Windows port needs a genuinely separate CLI: either a
   PowerShell script re-implementing the same command surface, or a
   compiled binary via `bun build --compile` that replaces bash entirely
   (this option also sidesteps primitives 1 and 2 above, since it would
   own detach/signal-equivalent logic directly instead of shelling out to
   `nohup`/`kill`).

## DR-5.2 — `process.kill(pid, 0)` on native Windows

`runtime/src/lib/pid-watcher.ts` polls `process.kill(pid, 0)` every 2s to
detect when the interactive Claude process (not a Unix child of the
daemon) has exited — see the comment block at the top of that file. Under
Bun/Node on native Windows (not WSL), this call's semantics differ: there
is no real POSIX signal 0 delivery: the underlying implementation maps it
to a different existence check. This is flagged as a risk to reconfirm
if/when Windows support is actually scheduled — not a blocker today,
since the daemon currently only ever runs under Linux/macOS/WSL.

## Non-goals of this document

Per DR-5.1's pitfall: this is the seam **documented**, not **abstracted
in code**. No `platform.ts`/strategy-pattern layer exists yet, and none
should be added speculatively — building one now, with no Windows target
scheduled, is effort against a need that doesn't exist. This doc exists
so that Fase 1-4/6-7 work doesn't accidentally couple business logic to
`kill`/`nohup` outside the 4 boundaries named above, keeping a future
port a bounded, localized change instead of an archaeology project.
