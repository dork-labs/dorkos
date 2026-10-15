/**
 * The rules rung of triage (spec `heartbeats` §6.1): free, deterministic, and
 * honest about what it cannot tell.
 *
 * - `quiet`: nothing needs the agent — only informational changes, and only
 *   ones that touch nothing serious.
 * - `work`: the agent should work on it now — a local message to it unanswered,
 *   an overdue commitment, a failed or parked run, a lost connection, a failing
 *   check on its own branch.
 * - `undecided`: anything else, including any change with non-empty
 *   `touches`. In PR 3 `undecided` means a turn: unsure goes up to the runtime,
 *   never down to silence (canon §5.2 step 3).
 *
 * During a failure storm (§7.5) a change derived from the agent's own beat
 * failures does not trigger a turn on its own, so a failing runtime is not
 * asked to look at its own failure every beat. A standing condition (a lost
 * connection, a failing check, a promise due) counts once, when it first
 * appears or changes, not on every beat it is still true.
 *
 * @module services/heartbeats/triage-rules
 */
import type { Change } from './gatherers/index.js';

/** The rules rung's answer. */
export type TriageVerdict = 'quiet' | 'work' | 'undecided';

/** Signals that mean "work on it now". */
const WORK_SIGNALS: ReadonlySet<Change['signal']> = new Set([
  'unanswered',
  'commitment-overdue',
  'run-failed',
  'connection-lost',
  'check-failed',
]);

/**
 * Signals that never need the agent by themselves. A heavy day of beat turns is
 * a record line: a turn about it would add to it.
 */
const QUIET_SIGNALS: ReadonlySet<Change['signal']> = new Set(['info', 'usage-high']);

/**
 * Standing conditions: true until something changes, so seen every beat. One
 * counts as work only the first time its key (with its signal) appears.
 */
export const STANDING_SIGNALS: ReadonlySet<Change['signal']> = new Set([
  'connection-lost',
  'check-failed',
  'commitment-due',
  'commitment-overdue',
]);

/**
 * What identifies a standing condition from one beat to the next.
 *
 * @param change - The change.
 */
export function standingKey(change: Change): string {
  return `${change.key}|${change.signal}`;
}

/** Signals derived from the agent's own beats failing. */
const FAILURE_SIGNALS: ReadonlySet<Change['signal']> = new Set(['beat-failed']);

/** What triage reads besides the changes. */
export interface TriageContext {
  /** Whether the agent is in a failure storm (§7.5). */
  failureStorm: boolean;
  /** The standing conditions the last beat already saw ({@link standingKey}). */
  seenStanding?: ReadonlySet<string>;
}

/**
 * Triage a beat's changes by the rules.
 *
 * @param changes - What the gatherers found.
 * @param context - The agent's failure state.
 * @returns The verdict and the changes it counted.
 */
export function triageByRules(
  changes: readonly Change[],
  context: TriageContext
): { verdict: TriageVerdict; considered: Change[] } {
  const seen = context.seenStanding ?? new Set<string>();
  const considered = changes.filter(
    (change) =>
      !(context.failureStorm && FAILURE_SIGNALS.has(change.signal)) &&
      !(STANDING_SIGNALS.has(change.signal) && seen.has(standingKey(change)))
  );
  if (considered.length === 0) return { verdict: 'quiet', considered };
  if (considered.some((change) => WORK_SIGNALS.has(change.signal))) {
    return { verdict: 'work', considered };
  }
  const allQuiet = considered.every(
    (change) => QUIET_SIGNALS.has(change.signal) && (change.touches?.length ?? 0) === 0
  );
  return { verdict: allQuiet ? 'quiet' : 'undecided', considered };
}
