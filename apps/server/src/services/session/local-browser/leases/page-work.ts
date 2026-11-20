import type { BrowserActionFlight } from '../lifecycle.js';

/** Track physical protocol work independently of any caller's response deadline. */
export type PageWorkTracker = <T>(operation: Promise<T>) => Promise<T>;

/** Custody cannot transfer until every already dispatched read/effect has settled. */
export class BrowserPageWork {
  private readonly pending = new Set<Promise<unknown>>();
  readonly track: PageWorkTracker = <T>(operation: Promise<T>): Promise<T> => {
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => undefined);
    return operation;
  };

  /** Acknowledged closure ends this Page's custody, not its late response's identity fence. */
  beginPage(): void {
    this.pending.clear();
  }

  /** Reads and effects share custody, while effects retain their existing timeout semantics. */
  async drainWith(actions: BrowserActionFlight): Promise<void> {
    await Promise.all([this.drain(), actions.settled()]);
  }

  /** New admissions must be blocked synchronously before calling this barrier. */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
