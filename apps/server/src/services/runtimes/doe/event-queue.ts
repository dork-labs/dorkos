/** Single-consumer callback bridge with deterministic parked-reader teardown. */
export class DoeEventQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = [];
  private waiter?: (result: IteratorResult<T>) => void;
  private ended = false;

  /** Send one item unless this consumer has already closed. */
  push(value: T): void {
    if (this.ended) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value, done: false });
    } else this.values.push(value);
  }

  /** Finish after buffered events; wake a reader waiting for work. */
  end(): void {
    this.ended = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  /** Consume the queued item or wait until an item or termination arrives. */
  next(): Promise<IteratorResult<T>> {
    if (this.values.length) return Promise.resolve({ value: this.values.shift()!, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    if (this.waiter) return Promise.reject(new Error('Only one queue reader is supported.'));
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  /** Closing a parked iterator ends it immediately and discards its backlog. */
  return(): Promise<IteratorResult<T>> {
    this.values.length = 0;
    this.end();
    return Promise.resolve({ value: undefined, done: true });
  }

  /** Return this single-consumer iterator. */
  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}
