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
  PrivateNotificationOptions,
  PrivateNotificationResult,
} from './types.js';
import { describeError } from './lib/describe-error.js';

/** A pending ownership claim held across configuration persistence and startup. */
export interface AdapterOwnershipReservation {
  /** Start and install the matching adapter while retaining this claim. */
  register(adapter: RelayAdapter): Promise<void>;
  /** Release this claim; calling again cannot release another operation's claim. */
  release(): void;
}

/** Match a route at whole dot-token boundaries; a trailing dot means descendants only. */
function matchesPrefix(subject: string, prefix: string): boolean {
  return prefix.endsWith('.')
    ? subject.startsWith(prefix)
    : subject === prefix || subject.startsWith(`${prefix}.`);
}

/**
 * Whether two claims have ambiguous ownership rather than intentional specialization.
 * @param first - An adapter routing prefix.
 * @param second - Another adapter routing prefix.
 */
export function adapterPrefixesConflict(first: string, second: string): boolean {
  const a = first.endsWith('.') ? first.slice(0, -1) : first;
  const b = second.endsWith('.') ? second.slice(0, -1) : second;
  if (a === b) return true;
  const overlaps = matchesPrefix(a, b) || matchesPrefix(b, a);
  const webhook = (p: string) => p === 'relay.webhook' || p.startsWith('relay.webhook.');
  return overlaps && (webhook(a) || webhook(b));
}

function prefixesOf(prefix: string | readonly string[]): readonly string[] {
  return typeof prefix === 'string' ? [prefix] : prefix;
}

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
  private readonly stopping = new WeakMap<RelayAdapter, Promise<void>>();
  private readonly pending = new Map<string, { prefixes: readonly string[]; token: symbol }>();
  private logger: Logger = console;

  /** Inject a structured logger to replace default console output. */
  setLogger(logger: Logger): void {
    this.logger = logger;
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
   * Reserve routing ownership before any persistence or asynchronous startup.
   * @param id - The owner, excluding only its current active claims on replacement.
   * @param subjectPrefix - Prospective routing prefixes.
   * @returns An operation-bound claim; the caller must release it in a finally block.
   */
  reserveOwnership(
    id: string,
    subjectPrefix: string | readonly string[]
  ): AdapterOwnershipReservation {
    if (this.pending.has(id)) throw new Error(`Routing ownership for '${id}' is already changing`);
    const prefixes = [...prefixesOf(subjectPrefix)];
    const owners = [
      ...[...this.adapters.values()]
        .filter((a) => a.id !== id)
        .map((a) => ({ id: a.id, prefixes: prefixesOf(a.subjectPrefix) })),
      ...[...this.pending].map(([owner, claim]) => ({ id: owner, prefixes: claim.prefixes })),
    ];
    for (const owner of owners) {
      if (prefixes.some((p) => owner.prefixes.some((other) => adapterPrefixesConflict(p, other)))) {
        throw new Error(
          `Routing ownership conflicts with '${owner.id}'; choose a different address`
        );
      }
    }
    const token = Symbol(id);
    this.pending.set(id, { prefixes, token });
    let used = false;
    return {
      release: () => {
        if (this.pending.get(id)?.token === token) this.pending.delete(id);
      },
      register: async (adapter) => {
        if (
          used ||
          this.pending.get(id)?.token !== token ||
          adapter.id !== id ||
          JSON.stringify(prefixesOf(adapter.subjectPrefix)) !== JSON.stringify(prefixes)
        ) {
          throw new Error('Routing ownership reservation does not match this registration');
        }
        used = true;
        await this.registerReserved(adapter, () => this.pending.get(id)?.token === token);
      },
    };
  }

  /**
   * Register and start an adapter.
   *
   * Registering the identical active instance is a no-op. A different instance
   * with the same ID performs a hot-reload:
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
    const claim = this.reserveOwnership(adapter.id, adapter.subjectPrefix);
    try {
      await claim.register(adapter);
    } finally {
      claim.release();
    }
  }

  private async registerReserved(adapter: RelayAdapter, ownsClaim: () => boolean): Promise<void> {
    if (!this.relay) {
      throw new Error(
        'AdapterRegistry: relay not set — call setRelay() before registering adapters'
      );
    }

    const existing = this.adapters.get(adapter.id);
    // Re-registering the active object is not a replacement. Starting/stopping
    // it again would disconnect the very instance retained as the route owner.
    if (existing === adapter) return;

    // Start the new adapter first — if this throws, abort (old adapter stays active)
    this.logger.info(`AdapterRegistry: starting adapter '${adapter.id}'`);
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        adapter.start(this.relay),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `Adapter '${adapter.id}' start timed out after ${ADAPTER_START_TIMEOUT_MS / 1000}s`
              )
            );
          }, ADAPTER_START_TIMEOUT_MS);
        }),
      ]);
      if (!ownsClaim())
        throw new Error('Routing ownership reservation was released during startup');
    } catch (err) {
      // A failed start may already have acquired resources. Never stop the old owner.
      void Promise.resolve()
        .then(() => adapter.stop())
        .catch((stopErr) => {
          this.logger.warn(
            `AdapterRegistry: failed to stop unsuccessful adapter '${adapter.id}':`,
            describeError(stopErr)
          );
        });
      throw err;
    } finally {
      clearTimeout(timer!);
    }
    this.logger.info(`AdapterRegistry: adapter '${adapter.id}' started`);

    // Swap in the new adapter
    this.adapters.set(adapter.id, adapter);

    // Stop the old adapter (non-blocking, errors are isolated)
    if (existing) {
      try {
        await this.stopInstance(existing);
      } catch (err) {
        // Log but don't throw — new adapter is already active
        this.logger.warn(
          `AdapterRegistry: failed to stop old adapter '${adapter.id}':`,
          describeError(err)
        );
      }
    }
  }

  /** Share teardown only while this same instance is already stopping. */
  private stopInstance(adapter: RelayAdapter): Promise<void> {
    const existing = this.stopping.get(adapter);
    if (existing) return existing;
    // Unregister can overlap hot replacement cleanup. Both must await the same
    // teardown; a second stop can race the first on the connection's resources.
    const stopping = Promise.resolve()
      .then(() => adapter.stop())
      .finally(() => {
        this.stopping.delete(adapter); // A failed stop remains retryable.
      });
    this.stopping.set(adapter, stopping);
    return stopping;
  }

  /**
   * Unregister and stop an adapter by ID.
   *
   * ## Stop first, then forget
   *
   * This used to delete the entry and then await `stop()`. When `stop()` threw
   * — a Telegram poller mid-`getUpdates`, a Slack socket refusing to close —
   * the adapter was already gone from the registry while its connection was
   * still live, and every call site swallowed the throw. The next
   * `register()` (an `updateConfig` restart, a hot reload) then saw an empty
   * slot and started a SECOND adapter on the same bot token: two pollers, two
   * copies of every inbound message, two agent turns, two bills.
   *
   * Now a failed stop keeps the entry and rethrows. That is a signal, not a
   * cure: {@link register} does NOT protect you here — it starts the new
   * adapter *first* and only then swaps, so calling it after a failed stop
   * still puts a second connection on the same credentials, and the old entry
   * is simply overwritten. What actually prevents the double poller is the
   * caller heeding this throw: `AdapterManager.updateConfig` rethrows without
   * building a replacement, and `removeAdapter`/`reload` record an
   * `adapter.error` event rather than swallowing it.
   *
   * The adapter's own status is left in the `error` state (see
   * `BaseRelayAdapter.stop`), so the app shows a connection that would not
   * let go instead of one that looks cleanly gone.
   *
   * @param id - The adapter ID to remove
   * @returns true if the adapter was found and stopped, false if not found
   * @throws Whatever `stop()` threw — the adapter is left registered.
   */
  async unregister(id: string): Promise<boolean> {
    const adapter = this.adapters.get(id);
    if (!adapter) return false;
    try {
      await this.stopInstance(adapter);
    } catch (err) {
      this.logger.warn(
        `AdapterRegistry: adapter '${id}' failed to stop and is still registered — ` +
          `it may still be connected:`,
        describeError(err)
      );
      throw err;
    }
    if (this.adapters.get(id) === adapter) this.adapters.delete(id);
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
        if (matchesPrefix(subject, p) && (!best || p.length > best.length)) {
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

  /** Deliver only to the exact still-registered adapter without a durable payload copy. */
  async deliverPrivateNotification(
    subject: string,
    text: string,
    options: PrivateNotificationOptions
  ): Promise<PrivateNotificationResult> {
    const adapter = this.getBySubject(subject);
    if (!adapter || adapter.id !== options.adapterId || !adapter.deliverPrivateNotification)
      return { state: 'refused' };
    return adapter.deliverPrivateNotification(
      subject,
      text,
      () =>
        this.getBySubject(subject) === adapter &&
        adapter.id === options.adapterId &&
        options.authorizeDispatch()
    );
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
    const results = await Promise.allSettled([...this.adapters.values()].map((a) => a.stop()));

    // Log individual failures but don't throw
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn('AdapterRegistry: adapter shutdown failed:', describeError(result.reason));
      }
    }

    this.adapters.clear();
  }
}
