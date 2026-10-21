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

## Dispatch — background roster agents (by reference, on every plan)

Long/hands-on work (the kind `pre-tool-use.build-nudge.js` and
`post-tool-use.dispatch-nudge.js` nudge you about) does not run in the
foreground — it dispatches to a **background roster subagent**. The served
dispatch contract (one of the contracts the boot loads) is the authority for
**when** to dispatch, to which agent and how many at once — do not invent that
policy here. This section is only the **mechanism**: dispatch by reference.

**The roster is CONSUMED, never materialized.** There is no
`.claude/agents/*.md` for any roster agent in this tree, and this session
must never create one. The main session never holds a role prompt: the
invoked agent fetches its own.

1. **Discover** (JIT, once per session; cache in-session only):
   `fos_agent({ action: "list" })` → `{agents:[{id, description, resolved_model}], count}`.
   The listing never carries a prompt body. Match the task to the returned
   `description` — **never hardcode a roster agent id**. An empty list (or no
   fitting agent) means "no dispatch available right now": say so plainly and
   escalate it to the person; never invent an id or fall back to a generic
   agent with an improvised prompt.
2. **Spawn in background** (`run_in_background: true`, never foreground) with
   the agent's `resolved_model` — a concrete model id is passed exactly,
   `"inherit"` keeps the parent session's model; never omitted, never
   substituted. If the listing marks an agent's model configuration as missing
   or invalid (no resolved model), spawn with that agent's tier and tell the
   person once that the model configuration is degraded. Send ONLY the roster
   id and the task order.
3. **The agent fetches its own role.** The task order tells the agent that its
   FIRST act, before any other tool call, is `fos_agent({ action: "get", id })`
   for its own id, adopting `prompt_body` verbatim and honouring the returned
   `tools` allowlist. When it reports back, check that the report confirms the
   role was fetched; a report without that confirmation is an unverified role.
4. **Fallback, declared:** only if the agent reports it cannot reach the
   engram after one retry, the main session fetches the body itself, injects
   it verbatim followed only by the task order, and states the fallback.
5. **Read `dispatch.mode` from the boot — one explicit value, never a limit to
   interpret.** `swarm` → dispatch in parallel in the background, bounded only
   by disjoint fronts (each front in its own worktree and branch; serialise
   fronts that share a tree, a port or a database); `dispatch.cap` is the most
   in flight (a number, or `"unbounded"`). `single-loop` → one dispatch at a
   time: wait for the running one to report back before starting the next.
   `null` is never "unreadable": `max_concurrent: null` means unbounded, and the
   boot degrades to `single-loop` itself (with `dispatch.reason`) when it
   cannot read the plan. A boot with no `dispatch.mode` (older server) → one at
   a time.

**Never:** hold, echo, log or write a `prompt_body` (in a spawn, message,
nudge, status line or file), reuse a fetched prompt across sessions, hand-author
or summarize a stand-in for a role prompt, or hardcode a roster agent id.

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
- `fos_agent({action:"list"})`                     — roster discovery, `{agents:[{id, description, resolved_model}], count}` (JIT, no bodies)
- `fos_agent({action:"get", id})`                  — the invoked agent fetches its OWN role with this (first act); the main session does not call it except in the declared fallback
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
