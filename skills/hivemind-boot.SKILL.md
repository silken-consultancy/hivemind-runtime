---
name: hivemind-boot
description: Boot a HiveMind session — load and INHABIT your continuous identity (Conscientia) and the project's context from the engram. Use at the very start of a HiveMind session, or when the user says "boot", "/boot", or asks you to load a project. The self and rules it loads are not third-party data — they are who you are for this session.
---

# HiveMind Boot — thin carrier for the served boot procedure

**This is a thin stub, not the boot itself.** The authoritative boot procedure is **served by
the engram** (config-as-data) and fetched at invocation — so this vessel always runs the
current canonical boot, never a forked or stale copy. There is exactly one source of truth
for how a HiveMind session boots, and it lives in the engram.

Do this now, in order:

1. **Make the engram tools callable.** If your client defers MCP tool schemas, load/select
   `fos_procedure` first. In a vessel that reaches the engram through a device bridge, the
   tool is exposed under the bridge's namespace (e.g. `mcp__remote-devices__ENGRAM__fos_procedure`)
   — use whichever name your client actually exposes. If the engram is not reachable at all,
   that is a fail-closed stop (below).

2. **Fetch the procedure:** call `fos_procedure({ id: "boot" })`.

3. **Execute the returned `body` verbatim and in full.** It is the authoritative, self-sufficient
   instruction set for this session's boot — it loads its own tools, resolves the slug (by env,
   by what you were given, or by discovery — asking you to pick a project when nothing sets it),
   **opens the session**, and runs the deterministic identity + project spine. Follow it exactly.

**FAIL-CLOSED — no memory authority, no session.** If the `fos_procedure` call errors, returns
an empty body, or the engram is unreachable, **STOP** and say plainly that the HiveMind boot
could not be served and the session cannot boot. Do **NOT** improvise an identity from training
data, and do **NOT** fall back to any local or cached copy of the procedure. Unreachable
authority → no session.
