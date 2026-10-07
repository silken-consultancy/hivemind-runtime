# Changelog — hivemind-runtime

Installed clients detect new `main` commits through `_maybe_auto_update`, which compares
`git ls-remote` against the local HEAD. `LATEST_SHA` (the dist repo `main` HEAD, pulled every
2 minutes by a timer on each box — silken-ops `product-vps/manifest-cd/`; GitHub no longer
SSHes into the boxes, and `.github/workflows/publish-dist.yml` only pushes the dist) is not the trigger: it is the integrity
fallback `_verify_commit_integrity` uses for unsigned commits. **Merging to `main` is
shipping to every client.** Entries below that carry a release-ordering constraint must
not be merged until that constraint holds.

## Unreleased

### LATEST_SHA manifests are pull-based; the SSH publish is gone (impl 3e2c90da, D11)

- `.github/workflows/publish-dist.yml` keeps `build-and-guard` + `push-dist` only. The
  `resolve-sha` / `publish-prod` / `publish-lab` jobs and every use of
  `PROD_MANIFEST_SSH_*` / `LAB_MANIFEST_SSH_*` are removed. With `DIST_ENABLED` unset the
  workflow publishes nothing; the legacy "dev commit to the manifest" path is gone.
- The manifests on `hivemind.ia.br` and `kernel.silken.ia.br` are written by a pull timer on
  each box (silken-ops `product-vps/manifest-cd/`), which reads the dist `main` HEAD.
  **Release-ordering constraint:** merge this only after both boxes' timers are installed
  and proven to track the dist. Otherwise the manifests freeze and clients without GPG stop
  updating.

### Daemon survives Ctrl+C in the launching terminal (impl 3e2c90da, I8 + A6)

- I8: every daemon spawn of `bin/hivemind` (`_spawn_runtime` — used by `start`, `hivemind
  <slug>`, the auto-update restart and `autostart wsl-boot` — and the `--setup-only` spawn)
  now runs in its own session (`setsid`) or, without `setsid` (base macOS), its own process
  group. Before, `nohup … & disown` left it in the terminal's foreground group and a Ctrl+C
  (e.g. at the project menu right after an auto-update restart) shut the proxy down. An
  interrupted enrollment stops its setup daemon deliberately (INT/TERM/HUP trap, armed
  before the spawn, identity-guarded like `hivemind stop`; exits 130/143/129) and clears its
  pidfile. `HIVEMIND_DETACH_VIA=setsid` (test seam) falls back to the process-group path
  when there is no `setsid` binary.
- A6: `autostart` treats the machine as WSL only when `WSL_DISTRO_NAME` is set AND Windows
  interop is present (`binfmt_misc/WSLInterop[-late]` or `cmd.exe` on PATH) — no longer
  when the kernel release merely says "microsoft" (a Linux container on Docker Desktop).
- A7: `autostart off` / `uninstall` in a WSL shell that lost `WSL_DISTRO_NAME` and `/mnt/c`
  on PATH (ssh, su, sudo) but still has the `WSLInterop` binfmt entry no longer reports
  "already off" while a Windows Startup trigger may remain: it exits 1 and prints the
  `%APPDATA%\...\Startup\hivemind-wsl.cmd` path to delete by hand; `autostart status`
  says "unknown" there instead of "not installed". Only when a trigger was written here:
  `autostart on` under WSL now leaves a user-only record (`~/.engram/autostart-wsl-startup`,
  mode 600, the trigger's path), removed with the trigger. Without it (and without a unit
  or keep-alive pidfile from an older `on`), the same shell prints a one-line note and
  exits 0 — a user who never enabled autostart sees no failure.

### Proxy / harness split (impl 3e2c90da, phase S)

Ships in the same merge as phase U. **Proxy+harness is the reference configuration and
stays behaviourally identical**; an install without the marker below is a legacy
proxy+harness install and needs no migration.

- Component marker `$HIVEMIND_HOME/.components` (`proxy harness` | `proxy`), plain text,
  never a `.env` key. Reader: `_has_harness` — only `proxy` without `harness` means
  proxy-only; absent, empty or unreadable → proxy+harness.
- `install.sh --proxy-only`: writes marker `proxy` first (before `.env`/runtime/deps, so a
  partial failure never leaves a markerless runtime), then installs runtime, `.env` and binary; skips
  CLAUDE.md, settings.json, commands, hooks, statusline and the credentials seed. Refused
  when a harness is already installed (use `hivemind uninstall harness`). The default
  install is unchanged and also writes `proxy harness`. Re-running without `--proxy-only`
  adds the harness.
- `hivemind update`: `_stage_build` stages a proxy-only install through
  `_stage_build_proxy_only` (runtime + `.env` + marker + live `.claude` as-is). Every other
  install runs the previous steps unchanged and only carries an existing marker; the
  staged tree of a legacy install is byte-identical to origin/main's (tested). A
  proxy-only install stays proxy-only on update only when `update` runs from a binary of
  this release or later — a stale older `hivemind` earlier on PATH would re-ship the harness.
- Proxy-only `hivemind [<slug>]`: enrollment if needed → auto-update → proxy → connect
  hints (proxy URL, Claude Code / Codex / `hivemind install` lines, local CA path, and the
  direct-HTTPS bearer fallback with `Authorization: Bearer fospb_…` "where your plan allows
  it"); no picker, no session open, never Claude. The fallback URL
  (`https://api.hivemind.ia.br/v1/mcp`) is printed only when the endpoint is the default
  PROD one; any other endpoint needs `HIVEMIND_DIRECT_MCP_URL` in the process env (a `.env`
  line is ignored) or the fallback is not printed. `hivemind resume <slug>` on proxy-only
  prints only the "ignored" note. `hivemind start` prints the same hints on a proxy-only install only.
- `hivemind uninstall harness`: removes `$HIVEMIND_HOME/.claude` (incl. the isolated
  Claude Code state, listed first), the statusline and the update copies
  `$HIVEMIND_HOME.staging` / `.last-good` entirely (no backup left) — through the same guarded
  `_uninstall_rm`, writes marker `proxy`; the daemon keeps running and runtime, `.env`,
  `~/.engram`, client wiring and binaries are untouched. `hivemind uninstall proxy` →
  exit 1 (the harness depends on the proxy); `--keep-certs` only with `all`.
- Tests: `runtime/src/hivemind-split.test.ts` (install, update, launch compared against
  origin/main's code on the same input) + S5 cases in `hivemind-uninstall.test.ts`.

### `hivemind uninstall` (impl 3e2c90da, phase U)

- New subcommand `hivemind uninstall [all] [--yes|-y] [--keep-certs]` (`harness` added in phase S). Lists every path
  first; without `--yes` it asks `[y/N]` and needs a terminal (no TTY → exit 1).
- Removes, in order: the daemon via its pidfile (`cmd_stop`), `mcpServers.engram` in every
  config recorded in `~/.engram/mtls/port-map.json` (only when its url is still the HiveMind
  port; other keys kept, atomic, mode preserved), the Cowork skill dirs, the harness
  (`$HIVEMIND_HOME/.claude` including the isolated Claude Code state, statusline),
  `$HIVEMIND_HOME{,.staging,.last-good}`, `~/.engram`, the system-trusted local HTTPS CA
  (sudo best-effort, manual commands printed on failure), the binaries last.
- `--keep-certs` keeps `~/.engram/mtls` certs, `device-id` and the system CA.
- Guard (`_uninstall_guard` / `_uninstall_root_check`), run on the final values (after the
  `.env` re-load) before anything is stopped or removed: every rm -rf root must resolve
  strictly inside `$HOME`, must not overlap `HIVEMIND_SOURCE_DIR`, must not be in or contain
  a git repo, and must carry a HiveMind fingerprint (`$HIVEMIND_HOME`: `runtime/src/server.ts`,
  `bin/hivemind-statusline.py` or `.claude/hooks/session-end.close-session.js`; `~/.engram`: `mtls/`, `cache/` or `device-id`; Cowork skill:
  `SKILL.md`). `_uninstall_rm` removes only approved roots or paths inside them.
- No server-side device revoke (out of v1).
- `uninstall.sh` is now a thin wrapper: `exec bash <clone>/bin/hivemind uninstall "$@"`.
- Symlinked client configs are edited at their target (the link is kept); output keeps a
  trailing newline.
- System CA is removed only when its basename is `hivemind-local-https-ca.crt` and its bytes equal
  `~/.engram/mtls/local-https/ca.cert.pem` (checked before `~/.engram` goes); otherwise the manual
  commands are printed.
- Uninstall-only test seams: `HIVEMIND_SYSTEM_CA_DEST` (process env only, snapshotted before the
  `.env` load; install-time trust still uses the fixed path) and `HIVEMIND_UNINSTALL_BIN_DIRS` (colon-separated,
  default `/usr/local/bin:~/.local/bin`).
- Tests: `runtime/src/hivemind-uninstall.test.ts` on the new sandbox helper
  `runtime/src/test-sandbox.ts` (throwaway HOME/HIVEMIND_HOME, stub PATH, non-default ports).

### Launcher opens real projects only (impl 4e978e9c, Phase 9)

- No project, no session. `_resolve_project_slug` lists real projects only (not
  `default`, not archived). No projects: exit 1 with the web create URL, derived from
  `HIVEMIND_ENDPOINT` (`/app`, the web first-project screen).
  A real project = owned, not `default`, not archived/retired (legacy `inactive` counts);
  rows with `owned:false` are ignored, an absent flag is tolerated. One project: opened directly. Several: picker without `default`.
- A `default`, unknown or archived slug argument aborts before Claude starts (exit 2
  for `default`, 1 otherwise). The registry is always consulted first.
- `_open_session_spine` never opens on `default` and aborts on the engram's
  `project_required` / `slug_not_found`; in warn mode it prints the gate warning.
- Removed `ENGRAM_STARTUP` and the onboarding routing. This supersedes the Phase 3
  entry below (`_onboarding_probe` / `_onboarding_state` / `_is_first_timer`).
- `CLAUDE.md`: "First act (empty boot)" became "First session - self onboarding".
- Release ordering: merge after the served texts (R-3) are on PROD.

### SessionEnd hook closes the session only on real process exit

- `.claude/hooks/session-end.close-session.js`: the reason filter is now an allowlist.
  The hook closes the fos_session only on `prompt_input_exit` and `other`. `clear`,
  `resume`, `logout`, unknown reasons and an empty reason exit 0 with no network call.
  Before this, `/resume` (an in-process conversation swap) closed the live window's
  session. Measured on session 82f9f738, which closed 1 s after `/resume`. A real orphan
  is still reclaimed by the engram watchdog.
- The raw reason is forwarded as `close_reason = session-end-hook:<reason>` (was the fixed
  string `session-end-hook`). No engram consumer matches the old exact string.
- New regression test `.claude/hooks/test/session-end-reasons.regression.test.js`. It runs
  the real hook against a stub HTTPS server and needs `openssl` on PATH.

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

**RELEASE ORDERING (P3-2):** merge this to `main` only after **all three** of these
hold on the target engram (LAB first, then prod):

1. **Phase 2 is live**: `fos_onboarding` deployed, the `owner_onboarding` migration
   applied, its RLS applied, and the backfill run.
2. **The served startup contract is active**, so a session opened with
   `ENGRAM_STARTUP=1` has a served law that runs onboarding and completes it.
3. **Boot Step 2b is live** in the served boot procedure (the
   `skeleton.onboarding_completed === false` re-check).

Before Phase 2 is live, this change is safe but gives no benefit. Version skew is
covered in both directions:

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

Why Phase 2 alone is not enough: once Phase 2 is live, the new runtime routes every
`pending` owner to `default` + `ENGRAM_STARTUP=1`. That env var does nothing by itself.
If the served startup contract and boot Step 2b are not active, nothing in the session
acts on it, so onboarding is never completed and the owner stays `pending`. A pending
owner who already has projects then loses the project picker on every no-arg launch,
with no way out.
