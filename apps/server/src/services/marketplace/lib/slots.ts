/**
 * A first-in, first-out counting semaphore: at most `size` tasks run at once,
 * and the rest wait their turn in arrival order.
 *
 * @module services/marketplace/lib/slots
 */

/** A first-in, first-out counting semaphore. */
export class Slots {
  private readonly waiting: (() => void)[] = [];

  /**
   * Build a semaphore with this many slots.
   *
   * @param free - How many tasks may run at once.
   */
  constructor(private free: number) {}

  /**
   * Run `task` once a slot is free, releasing the slot when it settles.
   *
   * @param task - The work to run inside a slot.
   * @returns Whatever the task resolves to.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free -= 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free += 1;
    }
  }
}
