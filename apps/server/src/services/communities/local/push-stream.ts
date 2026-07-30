/**
 * A push-driven async iterable, for the two `CommunityAdapter` streams whose
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
 * call time.
 *
 * @module server/services/communities/local/push-stream
 */

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
   * @param value - The event to deliver.
   */
  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.queue.push(value);
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
