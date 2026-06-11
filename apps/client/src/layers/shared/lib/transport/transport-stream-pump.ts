/**
 * In-process stream pumps — the embedded-mode counterpart of `SSEConnection`.
 *
 * In embedded mode (Obsidian's `DirectTransport`) there is no HTTP server, so
 * the StreamManager cannot open SSE connections. These pumps adapt the
 * Transport seam's async iterables (`getSessionSnapshot` + `subscribeSession`,
 * `subscribeSessionList`) onto the same `SSEConnectionLike` lifecycle and
 * handler maps the StreamManager already speaks, so every consumer downstream
 * of the manager (binding → stores → UI) is source-agnostic.
 *
 * No reconnection loop: an in-process iterable does not drop the way a network
 * connection does — it lives as long as the embedded runtime. If it ends or
 * throws, the pump reports `disconnected` honestly and stops.
 *
 * @module shared/lib/transport/transport-stream-pump
 */
import type { ConnectionState } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';

/** The narrow Transport surface the pumps consume (the stream contract). */
export type TransportStreams = Pick<
  Transport,
  'getSessionSnapshot' | 'subscribeSession' | 'subscribeSessionList'
>;

/** Shared lifecycle for both pumps: start-once, abortable, permanent destroy. */
abstract class TransportStreamPump {
  protected readonly abortController = new AbortController();
  private started = false;

  /** Start pumping. Subsequent calls are no-ops (one pump per attach). */
  connect(): void {
    if (this.started || this.abortController.signal.aborted) return;
    this.started = true;
    void this.run();
  }

  /** Stop pumping. In-process pumps cannot resume — equivalent to destroy. */
  disconnect(): void {
    this.teardown();
  }

  /** Permanent teardown. */
  destroy(): void {
    this.teardown();
  }

  private teardown(): void {
    // The signal is the deterministic stop (a generator parked on an
    // un-settleable wait ignores a bare iterator.return()); the subclass's
    // stored iterator return() is belt-and-suspenders for idle phases.
    this.abortController.abort();
    this.stopIteration();
  }

  protected abstract run(): Promise<void>;
  protected abstract stopIteration(): void;
}

/**
 * Pump one session's hydration + live events through the Transport seam:
 * snapshot first (dispatched to the `snapshot` handler), then iterate
 * `subscribeSession` from the snapshot's cursor so no event is missed between
 * capture and subscription — the same cold-connect protocol as the server's
 * `/events` route.
 */
export class TransportSessionStreamPump extends TransportStreamPump {
  private iterator: AsyncIterator<unknown> | undefined;

  constructor(
    private readonly options: {
      transport: TransportStreams;
      sessionId: string;
      cwd: string | null;
      /** StreamManager's handler map: `snapshot` plus the SessionEvent types. */
      eventHandlers: Record<string, (data: unknown) => void>;
      onStateChange?: (state: ConnectionState) => void;
    }
  ) {
    super();
  }

  protected async run(): Promise<void> {
    const { transport, sessionId, cwd, eventHandlers, onStateChange } = this.options;
    const signal = this.abortController.signal;
    onStateChange?.('connecting');
    try {
      const snapshot = await transport.getSessionSnapshot(sessionId, cwd ?? undefined);
      if (signal.aborted) return;
      eventHandlers['snapshot']?.(snapshot);
      onStateChange?.('connected');

      this.iterator = transport
        .subscribeSession(sessionId, snapshot.cursor, cwd ?? undefined, signal)
        [Symbol.asyncIterator]();
      for (;;) {
        const { value, done } = await this.iterator.next();
        if (done || signal.aborted) break;
        const event = value as { type: string };
        eventHandlers[event.type]?.(event);
      }
      if (!signal.aborted) onStateChange?.('disconnected');
    } catch (err) {
      if (signal.aborted) return;
      console.warn('[TransportStreamPump] session stream failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      onStateChange?.('disconnected');
    }
  }

  protected stopIteration(): void {
    void this.iterator?.return?.(undefined);
  }
}

/** Pump the global session-list stream through the Transport seam. */
export class TransportListStreamPump extends TransportStreamPump {
  private iterator: AsyncIterator<unknown> | undefined;

  constructor(
    private readonly options: {
      transport: TransportStreams;
      /** StreamManager's handler map keyed by the 3 list-event types. */
      eventHandlers: Record<string, (data: unknown) => void>;
      onStateChange?: (state: ConnectionState) => void;
    }
  ) {
    super();
  }

  protected async run(): Promise<void> {
    const { transport, eventHandlers, onStateChange } = this.options;
    const signal = this.abortController.signal;
    try {
      this.iterator = transport.subscribeSessionList()[Symbol.asyncIterator]();
      onStateChange?.('connected');
      for (;;) {
        const { value, done } = await this.iterator.next();
        if (done || signal.aborted) break;
        const event = value as { type: string };
        eventHandlers[event.type]?.(event);
      }
      if (!signal.aborted) onStateChange?.('disconnected');
    } catch (err) {
      if (signal.aborted) return;
      console.warn('[TransportStreamPump] session-list stream failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      onStateChange?.('disconnected');
    }
  }

  protected stopIteration(): void {
    void this.iterator?.return?.(undefined);
  }
}
