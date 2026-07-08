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
 * @module relay/adapter-delivery
 */
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { SqliteIndex } from './sqlite-index.js';
import type { MaildirStore } from './maildir-store.js';
import type { DeadLetterQueue } from './dead-letter-queue.js';
import type { AdapterRegistryLike, AdapterContext, DeliveryResult } from './types.js';

import type { Logger } from '@dorkos/shared/logger';

/** Subject prefix for agent-session deliveries that run detached. */
const AGENT_SUBJECT_PREFIX = 'relay.agent.';

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
 * @param envelope - The dead-lettered envelope (for budget/hop context).
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
   * (adapter error, capacity rejection, thrown exception), the envelope is
   * dead-lettered for forensics; on success the audit row is indexed.
   */
  private deliverDetached(
    subject: string,
    envelope: RelayEnvelope,
    context: AdapterContext | undefined
  ): DeliveryResult {
    const startTime = Date.now();

    void this.deps
      .adapterRegistry!.deliver(subject, envelope, context)
      .then(async (result) => {
        if (result === null) {
          // Acceptance was already reported, so a no-match here (registry
          // without getBySubject, or the adapter vanished mid-flight) must
          // dead-letter — otherwise the message is silently swallowed.
          await this.deadLetterDetached(subject, envelope, 'no adapter matched subject');
        } else if (!result.success) {
          await this.deadLetterDetached(subject, envelope, result.error ?? 'unknown error');
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
    reason: string
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
  }
}
