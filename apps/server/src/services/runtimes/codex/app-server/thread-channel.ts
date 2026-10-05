/**
 * One loaded thread's notification stream, routed (spec
 * `codex-app-server-transport` §7 "Late events").
 *
 * A thread is subscribed once, for as long as it is loaded, because Codex
 * keeps talking after a turn ends: a background command's `item/completed`
 * arrives under its old turn id after `turn/completed` (protocol §5). Each
 * notification goes to the open turn's sink when it names that turn, and to
 * the thread's LATE SINK otherwise — never into a closed turn. P1 records the
 * late ones (count and last item) for diagnostics; P3 surfaces them.
 *
 * @module services/runtimes/codex/app-server/thread-channel
 */
import type { CodexClientClose } from './json-rpc-client.js';
import type { CodexAppServerProcess } from './process-pool.js';
import type { ServerNotification } from './protocol/methods.js';

/** Receives the open turn's notifications. */
export interface TurnSink {
  /** The turn's id, once `turn/start` answered. Until then everything buffers. */
  turnId: string | undefined;
  /** One notification for this turn (or, before `turnId` is known, for the thread). */
  notify(notification: ServerNotification): void;
  /** The process went away under the turn. */
  closed(close: CodexClientClose): void;
}

/** What the late sink has seen. */
export interface LateSinkRecord {
  /** How many notifications arrived for no open turn. */
  count: number;
  /** The last one's method, and its item type when it carried an item. */
  last: { method: string; itemType?: string } | undefined;
}

/** The turn id a notification names, if any. */
export function turnIdOf(notification: ServerNotification): string | undefined {
  const params = notification.params as { turnId?: unknown; turn?: { id?: unknown } } | undefined;
  if (typeof params?.turnId === 'string') return params.turnId;
  if (typeof params?.turn?.id === 'string') return params.turn.id;
  return undefined;
}

/** One thread's routed subscription. */
export class ThreadChannel {
  /** The open turn's sink, if a turn is open. */
  private sink: TurnSink | undefined;
  /** Notifications that arrived before the open turn's id was known. */
  private pending: ServerNotification[] = [];
  /** Everything that belonged to no open turn. */
  readonly late: LateSinkRecord = { count: 0, last: undefined };
  private readonly unsubscribe: () => void;

  /**
   * Subscribe to a thread for its loaded life.
   *
   * @param process - The process it is loaded in.
   * @param threadId - The thread.
   * @param onThreadEvent - Thread-level notifications (`thread/closed`, `serverRequest/resolved`).
   */
  constructor(
    readonly process: CodexAppServerProcess,
    readonly threadId: string,
    private readonly onThreadEvent: (notification: ServerNotification) => void
  ) {
    this.unsubscribe = process.client.subscribeThread(threadId, {
      notification: (notification) => this.route(notification),
      closed: (close) => {
        const sink = this.sink;
        this.sink = undefined;
        sink?.closed(close);
      },
    });
  }

  /**
   * Open a turn on this thread. Notifications buffer until `sink.turnId` is
   * set and {@link flush} is called.
   *
   * @param sink - The turn's sink.
   */
  open(sink: TurnSink): void {
    this.sink = sink;
    this.pending = [];
  }

  /** Deliver what buffered before the turn's id was known. */
  flush(): void {
    const buffered = this.pending;
    this.pending = [];
    for (const notification of buffered) this.route(notification);
  }

  /**
   * Close the open turn (its terminal was emitted, or it was abandoned).
   *
   * @param sink - The sink being closed; a newer one is left alone.
   */
  release(sink: TurnSink): void {
    if (this.sink === sink) this.sink = undefined;
    for (const notification of this.pending) this.toLate(notification);
    this.pending = [];
  }

  /** Stop listening (the thread unloaded). */
  dispose(): void {
    this.unsubscribe();
  }

  private route(notification: ServerNotification): void {
    if (
      notification.method === 'thread/closed' ||
      notification.method === 'serverRequest/resolved'
    ) {
      this.onThreadEvent(notification);
      return;
    }
    const sink = this.sink;
    if (!sink) {
      this.toLate(notification);
      return;
    }
    if (sink.turnId === undefined) {
      this.pending.push(notification);
      return;
    }
    const turnId = turnIdOf(notification);
    if (turnId === undefined || turnId === sink.turnId) sink.notify(notification);
    else this.toLate(notification);
  }

  private toLate(notification: ServerNotification): void {
    this.late.count += 1;
    const item = (notification.params as { item?: { type?: unknown } } | undefined)?.item;
    this.late.last = {
      method: notification.method,
      ...(typeof item?.type === 'string' ? { itemType: item.type } : {}),
    };
  }
}
