// lifecycle-emitter.ts — fire-and-forget observability events for daemon
// reconcile/shutdown lifecycle (Fase 4, DR-4.1,
// docs/wip/hivemind-runtime-lifecycle-daemon-reconcile-port.md).
//
// Lean port of services/agent-runtime/src/lib/backend-emitter.ts (92 lines) —
// same queue cap (1000, drop-oldest) + exponential backoff. Transport is
// corrected for this daemon: `fos_event_emit` over MCP via
// backend-mcp-client.ts (Fase 2), NOT a raw `POST /v1/events` — this daemon
// has no REST access to the backend, only the mTLS→MCP upstream (the same
// transport correction DR-2.3 already made for close/pause/resume).
//
// CORRECTED vs the plan's literal text (measured live, resolved with
// team-lead 2026-07-15 — the architect is fixing DR-4.1's wording in
// parallel): DR-4.1 as written said `kind_category:'lifecycle'` plus a raw
// `kind` field in the emit body. Measured against the live EventEmitInput
// contract (packages/contract/src/mcp/tools.ts:2363-2392, projetos/engram),
// both are invalid: kind_category is a closed 7-value zod enum
// (tool_call|maintenance|memory|cortex|code|heartbeat|domain) with no
// 'lifecycle' member, and there is no raw `kind` input at all — the service
// always computes `kind = kind_detail ? \`${kind_category}.${kind_detail}\`
// : kind_category` server-side (session-infra-core.service.ts:190-193). A
// call built exactly as the plan described would be rejected by the
// backend's own validation. Using kind_category:'domain' instead — the
// documented entity-lifecycle catch-all (tools.ts:2356) — with kind_detail
// carrying the event names DR-4.1 wanted; composes server-side to e.g.
// `domain.hivemind_runtime.daemon_started`.
//
// `slug` is omitted entirely (not passed as `null`) — daemon lifecycle isn't
// scoped to a project slug (the "OS-level event" case the schema's own
// description names), and the schema type is `z.string().optional()`, not
// nullable — passing a literal `null` would itself fail validation.
//
// device_id = the durable HIVEMIND_DEVICE_ID (Fase 6/DR-6.3), never
// os.hostname() (unlike the lab's backend-emitter.ts:26) — one device
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
  lamport?: string;
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
