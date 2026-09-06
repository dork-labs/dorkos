/**
 * A push-driven async iterable, for the `CommunityAdapter` streams whose
 * events arrive from somewhere other than the consumer's own pull.
 *
 * The port requires `subscribeRoom` to validate its cursor **synchronously** and
 * only then hand back a stream, which rules out writing either stream as an
 * `async function*`: a generator body does not run until the first `next()`, so
 * the eager throw would arrive one pull too late and the opening snapshot would
 * be composed against a room that had already moved. A plain method that
 * arranges everything up front and returns one of these satisfies both.
 *
 * Events queue until a consumer pulls them, so nothing pushed before the first
 * `next()` is lost — which is the whole reason the snapshot can be composed at
 * call time. That queue is **bounded**, and the bound is the same bound-and-end
 * policy `services/rooms/room-stream.ts` has always had, for the same reasons.
 *
 * @module server/services/communities/push-stream
 */
import { logger } from '../../lib/logger.js';

/**
 * How many undelivered events one stream may hold before it is ended instead of
 * buffering further.
 *
 * The number and the argument are `RoomBroadcaster`'s, deliberately unforked:
 * dropping frames would open a silent gap; buffering without limit would let one
 * stalled reader grow the heap until this process dies. Ending the stream does
 * neither — the port makes a consumer handle a stream that ends anyway (a room
 * closes, an adapter disconnects), and the recovery is the one the port already
 * prescribes: subscribe again, from a cursor, and the replay is gap-free.
 *
 * A community stream carries at most one snapshot and then one frame per
 * committed entry, so a thousand undelivered events is a reader that has stopped
 * reading rather than a busy room.
 */
export const MAX_QUEUED_EVENTS = 1000;

/**
 * A queue that is also an async iterable. One producer, one consumer.
 *
 * @template T - What travels on the stream.
 */
export class PushStream<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly waiters: ((result: IteratorResult<T>) => void)[] = [];
  private ended = false;

  /**
   * Build a stream that tells its producer when the consumer walks away.
   *
   * @param onClose - Called once, when the consumer stops iterating or the
   *   producer ends the stream, so whatever feeds this can unregister itself.
   */
  constructor(private readonly onClose: () => void = () => {}) {}

  /**
   * Queue one event, delivering it immediately if a consumer is parked.
   *
   * A push that would take the queue past {@link MAX_QUEUED_EVENTS} ENDS the
   * stream instead — the queue is discarded with it, because a reader that is
   * given some of what it missed and not the rest has a gap it cannot see. What
   * it gets instead is the end of the stream, which every consumer of this port
   * already handles.
   *
   * @param value - The event to deliver.
   */
  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    if (this.queue.length >= MAX_QUEUED_EVENTS) {
      logger.warn('[PushStream] ending a stalled community subscriber; it must resubscribe', {
        queued: this.queue.length,
      });
      this.queue.length = 0;
      this.end();
      return;
    }
    this.queue.push(value);
  }

  /**
   * Terminate the stream once everything already queued has been read.
   *
   * Idempotent, so the producer may end a stream the consumer has already
   * abandoned.
   */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    let waiter = this.waiters.shift();
    while (waiter) {
      waiter({ value: undefined as never, done: true });
      waiter = this.waiters.shift();
    }
    this.onClose();
  }

  /** Whether {@link PushStream.end} has run. */
  get closed(): boolean {
    return this.ended;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const queued = this.queue.shift();
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
      // A consumer that stops early releases the producer, which is what stops a
      // parked room subscription from outliving the reader that opened it.
      return: (): Promise<IteratorResult<T>> => {
        this.end();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
