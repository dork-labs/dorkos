/**
 * The in-process live half of a room's SSE stream.
 *
 * A room's SSE contract is snapshot → gap-free replay → live, the same three
 * parts the session stream serves. The first two come from the log, which is
 * durable and never trimmed, so this module only has to carry what has not been
 * written yet at the moment a reader connects — plus ephemeral signals, which
 * are never written at all.
 *
 * @module server/services/rooms/room-stream
 */
import type { RoomEvent } from '@dorkos/shared/room-schemas';
import { logger } from '../../lib/logger.js';

/**
 * How many undelivered events one subscriber may hold before its stream is
 * ended instead of buffering further.
 *
 * Dropping frames would open a silent gap; buffering without limit would let
 * one stalled reader grow the heap without bound. Ending the stream does
 * neither: the client reconnects with its `Last-Event-ID` and the replay comes
 * back off the durable log, which is the one recovery that stays gap-free.
 */
const MAX_QUEUED_EVENTS = 1000;

/** One connected reader of one room. */
interface Subscriber {
  queue: RoomEvent[];
  /** Resolver for the parked `await` when the queue is empty. */
  wake: (() => void) | null;
  /** Set when the queue overflowed; the drain loop then ends the stream. */
  overflowed: boolean;
}

/**
 * Fans committed entries and ephemeral signals out to the readers of one room.
 *
 * One instance per server process, owned by the room subsystem.
 */
export class RoomBroadcaster {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  /**
   * Deliver an event to every current reader of a room.
   *
   * @param roomId - The room the event belongs to.
   * @param event - The entry or signal to deliver.
   */
  publish(roomId: string, event: RoomEvent): void {
    const readers = this.subscribers.get(roomId);
    if (!readers) return;
    for (const reader of readers) {
      if (reader.queue.length >= MAX_QUEUED_EVENTS) {
        reader.overflowed = true;
        reader.queue.length = 0;
        logger.warn(
          '[RoomBroadcaster] ending a stalled room subscriber; it will replay on reconnect',
          {
            roomId,
          }
        );
      } else {
        reader.queue.push(event);
      }
      reader.wake?.();
    }
  }

  /**
   * Open a live subscription.
   *
   * Registration happens **synchronously**, before this returns, which is what
   * closes the cold-connect race: the caller registers, then reads the log, and
   * anything committed in between lands in the queue rather than falling
   * between the two.
   *
   * @param roomId - The room to follow.
   * @param signal - Aborting it unregisters the reader and ends the iteration.
   * @returns An async iterable of live events.
   */
  subscribe(roomId: string, signal: AbortSignal): AsyncIterable<RoomEvent> {
    const reader: Subscriber = { queue: [], wake: null, overflowed: false };
    let readers = this.subscribers.get(roomId);
    if (!readers) {
      readers = new Set();
      this.subscribers.set(roomId, readers);
    }
    readers.add(reader);

    const release = (): void => {
      this.unsubscribe(roomId, reader);
      reader.wake?.();
    };
    if (signal.aborted) release();
    else signal.addEventListener('abort', release, { once: true });

    return this.drain(reader, signal, () => {
      signal.removeEventListener('abort', release);
      this.unsubscribe(roomId, reader);
    });
  }

  /** How many readers a room currently has. Used by tests and diagnostics. */
  subscriberCount(roomId: string): number {
    return this.subscribers.get(roomId)?.size ?? 0;
  }

  /** Drop a reader, and the room's bucket once it is empty. */
  private unsubscribe(roomId: string, reader: Subscriber): void {
    const readers = this.subscribers.get(roomId);
    if (!readers) return;
    readers.delete(reader);
    if (readers.size === 0) this.subscribers.delete(roomId);
  }

  /** Yield queued events, parking on `wake` whenever the queue runs dry. */
  private async *drain(
    reader: Subscriber,
    signal: AbortSignal,
    cleanup: () => void
  ): AsyncGenerator<RoomEvent> {
    try {
      while (!signal.aborted && !reader.overflowed) {
        const next = reader.queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          reader.wake = resolve;
        });
        reader.wake = null;
      }
    } finally {
      cleanup();
    }
  }
}
