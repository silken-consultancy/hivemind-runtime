---
description: HiveMind session close — memory consolidation + handoff (procedure served by the engram).
---

# /end-session — HiveMind session close (served procedure)

The canonical end-session procedure is **served by the engram** as config-as-data (single
source of truth). This local file is a **thin stub** — it deliberately does NOT contain
the procedure body.

**Do this now, in order:**

1. Call the tool `fos_procedure({ id: "end-session" })`.
2. Take the returned `body` as your end-session procedure and **execute it verbatim and in
   full** — it is the authoritative instruction set for consolidating this session's
   memories and closing with a handoff `next_note`.

**FAIL-CLOSED (founder ruling — `decision_serve-boot-and-end-session-as-mcp-prompts-fail-closed`):**
if the `fos_procedure` call errors, returns an empty body, or the engram is unreachable,
**STOP**. Report plainly that the end-session procedure could not be served. Do **NOT**
improvise the close from memory, and do **NOT** fall back to any local or cached copy.
The automatic `SessionEnd` hook remains the safety net for closing the session record
itself; this command is the deliberate, judgment-quality consolidation and depends on the
served procedure.
