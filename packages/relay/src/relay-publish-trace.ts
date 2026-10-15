import type { PublishDeps } from './relay-publish-policy-data.js';
import type { DeliveryResult, PublishResult } from './types.js';
import type { BudgetRejectionCode } from '@dorkos/shared/relay-schemas';
import { chatSpanFields } from './lib/chat-span-fields.js';

export interface PublishTraceSpan {
  messageId: string;
  subject: string;
  /**
   * Who published it. Recorded so a span can tell a message a chat
   * connection brought in (`relay.human.<platform>.<adapterId>.bot`) from the
   * agent's replies and stream events published back to the same chat
   * subject — the observed-chats list counts only the former (DOR-2590).
   */
  from: string;
  /**
   * The published payload, read only by {@link chatSpanFields} for a chat's
   * display name and whether it said anything, never for its body.
   */
  payload?: unknown;
  deliveredTo: number;
  rejected: PublishResult['rejected'];
  adapterResult: DeliveryResult | null;
  /** When the publish started, for the span's duration. */
  createdAt: string;
  /** Human-readable cause, when this publish was stopped at a gate. */
  error?: string;
  /** Machine rejection code, when one applies (gate or budget). */
  rejectionCode?: string;
  /** The budget check that rejected it, for the budget-rejection counters. */
  budgetCode?: BudgetRejectionCode;
  /**
   * The dispatch this publish belongs to, when the caller knows it.
   *
   * This is what turns the `relayTraces` table into the thing it was built
   * for. `traceId` was set to `messageId` on every row, so every trace had
   * exactly one span and `getTrace(traceId)` could only return the row you
   * already had. Sharing the dispatch id across hops makes it a real trace.
   */
  dispatchId?: string;
}

/**
 * Record a trace span for delivery tracking (best-effort).
 *
 * ## Zero deliveries is two different stories
 *
 * This used to write `failed` for every `deliveredTo === 0`, with no error
 * message, which is how 1,653 rows came to claim failure while naming no
 * cause and one whole day read as a 100% failure rate — its traffic was
 * publishes to a subject nothing subscribed to. A message nobody was
 * listening for is `no_subscriber`: nothing went wrong and nothing needs
 * fixing. A message that hit a gate, a rejecting endpoint, or an adapter
 * error is `failed`, and now carries the reason that made it one.
 *
 * @param span - What happened to one published message.
 */
export function recordPublishTrace(deps: PublishDeps, span: PublishTraceSpan): void {
  if (!deps.traceStore) return;
  const { messageId, subject, deliveredTo, rejected, adapterResult, createdAt } = span;
  const failureReason = span.error ?? adapterResult?.error ?? undefined;
  const status =
    deliveredTo > 0
      ? 'delivered'
      : failureReason || (rejected?.length ?? 0) > 0
        ? 'failed'
        : 'no_subscriber';
  try {
    deps.traceStore.insertSpan({
      messageId,
      traceId: span.dispatchId ?? messageId,
      subject,
      status,
      // A delivery that happened has a time it happened at. Leaving this null
      // on the delivered path is what left the latency percentiles computing
      // over an empty column while the panel presented them as measurements.
      ...(status === 'delivered' ? { deliveredAt: new Date().toISOString() } : {}),
      ...(failureReason ? { error: failureReason } : {}),
      metadata: {
        from: span.from,
        ...chatSpanFields(span.from, span.payload),
        deliveredTo,
        rejectedCount: rejected?.length ?? 0,
        hasAdapterResult: !!adapterResult,
        durationMs: Date.now() - new Date(createdAt).getTime(),
        ...(span.rejectionCode ? { rejectionCode: span.rejectionCode } : {}),
        ...(span.budgetCode ? { budgetCode: span.budgetCode } : {}),
      },
    });
  } catch {
    // Trace insertion is best-effort — never fail a publish for tracing
  }
}
