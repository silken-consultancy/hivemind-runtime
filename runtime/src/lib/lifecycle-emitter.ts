// lifecycle-emitter.ts — fire-and-forget observability events for daemon
// reconcile/shutdown lifecycle.
//
// Bounded queue (cap 1000, drop-oldest) + exponential backoff. Transport is
// `fos_event_emit` over MCP via
// backend-mcp-client.ts — this daemon
// has no other access to the backend, only the mTLS→MCP upstream.
//
// Per the live `fos_event_emit` contract (measured 2026-07-15):
// kind_category is a closed enum with no
// 'lifecycle' member, and there is no raw `kind` input at all — the server
// always derives the full kind as `${kind_category}.${kind_detail}` (or just
// `kind_category` when no detail is given). We use kind_category:'domain' —
// the documented entity-lifecycle catch-all — with kind_detail
// carrying the event names; the server composes e.g.
// `domain.hivemind_runtime.daemon_started`.
//
// `slug` is omitted entirely (not passed as `null`) — daemon lifecycle isn't
// scoped to a project slug (the "OS-level event" case the tool's own
// description names), and the field is optional, not
// nullable — passing a literal `null` would itself fail validation.
//
// device_id = the durable HIVEMIND_DEVICE_ID, never
// os.hostname() — one device
// identity shared across reconcile, heartbeat, and events in this daemon.

import { callMcpTool } from './backend-mcp-client.ts';
import { env } from './env.ts';

interface QueuedEvent {
  kind_detail: string;
  payload: Record<string, unknown>;
  queued_at: number;
  attempts: number;
}

interface EventEmitResult {
  ok: boolean;
  event_id?: string;
  error?: string;
}

const QUEUE_CAP = 1000;
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 500;

class LifecycleEmitter {
  private queue: QueuedEvent[] = [];
  private flushing = false;

  /** Fire-and-forget — enqueues and returns immediately, never throws. */
  emit(kindDetail: string, payload: Record<string, unknown>): void {
    if (this.queue.length >= QUEUE_CAP) {
      this.queue.shift(); // drop oldest
    }
    this.queue.push({ kind_detail: kindDetail, payload, queued_at: Date.now(), attempts: 0 });
    this.flush();
  }

  private flush(): void {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    void this.drainNext();
  }

  private async drainNext(): Promise<void> {
    const item = this.queue[0];
    if (!item) {
      this.flushing = false;
      return;
    }

    // callMcpTool is itself best-effort (never throws) — a network failure,
    // an unenrolled daemon, or a malformed response all resolve to
    // `undefined` here, same as a genuine tool-level rejection would if it
    // came back with ok:false.
    const result = await callMcpTool<EventEmitResult>('fos_event_emit', {
      kind_category: 'domain',
      kind_detail: item.kind_detail,
      payload: item.payload,
      device_id: env.HIVEMIND_DEVICE_ID,
    });

    if (result?.ok) {
      this.queue.shift(); // success — remove from queue
      setImmediate(() => void this.drainNext());
      return;
    }

    item.attempts++;
    if (item.attempts >= MAX_ATTEMPTS) {
      const reason = result?.error ?? 'no result (see backend-mcp-client warnings above)';
      console.error(
        `[lifecycle-emitter] dropping event 'domain.${item.kind_detail}' after ${MAX_ATTEMPTS} attempts: ${reason}`,
      );
      this.queue.shift();
      setImmediate(() => void this.drainNext());
      return;
    }

    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** item.attempts, 30_000);
    setTimeout(() => void this.drainNext(), backoff);
  }
}

export const lifecycleEmitter = new LifecycleEmitter();
