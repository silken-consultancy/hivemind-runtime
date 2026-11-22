// heartbeat-cadence.ts — self-rescheduling heartbeat that honours the
// server-driven cadence (`next_heartbeat_s` in the fos_heartbeat reply).
//
// Why: a fixed 30 s beat per open Claude window keeps the (scale-to-zero) DB
// awake forever. The server (which knows the watchdog threshold) advises the
// next interval; the runtime obeys within a clamp.
//
// Rules:
//  - reply carries a finite number `next_heartbeat_s` -> next beat after that
//    many seconds, clamped to [HEARTBEAT_MIN_S, HEARTBEAT_MAX_S];
//  - field absent / not a finite number (old server, PROD) -> 30 s (today);
//  - send failed (undefined reply / throw) -> retry at 30 s until a beat
//    succeeds (two transient failures at a long interval could otherwise let
//    a live session look dead to the watchdog);
//  - reply carries liveness === 'activity' (Z8.3 server: liveness is counted
//    from tool-call activity, not from beats) -> the loop ENDS, nothing is
//    rescheduled. Only a real reply can do this; a failed send never stops it.
//    An old server never sends the field, so it keeps beating as above;
//    the stop is honoured ONLY when the caller says this session's MCP URL
//    carries session=<uuid> (opts.honourActivityStop): the server answers
//    'activity' by global mode, but only a keyed session has its calls counted
//    as that session's liveness; an unkeyed one (Windows launcher, failed spine,
//    non-cmd_open launch) keeps the advised cadence;
//  - otherwise never stops by itself: only stop() ends it (window close / pid gone).
//
// Clamp rationale: floor 30 s = today's cadence, a server can never make the
// runtime chatter more than it does now. Ceiling 3600 s only bounds a buggy
// or hostile reply; the server's advised value is the authority (it derives
// it from the effective watchdog threshold, which can be lower than 60 min
// for a per-slug floor, and its own cap is 3000 s).

export const HEARTBEAT_DEFAULT_S = 30;
export const HEARTBEAT_MIN_S = 30;
export const HEARTBEAT_MAX_S = 3600;

export interface HeartbeatHandle {
  stop(): void;
  /** Seconds the next (or in-flight) beat is/was scheduled after; for diagnostics. */
  currentIntervalS(): number;
  /** True once stop() was called or the server declared liveness:'activity'. */
  stopped(): boolean;
}

/** True when the reply says the server counts activity, so beats are pointless. */
export function replyIsActivityLiveness(reply: unknown): boolean {
  if (reply === null || typeof reply !== 'object') return false;
  return (reply as { liveness?: unknown }).liveness === 'activity';
}

/** Interval in seconds the reply asks for, or undefined when it asks nothing usable. */
export function nextIntervalFromReply(reply: unknown): number | undefined {
  if (reply === null || typeof reply !== 'object') return undefined;
  const v = (reply as { next_heartbeat_s?: unknown }).next_heartbeat_s;
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(HEARTBEAT_MAX_S, Math.max(HEARTBEAT_MIN_S, v));
}

/**
 * Start beating. The first beat fires after HEARTBEAT_DEFAULT_S (as the old
 * setInterval did). `send` resolves to the reply, or undefined on failure.
 */
export function startHeartbeat(
  send: () => Promise<unknown>,
  opts: { honourActivityStop?: boolean } = {},
): HeartbeatHandle {
  const honourActivityStop = opts.honourActivityStop === true;
  let intervalS = HEARTBEAT_DEFAULT_S;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => { void beat(); }, intervalS * 1000);
  };

  const beat = async (): Promise<void> => {
    let reply: unknown;
    try {
      reply = await send();
    } catch {
      reply = undefined; // error: keep current interval
    }
    if (stopped) return; // window closed while the call was in flight
    if (honourActivityStop && replyIsActivityLiveness(reply)) { stopped = true; return; } // server counts activity: end the loop
    // success: obey the reply (30 s when it is silent); failure: retry at 30 s
    intervalS = reply === undefined
      ? HEARTBEAT_DEFAULT_S
      : (nextIntervalFromReply(reply) ?? HEARTBEAT_DEFAULT_S);
    schedule();
  };

  schedule();

  return {
    stop(): void {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = undefined; }
    },
    currentIntervalS: () => intervalS,
    stopped: () => stopped,
  };
}
