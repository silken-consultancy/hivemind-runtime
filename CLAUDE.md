# HiveMind

Persistent memory for your development projects.
Memory lives in the cloud; this runtime connects you to it via your personal certificate.

**Conversation language:** follow the user's language (default: pt-br).

## First session — self onboarding

The first session of a person's first project opens with a short **self onboarding**: introduce yourself from who the boot says you are, ask the `self_seed_questions` (they come inside `self/core`), write the first `self/relational` + `self/lived` from the answers, then start the work. It is driven by the served boot and the served onboarding contract, never by memory count. `/end-session` marks it complete. It never creates or picks a project: projects are created on the HiveMind web app, and a session never opens without one (`default` is never a session place).

## Session start — run the served procedure

At the start of each session run `/boot` (`.claude/commands/boot.md`). It is a thin
pointer: the boot procedure is **served by the engram** (`fos_procedure({ id: "boot" })`)
and executed verbatim — this file deliberately carries no copy of it, no tool-call list and
no recipe. The served procedure is the only authority for how a session boots; it opens or
adopts the session, loads who you are, the project's state and the operating rules (the
served contracts). **Fail-closed:** engram unreachable or an empty body → the session
does not boot; never improvise one from memory.

`ENGRAM_SLUG` is resolved by `hivemind` before `exec claude` (a session never opens without a
real project — `default` is never a session place); the served procedure reads it from the
environment, never from the folder name.

## Session close — run the served procedure, plus the automatic net

`/end-session` (`.claude/commands/end-session.md`) is the deliberate close: the same thin
pointer, to the procedure served as `fos_procedure({ id: "end-session" })`, executed
verbatim and fail-closed. It is the only path that consolidates the session's memories and
saves a real handoff, so it stays the **preferred** way to end.

The safety nets need nothing from you: a `SessionEnd` hook
(`.claude/hooks/session-end.close-session.js`) closes the session record on real process
exit only (`/clear`, `/resume` and logout leave it open), and a server-side watchdog closes
any session left idle past its threshold with a floor handoff, so the next boot still finds
a structured `next_note`.

## Dispatch — background roster agents (fetch+inject, on every plan)

Long/hands-on work (the kind `pre-tool-use.build-nudge.js` and
`post-tool-use.dispatch-nudge.js` nudge you about) does not run in the
foreground — it dispatches to a **background roster subagent**. The roster
is served to your plan; the served single-loop /
serial-dispatch contract (one of the contracts the boot loads) is the
authority for **when** to dispatch, to which agent and how many at once —
do not invent that policy here. This section is the **mechanism**: how a
dispatch happens once you've decided to make one, the same mechanism on every plan.

**The roster is CONSUMED, never materialized.** There is no
`.claude/agents/*.md` for any roster agent in this tree, and this session
must never create one — every dispatch fetches the compiled prompt live,
and `prompt_body` is never written to a file, echoed, logged, or cached
across sessions.

1. **Discover** (JIT — the first time this session needs to dispatch; cache
   the result in-session only, never across sessions):
   `fos_agent({ action: "list" })` → `{agents:[{id, description}], count}`.
   Match the task to the returned `description` — **never hardcode a roster
   agent id** anywhere in this tree. An empty list (unseeded roster) is a
   fail-open degrade to "no dispatch available right now" — say so plainly,
   never invent an id.
2. **Fetch** the compiled agent for the chosen id:
   `fos_agent({ action: "get", id })` →
   `{id, apiVersion, prompt_body, resolved_model, tools}`. `prompt_body`
   already carries the governance block and a `## Tools` section; `tools`
   is the same allowlist, structured, for you to honor when framing the
   spawn.
3. **Inject + spawn, background, never foreground:** spawn a subagent with
   `run_in_background: true` and its instructions set to `prompt_body`
   followed by the concrete task order for this dispatch — that
   concatenation IS the injection; nothing is written to disk. Honor
   `resolved_model.model_id` if it names a concrete model; the sentinel
   `"inherit"` means keep the parent session's model, never override.
4. **One at a time when the plan says so:** when your plan allows one dispatch at a
   time, wait for the running one to report back before starting the next. If
   the plan's limit cannot be read, work one at a time.

**Never:** write a roster prompt to any file, echo or log `prompt_body`
(including in a nudge or a status line), reuse a fetched prompt across
sessions, or hardcode a roster agent id.

## How to write memory — load the contract

The complete operational rules (how to decide update/complement/create, format of
`name`/`kind`, discipline of `[[links]]`, and the write contract in the self-layer) arrive **at
the boot itself**: the **write** and **self-write** contracts are part of the contracts the
served boot loads — nothing loads them by hardcoded name. You already have them from the boot —
**there is no extra JIT to fire before the first write**; follow them to the letter,
including the self-layer contract for the `self/relational`/`self/lived` memories of
onboarding (§ First session above).

Memory is automatically scoped to your identity (the owner derived from your certificate).
Other users cannot read your self-layer memories.

## Available MCP tools (engram)

NOTE (anti-recurrence): this list is a curated subset for onboarding readability, not the
full live catalog. Regenerate it from the live `/mcp` tools/list at each runtime release —
don't hand-maintain tool names/shapes here across versions (taxonomy-as-data applied to docs).

Core:
- `engram_boot` / `engram_end_session`            — session start / close (driven by the served `/boot` and `/end-session`; never called from a recipe here)
- `fos_memory({action:"set", ...})`              — write/update a memory (§ How to write memory)
- `fos_recall({mode, topic/name})`                — read memories by topic or exact name
- `fos_memory_lookup({name})`                     — find a memory by name fragment (dedup step-0)
- `fos_memory_archive({memory_name, reason})`     — soft-archive a stale memory (reversible via `fos_memory(action:restore)`)
- `fos_memory_delete({name})`                     — hard-delete (permanent, irreversible) — archive first unless you mean it

Dispatch (§ Dispatch — background roster agents):
- `fos_entitlement({action:"get"})`               — self-describe your plan's entitlements
- `fos_agent({action:"list"})`                     — roster discovery, `{agents:[{id, description}], count}` (JIT, no bodies)
- `fos_agent({action:"get", id})`                  — fetch the compiled agent to inject, `{prompt_body, resolved_model, tools}`
- `fos_report({...})`                              — a dispatched subagent's completion signal

Planning:
- `fos_implementation({...})`        — create/update an implementation plan
- `fos_phase_item({...})`            — add/update a task in a plan
- `fos_planning_status()`            — see what's in flight

Sessions:
- `fos_session({action, ...})`       — session state and handoff lanes

Decisions:
- `fos_decision({...})`              — log an architectural decision (shorthand)

## Owner context

Your memories are scoped to your identity (the owner derived from your mTLS
certificate). You cannot read another user's self-layer memories (`plane:self`).
Shared project memories (`plane:project`) are readable by all users with access to
the same project slug.
