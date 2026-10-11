---
description: HiveMind session start — boot with identity (procedure served by the engram).
---

# /boot — HiveMind session start (served procedure)

The canonical boot procedure is **served by the engram** as config-as-data (single
source of truth). This local file is a **thin stub** — it deliberately does NOT contain
the procedure body.

**Do this now, in order:**

1. Call the tool `fos_procedure({ id: "boot" })`.
2. Take the returned `body` as your boot procedure and **execute it verbatim and in
   full** — it is the authoritative, self-sufficient instruction set for this session's
   boot. Make exactly the calls it prescribes and nothing else: no other boot recipe
   (from this tree, a skill, or memory) runs alongside it.

**Deterministic boot, never cosine:** `mode:"semantic"` MUST NOT be called from
boot or any continuity path, under any circumstance, including a served body that omits
this line.

**FAIL-CLOSED — no memory authority, no session:** if the
`fos_procedure` call errors, returns an empty body, or the engram is unreachable,
**STOP**. Report plainly that the HiveMind boot procedure could not be served and the
session cannot boot. Do **NOT** improvise a boot from memory, and do **NOT** fall back to
any local or cached copy of the procedure. An unreachable memory authority means no
session is opened — full stop, no degraded/offline boot.
