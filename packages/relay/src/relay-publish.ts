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
import { createDefaultBudget } from './budget-enforcer.js';
import { hashSubject } from './endpoint-registry.js';
import { checkRateLimit } from './rate-limiter.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { EndpointRegistry } from './endpoint-registry.js';
import type { SubscriptionRegistry } from './subscription-registry.js';
import type { MaildirStore } from './maildir-store.js';
import type { SqliteIndex } from './sqlite-index.js';
import type { AccessControl } from './access-control.js';
import type { DeadLetterQueue } from './dead-letter-queue.js';
import type { DeliveryPipeline } from './delivery-pipeline.js';
import type { AdapterDelivery } from './adapter-delivery.js';
import type {
  RateLimitConfig,
  PublishOptions,
  EndpointInfo,
  AdapterRegistryLike,
  AdapterContext,
  DeliveryResult,
  TraceStoreLike,
  RelayLogger,
} from './types.js';

// === Types ===

/** Result of a publish operation. */
export interface PublishResult {
  /** The ULID message ID assigned to the published envelope. */
  messageId: string;

  /** Number of endpoints the message was delivered to. */
  deliveredTo: number;

  /** Endpoints that rejected the message, with structured reasons. */
  rejected?: Array<{
    endpointHash: string;
    reason: 'backpressure' | 'circuit_open' | 'rate_limited' | 'budget_exceeded';
  }>;

  /** Per-endpoint pressure ratios for proactive signaling (0.0-1.0). */
  mailboxPressure?: Record<string, number>;

  /** Result from adapter delivery, if attempted. */
  adapterResult?: DeliveryResult;
}

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
   * Execute the publish pipeline for a message.
   *
   * Pipeline:
   * 1. Validate subject
   * 2. Check access control (from -> subject)
   * 3. Rate limit check (per-sender sliding window, before fan-out)
   * 4. Build envelope with ULID ID, budget, and payload
   * 5. Find all registered endpoints matching the subject
   * 6. For each endpoint: enforce budget, deliver via Maildir, index in SQLite
   * 7. Deliver to matching adapter (unified fan-out)
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
            : '')
      );
    }

    // 3. Rate limit check (per-sender, before fan-out)
    if (this.rateLimitConfig.enabled) {
      const windowStartIso = new Date(
        Date.now() - this.rateLimitConfig.windowSecs * 1000
      ).toISOString();
      const countInWindow = this.deps.sqliteIndex.countSenderInWindow(options.from, windowStartIso);
      const rateLimitResult = checkRateLimit(options.from, countInWindow, this.rateLimitConfig);
      if (!rateLimitResult.allowed) {
        this.deps.logger?.warn?.(
          `publish rate-limited: sender=${options.from}, ` +
            `count=${rateLimitResult.currentCount}/${rateLimitResult.limit} ` +
            `in ${this.rateLimitConfig.windowSecs}s window, subject=${subject}`
        );
        return {
          messageId: '',
          deliveredTo: 0,
          rejected: [{ endpointHash: '*', reason: 'rate_limited' }],
        };
      }
    }

    // 4. Build envelope
    const messageId = generateUlid();
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
      createdAt: new Date().toISOString(),
      payload,
    };

    // 5. Index for rate-limit counting (before fan-out so every published
    //    message is tracked regardless of delivery path)
    this.deps.sqliteIndex.insertMessage({
      id: messageId,
      subject,
      endpointHash: '*', // placeholder — not a Maildir endpoint
      status: 'delivered',
      createdAt: envelope.createdAt,
      expiresAt: envelope.budget.ttl ? new Date(envelope.budget.ttl).toISOString() : null,
      sender: options.from,
    });

    // 6-10. Deliver, dead-letter, and trace
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
    const matchingEndpoints = findMatchingEndpoints(this.deps.endpointRegistry, subject);

    // 5. Deliver to Maildir endpoints
    let deliveredTo = 0;
    const rejected: PublishResult['rejected'] = [];
    const mailboxPressure: Record<string, number> = {};

    for (const endpoint of matchingEndpoints) {
      const result = await this.deps.deliveryPipeline.deliverToEndpoint(endpoint, envelope);
      if (result.delivered) deliveredTo++;
      if (result.rejected) rejected.push(result.rejected);
      if (result.pressure !== undefined) mailboxPressure[endpoint.hash] = result.pressure;
    }

    // 6. Deliver to matching adapter (unified fan-out — always attempted)
    let adapterResult: DeliveryResult | null = null;
    if (this.deps.adapterRegistry) {
      adapterResult = await this.deps.adapterDelivery.deliver(
        subject,
        envelope,
        this.adapterContextBuilder
      );
      if (adapterResult?.success) deliveredTo++;
    }

    // 7. Dispatch to subscription handlers when no Maildir endpoints exist
    let subscriberCount = 0;
    if (matchingEndpoints.length === 0) {
      subscriberCount = await this.dispatchToSubscribers(envelope, subject);
      deliveredTo += subscriberCount;
    }

    // 8. Buffer for late subscribers when no handlers matched
    if (subscriberCount === 0 && matchingEndpoints.length === 0) {
      this.deps.subscriptionRegistry.bufferForPendingSubscriber(subject, envelope);
    }

    // 9. Dead-letter only when NO delivery targets matched at all
    if (deliveredTo === 0 && matchingEndpoints.length === 0 && subscriberCount === 0) {
      await this.deadLetter(subject, envelope, adapterResult);
    }

    // 10. Record trace span
    this.recordTrace(messageId, subject, deliveredTo, rejected, adapterResult, envelope);

    return {
      messageId,
      deliveredTo,
      ...(rejected.length > 0 && { rejected }),
      ...(Object.keys(mailboxPressure).length > 0 && { mailboxPressure }),
      ...(adapterResult && { adapterResult }),
    };
  }

  /**
   * Dispatch to matching subscription handlers (direct fast-path).
   *
   * Only fires when there are NO matching Maildir endpoints, enabling
   * BindingRouter and other subscribers to intercept messages published
   * to subjects with no registered endpoint.
   */
  private async dispatchToSubscribers(envelope: RelayEnvelope, subject: string): Promise<number> {
    let count = 0;
    const subscribers = this.deps.subscriptionRegistry.getSubscribers(subject);
    for (const handler of subscribers) {
      try {
        await handler(envelope);
        count++;
      } catch {
        // Subscription handler errors are non-fatal for publish()
      }
    }
    return count;
  }

  /** Dead-letter a message that had no delivery targets. */
  private async deadLetter(
    subject: string,
    envelope: RelayEnvelope,
    adapterResult: DeliveryResult | null
  ): Promise<void> {
    const subjectHash = hashSubject(subject);
    await this.deps.maildirStore.ensureMaildir(subjectHash);

    const reason = adapterResult?.error
      ? `adapter delivery failed: ${adapterResult.error}`
      : 'no matching endpoints or adapters';
    await this.deps.deadLetterQueue.reject(subjectHash, envelope, reason);
  }

  /** Record a trace span for delivery tracking (best-effort). */
  private recordTrace(
    messageId: string,
    subject: string,
    deliveredTo: number,
    rejected: PublishResult['rejected'],
    adapterResult: DeliveryResult | null,
    envelope: RelayEnvelope
  ): void {
    if (!this.deps.traceStore) return;
    try {
      this.deps.traceStore.insertSpan({
        messageId,
        traceId: messageId,
        subject,
        status: deliveredTo > 0 ? 'delivered' : 'failed',
        metadata: {
          deliveredTo,
          rejectedCount: rejected?.length ?? 0,
          hasAdapterResult: !!adapterResult,
          durationMs: Date.now() - new Date(envelope.createdAt).getTime(),
        },
      });
    } catch {
      // Trace insertion is best-effort — never fail a publish for tracing
    }
  }
}
