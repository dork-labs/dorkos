/**
 * Publish logic for the Relay message bus.
 *
 * Handles message publishing including subject validation, access control,
 * budget enforcement, rate limiting, circuit breaker integration, adapter
 * delivery, subscription dispatch, dead-lettering, and trace recording.
 *
 * @module relay/relay-publish
 */
import { monotonicFactory } from 'ulidx';
import { validateSubject, matchesPattern } from './subject-matcher.js';
import { requiresInitiateConsent } from './lib/consent-scope.js';
import { createDefaultBudget, enforceBudget } from './budget-enforcer.js';
import { checkRateLimit } from './rate-limiter.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { EndpointRegistry } from './endpoint-registry.js';
import type { SubscriptionRegistry } from './subscription-registry.js';
import type { MaildirStore } from './maildir-store.js';
import type { SqliteIndex } from './sqlite-index.js';
import type { AccessControl } from './access-control.js';
import type { DeadLetterQueue } from './dead-letter-queue.js';
import type { AdapterDelivery, ReplyFailureNotifier } from './adapter-delivery.js';
import type { DeliveryPipeline } from './delivery-pipeline.js';
import type {
  RateLimitConfig,
  PublishOptions,
  EndpointInfo,
  AdapterRegistryLike,
  AdapterContext,
  DeliveryResult,
  TraceStoreLike,
  RelayLogger,
  InitiateConsentGate,
  InitiateConsentDecision,
  PublishResult,
} from './types.js';
import type { BudgetRejectionCode } from '@dorkos/shared/relay-schemas';

// === Types ===

// `PublishResult` is defined in types.ts (so adapter interfaces can reference
// it without a circular import through relay-core.ts) and re-exported here for
// callers that import it from the pipeline module.
export type { PublishResult } from './types.js';

/** Resolved options needed by the publish pipeline. */
export interface PublishResolvedOptions {
  maxHops: number;
  defaultTtlMs: number;
  defaultCallBudget: number;
}

/** Dependencies injected into the RelayPublishPipeline. */
export interface PublishDeps {
  endpointRegistry: EndpointRegistry;
  subscriptionRegistry: SubscriptionRegistry;
  maildirStore: MaildirStore;
  sqliteIndex: SqliteIndex;
  accessControl: AccessControl;
  deadLetterQueue: DeadLetterQueue;
  deliveryPipeline: DeliveryPipeline;
  adapterDelivery: AdapterDelivery;
  adapterRegistry?: AdapterRegistryLike;
  traceStore?: TraceStoreLike;
  logger?: RelayLogger;
}

// === Private Helpers ===

const generateUlid = monotonicFactory();

/**
 * Find all registered endpoints whose subject matches the given target.
 *
 * @param endpointRegistry - The endpoint registry to search
 * @param subject - The target subject to match against
 */
function findMatchingEndpoints(
  endpointRegistry: EndpointRegistry,
  subject: string
): EndpointInfo[] {
  return endpointRegistry.listEndpoints().filter((ep) => matchesPattern(ep.subject, subject));
}

// === RelayPublishPipeline ===

/**
 * Encapsulates the publish pipeline for the Relay message bus.
 *
 * Validates subjects, checks access control, enforces rate limits,
 * builds envelopes with budgets, delivers to Maildir endpoints and
 * adapters, dispatches to subscribers, dead-letters undeliverable
 * messages, and records trace spans.
 */
export class RelayPublishPipeline {
  private readonly deps: PublishDeps;
  private readonly opts: PublishResolvedOptions;
  private rateLimitConfig: RateLimitConfig;
  private adapterContextBuilder?: (subject: string) => AdapterContext | undefined;

  /** Optional callback to settle a waiting reply-inbox caller when the budget gate rejects. */
  private replyFailureNotifier?: ReplyFailureNotifier;

  /**
   * The agent→human initiate-consent gate (DOR-277).
   *
   * Optional in the type, never optional in effect: while it is unset, every
   * publish to a bound human channel is denied. See
   * {@link evaluateInitiateConsent}.
   */
  private initiateConsentGate?: InitiateConsentGate;

  constructor(
    deps: PublishDeps,
    opts: PublishResolvedOptions,
    rateLimitConfig: RateLimitConfig,
    adapterContextBuilder?: (subject: string) => AdapterContext | undefined
  ) {
    this.deps = deps;
    this.opts = opts;
    this.rateLimitConfig = rateLimitConfig;
    this.adapterContextBuilder = adapterContextBuilder;
  }

  /** Update the rate limit config (called on hot-reload). */
  setRateLimitConfig(config: RateLimitConfig): void {
    this.rateLimitConfig = config;
  }

  /** Update the adapter context builder (called after construction). */
  setAdapterContextBuilder(builder: (subject: string) => AdapterContext | undefined): void {
    this.adapterContextBuilder = builder;
  }

  /**
   * Register the callback used to notify a reply inbox when the authoritative
   * budget gate rejects a message. Wired by RelayCore with the same notifier
   * instance that {@link AdapterDelivery} uses, so a budget rejection settles a
   * waiting caller (`relay_send_and_wait`, the A2A executor) exactly like a
   * failed detached delivery does.
   *
   * @param notifier - The reply-failure notifier.
   */
  setReplyFailureNotifier(notifier: ReplyFailureNotifier): void {
    this.replyFailureNotifier = notifier;
  }

  /**
   * Register the authoritative agent→human initiate-consent gate (DOR-277).
   *
   * Wired by the host after construction (the binding store the gate reads is
   * not available at RelayCore construction time). Once set, every publish
   * whose `from` is an agent-initiated principal targeting a bound human
   * channel is denied unless the resolved binding is enabled and its
   * `canInitiate` consent is on — closing the side door where `relay_send` to a
   * raw `relay.human.*` subject bypassed the two proactive-notify tool handlers.
   *
   * Until this is called, sends to bound human channels are denied rather than
   * waved through ({@link evaluateInitiateConsent}), so forgetting to wire it —
   * or failing to reach the wiring — cannot open the channel.
   *
   * @param gate - The consent gate predicate.
   */
  setInitiateConsentGate(gate: InitiateConsentGate): void {
    this.initiateConsentGate = gate;
  }

  /**
   * Execute the publish pipeline for a message.
   *
   * Pipeline:
   * 1. Validate subject
   * 2. Check access control (from -> subject)
   * 3. Rate limit check (per-sender sliding window, before fan-out)
   * 4. Build envelope with ULID ID, budget, and payload
   * 4b. Authoritative initiate-consent gate — an agent-initiated send to a
   *    bound human channel without `canInitiate` consent is dead-lettered and
   *    NO delivery path runs (DOR-277)
   * 5. Authoritative budget gate (hops, cycle, TTL, call budget) — a rejected
   *    message is dead-lettered and NO delivery path runs (DOR-260)
   * 6. For each matching endpoint: per-copy budget update, deliver via
   *    Maildir, index in SQLite
   * 7. Deliver to matching adapter with the gate-decremented budget
   * 8. Dead-letter when no delivery targets matched
   *
   * @param subject - The target subject for the message
   * @param payload - The message payload (any JSON-serializable value)
   * @param options - Publish options including sender, replyTo, and budget overrides
   * @returns A PublishResult with the message ID and delivery count
   * @throws If the subject is invalid or access is denied
   */
  async publish(
    subject: string,
    payload: unknown,
    options: PublishOptions
  ): Promise<PublishResult> {
    // 1. Validate subject
    const validation = validateSubject(subject);
    if (!validation.valid) {
      throw new Error(`Invalid subject: ${validation.reason.message}`);
    }

    // 2. Access control check
    const accessResult = this.deps.accessControl.checkAccess(options.from, subject);
    if (!accessResult.allowed) {
      throw new Error(
        `Access denied: ${options.from} -> ${subject}` +
          (accessResult.matchedRule
            ? ` (rule: ${accessResult.matchedRule.from} -> ${accessResult.matchedRule.to})`
            : accessResult.reason
              ? ` — ${accessResult.reason}`
              : '')
      );
    }

    // The id is minted before the rate-limit check so a rate-limited publish
    // can be traced like every other non-delivery. It used to return an empty
    // messageId and record nothing at all, which is how a whole class of
    // refusal stayed invisible to every surface that reads traces.
    const messageId = generateUlid();
    const createdAt = new Date().toISOString();

    // 3. Rate limit check (per-sender, before fan-out)
    if (this.rateLimitConfig.enabled) {
      const windowStartIso = new Date(
        Date.now() - this.rateLimitConfig.windowSecs * 1000
      ).toISOString();
      const countInWindow = this.deps.sqliteIndex.countSenderInWindow(options.from, windowStartIso);
      const rateLimitResult = checkRateLimit(options.from, countInWindow, this.rateLimitConfig);
      if (!rateLimitResult.allowed) {
        const reason =
          `rate limit: ${rateLimitResult.currentCount}/${rateLimitResult.limit} ` +
          `messages from ${options.from} in ${this.rateLimitConfig.windowSecs}s`;
        this.deps.logger?.warn?.(`publish rate-limited: ${reason}, subject=${subject}`);
        const rejected: PublishResult['rejected'] = [{ endpointHash: '*', reason: 'rate_limited' }];
        this.recordTrace({
          messageId,
          subject,
          deliveredTo: 0,
          rejected,
          adapterResult: null,
          createdAt,
          error: reason,
          rejectionCode: 'rate_limited',
          ...(options.dispatchId !== undefined ? { dispatchId: options.dispatchId } : {}),
        });
        return { messageId, deliveredTo: 0, rejected };
      }
    }

    // 4. Build envelope
    const budget = createDefaultBudget({
      maxHops: this.opts.maxHops,
      ttl: Date.now() + this.opts.defaultTtlMs,
      callBudgetRemaining: this.opts.defaultCallBudget,
      ...options.budget,
    });
    const envelope: RelayEnvelope = {
      id: messageId,
      subject,
      from: options.from,
      replyTo: options.replyTo,
      budget,
      createdAt,
      payload,
      // Stamped only when the caller supplied one — an unset field keeps the
      // envelope byte-identical to what every pre-existing producer writes.
      ...(options.dispatchId !== undefined ? { dispatchId: options.dispatchId } : {}),
    };

    // Index for rate-limit counting (before fan-out so every published
    // message is tracked regardless of delivery path)
    this.deps.sqliteIndex.insertMessage({
      id: messageId,
      subject,
      endpointHash: '*', // placeholder — not a Maildir endpoint
      status: 'delivered',
      createdAt: envelope.createdAt,
      expiresAt: envelope.budget.ttl ? new Date(envelope.budget.ttl).toISOString() : null,
      sender: options.from,
    });

    // 5-11. Budget gate, deliver, dead-letter, and trace
    return this.deliverAndFinalize(envelope, subject, options, messageId);
  }

  /**
   * Deliver the envelope to all targets and finalize the publish result.
   *
   * Separated from the main publish() to keep individual method complexity
   * manageable while maintaining the complete pipeline logic.
   */
  private async deliverAndFinalize(
    envelope: RelayEnvelope,
    subject: string,
    options: PublishOptions,
    messageId: string
  ): Promise<PublishResult> {
    // 4b. Authoritative agent→human initiate-consent gate (DOR-277). Runs
    //     BEFORE the budget gate and any delivery path, as a sibling
    //     authoritative check: an agent-initiated send to a bound human channel
    //     whose `canInitiate` consent is off (or that has no enabled binding) is
    //     denied here, no matter which publish path it took (relay_send*, A2A,
    //     etc.). Reply-forwarding and system principals are not agent-initiated
    //     and the gate returns allowed for them (see the host-side gate).
    const consent = this.evaluateInitiateConsent(envelope.from, subject);
    if (!consent.allowed) {
      return this.rejectAtGate(
        envelope,
        subject,
        messageId,
        'initiate_denied',
        consent.reason ?? consent.code ?? 'agent is not allowed to start conversations here'
      );
    }

    // 5. Authoritative budget gate — ONE check, against the target subject,
    //    BEFORE any delivery path runs. The per-endpoint Maildir check alone
    //    was insufficient: the adapter fan-out dispatches the real (paid)
    //    agent turn and previously ran unconditionally, so a budget-exhausted
    //    message was dead-lettered on the mailbox side while the live turn
    //    still executed (DOR-260). A rejection here guarantees nothing
    //    downstream runs — no Maildir copy, no adapter dispatch, no
    //    subscriber fan-out.
    const gate = enforceBudget(envelope, subject);
    if (!gate.allowed) {
      return this.rejectAtGate(
        envelope,
        subject,
        messageId,
        'budget_exceeded',
        gate.reason ?? 'budget enforcement failed',
        gate.code
      );
    }

    const matchingEndpoints = findMatchingEndpoints(this.deps.endpointRegistry, subject);

    // 6. Deliver to Maildir endpoints (per-copy budget update inside)
    let deliveredTo = 0;
    const rejected: PublishResult['rejected'] = [];
    const mailboxPressure: Record<string, number> = {};

    for (const endpoint of matchingEndpoints) {
      const result = await this.deps.deliveryPipeline.deliverToEndpoint(endpoint, envelope);
      if (result.delivered) {
        deliveredTo++;
        // A delivery counts as activity — an inbox still receiving replies must
        // not be reaped by the inactivity-based TTL sweeper (M3).
        this.deps.endpointRegistry.touch(endpoint.subject);
      }
      if (result.rejected) rejected.push(result.rejected);
      if (result.pressure !== undefined) mailboxPressure[endpoint.hash] = result.pressure;
    }

    // 7. Deliver to the matching adapter with the gate-decremented budget:
    //    the adapter copy is what triggers the real (paid) agent turn, so it
    //    must consume one call-budget unit, count one hop, and extend the
    //    ancestor chain exactly like a Maildir copy does. Each delivered copy
    //    is decremented exactly once — the Maildir path decrements its own
    //    copies from the original envelope above.
    let adapterResult: DeliveryResult | null = null;
    if (this.deps.adapterRegistry) {
      const adapterEnvelope: RelayEnvelope = { ...envelope, budget: gate.updatedBudget! };
      adapterResult = await this.deps.adapterDelivery.deliver(
        subject,
        adapterEnvelope,
        this.adapterContextBuilder
      );
      // An adapter that deliberately sent nothing did not deliver anything.
      // The Telegram/Slack echo guard returns success for a message the adapter
      // recognises as its own, which counted as a delivery — so an inbound chat
      // message with no binding behind it still reported `deliveredTo: 1` and
      // traced as `delivered`.
      if (adapterResult?.success && !adapterResult.skipped) deliveredTo++;
    }

    // 8. Dispatch to subscription handlers when no Maildir endpoints exist.
    //    `matched` is how many handlers were invoked; `handled` is how many
    //    took the message. Only the second is a delivery — but the first is
    //    what decides buffering and dead-lettering, so a refused message is
    //    not re-delivered to a late subscriber and does not manufacture a dead
    //    letter for every message in an unbound chat.
    let matchedSubscribers = 0;
    let handledSubscribers = 0;
    let refusal: string | undefined;
    if (matchingEndpoints.length === 0) {
      const dispatch = await this.dispatchToSubscribers(envelope, subject);
      matchedSubscribers = dispatch.matched;
      handledSubscribers = dispatch.handled;
      refusal = dispatch.refusal;
      deliveredTo += handledSubscribers;
    }

    // 9. Buffer for late subscribers when no handlers matched
    if (matchedSubscribers === 0 && matchingEndpoints.length === 0) {
      this.deps.subscriptionRegistry.bufferForPendingSubscriber(subject, envelope);
    }

    // 10. Dead-letter only when NO delivery targets matched at all
    if (
      deliveredTo === 0 &&
      matchingEndpoints.length === 0 &&
      matchedSubscribers === 0 &&
      !adapterResult?.skipped
    ) {
      await this.deadLetter(subject, envelope, adapterResult);
    }

    // 11. Record trace span
    this.recordTrace({
      messageId,
      subject,
      deliveredTo,
      rejected,
      adapterResult,
      createdAt: envelope.createdAt,
      ...(deliveredTo === 0 && refusal ? { error: refusal } : {}),
      ...(envelope.dispatchId !== undefined ? { dispatchId: envelope.dispatchId } : {}),
    });

    return {
      messageId,
      deliveredTo,
      ...(rejected.length > 0 && { rejected }),
      ...(Object.keys(mailboxPressure).length > 0 && { mailboxPressure }),
      ...(adapterResult && { adapterResult }),
    };
  }

  /**
   * Resolve the initiate-consent decision for one publish.
   *
   * Three outcomes, and the third is the one this method exists for:
   *
   * - **A gate is installed** — it decides. A gate that throws denies (a policy
   *   that cannot answer must not be read as a yes).
   * - **No gate, and the subject needs none** — allowed. Agent-to-agent
   *   traffic, system subjects and the operator's own console never depended on
   *   binding consent.
   * - **No gate, and the subject is a bound human channel** — DENIED. The gate
   *   is installed by the host only once the binding store it reads exists, and
   *   the binding subsystem can fail to come up (a chokidar `EMFILE` on a busy
   *   machine is a documented way for that to happen here). Treating "nobody
   *   installed a gate" as "everybody consents" meant a broken boot turned every
   *   private consent switch off — the machine sent messages to a person's
   *   Telegram or Slack precisely when it had lost the record of whether it was
   *   allowed to. Not knowing is a denial.
   *
   * @param from - The publish principal.
   * @param subject - The target subject.
   */
  private evaluateInitiateConsent(from: string, subject: string): InitiateConsentDecision {
    if (!this.initiateConsentGate) {
      if (!requiresInitiateConsent(subject)) return { allowed: true };
      return {
        allowed: false,
        code: 'NO_BINDING',
        reason:
          'initiate denied: no consent gate is installed, so this relay cannot tell ' +
          'whether you allowed an agent to message this channel. Chat integrations ' +
          'stay silent until the binding subsystem starts.',
      };
    }

    try {
      return this.initiateConsentGate(from, subject);
    } catch (err) {
      // Fail closed: a throwing consent policy denies rather than letting the
      // message slip through undecided. Dead-letter under the target subject.
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger?.warn?.(`initiate-consent gate threw; denying: ${message}`);
      return { allowed: false, reason: `consent gate error: ${message}` };
    }
  }

  /**
   * Dispatch to matching subscription handlers (direct fast-path).
   *
   * Only fires when there are NO matching Maildir endpoints, enabling
   * BindingRouter and other subscribers to intercept messages published
   * to subjects with no registered endpoint.
   */
  private async dispatchToSubscribers(
    envelope: RelayEnvelope,
    subject: string
  ): Promise<{ matched: number; handled: number; refusal?: string }> {
    let handled = 0;
    let refusal: string | undefined;
    const subscribers = this.deps.subscriptionRegistry.getSubscribers(subject);
    for (const handler of subscribers) {
      try {
        const verdict = await handler(envelope);
        // A handler that says it did nothing is not a delivery. The first
        // reason given is kept for the trace — it is what a person would be
        // shown if they asked why nothing happened.
        if (verdict && verdict.handled === false) {
          refusal ??= verdict.reason;
          continue;
        }
        handled++;
      } catch {
        // Subscription handler errors are non-fatal for publish()
      }
    }
    return { matched: subscribers.length, handled, ...(refusal ? { refusal } : {}) };
  }

  /**
   * Reject a message at an authoritative pre-delivery gate (budget or consent).
   *
   * Dead-letters the envelope under the target subject (the same convention
   * detached adapter failures use), settles any caller waiting on a reply
   * inbox, and records a failed trace span. Nothing is delivered: no Maildir
   * copy, no adapter dispatch (i.e. no live agent turn), no subscriber
   * fan-out.
   *
   * @param envelope - The envelope being rejected.
   * @param subject - The target subject.
   * @param messageId - The envelope's message id.
   * @param rejectionCode - Machine reason surfaced in the {@link PublishResult}.
   * @param reason - Human-readable reason recorded on the dead letter.
   */
  private async rejectAtGate(
    envelope: RelayEnvelope,
    subject: string,
    messageId: string,
    rejectionCode: NonNullable<PublishResult['rejected']>[number]['reason'],
    reason: string,
    budgetCode?: BudgetRejectionCode
  ): Promise<PublishResult> {
    this.deps.logger?.warn?.(
      `publish rejected at ${rejectionCode} gate: subject=${subject}, ` +
        `from=${envelope.from}, reason=${reason}`
    );

    await this.deps.maildirStore.ensureMaildir(subject);
    await this.deps.deadLetterQueue.reject(subject, envelope, reason);

    // Settle a waiting caller (relay_send_and_wait, the A2A executor) now
    // instead of leaving it to block until its own timeout.
    if (envelope.replyTo && this.replyFailureNotifier) {
      try {
        await this.replyFailureNotifier(envelope.replyTo, reason, envelope);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.logger?.warn?.(`failed to notify reply inbox of gate rejection: ${message}`);
      }
    }

    const rejected: PublishResult['rejected'] = [{ endpointHash: subject, reason: rejectionCode }];
    this.recordTrace({
      messageId,
      subject,
      deliveredTo: 0,
      rejected,
      adapterResult: null,
      createdAt: envelope.createdAt,
      error: reason,
      rejectionCode,
      ...(budgetCode ? { budgetCode } : {}),
      ...(envelope.dispatchId !== undefined ? { dispatchId: envelope.dispatchId } : {}),
    });
    return { messageId, deliveredTo: 0, rejected };
  }

  /** Dead-letter a message that had no delivery targets. */
  private async deadLetter(
    subject: string,
    envelope: RelayEnvelope,
    adapterResult: DeliveryResult | null
  ): Promise<void> {
    await this.deps.maildirStore.ensureMaildir(subject);

    const reason = adapterResult?.error
      ? `adapter delivery failed: ${adapterResult.error}`
      : 'no matching endpoints or adapters';
    await this.deps.deadLetterQueue.reject(subject, envelope, reason);
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
  private recordTrace(span: {
    messageId: string;
    subject: string;
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
  }): void {
    if (!this.deps.traceStore) return;
    const { messageId, subject, deliveredTo, rejected, adapterResult, createdAt } = span;
    const failureReason = span.error ?? adapterResult?.error ?? undefined;
    const status =
      deliveredTo > 0
        ? 'delivered'
        : failureReason || (rejected?.length ?? 0) > 0
          ? 'failed'
          : 'no_subscriber';
    try {
      this.deps.traceStore.insertSpan({
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
}
