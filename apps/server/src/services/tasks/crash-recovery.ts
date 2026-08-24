/**
 * Ending the runs a crash left behind — and ONLY those (DOR-1482).
 *
 * ## The mistake this replaces
 *
 * `start()` used to call `markRunningAsFailed()`, a bare UPDATE of every row in
 * the table that said `running`, on every boot of every process. ADR-285's whole
 * premise is that N processes share one `dorkHome` and therefore one database —
 * the cockpit on :4242, a dev server on :6242, the desktop app — so the second
 * process to boot marked the FIRST process's live runs failed. The damage was
 * not cosmetic: the terminal-status guard then refused the real `completed`
 * write when that run finished, so the true outcome was discarded, and the
 * terminal hook fired a `task_run_failed` broadcast plus an inbox notification
 * for a run that was working perfectly, which the escalation ladder can carry as
 * far as somebody's phone.
 *
 * ## The rule
 *
 * A `running` row does not say which process owns it, so "orphaned by a crash"
 * and "in flight somewhere else" are not directly distinguishable. Rather than
 * guess, the sweep acts only where ownership is IMPLIED by something already
 * true. A row is failed when:
 *
 * 1. **This process holds no leader lock at all.** Single-process installs and
 *    tests: nothing else could have written the row, so every unfinished run is
 *    this process's own from before the restart.
 * 2. **The run is `scheduled` and this process is the leader.** Only the leader
 *    creates scheduled runs (`dispatch()` returns early for a follower), and
 *    leadership is exclusive — so a scheduled run still marked running was
 *    started by a leader that no longer exists.
 * 3. **The run has outlived its task's own `maxRuntime`, by the lock's stale
 *    margin.** Whatever process owns such a run would have aborted it at the
 *    deadline (`AbortSignal.timeout` in `executeRunDirect`, the dispatch budget
 *    on the relay path). Past it, no live process can still be running it.
 *
 * Everything else is left exactly as it is: a manual run with no deadline,
 * started by a process that may well still be alive and working on it. That is
 * the deliberate residual — a manual run orphaned by a crash on a machine that
 * runs several DorkOS processes keeps saying `running` until a person cancels
 * it. Left that way on purpose: a stale row somebody can clear is a smaller
 * harm than a live run reported as failed, and closing it properly needs the run
 * row to record which process owns it, which is a schema change and an ADR, not
 * a bug fix.
 *
 * A follower sweeps nothing at all. It is not entitled to fire, and it is not
 * entitled to end other processes' work either.
 *
 * ## Runs this process is executing are never swept, by any rule
 *
 * The rules above reason about a run's PROBABLE owner. For one set of runs
 * there is no need to reason: the ones this process is running itself, which it
 * holds in {@link RunAccounting}. That matters because the sweep is not only a
 * boot-time thing — a follower promoted when the leader dies sweeps at the
 * moment of promotion, and by then it may well be executing runs of its own.
 * A process that stalls past the lock's stale TTL (a closed laptop is enough)
 * has its lock stolen and can be promoted again minutes later, and rule 2 would
 * then fail its OWN live scheduled run: written failed while its
 * `AbortController` is still held, its real completion refused by the terminal
 * guard, and a `task_run_failed` raised about work that is still going.
 *
 * @module services/tasks/crash-recovery
 */
import type { TaskStore } from './task-store.js';
import { SCHEDULER_LOCK_STALE_TTL_MS, type LeaderLock } from './scheduler-lock.js';

/** What one sweep did, for the caller to log. */
export interface InterruptedRunSweep {
  /** Runs marked failed. */
  swept: number;
  /**
   * Unfinished runs deliberately left alone, because nothing proves this
   * process is entitled to end them.
   */
  left: number;
}

/**
 * Mark the runs a crash left behind as failed, under the rule this module
 * documents.
 *
 * @param store - The task store to read candidates from and write outcomes to.
 * @param leaderLock - This process's leader lock, or null when it has none
 *   (single-process and test setups, where this process is always the leader).
 * @param liveHere - Runs this process is executing right now; never swept,
 *   whatever the rules below would otherwise say about them.
 * @returns How many runs were ended and how many were left alone.
 */
export function sweepInterruptedRuns(
  store: TaskStore,
  leaderLock: LeaderLock | null,
  liveHere: ReadonlySet<string> = new Set()
): InterruptedRunSweep {
  // A follower ends nothing. Its own runs, if any, are covered by rule 3 on the
  // leader's next boot or by its own boot once it is promoted.
  if (leaderLock && !leaderLock.isLeaderNow) {
    return { swept: 0, left: store.getRunningRuns().length };
  }

  // Whatever else is true below, a run THIS process is executing is not an
  // orphan — see the note above about promotion.
  const running = store.getRunningRuns().filter((run) => !liveHere.has(run.id));
  if (running.length === 0) return { swept: 0, left: 0 };

  // Rule 1: nobody else can own these rows.
  if (!leaderLock) {
    return { swept: store.markRunsInterrupted(running.map((run) => run.id)), left: 0 };
  }

  const now = Date.now();
  const doomed: string[] = [];
  for (const run of running) {
    // Rule 2: only a leader writes a scheduled run, and this process is the
    // leader now — so whoever wrote this one is gone.
    if (run.trigger === 'scheduled') {
      doomed.push(run.id);
      continue;
    }

    // Rule 3: past its own deadline plus the margin in which a dead leader is
    // still believed alive, no process can still be executing it.
    const maxRuntime = store.getTask(run.scheduleId)?.maxRuntime;
    if (!maxRuntime) continue;
    // A row with no readable start cannot be shown to be past anything, so it
    // is left alone rather than guessed at.
    if (!run.startedAt) continue;
    const startedAt = Date.parse(run.startedAt);
    if (Number.isNaN(startedAt)) continue;
    if (now - startedAt > maxRuntime + SCHEDULER_LOCK_STALE_TTL_MS) doomed.push(run.id);
  }

  return {
    swept: doomed.length > 0 ? store.markRunsInterrupted(doomed) : 0,
    left: running.length - doomed.length,
  };
}
