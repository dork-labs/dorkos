/**
 * A short-lived memo of in-flight or settled promises, for the update flow's
 * commit lookups and marketplace index fetches.
 *
 * @module services/marketplace/flows/update-memo
 */

/** A memoized in-flight or settled promise, and when it stops being shared. */
interface MemoEntry<T> {
  promise: Promise<T>;
  expiresAt: number;
}

/**
 * Share one promise per key for a fixed time. The in-flight promise is stored,
 * so concurrent callers (the CLI and the app together) share one request. A
 * rejection, or a value `keep` refuses, is dropped as soon as it settles, so a
 * failure is never served from the memo.
 */
export class TtlMemo<T> {
  private readonly entries = new Map<string, MemoEntry<T>>();

  /**
   * Build a memo.
   *
   * @param ttlMs - How long a promise is shared.
   * @param now - The clock.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number
  ) {}

  /**
   * The shared promise for `key`, loading it when there is none or it expired.
   *
   * @param key - What is being looked up.
   * @param load - How to look it up.
   * @param keep - Whether a settled value may be shared; defaults to always.
   * @returns The shared promise.
   */
  get(key: string, load: () => Promise<T>, keep: (value: T) => boolean = () => true): Promise<T> {
    const now = this.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.promise;

    const promise = load();
    this.entries.set(key, { promise, expiresAt: now + this.ttlMs });
    const forget = () => {
      if (this.entries.get(key)?.promise === promise) this.entries.delete(key);
    };
    promise.then((value) => {
      if (!keep(value)) forget();
    }, forget);
    return promise;
  }

  /** Forget everything, so the next lookup asks again. */
  clear(): void {
    this.entries.clear();
  }
}
