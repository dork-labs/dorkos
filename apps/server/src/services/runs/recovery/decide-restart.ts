/**
 * What follows a run a restart ended (spec `turns-survive-restarts` §7.3,
 * step 4): the rule, first match wins, read off the run and a few facts the
 * boot knows. Decides only; `run-recovery.ts` writes what it decided.
 *
 * @module services/runs/recovery/decide-restart
 */
import { RUNS } from '../../../config/constants.js';
import type { RestartDecision, TurnRun } from '../run-store.js';

/** What the rule reads beside the run. */
export interface RestartFacts {
  /** The clock, epoch ms. */
  now: number;
  /** This boot's epoch: a run it owned saw no restart. */
  epoch: string;
  /** Whether a runtime declares `continuesInterruptedTurn` (§7.2); unknown is no. */
  continues: (runtime: string | null) => boolean;
  /** How many continuations a chain already has. */
  continuationsInChain: (chainId: string) => number;
  /**
   * Whether something other than the run record owns what follows the run: a
   * task's run or a room's claim that already settled (§7.3).
   */
  settledElsewhere: (run: TurnRun) => boolean;
}

/**
 * A run's last sign of life, epoch ms: when it was last known to be alive.
 * A run that died with its owner keeps the lease it last renewed, and that
 * lease (or a later recorded fact) is its last sign; any other ended run's is
 * its `ended_at`. Read so a server that was down for a weekend never counts
 * from the moment recovery happened to look (§7.3, "The age bound").
 *
 * @param run - The run.
 */
export function lastSignOfLife(run: TurnRun): number {
  const times = [run.startedAt, run.deliveredAt, run.createdAt].flatMap((at) =>
    at === null ? [] : [Date.parse(at)]
  );
  if (run.leaseUntil !== null) return Math.max(run.leaseUntil, ...times);
  return run.endedAt !== null ? Date.parse(run.endedAt) : Math.max(...times);
}

/**
 * Whether a run's last sign of life is past the age bound (§7.3): nothing
 * starts for it any more, and no one is told but a mini app that asked.
 *
 * @param run - The run.
 * @param now - The clock, epoch ms.
 */
export function pastAgeBound(run: TurnRun, now: number): boolean {
  return now - lastSignOfLife(run) > RUNS.RESTART_AGE_BOUND_MS;
}

/**
 * What follows an undecided run (§7.1), first rule that applies (§7.3, step 4).
 * Past the age bound a run that would be continued stops instead, with its
 * line.
 *
 * @param run - The run, `ended` with `process_died` or `shutdown`.
 * @param facts - What the boot knows.
 */
export function decideRestart(run: TurnRun, facts: RestartFacts): RestartDecision {
  // This boot owned it: no restart happened, a write failed (§4.7).
  if (run.ownerEpoch === facts.epoch) return 'quiet';
  // Ended from `started`: the runtime may not have read the words, which go
  // back to whoever wrote them, never replayed.
  if (run.endingDetail.delivery === 'unknown') return 'quiet';
  // A stop someone asked for, even one no receipt confirmed (§4.4).
  if ((run.endingDetail.stopRequests?.length ?? 0) > 0) return 'quiet';
  // A private message whose outcome is unknown is never carried on: its
  // source's own `in_doubt` rule stands (§7.3, step 4; DOR-5218).
  if (run.endingDetail.outcomeUnknown) return 'quiet';
  if (run.waitingOnPerson) return 'waited_on_you';
  // A turn nobody asked for: a lost-work wake covers what died with it.
  if (run.openedBy === 'runtime') return 'quiet';
  if (!facts.continues(run.runtime)) return 'not_resumable';
  if (facts.continuationsInChain(run.chainId) >= RUNS.RESTART_CONTINUE_MAX) return 'chain_cap';
  if (facts.settledElsewhere(run)) return 'quiet';
  return pastAgeBound(run, facts.now) ? 'not_resumable' : 'continued';
}
