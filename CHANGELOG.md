# Changelog — hivemind-runtime

Installed clients detect new `main` commits through `_maybe_auto_update`, which compares
`git ls-remote` against the local HEAD. `LATEST_SHA` (published on every merge by
`.github/workflows/publish-latest-sha.yml`) is not the trigger: it is the integrity
fallback `_verify_commit_integrity` uses for unsigned commits. **Merging to `main` is
shipping to every client.** Entries below that carry a release-ordering constraint must
not be merged until that constraint holds.

## Unreleased

### First-timer routing reads the onboarding field (impl 4e978e9c, Phase 3)

- `bin/hivemind`: `_onboarding_probe` / `_onboarding_state` / `_is_first_timer`.
  The first-timer route (`default` + `ENGRAM_STARTUP=1`) now comes from the engram's
  per-owner onboarding flag (`fos_onboarding(action:get)` → `onboarding_completed`),
  not from counting projects:
  - `pending`: startup, even when the owner already has web-created projects.
  - `completed`: normal flow, even with zero non-default projects (opens `default`
    directly, no startup).
  - `legacy`: the engram has no `fos_onboarding` yet (tool-not-found), or the call
    failed or returned `null` twice (one retry). Falls back to the old project-count
    heuristic, prints a one-line stderr notice in the failure case, and never blocks
    the launch. Worst case is two bounded `_mcp_call` timeouts.
- A typed slug that exists in the owner's registry is always opened, even when
  onboarding is `pending`. The launcher does not silently switch to `default` + startup;
  it prints one stderr line (``seu onboarding ainda está pendente — rode `hivemind` sem
  argumentos para concluí-lo.``). A typed slug that does not exist, or the `legacy`
  heuristic, still routes a first-timer to startup, as before. The routing moved into
  `_resolve_project_slug` so the tests can run it directly.
- The registry-unreachable abort is unchanged. It runs before the onboarding check.

**RELEASE ORDERING (P3-2):** merge this to `main` only **after engram Phase 2
(`fos_onboarding` + `owner_onboarding` migration + backfill) is live** on the target
engram: LAB first, then prod. Until then this change is safe but gives no benefit.
Version skew is covered in both directions:

- New runtime + old engram: tool-not-found → `legacy`, which is exactly today's
  behaviour. Tested in `runtime/src/hivemind-cli.test.ts`, "older engram (tool-not-found)"
  and "real _mcp_call SSE extraction".
- Old runtime + new engram: the old runtime keeps the project-count heuristic. The
  served boot procedure (P4-2) re-checks `skeleton.onboarding_completed === false` in
  every vessel, so a pending owner that the runtime misses is still caught at boot.

Why the order still matters: before Phase 2 is live on an engram, the new runtime
only ever takes the `legacy` path against it. And the runtime trusts whatever
`onboarding_completed` the engram reports, so the Phase 2 runbook (P2-6: migrate,
deploy, backfill, verify) must be finished on that engram first. An owner whose row
is missing reads `completed`.
