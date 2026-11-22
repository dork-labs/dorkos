/** The longest a waiting hand-off goes without looking again, even when no turn ended. */
const HANDOFF_RECHECK_MS = 30_000;

/** Runtime-busy refusals back off from one second, so two seats cannot wake each other. */
const HANDOFF_RETRY_FIRST_MS = 1_000;

/** How long a hand-off waits after its attempt: 1 s, 2 s, 4 s, up to the recheck. */
export function handoffRetryDelay(attempt: number): number {
  return Math.min(HANDOFF_RETRY_FIRST_MS * 2 ** attempt, HANDOFF_RECHECK_MS);
}

interface Entry<T> {
  item: T;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
}
interface Seat<T> {
  active: boolean;
  entries: Entry<T>[];
  count: number;
}
type Admission<T> =
  | { accepted: true; item: T }
  | { accepted: false; why: 'capacity' | 'expired' | 'stopped' }
  | { accepted: false; why: 'invalid'; error: unknown };
/**
 * Bounded process-local FIFO for room hand-offs, including preparing and active work.
 * Waiting entries expire independently; an actual active turn retains its slot until completion.
 * @typeParam T - The immutable draft and its original admission scope.
 */
export class HandoffQueue<T> {
  private readonly seats = new Map<string, Seat<T>>();
  private readonly tasks = new Set<Promise<void>>();
  private count = 0;
  private stopped = false;
  /**
   * Build a queue whose callbacks retain domain-owned status and report delivery.
   * @param callbacks - Run, expiry and safe failure handlers; expiry never cancels active work.
   */
  constructor(
    private readonly callbacks: {
      run(item: T): Promise<unknown>;
      expired(item: T): void | Promise<void>;
      failed(item: T): void | Promise<void>;
      cancelled?(item: T): void;
    }
  ) {}
  /**
   * Whether the seat owns any preparing, waiting or active reservation.
   * @param key - The room-and-author seat key.
   * @returns True until the final owned reservation is released.
   */
  has(key: string): boolean {
    return this.seats.has(key);
  }
  /**
   * Reserve bounded capacity before synchronously capturing the draft's scope.
   * @param key - The room-and-author seat key.
   * @param deadline - Original acceptance deadline in epoch milliseconds.
   * @param create - Scope factory, called only while this preparation owns capacity.
   * @returns The accepted item, or a refusal carrying the factory's error for the caller to log.
   */
  admit(key: string, deadline: number, create: () => T): Admission<T> {
    if (this.stopped) return { accepted: false, why: 'stopped' };
    const previous = this.seats.get(key);
    // No factory, session lookup or asynchronous work before resource admission.
    if (this.count >= 1000 || (previous?.count ?? 0) >= 25)
      return { accepted: false, why: 'capacity' };
    if (!Number.isFinite(deadline) || Date.now() >= deadline)
      return { accepted: false, why: 'expired' };
    const seat = previous ?? { active: false, entries: [], count: 0 };
    this.seats.set(key, seat);
    this.count += 1;
    seat.count += 1;
    let item: T;
    try {
      item = create();
    } catch (error) {
      this.release(key, seat);
      // The caller logs it and answers by its cause; it is never shown to the sender raw.
      return { accepted: false, why: 'invalid', error };
    }
    if (this.stopped) {
      this.release(key, seat);
      this.callbacks.cancelled?.(item);
      return { accepted: false, why: 'stopped' };
    }
    const entry: Entry<T> = { item, deadline };
    seat.entries.push(entry);
    entry.timer = setTimeout(
      () => {
        const index = seat.entries.indexOf(entry);
        if (index < 0) return;
        seat.entries.splice(index, 1);
        this.release(key, seat);
        this.track(Promise.resolve().then(() => this.callbacks.expired(item)));
      },
      Math.max(0, deadline - Date.now())
    );
    // Promotion is asynchronous so callers can publish the accepted receipt first.
    this.track(Promise.resolve().then(() => this.pump(key, seat)));
    return { accepted: true, item };
  }
  /** Close admission and cancel only queued entries; active owners retain their real lifetime. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const [key, seat] of this.seats) {
      for (const entry of seat.entries.splice(0)) {
        clearTimeout(entry.timer);
        this.release(key, seat);
        this.callbacks.cancelled?.(entry.item);
      }
    }
  }
  /**
   * Wait for all admitted executions and terminal callbacks to finish.
   * Active turns must be released by their actual owner; this method does not cancel them.
   * @returns A promise resolved once all owned asynchronous work has settled.
   */
  async idle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
  }
  private async pump(key: string, seat: Seat<T>): Promise<void> {
    if (seat.active) return;
    seat.active = true;
    try {
      // One drain owner, without retaining a promise frame for every completed draft.
      while (seat.entries.length > 0) {
        const entry = seat.entries.shift()!;
        clearTimeout(entry.timer);
        try {
          // Timer delivery is not authority: a release can promote at the exact deadline first.
          if (Date.now() >= entry.deadline) await this.callbacks.expired(entry.item);
          else await this.callbacks.run(entry.item);
        } catch {
          try {
            await this.callbacks.failed(entry.item);
          } catch {
            // A failed terminal notice must not strand later admitted drafts.
          }
        } finally {
          this.release(key, seat);
        }
      }
    } finally {
      seat.active = false;
    }
  }
  private release(key: string, seat: Seat<T>): void {
    seat.count -= 1;
    this.count -= 1;
    if (seat.count === 0 && this.seats.get(key) === seat) this.seats.delete(key);
  }
  private track(task: Promise<void>): void {
    // Reporting failures cannot become an unhandled rejection or strand admission capacity.
    const settled = task.catch(() => undefined);
    this.tasks.add(settled);
    void settled.then(() => this.tasks.delete(settled));
  }
}
