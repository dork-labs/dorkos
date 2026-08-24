/**
 * The work a runtime adapter is executing right now, and the handle that ends it.
 *
 * Work dispatched over the relay runs INSIDE an adapter, so the process that
 * asked for it holds no `AbortController` for it and cannot stop it in place. A
 * stop therefore travels the bus, and lands here: this registry is the only
 * handle anything outside a running handler has on it. Two callers share it —
 * scheduled task runs (DOR-808) and agent turns (DOR-791) — because the shape
 * of the problem is identical and a second copy would drift.
 *
 * @module relay/lib/abort-registry
 */

/**
 * A registry of in-flight work, keyed by whatever names one unit of it.
 *
 * Deliberately narrow: it holds only what is needed to end the work, and only
 * for as long as the work is in flight. Anything that has finalized is GONE
 * from here, which is what makes a late stop request answerable with the truth
 * ("nothing with that id is executing") instead of a silent no-op.
 */
export class AbortRegistry {
  private readonly entries = new Map<string, AbortController>();

  /**
   * Record work as in-flight.
   *
   * @param key - What names this unit of work (a run id, a reply subject).
   * @param controller - The controller whose abort ends it.
   */
  register(key: string, controller: AbortController): void {
    this.entries.set(key, controller);
  }

  /**
   * Forget work that has finished.
   *
   * Only drops the entry when it is still the one this caller registered, so a
   * late release can never unregister newer work that reused the key.
   *
   * @param key - The key this caller registered under.
   * @param controller - The controller this caller registered.
   */
  release(key: string, controller: AbortController): void {
    if (this.entries.get(key) === controller) this.entries.delete(key);
  }

  /**
   * Ask in-flight work to stop.
   *
   * Idempotent: aborting an already-aborted controller keeps the first reason
   * and does nothing else, so a second stop is harmless.
   *
   * @param key - What to stop.
   * @param reason - Carried on the signal so the handler can tell WHY it was
   *   stopped — a person's decision reads differently from a deadline.
   * @returns Whether work with this key was executing here.
   */
  stop(key: string, reason?: unknown): boolean {
    const controller = this.entries.get(key);
    if (!controller) return false;
    controller.abort(reason);
    return true;
  }

  /** How many units of work are registered. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Drop every entry without aborting anything.
   *
   * Called when the adapter stops. The work itself is finalized by its own
   * handlers; this only stops the registry from outliving them.
   */
  clear(): void {
    this.entries.clear();
  }
}
