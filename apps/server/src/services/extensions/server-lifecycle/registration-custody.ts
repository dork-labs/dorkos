/** Cleanup facts belong to one original in-process registration, never its replacement. */
export class RegistrationCustody {
  private readonly blocked = new Map<string, Set<RegistrationOccurrence>>();

  /** Refuse a new producer while an earlier occurrence has unverified cleanup. */
  permits(id: string): boolean {
    return !this.blocked.has(id);
  }

  /** Removed publication is not proof that its original cleanup succeeded. */
  requireReleased(id: string): void {
    const held = this.blocked.get(id);
    if (!held) return;
    for (const occurrence of held) {
      const first = occurrence.failure();
      if (first) throw first.value;
    }
    throw new Error('Extension server cleanup is unverified.');
  }

  /** Allocate only after the lifecycle's ordinary approval and compilation gates. */
  begin(id: string): RegistrationOccurrence {
    if (!this.permits(id)) throw new Error('Extension server cleanup is unverified.');
    const occurrence = new RegistrationOccurrence(
      () => {
        let held = this.blocked.get(id);
        if (!held) this.blocked.set(id, (held = new Set()));
        held.add(occurrence);
      },
      () => {
        const held = this.blocked.get(id);
        held?.delete(occurrence);
        if (held?.size === 0) this.blocked.delete(id);
      }
    );
    return occurrence;
  }
}

/** An original cleanup bank; late receipts are attempted but cannot heal UNKNOWN. */
export class RegistrationOccurrence {
  private first: { value: unknown } | undefined;
  private readonly jobs = new Map<() => unknown, Promise<void>>();
  private closing: Promise<void> | undefined;
  private unverified = false;
  private readonly operations = new Set<Promise<void>>();

  constructor(
    private readonly block: () => void,
    private readonly release: () => void
  ) {}

  /** Observation-only first failure; it never authorizes another registration. */
  failure(): Readonly<{ value: unknown }> | undefined {
    return this.first;
  }

  /** Only the original live registration may enter or publish context work. */
  requireCurrent(): void {
    if (this.first) throw this.first.value;
    if (this.closing || this.unverified)
      throw new Error('Extension server registration was retired.');
  }

  /** Reserve original context work before entry and retain its actual settlement. */
  runOriginal<T>(enter: () => Promise<T>): Promise<T> {
    this.requireCurrent();
    let resolve!: (value: T) => void;
    let reject!: (value: unknown) => void;
    const original = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const settled = original.then(
      () => undefined,
      () => undefined
    );
    this.operations.add(settled);
    void settled.then(() => this.operations.delete(settled));
    try {
      void Promise.resolve(enter()).then(resolve, reject);
    } catch (value) {
      reject(value);
    }
    return original;
  }

  /** A registrar that did not return a receipt leaves its arbitrary effects unknown. */
  unknown(): void {
    this.unverified = true;
    this.block();
  }

  /** Keep the first exact failure, including false and undefined. */
  fail(value: unknown): void {
    this.first ??= { value };
    this.block();
  }

  /** Enter each original obligation once and retain its actual settlement. */
  private enter(cleanup: () => unknown): Promise<void> {
    const previous = this.jobs.get(cleanup);
    if (previous) return previous;
    // Reserve before entry: cleanup may synchronously reenter retirement.
    let resolve!: () => void;
    let reject!: (value: unknown) => void;
    const job = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.jobs.set(cleanup, job);
    // Retain rejection immediately, including a late receipt after retirement.
    void job.catch(() => undefined);
    try {
      const returned = cleanup();
      void Promise.resolve(returned).then(
        (value: unknown) => {
          if (value === undefined || value === null || value === true) resolve();
          else {
            this.fail(value);
            reject(value);
          }
        },
        (value: unknown) => {
          this.fail(value);
          reject(value);
        }
      );
    } catch (value) {
      this.fail(value);
      reject(value);
    }
    return job;
  }

  /** Join a late original receipt without reopening this extension's admission. */
  late(cleanup: () => unknown): Promise<void> {
    // In production only the original timed-out registrar supplies this receipt.
    // A late receipt is never evidence of a previously complete registration.
    this.unknown();
    return this.enter(cleanup);
  }

  /** Memoize retirement before callbacks; independently enter and join every duty. */
  retire(cleanups: readonly (() => unknown)[]): Promise<void> {
    if (this.closing) return this.closing;
    let resolve!: () => void;
    let reject!: (value: unknown) => void;
    const closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.closing = closing;
    this.block();
    void closing.catch(() => undefined);
    for (const cleanup of cleanups) this.enter(cleanup);
    const joinEntered = async () => {
      let joined = 0;
      while (joined !== this.jobs.size || this.operations.size > 0) {
        const snapshot = [...this.jobs.values(), ...this.operations];
        const cleanupCount = this.jobs.size;
        await Promise.allSettled(snapshot);
        joined = cleanupCount;
      }
      if (this.first) reject(this.first.value);
      else {
        if (!this.unverified) this.release();
        resolve();
      }
    };
    void joinEntered();
    return closing;
  }
}
