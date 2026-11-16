/** Bounded follow-up scans for directory notifications that represent only part of a burst. */
import { outsideAuditScope } from '../../audit/audit-context.js';
import { logger } from '../../../lib/logger.js';
import { scanTaskRoot, type ReadOutcome } from '../skills-root-discovery.js';
import type { TaskRoot } from '../skills-roots.js';

/** At most one recovery scan per second per root, even under continuous directory cues. */
export const TASK_DIRECTORY_CATCH_UP_MS = 1000;

/** One timer, one running scan, and one dirty follow-up; stop cancels and drains them. */
export class TaskWatchCatchUp {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private begun = false;
  private stopped = false;
  private dirty = false;
  private resolveReady!: () => void;
  readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  constructor(
    private readonly run: () => Promise<void>,
    private readonly active: () => boolean,
    private readonly startupMs: number,
    private readonly report: (error: unknown) => void
  ) {}

  /** Called once native ready (or an error) permits the existing startup scan. */
  begin(): void {
    if (this.stopped || this.begun) return;
    this.begun = true;
    this.schedule(this.startupMs);
  }

  /** A directory cue is evidence to look again, never a complete list of changes. */
  request(): void {
    if (this.stopped || !this.active()) return;
    this.dirty = true;
    if (this.begun && !this.timer && !this.running) this.schedule(TASK_DIRECTORY_CATCH_UP_MS);
  }

  /** Resolve startup waiters, cancel queued work, and drain an already running scan. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty = false;
    this.resolveReady();
    await this.running;
  }

  private schedule(delay: number): void {
    if (this.stopped || !this.active()) return;
    this.timer = setTimeout(
      outsideAuditScope(() => {
        this.timer = undefined;
        this.dirty = false;
        this.running = Promise.resolve()
          .then(() => {
            if (!this.stopped && this.active()) return this.run();
          })
          .catch(this.report)
          .finally(() => {
            this.running = undefined;
            this.resolveReady();
            if (this.dirty && !this.stopped && this.active())
              this.schedule(TASK_DIRECTORY_CATCH_UP_MS);
          });
      }),
      delay
    );
    this.timer.unref?.();
  }
}

/** Reuse the same discovery policy for startup and directory-burst recovery. */
export async function scanTaskWatchRoot(
  root: TaskRoot,
  apply: (outcome: ReadOutcome) => Promise<void>,
  active: () => boolean
): Promise<void> {
  if (!active()) return;
  let outcomes: ReadOutcome[];
  try {
    outcomes = await scanTaskRoot(root);
  } catch (error) {
    logger.warn(`[TaskFileWatcher] Could not scan ${root.dir} after arming its watch`, error);
    return;
  }
  // A failed row must not abandon every later file, or escape a native callback.
  for (const outcome of outcomes) {
    if (!active()) return;
    try {
      await apply(outcome);
    } catch (error) {
      logger.error(`[TaskFileWatcher] Failed to process ${outcome.filePath}`, error);
    }
  }
}

/** Wait for every close/scan even when another fails, then preserve the first refusal. */
export async function drainTaskWatchWork(
  work: readonly (Promise<unknown> | undefined)[]
): Promise<void> {
  for (const result of await Promise.allSettled(work)) {
    if (result.status === 'rejected') throw result.reason;
  }
}
