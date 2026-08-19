/**
 * Adapter delivery module for the Relay message bus.
 *
 * Routes messages to external channel adapters (Telegram, webhooks, etc.)
 * with timeout protection, SQLite audit-trail indexing, and error handling.
 *
 * Deliveries to `relay.agent.*` subjects are detached: an agent turn can run
 * far longer than any reasonable publish timeout, and its replies flow back
 * through the sender's reply inbox rather than the delivery return value.
 * Publish therefore acknowledges acceptance immediately and the turn runs in
 * the background; genuine delivery failures are dead-lettered.
 *
 * Budget enforcement does NOT happen here: every envelope arrives from the
 * publish pipeline's authoritative budget gate (see `relay-publish.ts`,
 * DOR-260) already checked and carrying the decremented budget. A
 * budget-rejected message never reaches this module — that single upstream
 * gate is what stops a live (paid) agent turn from dispatching.
 *
 * @module relay/adapter-delivery
 */
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { SqliteIndex } from './sqlite-index.js';
import type { MaildirStore } from './maildir-store.js';
import type { DeadLetterQueue } from './dead-letter-queue.js';
import type { AdapterRegistryLike, AdapterContext, DeliveryResult } from './types.js';
import type { ChatNoticeSender } from './chat-notice.js';
import { requiresInitiateConsent } from './lib/consent-scope.js';

import type { Logger } from '@dorkos/shared/logger';

/** Subject prefix for agent-session deliveries that run detached. */
const AGENT_SUBJECT_PREFIX = 'relay.agent.';

/**
 * Which chat notice a failed delivery deserves.
 *
 * Prefers the adapter's machine {@link DeliveryResult.code} — a runtime that
 * says `at_capacity` says it in a way no rewording of its message can break.
 * The prose match is the fallback for adapters that predate the code, and is
 * deliberately broad, because getting it wrong only picks the more general of
 * two true sentences.
 *
 * `agent_busy` is now the END of a wait, not the start of one: the built-in
 * runtime holds a message rather than refusing it, so this is reached only when
 * the hold ran out of time or room (or when an adapter that does not hold at all
 * reports capacity). The line it produces says what happened and asks for
 * nothing — {@link ChatNoticeSender} carries `agent_held` for the wait itself.
 *
 * @param reason - The failure text.
 * @param code - The adapter's machine code, when it gave one.
 */
function classifyChatFailure(
  reason: string,
  code?: DeliveryResult['code']
): 'agent_busy' | 'delivery_failed' {
  if (code === 'at_capacity') return 'agent_busy';
  return /\b(at capacity|capacity|too busy|queue full|concurren\w+ limit)\b/i.test(reason)
    ? 'agent_busy'
    : 'delivery_failed';
}

/**
 * Whether this delivery may be held for a busy runtime, rather than refused.
 *
 * **Only a message a person is waiting on in a bridged chat.** Being detached
 * is not enough, and assuming it was is a bug this shipped with for one review
 * cycle: `relay_send_and_wait` and the A2A executor also publish to
 * `relay.agent.*` — the pipeline detaches them all — but each then BLOCKS on a
 * reply inbox with its own, much shorter deadline (60 s and 120 s against a
 * hold that could last five minutes). Holding one of those does not delay a
 * reply, it destroys it: the caller times out saying "timed out" where the
 * truth was capacity, tears down its inbox, and the turn still runs minutes
 * later into a reply nobody is reading. A retry then runs the same turn twice.
 * A fast refusal is the kind answer for a caller that can act on it.
 *
 * The predicate is {@link requiresInitiateConsent}, which is exactly "a bound
 * external human chat" — the same test {@link ChatNoticeSender} applies before
 * it will say anything. So the licence to hold and the ability to explain the
 * hold are one decision, and a message can never be parked in a place where
 * nobody could be told about it.
 *
 * **Known gap, deliberately not closed here.** The binding's paused /
 * receive-denied state is checked by `BindingRouter` BEFORE this publish, and
 * nothing re-asks across the park. A chat paused while its message waits still
 * gets that turn when the slot frees. The hold is bounded in minutes and the
 * message was already accepted when the binding said yes, so this is the same
 * window an in-flight turn has always had; closing it means giving this module
 * a binding store it has deliberately never had (`chat-notice.ts` resolves
 * through an injected resolver for exactly that reason).
 *
 * @param envelope - The envelope being delivered; its `replyTo` is the reader.
 */
function mayHold(envelope: RelayEnvelope): boolean {
  return envelope.replyTo !== undefined && requiresInitiateConsent(envelope.replyTo);
}

/**
 * Callback that publishes a terminal failure notice to a dead-lettered
 * envelope's reply inbox, so a waiting caller (e.g. `relay_send_and_wait`, the
 * A2A executor) settles immediately instead of blocking to its full timeout.
 *
 * Wired by RelayCore after construction. Implementations MUST publish only to
 * reply inboxes (never re-enter the `relay.agent.*` detached path) and swallow
 * their own failures — a failed notice must never cascade.
 *
 * @param replyTo - The envelope's reply subject.
 * @param reason - The delivery-failure reason.
 * @param envelope - The dead-lettered envelope (for context; the notice itself
 *                   carries a fresh budget so it can never be gate-rejected).
 */
export type ReplyFailureNotifier = (
  replyTo: string,
  reason: string,
  envelope: RelayEnvelope
) => Promise<void>;

/** Dependencies injected into AdapterDelivery. */
export interface AdapterDeliveryDeps {
  /** The adapter registry to route deliveries through (absent when adapters are disabled). */
  adapterRegistry: AdapterRegistryLike | undefined;

  /** SQLite index for the delivery audit trail. */
  sqliteIndex: SqliteIndex;

  /** Maildir store used to materialize a mailbox for dead-lettered envelopes. */
  maildirStore: MaildirStore;

  /** Dead letter queue for failed detached deliveries. */
  deadLetterQueue: DeadLetterQueue;

  /** Logger for delivery diagnostics. Defaults to `console`. */
  logger?: Logger;
}

/**
 * Delivers messages to matching adapters with timeout protection
 * and SQLite audit-trail indexing.
 */
export class AdapterDelivery {
  /** Adapter delivery timeout in milliseconds (non-agent subjects only). */
  static readonly TIMEOUT_MS = 120_000;

  private readonly logger: Logger;

  /** Optional callback to notify a reply inbox when a detached delivery fails. */
  private replyFailureNotifier?: ReplyFailureNotifier;

  /** Optional callback that tells a person, in their chat, that their turn died. */
  private chatFailureNotifier?: ChatNoticeSender;

  constructor(private readonly deps: AdapterDeliveryDeps) {
    this.logger = deps.logger ?? console;
  }

  /**
   * Register the callback used to notify a reply inbox when a detached agent
   * delivery dead-letters. Wired by RelayCore once its publish pipeline exists.
   *
   * @param notifier - The reply-failure notifier.
   */
  setReplyFailureNotifier(notifier: ReplyFailureNotifier): void {
    this.replyFailureNotifier = notifier;
  }

  /**
   * Register the callback that tells a person, in the chat they wrote in, that
   * the turn their message started did not run.
   *
   * Distinct from {@link setReplyFailureNotifier} on purpose. That one settles
   * a *caller* waiting on a reply inbox and is deliberately restricted to
   * `relay.inbox.*` / `relay.a2a.reply.*`; widening it to chat subjects would
   * feed the notice back to the agent as a new prompt, because a chat subject
   * has a live subscriber (the binding router) that a reply inbox does not.
   *
   * @param notifier - The chat notice sender.
   */
  setChatFailureNotifier(notifier: ChatNoticeSender): void {
    this.chatFailureNotifier = notifier;
  }

  /**
   * Deliver a message to a matching adapter.
   *
   * `relay.agent.*` subjects are accepted immediately and delivered in the
   * background (see module docs); all other subjects are awaited with a
   * {@link AdapterDelivery.TIMEOUT_MS} timeout.
   *
   * @param subject - The target subject
   * @param envelope - The relay envelope to deliver
   * @param contextBuilder - Optional callback to build adapter context
   * @returns DeliveryResult, or null when no adapter registry is configured
   *          or no adapter matches the subject (publish() then falls back to
   *          the pending-buffer / dead-letter pipeline)
   */
  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    contextBuilder?: (subject: string) => AdapterContext | undefined
  ): Promise<DeliveryResult | null> {
    const registry = this.deps.adapterRegistry;
    if (!registry) return null;

    const context = contextBuilder?.(subject);

    if (subject.startsWith(AGENT_SUBJECT_PREFIX)) {
      // Check for a matching adapter BEFORE acknowledging acceptance. When
      // none matches (e.g. the CCA adapter failed to start), returning null
      // preserves the normal pipeline semantics — publish() pending-buffers
      // or dead-letters the message instead of counting a phantom delivery.
      if (registry.getBySubject && !registry.getBySubject(subject)) {
        return null;
      }
      return this.deliverDetached(subject, envelope, context);
    }

    return this.deliverWithTimeout(subject, envelope, context);
  }

  /**
   * Start an agent delivery in the background and acknowledge acceptance.
   *
   * The returned result marks the message as accepted so publish() counts the
   * adapter as a delivery target. If the background turn ultimately fails
   * (adapter error, thrown exception, or a wait for capacity that ran out), the
   * envelope is dead-lettered for forensics; on success the audit row is
   * indexed. A turn that is merely WAITING for a free slot is neither — it says
   * so through {@link AdapterContext.onHeld} and then runs.
   */
  private deliverDetached(
    subject: string,
    envelope: RelayEnvelope,
    context: AdapterContext | undefined
  ): DeliveryResult {
    const startTime = Date.now();

    // The adapter may park this delivery to wait for a free slot, but ONLY when
    // a person in a bridged chat is the one waiting — see `mayHold`. Adding the
    // callback here rather than in the context builder keeps it off the awaited
    // path, which never reaches this method at all.
    // Passed through untouched when this message may not be held, so a delivery
    // that cannot wait is handed exactly what it was handed before.
    const heldContext: AdapterContext | undefined = mayHold(envelope)
      ? { ...context, onHeld: () => void this.noticeHeld(subject, envelope) }
      : context;

    void this.deps
      .adapterRegistry!.deliver(subject, envelope, heldContext)
      .then(async (result) => {
        if (result === null) {
          // Acceptance was already reported, so a no-match here (registry
          // without getBySubject, or the adapter vanished mid-flight) must
          // dead-letter — otherwise the message is silently swallowed.
          await this.deadLetterDetached(subject, envelope, 'no adapter matched subject');
        } else if (!result.success) {
          await this.deadLetterDetached(
            subject,
            envelope,
            result.error ?? 'unknown error',
            result.code
          );
        } else {
          this.indexDelivered(subject, envelope);
        }
      })
      .catch(async (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        await this.deadLetterDetached(subject, envelope, message);
      });

    return { success: true, durationMs: Date.now() - startTime };
  }

  /**
   * Deliver to a non-agent adapter, awaiting completion with a timeout.
   *
   * Returns `null` when no adapter matched the subject — a maildir-only
   * publish is not an adapter failure and must not surface as one.
   */
  private async deliverWithTimeout(
    subject: string,
    envelope: RelayEnvelope,
    context: AdapterContext | undefined
  ): Promise<DeliveryResult | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const deliveryPromise = this.deps.adapterRegistry!.deliver(subject, envelope, context);

      const result = await Promise.race([
        deliveryPromise,
        new Promise<DeliveryResult>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('adapter delivery timeout (120s)')),
            AdapterDelivery.TIMEOUT_MS
          );
        }),
      ]);

      if (result && result.success) {
        this.indexDelivered(subject, envelope);
      }

      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn('RelayCore: adapter delivery failed:', errorMessage);
      return {
        success: false,
        error: errorMessage,
        deadLettered: false,
        durationMs: undefined,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Tell the chat that its message is waiting for a busy agent, not lost.
   *
   * The one notice here that is not about a failure. It is fired from inside
   * the adapter's wait, so it must swallow everything: a notice that threw
   * would reject a timer callback with nobody to catch it, and the delivery it
   * is about is still perfectly alive.
   *
   * The subject is the failed envelope's `replyTo`, which on `relay_send` the
   * model writes — the notifier resolves it through the binding store and says
   * nothing for a chat nothing is bound to, exactly as on the failure path.
   */
  private async noticeHeld(subject: string, envelope: RelayEnvelope): Promise<void> {
    if (!envelope.replyTo || !this.chatFailureNotifier) return;
    this.logger.warn(`RelayCore: ${subject} is waiting for a free slot on a busy adapter`);
    try {
      await this.chatFailureNotifier(envelope.replyTo, 'agent_held');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`RelayCore: failed to tell a chat its message is waiting: ${message}`);
    }
  }

  /** Index an adapter-delivered message in SQLite for the audit trail. */
  private indexDelivered(subject: string, envelope: RelayEnvelope): void {
    this.deps.sqliteIndex.insertMessage({
      id: envelope.id,
      subject,
      endpointHash: `adapter:${subject}`,
      status: 'delivered',
      createdAt: envelope.createdAt,
      expiresAt: null,
    });
  }

  /**
   * Dead-letter an envelope whose detached delivery failed.
   *
   * Mirrors the publish pipeline's dead-letter convention (mailbox keyed by
   * subject via `ensureMaildir`) so failed agent turns land in the same DLQ
   * surfaces as other undeliverable messages.
   */
  private async deadLetterDetached(
    subject: string,
    envelope: RelayEnvelope,
    reason: string,
    code?: DeliveryResult['code']
  ): Promise<void> {
    this.logger.warn(`RelayCore: detached adapter delivery failed for ${subject}: ${reason}`);
    try {
      await this.deps.maildirStore.ensureMaildir(subject);
      await this.deps.deadLetterQueue.reject(
        subject,
        envelope,
        `adapter delivery failed: ${reason}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`RelayCore: failed to dead-letter detached delivery: ${message}`);
    }

    // Signal the waiting caller so it settles now instead of timing out. The
    // notifier publishes only to reply inboxes and swallows its own failures,
    // so this can never recurse back into the detached path.
    if (envelope.replyTo && this.replyFailureNotifier) {
      try {
        await this.replyFailureNotifier(envelope.replyTo, reason, envelope);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`RelayCore: failed to notify reply inbox of delivery failure: ${message}`);
      }
    }

    // When the caller was a person in a chat, their reply subject IS that chat.
    // Tell them there, in one line, instead of leaving the message looking like
    // an agent that is still thinking.
    // The subject is NOT trusted: on `relay_send` the model writes `replyTo`,
    // so this could name any chat at all. The notifier resolves it through the
    // binding store and says nothing when nothing is bound there — and the
    // damper is keyed on the binding it resolved, so varying the failed agent
    // subject cannot buy another line.
    if (envelope.replyTo && this.chatFailureNotifier) {
      await this.chatFailureNotifier(envelope.replyTo, classifyChatFailure(reason, code));
    }
  }
}
