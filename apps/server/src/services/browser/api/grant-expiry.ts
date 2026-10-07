/** Original bounded timer owner: expiry effects cannot enter after close or replacement. */
export class BrowserGrantExpiry {
  private readonly entries = new Map<
    object,
    { identity: object; expiresAt: number; timer?: ReturnType<typeof setTimeout> }
  >();
  private closed = false;
  constructor(
    private readonly expire: (identity: object) => void,
    private readonly now: () => number = Date.now
  ) {}

  set(key: object, identity: object, expiresAt: number, observedAt?: number): void {
    if (this.closed) throw new Error('browserGrantExpiryClosed');
    this.remove(key);
    const entry = {
      identity,
      expiresAt,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    this.entries.set(key, entry);
    const arm = (capturedTime?: number) => {
      const remaining = entry.expiresAt - (capturedTime ?? this.now());
      if (this.closed || this.entries.get(key) !== entry) return;
      entry.timer = setTimeout(
        () => {
          const remaining = entry.expiresAt - this.now();
          if (this.closed || this.entries.get(key) !== entry) return;
          if (remaining > 0) {
            arm();
            return;
          }
          this.entries.delete(key);
          this.expire(entry.identity);
        },
        Math.max(1, Math.min(2147483647, remaining))
      );
      entry.timer.unref();
    };
    // Bank publication can supply its last authority-clock snapshot, avoiding callbacks after its final actor fence.
    arm(observedAt);
  }

  remove(key: object): void {
    const original = this.entries.get(key);
    if (!original) return;
    this.entries.delete(key);
    if (original.timer) clearTimeout(original.timer);
  }

  close(): void {
    this.closed = true;
    for (const key of this.entries.keys()) this.remove(key);
  }
}
