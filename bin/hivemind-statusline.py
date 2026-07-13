#!/usr/bin/env python3
"""
HiveMind statusline — thin-CLI edition (ported from the lab's
silken-statusline.py, 4tuenyOS `bin/silken-statusline.py`).

CLI is the primary UI; this strip — fixed under the Claude Code chat — is its
most-seen surface. Ported quase-verbatim: same design contract, same palette,
same segment order. The only real adaptation is identity — the product has a
single role (there is no messenger/orchestrator/project-agent distinction
here), so the segment collapses to "slug only", read from `ENGRAM_SLUG` (the
env var `cmd_open` in bin/hivemind always sets before `exec claude`) instead
of the lab's `FOS_SLUG`/`FOS_PROJECT_SLUG`/`FOS_ROLE` trio.

Design contract (unchanged from the lab):
  - ONE line. The harness renders the command's stdout inline — no agent table.
  - Reading order = importance: WHERE am I (slug) -> WHAT (model) -> git ->
    context budget -> quota -> ambient signal -> time.
  - Render budget < 100ms. Git is the only subprocess and is cached to a
    temp file with a short TTL keyed on cwd. Everything else is env / instant
    local file reads. NEVER touch the network directly (quota is refreshed
    out-of-band by the UserPromptSubmit hook, not by this script).
  - Fail-soft: any failure in a segment yields nothing (or a minimal line);
    never a traceback, never a broken row — this floor is unconditional even
    with no local cache at all (fresh install, first run).

Palette (xterm-256, TERM=xterm-256color — no truecolor assumed):
  bronze accent   137   identity, separator
  bronze bright   173   live slug emphasis
  ivory/text      252   primary value (model)
  neutral         245   secondary (dir, git)
  faint           240   tertiary (time, footer, ctx detail)
  ok / warn / crit 71 / 178 / 203   semantic gradient (ctx, quota, health)
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# ── palette ────────────────────────────────────────────────────────────────
def c(code: str) -> str:
    return f"\033[{code}m"

RST    = "\033[0m"
BRONZE = c("38;5;137")   # acento de marca — seda fosca
BRZLIT = c("1;38;5;173") # bronze vivo (slug em foco)
TEXT   = c("38;5;252")   # ivory aproximado — valor primário
MUTE   = c("38;5;245")   # secundário
FAINT  = c("38;5;240")   # terciário / cromo
OK     = c("38;5;71")    # verde sóbrio
WARN   = c("38;5;178")   # âmbar
CRIT   = c("38;5;203")   # vermelho

SEP = f" {FAINT}◆{RST} "


# ── git (the only subprocess — cached) ───────────────────────────────────────
def _git_raw(cwd: str) -> str:
    """branch[*][↑a↓b] or '' — single short-lived subprocess pass."""
    try:
        head = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=0.4,
        )
        if head.returncode != 0:
            return ""
        branch = head.stdout.strip() or "?"
        dirty = subprocess.run(
            ["git", "-C", cwd, "status", "--porcelain"],
            capture_output=True, text=True, timeout=0.4,
        )
        if dirty.stdout.strip():
            branch += "*"
        sync = subprocess.run(
            ["git", "-C", cwd, "rev-list", "--left-right", "--count", "HEAD...@{u}"],
            capture_output=True, text=True, timeout=0.4,
        )
        if sync.returncode == 0:
            p = sync.stdout.strip().split()
            if len(p) == 2:
                a, b = int(p[0]), int(p[1])
                if a:
                    branch += f"↑{a}"
                if b:
                    branch += f"↓{b}"
        return branch
    except Exception:
        return ""


def git_cached(cwd: str, ttl: float = 3.0) -> str:
    """git_raw with a per-cwd temp cache (TTL seconds) to stay under budget."""
    if not cwd:
        return ""
    key = str(abs(hash(cwd)))
    cache = Path("/tmp") / f".hivemind-status-git-{os.getuid()}-{key}.json"
    try:
        st = cache.stat()
        if (time.time() - st.st_mtime) < ttl:
            d = json.loads(cache.read_text())
            if d.get("cwd") == cwd:
                return d.get("branch", "")
    except Exception:
        pass
    branch = _git_raw(cwd)
    try:
        cache.write_text(json.dumps({"cwd": cwd, "branch": branch}))
    except Exception:
        pass
    return branch


# ── HiveMind identity (env-only, instant) ────────────────────────────────────
def slug_identity() -> str:
    """`slug` segment. Single-role product — no messenger/orchestrator/
    project-agent distinction to qualify it (unlike the lab's fos_identity,
    which also renders FOS_ROLE). ENGRAM_SLUG is always set by cmd_open
    before `exec claude` (bin/hivemind), so absence here means "not inside
    a hivemind session" — a silent empty segment, not an error."""
    slug = os.environ.get("ENGRAM_SLUG") or ""
    if not slug:
        return ""
    return f"{BRZLIT}{slug}{RST}"


# ── ambient signal (local cache only, fail-soft, never blocks) ──────────────
def fos_signal() -> str:
    """
    One compact pill from local daemon cache if present, else silent.
    Surfaces only what is actionable: open/critical blockers and active sessions.
    No network. Absent cache => no segment (not a noisy '[FOS?]'). The cache
    paths are the same as the lab's (~/.fos/...) — this is a fail-soft read of
    whatever local daemon state happens to exist on the machine; on a
    product-only install (no lab daemon), this stays silently empty forever,
    which is the correct behavior, not a bug to fix.
    """
    cache = Path.home() / ".fos" / ".cache" / "state.json"
    try:
        d = json.loads(cache.read_text())
    except Exception:
        return ""
    if not isinstance(d, dict) or "error" in d:
        return ""
    crit = int(d.get("blockers_critical_total", 0) or 0)
    blk = int(d.get("blockers_open_total", 0) or d.get("blockers_open", 0) or 0)
    ses = int(d.get("sessions_active", 0) or 0)
    bits = []
    if crit > 0:
        bits.append(f"{CRIT}{crit} crit{RST}")
    elif blk > 0:
        bits.append(f"{WARN}{blk} blk{RST}")
    if ses > 0:
        bits.append(f"{MUTE}{ses} ses{RST}")
    return " ".join(bits)


def fos_health() -> str:
    """API health dot from local cache. Bronze ring when healthy, red when not.
    Same fail-soft contract as fos_signal(): absent cache => empty segment."""
    cache = Path.home() / ".fos" / "cache" / "health.json"
    try:
        d = json.loads(cache.read_text())
    except Exception:
        return ""
    return f"{OK}● api{RST}" if d.get("ok") else f"{CRIT}● api{RST}"


# ── quota (local /usage cache only) ──────────────────────────────────────────
def _reset_remaining(iso: str) -> str:
    """ISO reset timestamp → 'H:MMm' time-until-reset, or '' if past/unparseable."""
    if not iso:
        return ""
    try:
        t = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        secs = (t - datetime.now(t.tzinfo)).total_seconds()
        if secs <= 0:
            return ""
        h, m = int(secs // 3600), int((secs % 3600) // 60)
        return f"{h}:{m:02d}m"
    except Exception:
        return ""


def quota() -> str:
    """
    Subscription quota, ALWAYS present — the founder wants it visible at all times.
    Layout (founder spec):
      Sessão: NN% H:MMm~      → 5h window: % USED + time left until reset
      Global: NN%             → 7-day all-models: total % USED

    Source: ~/.claude/cache/usage.json — kept fresh per-message by the sibling
    user-prompt-submit.capture-quota.js hook. NOTE (ported verbatim from the
    lab, gate confirmed at F5.2): this path is the REAL homedir, not
    ${CLAUDE_CONFIG_DIR}/cache/usage.json — the hook's CACHE constant hardcodes
    os.homedir(), same as here, so hook-write and statusline-read always agree
    with each other. This is intentional-safe: subscription quota is
    account-scoped, not session-scoped, so sharing this one cache file across
    an isolated hivemind session and the user's regular Claude Code use is
    harmless (same numbers either way).

    States: no cache → faint placeholder; fresh → semantic colour (more used =
    hotter); older than STALE_MIN → dimmed (only when idle, no messages to
    trigger the refresh hook).
    """
    STALE_MIN = 30
    cache = Path.home() / ".claude" / "cache" / "usage.json"
    try:
        d = json.loads(cache.read_text())
    except Exception:
        return f"{FAINT}Sessão: —{RST}"  # hold the slot

    stale = False
    cap = d.get("captured_at")
    if cap:
        try:
            t = datetime.fromisoformat(str(cap).replace("Z", "+00:00"))
            age_min = (datetime.now(t.tzinfo) - t).total_seconds() / 60.0
            stale = age_min >= STALE_MIN
        except Exception:
            pass

    def used_col(pct: int) -> str:
        if stale:
            return FAINT
        return CRIT if pct >= 80 else WARN if pct >= 50 else OK

    out = []

    # Sessão: NN% H:MMm~  (5h window, % used + time-to-reset)
    sp = d.get("session_pct")
    if sp is None:
        out.append(f"{FAINT}Sessão: —{RST}")
    else:
        body = f"{int(sp)}%"
        rem = _reset_remaining(d.get("session_resets_at"))
        if rem:
            body += f" {rem}~"
        out.append(f"{FAINT}Sessão:{RST} {used_col(int(sp))}{body}{RST}")

    # Global: NN%  (7-day all-models, total used)
    wp = d.get("week_pct")
    if wp is not None:
        out.append(f"{FAINT}Global:{RST} {used_col(int(wp))}{int(wp)}%{RST}")

    return f" {FAINT}·{RST} ".join(out)


# ── path (relative, compact) ─────────────────────────────────────────────────
def rel_dir(cwd: str, project_dir: str) -> str:
    home = os.path.expanduser("~")
    if project_dir and cwd.startswith(project_dir):
        rel = cwd[len(project_dir):].lstrip("/")
        return rel or "."  # at repo root, "." beats "./"
    if cwd.startswith(home):
        return "~" + cwd[len(home):]
    return cwd


# ── main ─────────────────────────────────────────────────────────────────────
def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}

    model = (data.get("model") or {}).get("display_name") or "Claude"
    ws = data.get("workspace") or {}
    cwd = ws.get("current_dir") or data.get("cwd") or os.getcwd()
    project_dir = ws.get("project_dir") or ""
    ctx = data.get("context_window") or {}
    used = ctx.get("used_percentage")

    parts: list[str] = []

    # 1. WHERE — identity (slug only, single-role product): anchor, bronze, far left.
    ident = slug_identity()
    if ident:
        parts.append(ident)

    # 2. WHAT — model, primary neutral.
    parts.append(f"{TEXT}{model}{RST}")

    # 3. git branch + dir, secondary neutral, fused (both answer "what tree?").
    branch = git_cached(cwd)
    place = rel_dir(cwd, project_dir)
    if branch:
        # dirty marker keeps bronze tint to read as "your edits"
        b = branch.replace("*", f"{BRONZE}*{RST}{MUTE}")
        seg = f"{MUTE}{b}{RST}"
        if place != ".":  # at repo root the "." is noise; the branch is the tree
            seg += f" {FAINT}{place}{RST}"
        parts.append(seg)
    else:
        parts.append(f"{FAINT}{place}{RST}")

    # 4. context budget — the one number worth a semantic gradient.
    if used is not None:
        col = CRIT if used >= 80 else WARN if used >= 50 else OK
        parts.append(f"{col}{used:.0f}%{RST}{FAINT} ctx{RST}")

    # 5. quota — always present (session + week % used); faint dashes when no data.
    qta = quota()
    if qta:
        parts.append(qta)

    # 6. ambient signal — blockers / sessions / health, only when present
    # (fail-soft: silently empty on a product-only install with no local
    # ~/.fos daemon cache).
    sig = fos_signal()
    if sig:
        parts.append(sig)
    hl = fos_health()
    if hl:
        parts.append(hl)

    # 7. time — faintest, far right (chrome, not signal).
    parts.append(f"{FAINT}{datetime.now().strftime('%H:%M')}{RST}")

    sys.stdout.write(SEP.join(parts))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # absolute fail-soft floor: never a traceback under the chat.
        sys.stdout.write(f"{BRONZE}hivemind{RST}")
