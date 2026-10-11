/** Nonissuing invalidation/start tickets; contains no birth, Transport or authority registrar. */
export class DocChannelFrameResources {
  private revision = 0;
  private draining = false;
  private cleanup: (() => unknown) | undefined;
  private readonly subscribers = new Set<() => unknown>();
  /** Reserve BEFORE draining callbacks; nested starts invalidate the returned ticket. */
  private readonly retirements = new WeakMap<
    object,
    { revision: number; cleanup?: () => unknown; callbacks: (() => unknown)[] }
  >();
  /** Reserve and detach EXACT old resources before authority invalidation/callbacks. */
  captureRetirement(): object {
    const ticket = Object.freeze({});
    const revision = ++this.revision;
    const cleanup = this.cleanup;
    this.cleanup = undefined;
    this.retirements.set(ticket, {
      revision,
      cleanup,
      callbacks: this.draining ? [] : [...this.subscribers],
    });
    return ticket;
  }
  drainRetirement(ticket: object): void {
    const captured = this.retirements.get(ticket);
    if (!captured) throw new Error('Frame resource retirement is foreign or consumed.');
    this.retirements.delete(ticket);
    const nested = this.draining;
    this.draining = true;
    try {
      this.drain(captured.cleanup);
      for (const callback of captured.callbacks) this.drain(callback);
    } finally {
      this.draining = nested;
    }
  }
  begin(): number {
    const ticket = this.captureRetirement();
    const revision = this.revision;
    this.drainRetirement(ticket);
    return revision;
  }
  /** One resource effect guarded on both sides, without choosing any authority facts. */
  once<T>(ticket: number, current: () => boolean, effect: () => T | null): () => T | null {
    let used = false;
    return () => {
      if (used) return null;
      used = true;
      if (!this.current(ticket) || !current() || !this.current(ticket)) return null;
      const result = effect();
      if (!this.current(ticket) || !current() || !this.current(ticket)) return null;
      return result;
    };
  }
  private drain(callback: (() => unknown) | undefined): void {
    try {
      void Promise.resolve(callback?.()).catch(() => {});
    } catch {
      /* Independent siblings still drain after synchronous throws. */
    }
  }
  current(ticket: number): boolean {
    return this.revision === ticket;
  }
  /** A provisional resource never overwrites/cancels the nested winner. */
  install(ticket: number, cleanup: () => unknown): boolean {
    if (!this.current(ticket)) {
      // No resource was installed: never disable a nested winner's shared binding.
      return false;
    }
    this.cleanup = cleanup;
    return true;
  }
  subscribe(callback: () => unknown): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }
}
