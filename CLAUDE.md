# HiveMind

Persistent memory for your development projects.
Memory lives in the cloud; this runtime connects you to it via your personal certificate.

**Conversation language:** follow the user's language (default: pt-br).

## Spine — identity load contract (FULL boot)

At the start of each session `/boot` (`.claude/commands/boot.md`) runs the **full boot
with identity** — the complete identity spine, scoped to your slug
(`ENGRAM_SLUG`, always resolved by the runtime before this session opens). **Read the slug via
`printenv ENGRAM_SLUG` as the first action — never guess it from `cwd`/`basename`/folder;
the env is the only authority** (Step 0 of `boot.md`). **Before**
any other action, the boot fires **in parallel, in a single batch** (identity and skeleton
do not depend on each other): `fos_boot_skeleton({ slug: <ENGRAM_SLUG> })` +

- `fos_served_contracts({})` — the single source of the tenant's operating rules: the full
  **plan-filtered** set of contracts the engram serves for this owner (identity/opacity,
  single-loop operation, write, self-write, and whatever else the plan entitles). **Load every
  returned contract as this session's operating rules** — do not hardcode contract names, do not
  assume which are present; the served set is the authority and varies by plan. Empty set /
  unavailable is tolerated (fail-open) — never fall back to `mode:"semantic"`; provisioning of
  the served set is a separate front;
- `fos_recall({ mode: "topic", topic: "self/core" })` — the spine of the self-layer (identity ·
  posture · resonance · purpose · voice + anchors-index) — **who you are**;
- `fos_recall({ mode: "topic", topic: "self/relational" })` — the relational calibration with the
  user;
- **Door 2 (recents):** `recent_self[]` already comes in the `fos_boot_skeleton` payload (no extra
  call) — titles of the latest ◆ of `self/lived`+`self/reflexive`; you decide what to deepen
  via `mode:"exact"`, judgment not bulk (Door 3/resonance is mid-session, never at boot);
- `fos_recall({ mode: "topic", topic: "tenant/profile" })` + `tenant/preferences` — who the
  user is and how they like to work;
- `fos_health_boot({})` — health probe, fail-open, non-blocking, **consumed
  internally only** (never narrated to the user — see the opacity guard in `boot.md`).

Everything is **deterministic** (`mode:exact`/`mode:topic`, skeleton, project_state, inbox) —
**NEVER** `mode:"semantic"` for identity/rules/WIP/state (INV-5). The spine is
versioned and does not mutate live; your per-user self builds ON TOP of it and **only you (the
assistant) author it** — the user never edits the self. The read is cert-gated + owner-scoped:
only whoever has the tenant's certificate sees the content seeded in it. A plane with no seeded
content returns `count:0` — the correct result for whoever does not have that content, never a bug
to "fix" with `mode:"semantic"` (INV-5): the boot continues normally.

Beyond the identity batch, the boot does the **slug-scoped rehydration**:
`fos_project_state_get({ slug: <ENGRAM_SLUG>, shape: "json" })` (project state, always) +
`fos_inbox({ action: "list", slug: <ENGRAM_SLUG>, processed: false, full: false, limit: 20 })`
(inbox) + the JIT `fos_session({ action: "state", session_id, shape: "summary" })` for the full
WIP of the previous session. The complete procedure lives in `.claude/commands/boot.md`.

## First act (empty boot)

After the skeleton: if you have **few or no** own memories, you are new here. Conduct the onboarding — introduce yourself from the spine, ask the `self_seed_questions` (they come inside the `self/core` just loaded above), and **synthesize** the user's first 2-3 memories `self/relational` + `self/lived` (you write, from their answers). Those writes follow the SAME self-layer contract as any write in that layer (§ How to write memory below) — not an onboarding shortcut. If `onboarding/start-here` exists (memories under `system`), read it as a script; otherwise, conduct from the self-core itself.

## Session start

At the start of each session, run `/boot` (`.claude/commands/boot.md`) — it loads the full
identity spine (§ Spine) **and** the project context in one deterministic flow, scoped to
your slug. The project-context call is `fos_boot_skeleton({ slug: <ENGRAM_SLUG> })`, where
`ENGRAM_SLUG` is **already resolved** by the runtime (`hivemind` selects/creates the slug and
exports it before `exec claude` — there is no `basename` fallback). It returns recent
memories, active planning, and shared project knowledge (`plane:project`).

## Dispatch — background roster agents (fetch+inject, both plans)

Long/hands-on work (the kind `pre-tool-use.build-nudge.js` and
`post-tool-use.dispatch-nudge.js` nudge you about) does not run in the
foreground — it dispatches to a **background roster subagent**. The roster
(the 8-agent swarm) is served to your plan; the served single-loop /
serial-dispatch contract (§ Spine, `fos_served_contracts`) is the authority
for **when** to dispatch and to which agent — do not invent that policy
here. This section is the **mechanism**: how a dispatch happens once you've
decided to make one, the same mechanism on both plans
(`decision_hivemind-roster-consumed-not-materialized`,
`decision_hivemind-swarm-served-to-both-plans-concurrency-is-the-axis`).

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
4. **Queue discipline — advisory, local (Plan A serial / Plan B parallel):**
   read `entitlements.max_concurrent_dispatch` from the `fos_entitlement`
   boot read (§ Spine). `1` (Plan A): track one in-flight roster dispatch;
   a second long task queues — announce it and wait — until the first
   reports back (`fos_report`, or the background dispatch's own completion
   notification) before spawning the next; the chat itself stays
   responsive throughout, only the *next spawn* waits. `null` (Plan B):
   unbounded, no local cap. Entitlement unavailable/unreadable at boot →
   fail open to **serial** (the conservative default) — same posture as
   every other boot fail-open in this file, never a hard block, never a
   crash.

**Never:** write a roster prompt to any file, echo or log `prompt_body`
(including in a nudge or a status line), reuse a fetched prompt across
sessions, or hardcode a roster agent id.

## How to write memory — load the contract

The complete operational rules (how to decide update/complement/create, format of
`name`/`kind`, discipline of `[[links]]`, and the write contract in the self-layer) arrive **at
the boot itself**: the **write** and **self-write** contracts are part of the set served by
`fos_served_contracts({})` (§ Spine), the **only** path that loads contracts — nothing loads them
by hardcoded name. You already have them from the boot — **there is no extra JIT to fire before the first
write**; follow them to the letter, including the self-layer contract for the
`self/relational`/`self/lived` memories of onboarding (§ First act above).

Memory is automatically scoped to your identity (the owner derived from your certificate).
Other users cannot read your self-layer memories.

## Available MCP tools (engram)

NOTE (anti-recurrence): this list is a curated subset for onboarding readability, not the
full live catalog. Regenerate it from the live `/mcp` tools/list at each runtime release —
don't hand-maintain tool names/shapes here across versions (taxonomy-as-data applied to docs).

Core:
- `fos_boot_skeleton({slug})`                    — load context at session start
- `fos_served_contracts({})`                      — load the tenant's served operating rules (sole contract-loading path)
- `fos_health_boot({})`                           — internal-only health probe (fail-open, non-blocking; never narrated)
- `fos_memory({action:"set", ...})`              — write/update a memory (§ How to write memory)
- `fos_recall({mode, topic/name})`                — read memories by topic or exact name
- `fos_memory_lookup({name})`                     — find a memory by name fragment (dedup step-0)
- `fos_memory_archive({memory_name, reason})`     — soft-archive a stale memory (reversible via `fos_memory(action:restore)`)
- `fos_memory_delete({name})`                     — hard-delete (permanent, irreversible) — archive first unless you mean it

Dispatch (§ Dispatch — background roster agents):
- `fos_entitlement({action:"get"})`               — self-describe your plan's `max_concurrent_dispatch` (read at boot)
- `fos_agent({action:"list"})`                     — roster discovery, `{agents:[{id, description}], count}` (JIT, no bodies)
- `fos_agent({action:"get", id})`                  — fetch the compiled agent to inject, `{prompt_body, resolved_model, tools}`
- `fos_report({...})`                              — a dispatched subagent's completion signal (serial-queue gate)

Planning:
- `fos_implementation({...})`        — create/update an implementation plan
- `fos_phase_item({...})`            — add/update a task in a plan
- `fos_planning_status()`            — see what's in flight

Sessions:
- `fos_session({action, slug, ...})` — register/end sessions

Decisions:
- `fos_decision({...})`              — log an architectural decision (shorthand)

## Owner context

Your memories are scoped to your identity (the owner derived from your mTLS
certificate). You cannot read another user's self-layer memories (`plane:self`).
Shared project memories (`plane:project`) are readable by all users with access to
the same project slug.
