import { EnvelopeError, intakeFailureCause } from './scanner.js';
import type { Cause } from './records.js';

/** Private representation reservations, not measured JavaScript heap limits. */
export const reservations = Object.freeze({
  runner: 1048576,
  reply: 131072,
  local: 524288,
  runnerRetained: 393216,
  replyRetained: 24576,
  total: 2097152,
});
/** One retained fixture transaction owner. This supplies no physical deadline enforcement. */
export class EnvelopeOwner {
  readonly buffers: readonly [Uint8Array, Uint8Array];
  readonly origin: number;
  get currentTime(): number {
    return this.previous;
  }
  cause: Cause | null = null;
  readonly cleanupCauses: Cause[] = [];
  lostCleanupCauses = 0;
  units = 0;
  private previous = -Infinity;
  private checking = false;
  private clockFailed = false;
  private readonly phases = new Map<object, number>();
  private metadataHeld = false;
  private readonly metadata = Object.freeze({});
  private readonly retireCallbacks = new Set<() => void>();
  constructor(
    readonly clock: () => number,
    readonly workEnd: number,
    readonly finalEnd: number,
    readonly signal: AbortSignal
  ) {
    if (!Number.isFinite(workEnd) || !Number.isFinite(finalEnd) || finalEnd < workEnd)
      throw new EnvelopeError('INVALID_INSTALL_CONFIGURATION');
    EventTarget.prototype.addEventListener.call(
      signal,
      'abort',
      () => this.retire('ATTEMPT_INTERRUPTED'),
      { once: true }
    );
    this.check();
    this.origin = this.previous;
    this.buffers = [new Uint8Array(65536), new Uint8Array(65536)];
  }
  onRetire(callback: () => void): () => void {
    this.retireCallbacks.add(callback);
    if (this.cause) callback();
    return () => this.retireCallbacks.delete(callback);
  }
  retire(cause: Cause): void {
    if (this.cause) return;
    this.cause = cause;
    for (const callback of this.retireCallbacks) {
      try {
        callback();
      } catch {
        this.cleanup('CUSTODY_UNCERTAIN');
      }
    }
  }
  cleanup(cause: Cause): void {
    if (this.cleanupCauses.includes(cause)) return;
    if (this.cleanupCauses.length < 31) this.cleanupCauses.push(cause);
    else {
      if (!this.cleanupCauses.includes('CUSTODY_UNCERTAIN'))
        this.cleanupCauses.push('CUSTODY_UNCERTAIN');
      if (this.lostCleanupCauses < Number.MAX_SAFE_INTEGER) this.lostCleanupCauses++;
    }
  }
  check(cleanup = false, end = this.workEnd): void {
    if (this.clockFailed || (!cleanup && this.cause))
      throw new EnvelopeError(this.cause ?? 'OWNERSHIP_UNCERTAIN');
    if (
      !cleanup &&
      Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(this.signal)
    ) {
      this.retire('ATTEMPT_INTERRUPTED');
      throw new EnvelopeError(this.cause!);
    }
    if (this.checking) {
      this.clockFailed = true;
      this.retire('OWNERSHIP_UNCERTAIN');
      throw new EnvelopeError(this.cause!);
    }
    this.checking = true;
    let now: number;
    try {
      now = this.clock();
    } catch {
      this.clockFailed = true;
      this.retire('OWNERSHIP_UNCERTAIN');
      throw new EnvelopeError(this.cause!);
    } finally {
      this.checking = false;
    }
    if (this.clockFailed || (!cleanup && this.cause))
      throw new EnvelopeError(this.cause ?? 'OWNERSHIP_UNCERTAIN');
    if (!Number.isFinite(now) || now < this.previous) {
      this.clockFailed = true;
      this.retire('OWNERSHIP_UNCERTAIN');
      throw new EnvelopeError(this.cause!);
    }
    this.previous = now;
    if (now >= (cleanup ? this.finalEnd : Math.min(this.workEnd, end))) {
      this.retire('ATTEMPT_INTERRUPTED');
      throw new EnvelopeError(this.cause!);
    }
  }
  reserve(phase: object, amount: number, end = this.workEnd): void {
    this.check(false, end);
    if (this.phases.has(phase) || this.units > reservations.total - amount) {
      this.retire('BUDGET_EXCEEDED');
      throw new EnvelopeError(this.cause!);
    }
    this.units += amount;
    this.phases.set(phase, amount);
  }
  retain(phase: object, amount: number, end = this.workEnd): void {
    this.check(false, end);
    const old = this.phases.get(phase);
    if (old === undefined || old < amount) throw new EnvelopeError('OWNERSHIP_UNCERTAIN');
    this.units -= old - amount;
    this.phases.set(phase, amount);
  }
  /** Reserve the fixed overhead before terminal metadata can outlive all working phases. */
  retainMetadata(): void {
    this.metadataHeld = true;
    if (this.units === 0) {
      this.phases.set(this.metadata, 65536);
      this.units = 65536;
    }
  }
  /** Release only after an exact supported acknowledgement, including retired custody. */
  release(phase: object): void {
    const old = this.phases.get(phase);
    if (old !== undefined) {
      this.units -= old;
      this.phases.delete(phase);
      if (this.metadataHeld && this.units === 0) {
        this.phases.set(this.metadata, 65536);
        this.units = 65536;
      }
    }
  }
}
/** A bounded fixture byte producer; delivery acknowledgement is object identity, not a caller flag. */
export interface BytePort {
  read(
    target: Uint8Array,
    delivery: object
  ): Promise<{ count: number; eof: boolean; delivery: object }>;
  close(delivery: object, finalEnd: number): Promise<{ delivery: object; state: 'closed' }>;
}
/** Registered intake retains unknown reads and closes once under the original final end. */
export class Intake {
  readonly delivery = Object.freeze({});
  readonly phase = Object.freeze({});
  private closePromise: Promise<void> | undefined;
  private unknown = true;
  private readPending = false;
  private closed = false;
  private readonly detach: () => void;
  constructor(
    private readonly owner: EnvelopeOwner,
    private readonly port: BytePort,
    private readonly end = owner.workEnd
  ) {
    this.detach = owner.onRetire(() => {
      void this.close();
    });
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.closePromise = promise;
    void (async () => {
      try {
        // Cleanup remains permitted after retirement, but uses this exact registered delivery.
        this.owner.check(true);
        const close = this.port.close;
        this.owner.check(true);
        const ack = await close.call(this.port, this.delivery, this.owner.finalEnd);
        this.owner.check(true);
        const descriptors = Object.getOwnPropertyDescriptors(ack);
        this.owner.check(true);
        if (
          !descriptors.delivery ||
          !('value' in descriptors.delivery) ||
          descriptors.delivery.value !== this.delivery ||
          !descriptors.state ||
          !('value' in descriptors.state) ||
          descriptors.state.value !== 'closed' ||
          Reflect.ownKeys(ack).length !== 2
        )
          throw new EnvelopeError('CUSTODY_UNCERTAIN');
        // The final own-key reflection is external too; cleanup cannot renew finalEnd.
        this.owner.check(true);
        this.unknown = false;
        this.closed = true;
        this.detach();
        if (this.owner.cause && !this.readPending) this.owner.release(this.phase);
      } catch {
        this.owner.cleanup('CUSTODY_UNCERTAIN');
      }
      resolve();
    })();
    return promise;
  }
  async read(cap: number): Promise<Uint8Array> {
    let used = 0;
    try {
      this.owner.reserve(this.phase, reservations.runner, this.end);
      while (true) {
        this.owner.check(false, this.end);
        const read = this.port.read;
        this.owner.check(false, this.end);
        const buffer = used < cap ? this.owner.buffers[0] : this.owner.buffers[1];
        const offset = used < cap ? used : 0;
        const requested = Math.min(buffer.length - offset, cap - used + 1);
        this.owner.check(false, this.end);
        this.unknown = true;
        this.readPending = true;
        let response: Awaited<ReturnType<BytePort['read']>>;
        try {
          response = await read.call(
            this.port,
            buffer.subarray(offset, offset + requested),
            this.delivery
          );
        } finally {
          this.readPending = false;
          if (this.owner.cause && this.closed) this.owner.release(this.phase);
        }
        this.owner.check(false, this.end);
        const descriptors = Object.getOwnPropertyDescriptors(response);
        this.owner.check(false, this.end);
        for (const key of ['count', 'eof', 'delivery'])
          if (!descriptors[key] || !('value' in descriptors[key]!))
            throw new EnvelopeError('CUSTODY_UNCERTAIN');
        const count: unknown = descriptors.count!.value;
        const eof: unknown = descriptors.eof!.value;
        if (
          Reflect.ownKeys(response).length !== 3 ||
          descriptors.delivery!.value !== this.delivery ||
          typeof count !== 'number' ||
          !Number.isSafeInteger(count) ||
          count < 0 ||
          count > requested ||
          typeof eof !== 'boolean' ||
          (count === 0 && !eof)
        )
          throw new EnvelopeError('CUSTODY_UNCERTAIN');
        used += count;
        if (used > cap) {
          this.owner.retire('BUDGET_EXCEEDED');
          throw new EnvelopeError(this.owner.cause!);
        }
        this.owner.check(false, this.end);
        if (eof) {
          this.unknown = false;
          return this.owner.buffers[0].subarray(0, used);
        }
      }
    } catch (error) {
      this.owner.retire(
        intakeFailureCause(error) === 'BUDGET_EXCEEDED'
          ? 'BUDGET_EXCEEDED'
          : (this.owner.cause ?? 'CUSTODY_UNCERTAIN')
      );
      if (this.unknown) this.owner.cleanup('CUSTODY_UNCERTAIN');
      void this.close();
      throw new EnvelopeError(this.owner.cause!);
    }
  }
  get isClosed(): boolean {
    return this.closed;
  }
}
