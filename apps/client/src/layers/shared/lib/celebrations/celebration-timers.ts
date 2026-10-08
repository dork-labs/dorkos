/** Retains exact celebration timers and their first cleanup failure. */
export class TimerBag {
  private readonly handles = new Map<ReturnType<typeof setTimeout>, 'timeout' | 'interval'>();
  private first: { value: unknown } | undefined;
  private closed = false;
  private readonly timeoutClear: typeof globalThis.clearTimeout;
  private readonly intervalClear: typeof globalThis.clearInterval;
  constructor(
    private readonly beforeEffect: () => void,
    private readonly onIdle: () => void
  ) {
    // Capture platform methods before any handle acquisition. Cleanup never
    // rereads a callback-shaped method getter after retiring a numeric handle.
    this.timeoutClear = globalThis.clearTimeout;
    this.intervalClear = globalThis.clearInterval;
  }

  private check(): void {
    if (this.closed) throw new Error('Celebration schedules retired.');
    this.beforeEffect();
    if (this.closed) throw new Error('Celebration schedules retired.');
  }

  private callback(fn: () => void): void {
    try {
      this.check();
      fn();
    } catch (value) {
      this.first ??= { value };
      // Timer failure never admits a new echo or leaks an uncaught rejection.
      try {
        this.clear();
      } catch {
        this.first ??= {
          value: new Error('Celebration cleanup could not be confirmed.'),
        };
      }
      try {
        console.warn('[extensions] Celebration did not complete.');
      } catch {
        /* Diagnostic only. */
      }
    }
  }

  after(ms: number, fn: () => void): void {
    const schedule = globalThis.setTimeout;
    const callback = () => {
      this.handles.delete(id);
      this.callback(fn);
      this.onIdle();
    };
    this.check();
    let id: ReturnType<typeof setTimeout>;
    try {
      id = Reflect.apply(schedule, globalThis, [callback, ms]);
    } catch (error) {
      this.first ??= { value: error };
      try {
        this.clear();
      } catch {
        /* Unacknowledged schedule remains uncertain. */
      }
      throw error;
    }
    this.handles.set(id, 'timeout');
    // A reentrant platform mock may retire during schedule entry. The created
    // handle is registered before the final check, so cleanup can still own it.
    try {
      this.check();
    } catch (error) {
      if (this.closed) this.clearHandle(id);
      else {
        try {
          this.clear();
        } catch {
          /* Sticky uncertainty. */
        }
      }
      throw error;
    }
  }

  every(stepMs: number, durationMs: number, fn: () => void): void {
    const now = Date.now;
    const start = Reflect.apply(now, Date, []);
    const schedule = globalThis.setInterval;
    const callback = () => {
      this.callback(() => {
        const current = Reflect.apply(now, Date, []);
        this.check();
        if (!Number.isFinite(current) || current - start >= durationMs) {
          this.clearHandle(id);
          return;
        }
        fn();
      });
      this.onIdle();
    };
    this.check();
    let id: ReturnType<typeof setTimeout>;
    try {
      id = Reflect.apply(schedule, globalThis, [callback, stepMs]);
    } catch (error) {
      this.first ??= { value: error };
      try {
        this.clear();
      } catch {
        /* Unacknowledged schedule remains uncertain. */
      }
      throw error;
    }
    this.handles.set(id, 'interval');
    try {
      this.check();
    } catch (error) {
      if (this.closed) this.clearHandle(id);
      else {
        try {
          this.clear();
        } catch {
          /* Sticky uncertainty. */
        }
      }
      throw error;
    }
  }

  private clearHandle(id: ReturnType<typeof setTimeout>): void {
    const kind = this.handles.get(id);
    if (kind === undefined) return;
    // Retire this exact acquired handle before one external clear entry. Never
    // retry an old numeric id or clear it again through a second timer API.
    this.handles.delete(id);
    try {
      const clear = kind === 'timeout' ? this.timeoutClear : this.intervalClear;
      Reflect.apply(clear, globalThis, [id]);
    } catch (value) {
      this.first ??= { value };
    }
  }

  idle(): boolean {
    return this.handles.size === 0;
  }

  clear(): void {
    if (!this.closed) {
      this.closed = true;
      for (const id of [...this.handles.keys()]) this.clearHandle(id);
    }
    if (this.first) throw this.first.value;
  }
}
