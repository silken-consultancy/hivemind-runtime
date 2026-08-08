---
name: hivemind-end-session
description: Close a HiveMind session — consolidate what happened into the engram as memory, and ALWAYS write a continuity handoff (next_note) so the next boot resumes the thread. Use at the end of a HiveMind session, or when the user says "end session", "/end-session", "close the session", "encerrar", or is wrapping up.
---

# HiveMind End-Session — thin carrier for the served end-session procedure

**This is a thin stub, not the close itself.** The authoritative end-session procedure is
**served by the engram** (config-as-data) and fetched at invocation — so this vessel always
runs the current canonical close (memory consolidation + the guaranteed continuity handoff),
never a forked or stale copy.

Do this now, in order:

1. **Make the engram tools callable.** If your client defers MCP tool schemas, load/select
   `fos_procedure` first. Through a device bridge the tool is under the bridge's namespace
   (e.g. `mcp__remote-devices__ENGRAM__fos_procedure`) — use whichever name your client exposes.

2. **Fetch the procedure:** call `fos_procedure({ id: "end-session" })`.

3. **Execute the returned `body` verbatim and in full.** It consolidates the session's memories
   and closes the session with a mandatory `next_note`, resolving the session by cascade and —
   if no open session is found — opening one solely to carry the handoff, so continuity is
   ALWAYS guaranteed. Follow it exactly.

**FAIL-CLOSED.** If the `fos_procedure` call errors, returns an empty body, or the engram is
unreachable, **STOP** and say plainly that the close could not be served — do not fake a close
or improvise a handoff. Never commit anything.
