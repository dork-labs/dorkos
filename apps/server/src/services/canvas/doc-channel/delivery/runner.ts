/** One serialized recovery/pending runner; timers carry no authority. */
import type { DocBatchDeliveryPump } from './pump.js';
import type { DocRecoveryCursor } from './resume.js';
import type { DocWarningCursor } from './warnings.js';
const RETRY_MS = 60_000;
const YIELD_MS = 100;
/** Boot composition installs real gates before starting the runner. */
export interface DocDeliveryRunnerOptions {
  pump: Pick<DocBatchDeliveryPump, 'resumeAcceptedPage' | 'run'>;
  now: () => Date;
  onError(error: unknown): void;
}
/** Retain one timer, one active pass, and dirty requests arriving while preparation awaits. */
export class DocDeliveryRunner {
  private timer?: ReturnType<typeof setTimeout>;
  private timerAt?: number;
  private running?: Promise<void>;
  private started = false;
  private stopped = false;
  private dirty = false;
  private nextDelay = RETRY_MS;
  private cursor?: DocRecoveryCursor;
  private integrityCursor?: DocRecoveryCursor;
  private warningCursor?: DocWarningCursor;
  constructor(private readonly options: DocDeliveryRunnerOptions) {}
  /** Whether a post-await scheduling hint may still notify the existing dispatcher. */
  get active(): boolean {
    return this.started && !this.stopped;
  }
  /** Start only after shared-source boot repair and interrupted-attempt quarantine. */
  start(): void {
    if (this.stopped) throw new Error('Document delivery runner has stopped.');
    if (this.started) return;
    this.started = true;
    this.wake();
  }
  /** Coalesce committed hints; an active pass always gets a later bounded rerun. */
  wake(): void {
    if (!this.active) return;
    this.dirty = true;
    if (!this.running && (!this.timer || this.timerAt! > this.options.now().getTime() + YIELD_MS))
      this.arm(YIELD_MS);
  }
  /** Detach callers first, then await preparation before database disposal. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.dirty = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = undefined;
    await this.running;
  }
  private arm(delay: number): void {
    if (!this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = this.options.now().getTime() + delay;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerAt = undefined;
      this.launch();
    }, delay);
    this.timer.unref?.();
  }
  private launch(): void {
    if (!this.active || this.running) return;
    this.running = this.pass();
    void this.running.finally(() => {
      this.running = undefined;
      if (this.active) this.arm(this.dirty ? YIELD_MS : this.nextDelay);
    });
  }
  private async pass(): Promise<void> {
    this.dirty = false;
    this.nextDelay = RETRY_MS;
    try {
      const recovered = await this.options.pump.resumeAcceptedPage(
        this.cursor,
        this.integrityCursor,
        () => this.active,
        this.warningCursor
      );
      if (!this.active) return;
      this.cursor = recovered.hasMore ? recovered.cursor : undefined;
      this.integrityCursor = recovered.hasIntegrityMore ? recovered.integrityCursor : undefined;
      this.warningCursor = recovered.hasWarningMore ? recovered.warningCursor : undefined;
      const pending = this.options.pump.run(100);
      const deadlines = [recovered.nextEligibleAt, pending.nextEligibleAt]
        .filter((at): at is string => at !== null)
        .map((at) => Date.parse(at));
      if (deadlines.some((at) => !Number.isFinite(at)))
        throw new Error('Invalid document delivery wake time.');
      if (recovered.hasMore || recovered.hasIntegrityMore || recovered.hasWarningMore)
        this.nextDelay = YIELD_MS;
      else if (
        recovered.retryableFailures &&
        !pending.admitted &&
        !pending.waiting &&
        !pending.expired &&
        !pending.cancelled
      )
        this.nextDelay = RETRY_MS;
      else if (deadlines.length)
        this.nextDelay = Math.max(
          YIELD_MS,
          Math.min(RETRY_MS, Math.min(...deadlines) - this.options.now().getTime())
        );
    } catch (error) {
      this.nextDelay = RETRY_MS;
      try {
        this.options.onError(error);
      } catch {
        // Diagnostics cannot stop durable recovery.
      }
    }
  }
}
