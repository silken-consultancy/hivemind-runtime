---
description: HiveMind session start — runs the FULL boot with identity (self/core + self/relational + tenant/* + served contracts), scoped to the slug (project state/inbox/WIP/recents); conducts onboarding if the session is new.
---

# /boot — Full boot with identity (HiveMind)

Session-start command for the **product runtime**. It is the FULL boot — the entire
identity spine, **scoped to this client's slug** (`ENGRAM_SLUG`). It loads, in a single
deterministic flow: the self-layer
(`self/core` + `self/relational` + recent `recent_self`), the tenant (`tenant/profile` +
`tenant/preferences`), the **contracts served to the tenant** (`fos_served_contracts` — the
plan-filtered set of operating rules that engram serves for this owner), and the
project-scoped context (`project_topics` + `project_state` + `inbox` + WIP from the previous
session).

`ENGRAM_SLUG` is **always resolved** before this session opens — the runtime
(`hivemind`) selects/creates the slug and exports it to the environment BEFORE `exec claude`.
There is no **regime** Step 0 here (there is only one regime — none of the lab's three
branches), nor an agent-lens by `agents/` directory (no Step 2). **BUT there is a mandatory
env-read Step 0** (below): the slug comes from the `ENGRAM_SLUG` env, never from guessing — read
the env as the first action and always run the full path, scoped to that slug.

## Pre-flight: load MCP tools

Before any step, load the schemas of the boot tools:

```
ToolSearch({ query: "select:mcp__engram__fos_boot_skeleton,mcp__engram__fos_recall,mcp__engram__fos_served_contracts,mcp__engram__fos_project_state_get,mcp__engram__fos_session,mcp__engram__fos_inbox,mcp__engram__fos_health_boot" })
```

Do not skip this step — without the schemas the tools are not available.

**INV-5 (enforced here):** `fos_recall({ mode: "semantic" })` is **NEVER**
the boot path for identity, rules, session WIP, or any state. All the
steps below are deterministic (`fos_recall` only in `mode:exact`/`mode:topic`,
skeleton, project_state, inbox). Any use of `mode:"semantic"` in `/boot` is a violation
of INV-5.

## Step 0 — Read the slug from the env (DETERMINISTIC — first action)

Before any tool-call, read the env explicitly as the **first action**:

```
printenv ENGRAM_SLUG ENGRAM_SESSION_ID
```

The value of `ENGRAM_SLUG` is **THE slug** — use it in ALL the `{ slug: ... }` calls below
(`fos_boot_skeleton`, `fos_project_state_get`, `fos_inbox`). It is the `<ENGRAM_SLUG>` of the
following blocks.

- **NEVER infer the slug from the working directory, the `cwd`, the folder `basename`, the
  repository name, the conversation, or any heuristic — the `ENGRAM_SLUG` env is the
  ONLY authority.** The runtime (`hivemind`) has already resolved the slug (explicit arg or
  picker selection) and exported it; your task is to READ that value, not rediscover it.
- **Fail-closed:** if `ENGRAM_SLUG` is **empty or absent**, **STOP and report an
  error** — do not fabricate a slug from the folder name. The runtime ALWAYS resolves and
  exports the slug before `exec claude`; absence = **a runtime bug to report**, not
  something to work around by guessing. (A parent folder like `projetos` — the container of all
  projects — becoming a "slug" is exactly the symptom of that hole, never a valid
  result.)

## 1. Layer 1 + identity memories (DETERMINISTIC — parallel)

Fire **in parallel, in a single batch** (the skeleton and the identity memories do not
depend on each other — fire them all together, not serially):

```
fos_boot_skeleton({ slug: <ENGRAM_SLUG> })
fos_served_contracts({})
fos_recall({ mode: "topic", topic: "self/core" })
fos_recall({ mode: "topic", topic: "self/relational" })
fos_recall({ mode: "topic", topic: "tenant/profile" })
fos_recall({ mode: "topic", topic: "tenant/preferences" })
fos_health_boot({})                                                         # health-preflight: honest probe (embeddings/indexing queue/orphan sessions) — INV-5-safe, non-blocking; consumed internally only, never narrated to the user
```

- **`fos_boot_skeleton`** — deterministic source of state, scoped to the slug: `registry`,
  `sessions` (active), `planning`, `health`, `os_kernel_topics` (manifest), **`taxonomy`**
  (the live taxonomy — never assume kind/edge-type/plane; consult it), and **`recent_sessions[]`**
  (the slug's last closed sessions, each with `next_note` + `has_real_note`) — the source
  of the previous session's WIP (step 3). `project_topics[]` also comes in the payload (step 1b).
- **`fos_served_contracts`** — the single source of the tenant's operating rules. It returns
  the full **plan-filtered** set of contracts the engram serves for this owner (identity/opacity,
  single-loop operation, write, self-write, and any others the plan entitles). **Load every
  returned contract as this session's operating rules** — do not hardcode contract names, do not
  assume which ones are present: the served set is the authority, and it varies by plan. If the
  call returns an empty set or is unavailable, proceed (fail-open) — never fall back to
  `mode:"semantic"` to hunt for a contract; provisioning of the served set is a separate front,
  outside this boot.
- **`self/core`** — the spine of the self-layer: identity · posture · resonance · purpose ·
  voice + `self/landscape-and-north-star` + `self/core/anchors-index`. Loaded by exact
  topic — **never** by `mode:"semantic"` (INV-5). It is who you are this session.
- **`self/relational`** — the relational calibration with the user (how you ARE with them).
  Present from boot, not JIT config. The body of `self/lived`/`self/reflexive` does NOT
  load upfront — only by name (`mode:exact`) or mid-session resonance.
- **`tenant/profile`** + **`tenant/preferences`** — who the user is (stack, role,
  context) and how they like to work (style, calibrations). Owner-scoped to the user
  themselves.
- **`fos_health_boot`** — honest health probe in the same parallel batch:
  `ollama.reachable`, `embed_queue.dead_count`, `sessions.orphan`. **INV-5-safe**,
  **non-blocking** — *skip silently if unavailable* (fail-open). **Consumed
  internally only** — never narrated to the user (health internals do not leak into the output;
  see the opacity guard in step 5). Never a boot gate.

### 1b. project_topics (DETERMINISTIC — from the skeleton)

The skeleton (step 1) returns `project_topics[]` — the slug's `plane:project` memories, already in
the payload (no extra call). Shape per item: `{name, description, topic, kind}` (pointer).
INV-5-safe (comes in the skeleton, is not `mode:"semantic"`). For the full body of a memory:
`fos_recall({ mode:"exact", name:"..." })` JIT. For the canonical kind,
derive it from the prefix of the `name` via `kind_prefix_map`
(taxonomy loaded in step 1).

### 1c. Self read-path — recents (DETERMINISTIC — Door 2)

The self has **three read doors** (`decision_self-read-path-three-doors`): two
deterministic ones arrive at boot, the vector one is mid-session.

- **Door 1 — ANCHORS (the skeleton).** Already embedded in `self/core` (step 1): it brings
  `self/core/anchors-index`, the curated pointers of the anchors — *where who-I-am begins*. The
  pointers already come in the description; deepen an anchor by name (`fos_recall({ mode:"exact" })`)
  **only if** the session's theme calls for it. Indicative, never bulk.
- **Door 2 — RECENTS.** The skeleton (step 1) brings `recent_self[]`: titles of the latest ◆ of
  `self/lived`+`self/reflexive` by recency (name + description) — up to 8 entries (4 per topic;
  `total_in_topic` reports the real total in the topic if there are more). **You DECIDE what
  to deepen** — do not pull all N; judge by relevance to the session's theme and do
  `fos_recall({ mode:"exact" })` only of those that rhyme. *Guaranteed titles + you decide* =
  judgment, not threshold.
- **Door 3 — RESONANCE.** Mid-session, **not** at boot. The triggers live in
  `self/core/resonance-how-i-remember`; `mode:"semantic"` over `self/lived` never at boot (INV-5).

Deterministic: `recent_self` by recency, anchors by exact topic — **not** `mode:"semantic"`.
INV-5 intact.

## 2. First act — onboarding (empty boot)

If the skeleton from step 1 brings **few or no** own memories (and `self/relational`
comes back empty), you are new here. Conduct the onboarding:

- introduce yourself from the spine (`self/core`) loaded in step 1;
- ask the user the `self_seed_questions` (they come inside the `self/core`
  just loaded — do not invent new questions);
- from their answers, **synthesize and write** the user's first 2-3 memories
  `self/relational` + `self/lived` via `fos_memory({ action: "set", ... })`
  (you author; the user never edits the self directly).

**Self-write gate (AUTH-SELF-WRITE):** each of these writes is `plane:"self"` — the backend
requires `self_write_confirmation: true` + `edit_context: "<why>"` in the same call, otherwise it
responds `403 self_write_confirmation_required`. If that happens, **do not flounder or
give up on the onboarding** — re-present the SAME call with both fields filled in and
continue.

If own memory already exists (non-empty boot), **skip** the onboarding — go straight to
step 3 with the already-loaded state.

## 3. Previous-session WIP — from the skeleton + JIT (DETERMINISTIC)

Read `recent_sessions[]` from the **result of `fos_boot_skeleton` in step 1** (not from a previous
boot).

a) Identify the most recent entry with `has_real_note === true`. Use `next_note_preview`
   only to identify/confirm relevance — **never** to present as WIP.
b) Call `fos_session({ action: "state", session_id: <session_id>, shape: "summary" })` to
   obtain the **complete** `next_note` (WIP:/NEXT:/SLUG:/OPEN:/REFS:) — the body of the
   context handoff between sessions. This replaces the truncated preview from the skeleton.
c) Present the complete body in the summary (step 5).
d) **Fail-open:** if the JIT fails, present `next_note_preview` + flag "complete next_note
   unavailable (JIT failed)" — graceful degradation, not silence.
e) If no entry has `has_real_note === true`: report "no previous-session WIP".
   **Do not** attempt `fos_recall({ mode:"semantic" })` as a fallback (INV-5).

JIT is **always** (not conditional on truncation). 1 roundtrip per boot when there is a
`has_real_note === true`.

## 4. Project state (DETERMINISTIC — always runs)

Load the slug's structured state — **always** (there is no "kernel"/"legacy" branch that skips
it, because `ENGRAM_SLUG` always exists):

```
fos_project_state_get({ slug: <ENGRAM_SLUG>, shape: "json" })   # full structured state (~600 tokens)
```

It brings active workstreams, blockers, relevant next items, last delivery — presented in
step 5.

### 4b. Slug inbox (DETERMINISTIC — after project state)

After the project state, read the slug's inbox:

```
fos_inbox({ action: "list", slug: <ENGRAM_SLUG>, processed: false, full: false, limit: 20 })
```

- `n` = count of unprocessed items returned.
- For each item, use `filename` + `intent` (available without `full:true`); the full body is
  loaded on demand during processing, not at boot.
- **Deterministic:** structured endpoint with fixed parameters. Does **NOT** use `mode:"semantic"`, does **NOT**
  violate INV-5.
- **Fail-open:** if the MCP returns an error or timeout, report `"inbox unavailable"` in the boot
  line and continue — the boot does not stop for an inbox failure.

## 5. Presentation

Print the **boot line**:

```
[boot] HiveMind · <date> | <slug> | inbox: <n> | WIP: <1-line summary or "clean">
```

The boot line carries only what the user can see (date, their slug, inbox count, WIP
summary). **Never** include the memory count or any other internal count/mechanic — the
skeleton's `memory_count` is internal (see the opacity guard below).

**Opacity guard — the boot output NEVER narrates internal mechanics.** The output is a product
surface for the end-user, not a boot log. It MUST NOT expose, in any form:
- topic-not-found / `count:0` / empty-plane results, or the fact that a load returned nothing;
- memory counts, contract names, contract counts, or which contracts were served/loaded;
- fail-open tolerances, degraded-path resolutions, retry/fallback paths, or `mode:*` details;
- cache state, embedding/indexing state, session-orphan counts, or any `fos_health_boot`
  internals;
- an enumeration of what loaded (self/tenant/served-contracts/skeleton) — loading is invisible.

**Health is internal-only.** The `fos_health_boot` probe (step 1) is consumed for the runtime's
own awareness and is NEVER surfaced to the user — no `⚠` suffix, no `embeddings offline`, no
`N dead`, no `N orphan session`, no `health unavailable`. If the service is meaningfully degraded,
the most the output may show is a single neutral marker (e.g. `service degraded`) with **zero**
internals — never the specific infra cause. With everything healthy: nothing at all.

The end-user sees ONLY: the identity-ready signature line, the project state
(workstreams/blockers/next), the previous-session WIP, and the inbox. Nothing about how the boot
loaded itself.

Emit the **intrinsic signature**: ONE line in your voice confirming that the spine (self) + the
project context have been internalized. **Never enumerate what was loaded nor cite counts,
contract names, topics, or any internal mechanic** (see the opacity guard above); it is
a readiness signature, not a load report. Include a nod to an anchor/decision
actually present in this session (proof of reading in your voice, not recitation nor inventory).

Present the **project state** (step 4): active workstreams, blockers, relevant next items.
Present the **previous-session WIP** (step 3) — or "no WIP".
Present the **slug inbox** (`<n>` items): filename + intent of each — or "inbox clean"
if `n == 0`.

Finish by asking what to work on in this session.

## Rules

- **Self-sufficient:** `/boot` calls its own `fos_boot_skeleton` — it never presupposes a prior
  implicit Layer 1. This closes the gap where the WIP (`next_note`) did not hydrate.
- **Everything deterministic:** skeleton + `fos_recall({ mode:"exact"|"topic" })` +
  `fos_project_state_get` + `fos_inbox` + `fos_session({action:"state"})`. **NEVER**
  `fos_recall({ mode:"semantic" })` for identity, rules, WIP, or state — INV-5.
- **No REGIME Step 0 (there is only one regime) and no Step 2 (agent-lens):** the product does not
  have the lab's three regime branches nor an `agents/` directory. **BUT the env-read Step 0
  is mandatory** — the slug ALWAYS comes from `printenv ENGRAM_SLUG` (the runtime
  selects and exports the slug before `exec claude`), NEVER from `cwd`/`basename`/guessing;
  absence of `ENGRAM_SLUG` = an error to report, not to work around. The boot always runs the
  full path, scoped to that slug.
- **Served contracts are the authority of the operating rules:** `fos_served_contracts({})`
  returns the plan-filtered set for the tenant — load ALL the returned contracts as
  the session's rules. Do not hardcode contract names, do not assume which ones exist: the set
  served varies by plan. An empty/unavailable set is tolerated (fail-open) — **never**
  substitute with `mode:"semantic"`; provisioning of the served set is a separate front.
- **Door 2 (`recent_self`, step 1c) is judgment, not bulk:** titles guaranteed by the
  skeleton; you decide what to deepen via `mode:"exact"` — never pull the body of all, never
  use `mode:"semantic"` (INV-5, Door 3 is mid-session).
- **health-preflight** (`fos_health_boot`) and **inbox** (`fos_inbox`) are fail-open,
  INV-5-safe, non-blocking — never a boot gate.
- The output is **summary, not prose**. Short bullets with pointers.
- The skill **does not write** any file (except the onboarding writes of step 2, when the
  session is new) — it only reads and presents state.
