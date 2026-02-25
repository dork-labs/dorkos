/**
 * Registry for external channel adapters.
 *
 * Manages adapter lifecycle (register, unregister, hot-reload) and routes
 * outbound messages to the correct adapter by subject prefix matching.
 *
 * @module relay/adapter-registry
 */
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { RelayAdapter, RelayPublisher, AdapterRegistryLike } from './types.js';

/**
 * Registry that manages the lifecycle of external channel adapters and routes
 * outbound messages to the correct adapter by subject prefix.
 *
 * Implements the {@link AdapterRegistryLike} interface so it can be passed
 * through {@link RelayOptions} without creating a circular dependency.
 */
export class AdapterRegistry implements AdapterRegistryLike {
  private readonly adapters = new Map<string, RelayAdapter>();
  private relay: RelayPublisher | null = null;

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
      throw new Error('AdapterRegistry: relay not set — call setRelay() before registering adapters');
    }

    const existing = this.adapters.get(adapter.id);

    // Start the new adapter first — if this throws, abort (old adapter stays active)
    await adapter.start(this.relay);

    // Swap in the new adapter
    this.adapters.set(adapter.id, adapter);

    // Stop the old adapter (non-blocking, errors are isolated)
    if (existing) {
      try {
        await existing.stop();
      } catch (err) {
        // Log but don't throw — new adapter is already active
        console.warn(`AdapterRegistry: failed to stop old adapter '${adapter.id}':`, err);
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
   * Find the adapter whose subjectPrefix is a prefix of the given subject.
   *
   * @param subject - The Relay subject to match against adapter prefixes
   */
  getBySubject(subject: string): RelayAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (subject.startsWith(adapter.subjectPrefix)) {
        return adapter;
      }
    }
    return undefined;
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
   * @returns true if an adapter matched and delivery was attempted, false otherwise
   */
  async deliver(subject: string, envelope: RelayEnvelope): Promise<boolean> {
    const adapter = this.getBySubject(subject);
    if (!adapter) return false;
    await adapter.deliver(subject, envelope);
    return true;
  }

  /**
   * Stop all registered adapters gracefully.
   *
   * Uses Promise.allSettled so a single adapter failure does not prevent
   * the others from shutting down. Clears the registry after all adapters
   * have been given a chance to stop.
   */
  async shutdown(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.adapters.values()].map((a) => a.stop()),
    );

    // Log individual failures but don't throw
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('AdapterRegistry: adapter shutdown failed:', result.reason);
      }
    }

    this.adapters.clear();
  }
}
