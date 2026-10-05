/** Bounded original-envelope queue; ambiguity is retained truthfully, never converted to saved. */
import {
  PageEventSchema,
  type CanvasChannelEventReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  checkedDocReceipt,
  type BoundDocPort,
  type BoundDocOriginalRequest,
} from './bound-doc-port';
/** Completion is durable acceptance or an honest local refusal/uncertainty. */
export type DocQueueOutcome =
  | { kind: 'accepted'; receipt: CanvasChannelEventReceipt }
  | { kind: 'cancelled' | 'refused' | 'unconfirmed' };
/** Explicit clock/scheduling ports make retry bounds and cancellation testable. */
export interface DocQueueScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
  random(): number;
}
interface Entry {
  original?: BoundDocOriginalRequest;
  id: string;
  bytes: string;
  weight: number;
  sent: boolean;
  settled: boolean;
  unconfirmed: boolean;
  resolve(outcome: DocQueueOutcome): void;
  promise: Promise<DocQueueOutcome>;
}
/** Local SDK queue with a fixed 100-entry / 1 MiB envelope-plus-metadata budget. */
export class DocFrameQueue {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private running = false;
  private retired = false;
  private readonly abort = new AbortController();
  private timer: unknown;
  private wake: (() => void) | null = null;
  private readonly detach: () => void;
  constructor(
    private readonly port: BoundDocPort,
    private readonly scheduler: DocQueueScheduler
  ) {
    if (
      !port.current() ||
      !scheduler ||
      ['schedule', 'cancel', 'random'].some(
        (key) => typeof scheduler[key as keyof DocQueueScheduler] !== 'function'
      )
    )
      throw new Error('Current bound Doc port and scheduler required.');
    this.detach = port.onRetire(() => this.retire());
  }
  /** Read bounded local counts; these are never delivery-success claims. */
  getStatus(): Readonly<{ pending: number; bytes: number; unconfirmed: number; retired: boolean }> {
    return Object.freeze({
      pending: [...this.entries.values()].filter((e) => !e.settled).length,
      bytes: this.bytes,
      unconfirmed: [...this.entries.values()].filter((e) => e.unconfirmed).length,
      retired: this.retired,
    });
  }
  /** Snapshot a strict public envelope once; duplicate pending IDs reuse only identical original bytes. */
  emit(value: unknown): Promise<DocQueueOutcome> {
    if (!this.live()) return Promise.resolve({ kind: 'cancelled' });
    const parsed = PageEventSchema.safeParse(value);
    if (!parsed.success) return Promise.resolve({ kind: 'refused' });
    if (!this.live()) return Promise.resolve({ kind: 'cancelled' });
    const bytes = JSON.stringify(parsed.data),
      id = parsed.data.id;
    const prior = this.entries.get(id);
    if (prior) return prior.bytes === bytes ? prior.promise : Promise.resolve({ kind: 'refused' });
    // Include retained immutable birth/scope and retry/ambiguity metadata, not just payload size.
    const weight =
      new TextEncoder().encode(
        JSON.stringify({
          bytes,
          id,
          birth: this.port.binding.incarnation,
          scope: this.port.binding.scope,
          loadToken: this.port.binding.observation.token,
          publisherEpoch: this.port.binding.observation.publisherEpoch,
          sent: false,
          settled: false,
          unconfirmed: false,
          attempts: 8,
          retryAfterMs: 30_000,
        })
      ).byteLength + 1024;
    for (const cached of this.entries.values()) {
      if (this.entries.size < 100 && this.bytes + weight <= 1_048_576) break;
      if (cached.settled && !cached.unconfirmed) {
        this.entries.delete(cached.id);
        this.bytes -= cached.weight;
      }
    }
    if (this.entries.size >= 100 || this.bytes + weight > 1_048_576)
      return Promise.resolve({ kind: 'refused' });
    let resolve!: (outcome: DocQueueOutcome) => void;
    const promise = new Promise<DocQueueOutcome>((done) => {
      resolve = done;
    });
    this.entries.set(id, {
      id,
      bytes,
      weight,
      sent: false,
      settled: false,
      unconfirmed: false,
      resolve,
      promise,
    });
    this.bytes += weight;
    void this.pump();
    return promise;
  }
  /** Invalidate immediately; already-sent work is unconfirmed, unsent work is canceled. */
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    this.abort.abort();
    if (this.timer !== undefined) {
      try {
        this.scheduler.cancel(this.timer);
      } catch {
        /* Continue draining. */
      }
    }
    this.timer = undefined;
    this.wake?.();
    this.wake = null;
    for (const entry of this.entries.values())
      this.settle(entry, { kind: entry.sent ? 'unconfirmed' : 'cancelled' });
    this.entries.clear();
    this.bytes = 0;
    this.detach?.();
  }
  private settle(entry: Entry, outcome: DocQueueOutcome): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.unconfirmed = outcome.kind === 'unconfirmed';
    entry.resolve(outcome);
    // Uncertainty remains bounded against duplicate local resubmission until retirement.
    if (outcome.kind !== 'unconfirmed' && outcome.kind !== 'accepted') {
      this.entries.delete(entry.id);
      this.bytes -= entry.weight;
    }
  }
  private live(): boolean {
    if (this.retired || this.abort.signal.aborted) return false;
    const current = this.port.current();
    // The owner predicate can retire the queue while still returning true.
    return current && !this.retired && !this.abort.signal.aborted;
  }
  private cancel(timer: unknown): void {
    try {
      if (timer !== undefined) this.scheduler.cancel(timer);
    } catch {
      /* A failing cleanup cannot prevent settlement or sibling draining. */
    }
  }
  private async wait(delay: number): Promise<void> {
    if (!this.live()) {
      this.retire();
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: unknown;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this.wake === finish) this.wake = null;
        resolve();
      };
      this.wake = finish;
      try {
        timer = this.scheduler.schedule(() => {
          if (this.timer === timer) this.timer = undefined;
          finish();
        }, delay);
        // Retirement or a synchronous timer may finish before its handle exists.
        if (!this.live() || settled) {
          this.cancel(timer);
          finish();
          if (!this.live()) this.retire();
          return;
        }
        this.timer = timer;
      } catch {
        finish();
        this.retire();
      }
    });
  }
  private async call<T>(run: (signal: AbortSignal) => Promise<T>, fallback: T): Promise<T> {
    if (!this.live()) {
      this.retire();
      return fallback;
    }
    const abort = new AbortController();
    let finish: (value: T) => void = () => {};
    let timer: unknown;
    const stop = () => {
      abort.abort();
      this.cancel(timer);
      finish(fallback);
    };
    this.abort.signal.addEventListener('abort', stop, { once: true });
    try {
      return await new Promise<T>((resolve) => {
        let settled = false;
        finish = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        timer = this.scheduler.schedule(() => {
          abort.abort();
          finish(fallback);
        }, 15_000);
        // A returned handle is provisional until callbacks leave this call live.
        if (!this.live() || this.abort.signal.aborted || abort.signal.aborted || settled) {
          stop();
          if (!this.live()) this.retire();
          return;
        }
        try {
          void Promise.resolve(run(abort.signal)).then(finish, () => finish(fallback));
        } catch {
          finish(fallback);
        }
      });
    } finally {
      this.abort.signal.removeEventListener('abort', stop);
      this.cancel(timer);
    }
  }
  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const entry of this.entries.values()) {
        if (entry.settled) continue;
        let needsInspection = false;
        for (let attempts = 0; attempts < 8 && !entry.settled; attempts++) {
          if (!this.live()) {
            this.retire();
            break;
          }
          if (!entry.original) {
            entry.original =
              this.port.captureOriginal(Object.freeze({ id: entry.id, bytes: entry.bytes })) ??
              undefined;
            if (!entry.original || !this.live()) {
              this.settle(entry, { kind: entry.sent ? 'unconfirmed' : 'refused' });
              break;
            }
          }
          const original = entry.original;
          if (needsInspection) {
            let inspected;
            try {
              inspected = await this.call((signal) => original.inspect(signal), {
                kind: 'unknown' as const,
              });
            } catch {
              this.settle(entry, { kind: 'unconfirmed' });
              break;
            }
            if (!this.live()) {
              this.retire();
              break;
            }
            if (inspected.kind === 'accepted') {
              const receipt = checkedDocReceipt(entry.id, inspected.receipt);
              this.settle(entry, receipt ? { kind: 'accepted', receipt } : { kind: 'unconfirmed' });
              break;
            }
            if (inspected.kind !== 'absent') {
              this.settle(entry, { kind: 'unconfirmed' });
              if (inspected.kind === 'terminal') this.retire();
              break;
            }
          }
          entry.sent = true;
          let result;
          try {
            result = await this.call((signal) => original.submit(signal), {
              kind: 'uncertain' as const,
            });
          } catch {
            result = { kind: 'uncertain' as const };
          }
          if (!this.live()) {
            this.retire();
            break;
          }
          if (result.kind === 'accepted') {
            const receipt = checkedDocReceipt(entry.id, result.receipt);
            this.settle(entry, receipt ? { kind: 'accepted', receipt } : { kind: 'unconfirmed' });
            break;
          }
          if (result.kind === 'terminal') {
            this.settle(entry, { kind: 'unconfirmed' });
            this.retire();
            break;
          }
          needsInspection = true;
          const random = this.scheduler.random();
          if (!this.live() || entry.settled) {
            this.retire();
            break;
          }
          const delay =
            result.kind === 'retry' && Number.isFinite(result.retryAfterMs)
              ? Math.max(0, Math.min(30_000, result.retryAfterMs))
              : 500;
          await this.wait(
            delay + Math.floor(Math.max(0, Math.min(1, Number.isFinite(random) ? random : 0)) * 250)
          );
        }
        if (!entry.settled) this.settle(entry, { kind: 'unconfirmed' });
      }
    } catch {
      this.retire();
    } finally {
      this.running = false;
    }
  }
}
