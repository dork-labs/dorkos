/**
 * Registry for external channel adapters.
 *
 * Manages adapter lifecycle (register, unregister, hot-reload) and routes
 * outbound messages to the correct adapter by subject prefix matching.
 *
 * @module relay/adapter-registry
 */
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { Logger } from '@dorkos/shared/logger';
import type {
  RelayAdapter,
  RelayPublisher,
  AdapterRegistryLike,
  AdapterContext,
  DeliveryResult,
} from './types.js';
import { AdapterStreamManager } from './adapter-stream-manager.js';
import { detectStreamEventType } from './lib/payload-utils.js';

/**
 * Registry that manages the lifecycle of external channel adapters and routes
 * outbound messages to the correct adapter by subject prefix.
 *
 * Implements the {@link AdapterRegistryLike} interface so it can be passed
 * through {@link RelayOptions} without creating a circular dependency.
 */
/** Timeout for adapter.start() calls within register() (ms). */
const ADAPTER_START_TIMEOUT_MS = 30_000;

/**
 * Registry that manages the lifecycle of external channel adapters and routes
 * outbound messages to the correct adapter by subject prefix.
 */
export class AdapterRegistry implements AdapterRegistryLike {
  private readonly adapters = new Map<string, RelayAdapter>();
  private relay: RelayPublisher | null = null;
  private logger: Logger = console;
  private streamManager: AdapterStreamManager | null = null;

  /** Inject a structured logger to replace default console output. */
  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  /** Inject the stream manager for aggregated streaming delivery. */
  setStreamManager(streamManager: AdapterStreamManager): void {
    this.streamManager = streamManager;
  }

  /**
   * Set the RelayPublisher instance.
   *
   * Called once during RelayCore initialization before any adapters are registered.
   *
   * @param relay - The relay publisher to use for inbound message publishing
   */
  setRelay(relay: RelayPublisher): void {
    this.relay = relay;
  }

  /**
   * Register and start an adapter.
   *
   * If an adapter with the same ID already exists, performs a hot-reload:
   * 1. Start the new adapter first
   * 2. Swap it into the registry
   * 3. Stop the old adapter (drain in-flight messages)
   *
   * If the new adapter fails to start, the old adapter remains active.
   *
   * @param adapter - The adapter to register and start
   * @throws If relay has not been set via {@link setRelay}
   */
  async register(adapter: RelayAdapter): Promise<void> {
    if (!this.relay) {
      throw new Error(
        'AdapterRegistry: relay not set — call setRelay() before registering adapters'
      );
    }

    const existing = this.adapters.get(adapter.id);

    // Start the new adapter first — if this throws, abort (old adapter stays active)
    this.logger.info(`AdapterRegistry: starting adapter '${adapter.id}'`);
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        adapter.start(this.relay),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Adapter '${adapter.id}' start timed out after ${ADAPTER_START_TIMEOUT_MS / 1000}s`
                )
              ),
            ADAPTER_START_TIMEOUT_MS
          );
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
    this.logger.info(`AdapterRegistry: adapter '${adapter.id}' started`);

    // Swap in the new adapter
    this.adapters.set(adapter.id, adapter);

    // Stop the old adapter (non-blocking, errors are isolated)
    if (existing) {
      try {
        await existing.stop();
      } catch (err) {
        // Log but don't throw — new adapter is already active
        this.logger.warn(`AdapterRegistry: failed to stop old adapter '${adapter.id}':`, err);
      }
    }
  }

  /**
   * Unregister and stop an adapter by ID.
   *
   * @param id - The adapter ID to remove
   * @returns true if the adapter was found and stopped, false if not found
   */
  async unregister(id: string): Promise<boolean> {
    const adapter = this.adapters.get(id);
    if (!adapter) return false;
    this.adapters.delete(id);
    await adapter.stop();
    return true;
  }

  /**
   * Get an adapter by ID.
   *
   * @param id - The adapter ID to look up
   */
  get(id: string): RelayAdapter | undefined {
    return this.adapters.get(id);
  }

  /**
   * Find the adapter whose subjectPrefix best matches the given subject.
   *
   * Uses longest-matching-prefix-wins semantics so that specific prefixes
   * (e.g. `'relay.agent.claude-code.'`) always beat broader ones
   * (e.g. `'relay.agent.'`), independent of adapter registration order. This
   * keeps routing deterministic as new runtime adapters are registered.
   *
   * @param subject - The Relay subject to match against adapter prefixes
   */
  getBySubject(subject: string): RelayAdapter | undefined {
    let best: { adapter: RelayAdapter; length: number } | undefined;
    for (const adapter of this.adapters.values()) {
      const prefixes = Array.isArray(adapter.subjectPrefix)
        ? adapter.subjectPrefix
        : [adapter.subjectPrefix];
      for (const p of prefixes) {
        if (subject.startsWith(p) && (!best || p.length > best.length)) {
          best = { adapter, length: p.length };
        }
      }
    }
    return best?.adapter;
  }

  /**
   * List all registered adapters.
   */
  list(): RelayAdapter[] {
    return [...this.adapters.values()];
  }

  /**
   * Deliver a message to the matching adapter by subject prefix.
   *
   * Called by RelayCore publish pipeline after Maildir endpoint delivery.
   *
   * @param subject - The target subject
   * @param envelope - The relay envelope to deliver
   * @param context - Optional rich context passed through to the matched adapter
   * @returns The adapter's DeliveryResult if an adapter matched, null otherwise
   */
  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    context?: AdapterContext
  ): Promise<DeliveryResult | null> {
    const adapter = this.getBySubject(subject);
    if (!adapter) return null;

    // Check if this is a StreamEvent that the stream manager should handle
    if (this.streamManager) {
      const eventType = detectStreamEventType(envelope.payload);
      if (eventType) {
        // Extract thread ID from the subject — portion after adapter's subject prefix
        const prefix = Array.isArray(adapter.subjectPrefix)
          ? adapter.subjectPrefix.find((p) => subject.startsWith(p))
          : adapter.subjectPrefix;
        const threadId = prefix ? subject.slice(prefix.length + 1) : subject;

        const result = await this.streamManager.handleStreamEvent(
          adapter.id,
          threadId,
          eventType,
          envelope,
          adapter,
          subject,
          context
        );

        // If the stream manager handled it, return the result.
        // If it returned null (e.g., approval_required fallthrough), fall through to deliver().
        if (result !== null) return result;
      }
    }

    return adapter.deliver(subject, envelope, context);
  }

  /**
   * Stop all registered adapters gracefully.
   *
   * Uses Promise.allSettled so a single adapter failure does not prevent
   * the others from shutting down. Clears the registry after all adapters
   * have been given a chance to stop.
   */
  async shutdown(): Promise<void> {
    if (this.streamManager) {
      await this.streamManager.stop();
    }

    const results = await Promise.allSettled([...this.adapters.values()].map((a) => a.stop()));

    // Log individual failures but don't throw
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn('AdapterRegistry: adapter shutdown failed:', result.reason);
      }
    }

    this.adapters.clear();
  }
}
