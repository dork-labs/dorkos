/**
 * Reply-inbox failure notice for the Relay message bus.
 *
 * When a detached `relay.agent.*` delivery dead-letters, the caller waiting on
 * the reply inbox (`relay_send_and_wait`, the A2A executor) would otherwise
 * block to its full timeout with no signal. This factory builds the notifier
 * that {@link AdapterDelivery} invokes to publish a terminal failure to that
 * reply inbox so the caller settles immediately.
 *
 * The notice shape (`{type:'error', data:{message}}` then `{type:'done'}`)
 * matches what the Claude Code adapter streams, so BOTH consumers settle on it:
 * `relay_send_and_wait` resolves on the first non-progress payload (the error),
 * and the A2A executor records the error and settles on the `done`.
 *
 * @module relay/reply-failure-notifier
 */
import type { ReplyFailureNotifier } from './adapter-delivery.js';
import type { PublishOptions } from './types.js';
import type { PublishResult } from './relay-publish.js';

/** Reply-subject prefixes eligible for a failure notice. */
const REPLY_INBOX_PREFIXES = ['relay.inbox.', 'relay.a2a.reply.'] as const;

/** System sender identity for delivery-failure notices. */
const DELIVERY_FAILURE_SENDER = 'relay.system.delivery';

/** Dependencies for {@link createReplyFailureNotifier}. */
export interface ReplyFailureNotifierDeps {
  /** Publish a payload to a subject (the relay publish pipeline). */
  publish: (subject: string, payload: unknown, options: PublishOptions) => Promise<PublishResult>;
  /**
   * Whether the subject still has a live consumer — a registered endpoint
   * (`relay_send_and_wait`) OR an active subscriber (the A2A executor, which
   * consumes its reply subject via `subscribe()` with no registered endpoint).
   */
  hasConsumer: (subject: string) => boolean;
}

/**
 * Build a {@link ReplyFailureNotifier} bound to the relay publish pipeline.
 *
 * The returned notifier publishes ONLY to reply inboxes (never re-entering the
 * `relay.agent.*` detached path, so it cannot recurse) and skips inboxes whose
 * caller already settled and tore down its consumer (avoiding a junk dead
 * letter).
 *
 * @param deps - Publish + consumer-lookup callbacks.
 * @returns A notifier that settles a waiting caller on delivery failure.
 */
export function createReplyFailureNotifier(deps: ReplyFailureNotifierDeps): ReplyFailureNotifier {
  return async (replyTo, reason, _envelope) => {
    if (!REPLY_INBOX_PREFIXES.some((prefix) => replyTo.startsWith(prefix))) return;
    if (!deps.hasConsumer(replyTo)) return;

    // The notice is a system-generated delivery signal, NOT another hop in the
    // failed message's chain — it must be deliverable precisely when the
    // original budget is exhausted. It previously inherited the rejected
    // envelope's hopCount (+1), so a "max hops exceeded" rejection produced a
    // notice that the publish pipeline's own budget gate rejected in turn,
    // silently leaving the waiting caller to time out. A fresh default budget
    // always passes the gate; loops remain impossible because the notice
    // carries no replyTo and only ever targets reply inboxes.
    const options: PublishOptions = {
      from: DELIVERY_FAILURE_SENDER,
    };
    await deps.publish(replyTo, { type: 'error', data: { message: reason } }, options);
    await deps.publish(replyTo, { type: 'done' }, options);
  };
}
