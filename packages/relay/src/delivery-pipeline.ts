/**
 * Endpoint delivery pipeline for the Relay message bus.
 *
 * Handles per-endpoint delivery with backpressure checks, circuit breaker
 * gating, budget enforcement, Maildir writes, SQLite indexing, and
 * synchronous subscription handler dispatch.
 *
 * @module relay/delivery-pipeline
 */
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { enforceBudget } from './budget-enforcer.js';
import { checkBackpressure } from './backpressure.js';
import type { SubscriptionRegistry } from './subscription-registry.js';
import type { MaildirStore } from './maildir-store.js';
import type { SqliteIndex } from './sqlite-index.js';
import type { DeadLetterQueue } from './dead-letter-queue.js';
import type { SignalEmitter } from './signal-emitter.js';
import type { CircuitBreakerManager } from './circuit-breaker.js';
import type { BackpressureConfig, EndpointInfo } from './types.js';

/** Internal result from delivering to a single endpoint. */
export interface EndpointDeliveryResult {
  delivered: boolean;
  rejected?: {
    endpointHash: string;
    reason: 'backpressure' | 'circuit_open' | 'rate_limited' | 'budget_exceeded';
  };
  pressure?: number;
}

/** Dependencies injected into the DeliveryPipeline. */
export interface DeliveryPipelineDeps {
  sqliteIndex: SqliteIndex;
  maildirStore: MaildirStore;
  subscriptionRegistry: SubscriptionRegistry;
  circuitBreaker: CircuitBreakerManager;
  signalEmitter: SignalEmitter;
  deadLetterQueue: DeadLetterQueue;
}

/**
 * Delivers envelopes to individual Maildir endpoints with reliability checks.
 *
 * Pipeline order per endpoint:
 * 1. Backpressure check — rejects if mailbox is full, emits warning signal
 * 2. Circuit breaker check — rejects if breaker is OPEN for this endpoint
 * 3. Budget enforcement — rejects expired/over-hop/over-call messages to DLQ
 * 4. Maildir delivery — writes envelope file, records CB success/failure
 * 5. SQLite indexing + synchronous handler dispatch
 */
export class DeliveryPipeline {
  constructor(
    private readonly deps: DeliveryPipelineDeps,
    private backpressureConfig: BackpressureConfig,
  ) {}

  /** Update the backpressure config (called on hot-reload). */
  setBackpressureConfig(config: BackpressureConfig): void {
    this.backpressureConfig = config;
  }

  /**
   * Deliver an envelope to a single endpoint.
   *
   * @param endpoint - The target endpoint
   * @param envelope - The envelope to deliver
   * @returns Delivery status, rejection info, and pressure ratio
   */
  async deliverToEndpoint(
    endpoint: EndpointInfo,
    envelope: RelayEnvelope,
  ): Promise<EndpointDeliveryResult> {
    // 1. Backpressure check
    const newCount = this.deps.sqliteIndex.countNewByEndpoint(endpoint.hash);
    const bpResult = checkBackpressure(newCount, this.backpressureConfig);

    if (bpResult.pressure >= this.backpressureConfig.pressureWarningAt) {
      this.deps.signalEmitter.emit(endpoint.subject, {
        type: 'backpressure',
        state: bpResult.allowed ? 'warning' : 'critical',
        endpointSubject: endpoint.subject,
        timestamp: new Date().toISOString(),
        data: { pressure: bpResult.pressure, currentSize: bpResult.currentSize },
      });
    }

    if (!bpResult.allowed) {
      return {
        delivered: false,
        rejected: { endpointHash: endpoint.hash, reason: 'backpressure' },
        pressure: bpResult.pressure,
      };
    }

    // 2. Circuit breaker check
    const cbResult = this.deps.circuitBreaker.check(endpoint.hash);
    if (!cbResult.allowed) {
      return {
        delivered: false,
        rejected: { endpointHash: endpoint.hash, reason: 'circuit_open' },
        pressure: bpResult.pressure,
      };
    }

    // 3. Budget enforcement
    const budgetResult = enforceBudget(envelope, endpoint.subject);
    if (!budgetResult.allowed) {
      await this.deps.deadLetterQueue.reject(
        endpoint.hash,
        envelope,
        budgetResult.reason ?? 'budget enforcement failed',
      );
      return {
        delivered: false,
        rejected: { endpointHash: endpoint.hash, reason: 'budget_exceeded' },
        pressure: bpResult.pressure,
      };
    }

    // Build the envelope with updated budget for this specific delivery
    const deliveryEnvelope: RelayEnvelope = {
      ...envelope,
      budget: budgetResult.updatedBudget!,
    };

    // 4. Deliver to Maildir
    const deliverResult = await this.deps.maildirStore.deliver(endpoint.hash, deliveryEnvelope);
    if (!deliverResult.ok) {
      this.deps.circuitBreaker.recordFailure(endpoint.hash);
      await this.deps.deadLetterQueue.reject(
        endpoint.hash,
        envelope,
        `delivery failed: ${deliverResult.error}`,
      );
      return { delivered: false, pressure: bpResult.pressure };
    }

    // Record successful delivery for circuit breaker
    this.deps.circuitBreaker.recordSuccess(endpoint.hash);

    // Index in SQLite
    this.deps.sqliteIndex.insertMessage({
      id: deliverResult.messageId,
      subject: deliveryEnvelope.subject,
      endpointHash: endpoint.hash,
      status: 'pending',
      createdAt: deliveryEnvelope.createdAt,
      expiresAt: deliveryEnvelope.budget.ttl
        ? new Date(deliveryEnvelope.budget.ttl).toISOString()
        : null,
    });

    // Synchronous fast-path: dispatch to matching subscription handlers
    await this.dispatchToSubscribers(endpoint, deliverResult.messageId, deliveryEnvelope);

    return { delivered: true, pressure: bpResult.pressure };
  }

  /**
   * Dispatch a delivered envelope to all matching subscription handlers.
   *
   * Claims the message from `new/` to `cur/`, invokes all handlers,
   * then completes (removes from `cur/`) on success or moves to `failed/`
   * on error.
   *
   * @param endpoint - The endpoint that received the message
   * @param messageId - The Maildir-assigned message ID (ULID filename)
   * @param envelope - The delivered envelope
   */
  async dispatchToSubscribers(
    endpoint: EndpointInfo,
    messageId: string,
    envelope: RelayEnvelope,
  ): Promise<void> {
    const handlers = this.deps.subscriptionRegistry.getSubscribers(endpoint.subject);
    if (handlers.length === 0) return;

    // Claim the message (move from new/ to cur/)
    const claimResult = await this.deps.maildirStore.claim(endpoint.hash, messageId);
    if (!claimResult.ok) return;

    try {
      await Promise.all(handlers.map((handler) => handler(claimResult.envelope)));

      // All handlers succeeded — complete the message
      await this.deps.maildirStore.complete(endpoint.hash, messageId);
      this.deps.sqliteIndex.updateStatus(messageId, 'delivered');
    } catch (err) {
      // Handler failed — move to failed/ and record for circuit breaker
      const reason = err instanceof Error ? err.message : String(err);
      await this.deps.maildirStore.fail(endpoint.hash, messageId, reason);
      this.deps.sqliteIndex.updateStatus(messageId, 'failed');
      this.deps.circuitBreaker.recordFailure(endpoint.hash);
    }
  }
}
