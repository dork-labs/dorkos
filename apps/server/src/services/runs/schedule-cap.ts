/**
 * The scheduler's cap on how many task turns run at once
 * (`scheduler.maxConcurrentRuns`), as admission reads it (spec
 * `turns-survive-restarts` §3.5, T12): a task's run that finds every slot
 * taken waits as `machine_full`, and goes when one frees, where the scheduler
 * used to skip the fire.
 *
 * A slot is claimed in the same synchronous step as admission's answer, before
 * the hand-over awaits anything, so two runs never both take the last one; it
 * is let go when the run's turn is over, when it goes back in line, or when the
 * hand-over did not take. Task runs the scheduler drives outside the port (a
 * run it hands the relay) count too, through the source the scheduler sets.
 *
 * @module services/runs/schedule-cap
 */
import type { RunStatus } from '@dorkos/shared/turn-port';
import type { TurnRun } from './run-store.js';

/** What the scheduler tells the cap: its limit, and its runs the port does not hold. */
export interface ScheduleCapSource {
  /** The most task turns that may run at once. */
  limit: () => number;
  /** The scheduler's live runs outside the port (the relay's), counted against the limit. */
  elsewhere: () => number;
}

/** The statuses a claimed slot is kept through: handed over, launching, running. */
const HOLDING: ReadonlySet<RunStatus> = new Set(['queued', 'starting', 'started', 'running']);

/** The cap. See the module documentation. */
export class ScheduleCap {
  private readonly claimed = new Set<string>();
  private source: ScheduleCapSource | undefined;

  /**
   * Build the cap.
   *
   * @param freed - Called when a slot frees, so the runs waiting for one look again.
   */
  constructor(private readonly freed: () => void) {}

  /**
   * Set (or clear) what the scheduler says. With none, nothing is capped here.
   *
   * @param source - The scheduler's limit and its other live runs.
   */
  setSource(source: ScheduleCapSource | undefined): void {
    this.source = source;
  }

  /** Whether every slot is taken. */
  full(): boolean {
    if (!this.source) return false;
    return this.claimed.size + this.source.elsewhere() >= this.source.limit();
  }

  /**
   * Take a slot for a run admission just let go. Only a task's run takes one.
   *
   * @param run - The run.
   */
  claim(run: Pick<TurnRun, 'id' | 'origin'>): void {
    if (run.origin?.kind === 'schedule') this.claimed.add(run.id);
  }

  /**
   * Let a run's slot go: its hand-over did not take.
   *
   * @param runId - The run.
   */
  release(runId: string): void {
    if (this.claimed.delete(runId)) this.freed();
  }

  /**
   * A run moved: its slot goes once its turn is over, or when it went back in
   * line from a launch (it claims again when admission next lets it go).
   *
   * @param run - The run, as stored after the move.
   * @param from - The status it left.
   */
  onRunMoved(run: TurnRun, from: RunStatus): void {
    if (!this.claimed.has(run.id)) return;
    const backInLine = run.status === 'queued' && from !== 'queued';
    if (!HOLDING.has(run.status) || backInLine) this.release(run.id);
  }
}
