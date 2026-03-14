/**
 * Optional abstract base class for relay adapter authors.
 *
 * @module relay/base-adapter
 */
import type {
  RelayAdapter,
  RelayPublisher,
  AdapterStatus,
  AdapterContext,
  DeliveryResult,
} from './types.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

/**
 * Optional abstract base class for relay adapters.
 *
 * Handles boilerplate that every adapter needs: status tracking state machine,
 * start/stop idempotency guards, error recording, and relay ref lifecycle.
 *
 * Subclasses implement `_start()`, `_stop()`, and `deliver()`.
 * Direct `RelayAdapter` implementation remains fully supported.
 *
 * @example
 * ```typescript
 * class MyAdapter extends BaseRelayAdapter {
 *   constructor(id: string, config: MyConfig) {
 *     super(id, 'relay.custom.mine', 'My Adapter');
 *   }
 *
 *   protected async _start(relay: RelayPublisher): Promise<void> {
 *     // Connect to external service
 *   }
 *
 *   protected async _stop(): Promise<void> {
 *     // Disconnect and drain in-flight messages
 *   }
 *
 *   async deliver(subject: string, envelope: RelayEnvelope, context?: AdapterContext): Promise<DeliveryResult> {
 *     // Deliver message to external channel
 *     return { success: true };
 *   }
 * }
 * ```
 */
export abstract class BaseRelayAdapter implements RelayAdapter {
  readonly id: string;
  readonly subjectPrefix: string | readonly string[];
  readonly displayName: string;

  /** Reference to the relay publisher, set on start, cleared on stop. */
  protected relay: RelayPublisher | null = null;

  private _status: AdapterStatus = {
    state: 'disconnected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  };

  constructor(
    id: string,
    subjectPrefix: string | readonly string[],
    displayName: string,
  ) {
    this.id = id;
    this.subjectPrefix = subjectPrefix;
    this.displayName = displayName;
  }

  /**
   * Start the adapter with idempotency guard and status tracking.
   *
   * Subclasses implement `_start()` for the actual connection logic.
   *
   * @param relay - The RelayPublisher to publish inbound messages to
   */
  async start(relay: RelayPublisher): Promise<void> {
    if (this._status.state === 'connected') return; // idempotent
    this._status = { ...this._status, state: 'starting' };
    this.relay = relay;
    try {
      await this._start(relay);
      this._status = {
        ...this._status,
        state: 'connected',
        startedAt: new Date().toISOString(),
      };
    } catch (err) {
      this.recordError(err);
      this.relay = null;
      throw err; // re-throw — host (AdapterRegistry) handles isolation
    }
  }

  /**
   * Stop the adapter with idempotency guard and status tracking.
   *
   * Subclasses implement `_stop()` for the actual disconnection logic.
   */
  async stop(): Promise<void> {
    if (this._status.state === 'disconnected') return; // idempotent
    this._status = { ...this._status, state: 'stopping' };
    try {
      await this._stop();
    } finally {
      this.relay = null;
      this._status = {
        state: 'disconnected',
        messageCount: this._status.messageCount,
        errorCount: this._status.errorCount,
      };
    }
  }

  /**
   * Return a snapshot of the current adapter status.
   *
   * Returns a shallow copy to prevent external mutation of internal state.
   */
  getStatus(): AdapterStatus {
    return { ...this._status };
  }

  /**
   * Track a successful delivery — increments outbound message count.
   *
   * Call this from `deliver()` after successful delivery.
   */
  protected trackOutbound(): void {
    this._status = {
      ...this._status,
      messageCount: {
        ...this._status.messageCount,
        outbound: this._status.messageCount.outbound + 1,
      },
    };
  }

  /**
   * Track an inbound message — increments inbound message count.
   *
   * Call this when receiving a message from an external channel.
   */
  protected trackInbound(): void {
    this._status = {
      ...this._status,
      messageCount: {
        ...this._status.messageCount,
        inbound: this._status.messageCount.inbound + 1,
      },
    };
  }

  /**
   * Record an error — updates status to 'error' state with error details.
   *
   * Call this from `deliver()` or `_start()` when an error occurs.
   * Does NOT catch or swallow the error — that's the host's job.
   *
   * @param err - The error to record
   */
  protected recordError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this._status = {
      ...this._status,
      state: 'error',
      errorCount: this._status.errorCount + 1,
      lastError: message,
      lastErrorAt: new Date().toISOString(),
    };
  }

  /**
   * Transition from 'error' to 'reconnecting'.
   *
   * Silently ignored from other states. Does not reset `errorCount` or
   * `lastError` — these persist across reconnection attempts.
   */
  protected setReconnecting(): void {
    if (this._status.state !== 'error') return;
    this._status = { ...this._status, state: 'reconnecting' };
  }

  /**
   * Transition from 'reconnecting' or 'starting' to 'connected'.
   *
   * Does not reset `startedAt` (set once on initial connect).
   * Silently ignored from 'connected', 'disconnected', or 'stopping'.
   */
  protected markConnected(): void {
    if (this._status.state !== 'reconnecting' && this._status.state !== 'starting') return;
    this._status = { ...this._status, state: 'connected' };
  }

  /** Whether the adapter has been stopped or is stopping. */
  protected get isStopped(): boolean {
    return this._status.state === 'disconnected' || this._status.state === 'stopping';
  }

  /** Subclass hook: connect to the external service. */
  protected abstract _start(relay: RelayPublisher): Promise<void>;

  /** Subclass hook: disconnect and drain in-flight messages. */
  protected abstract _stop(): Promise<void>;

  /**
   * Deliver a relay message to the external channel.
   *
   * @param subject - The target subject
   * @param envelope - The relay envelope to deliver
   * @param context - Optional rich context for informed dispatch decisions
   */
  abstract deliver(
    subject: string,
    envelope: RelayEnvelope,
    context?: AdapterContext,
  ): Promise<DeliveryResult>;
}
