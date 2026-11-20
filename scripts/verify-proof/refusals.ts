import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ProofLevel } from './cli.ts';

/**
 * The record of gate runs that exited without a proof because they did not finish
 * (DOR-4616), so `tracked.unfinished-verify-proofs` and its revert condition can be
 * counted: how often a stop or an unfinished turbo step was caught, and why.
 *
 * Each refusal is one line in `refusals.jsonl` beside the proofs in the common git
 * dir, as `escapes.jsonl` is for the arm script's escape. When the run is inside a
 * hook's time-wrap it is also a note on that hook's run, the same `O` line
 * `ci_steward_note` writes (packages/ci-steward/bin/time-wrap.sh); outside one, which
 * is where `pnpm verify` usually runs, there is no run to attach it to and the note
 * is skipped, exactly as the shell function skips it.
 */

/** Why a run got no proof: a signal stopped it, or a turbo step did not finish. */
export type RefusalKind = 'stopped' | 'unfinished';

/** One refusal, as recorded. */
export interface Refusal {
  /** The commit the run was for. */
  sha: string;
  /** Which gate it was. */
  level: ProofLevel;
  /** Why it got no proof. */
  kind: RefusalKind;
  /** The line the person was shown. */
  why: string;
  /** For a stop, the exit code the run reported (128 plus the signal's number). */
  status?: number;
}

/** The note keys, lowercase and underscores only, as `ci_steward_note` requires. */
const NOTE_KEYS: Record<RefusalKind, string> = {
  stopped: 'verify_stopped',
  unfinished: 'verify_unfinished',
};

/**
 * Record one refusal. Best effort: a record that cannot be written never changes the
 * run's outcome, which is already a refusal.
 *
 * @param dir - The proof directory, `<common git dir>/dorkos-verify-proof`.
 * @param refusal - What was refused, and why.
 */
export function recordRefusal(dir: string, refusal: Refusal): void {
  const t = Math.floor(Date.now() / 1000);
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, 'refusals.jsonl'),
      JSON.stringify({ ...refusal, when: new Date(t * 1000).toISOString() }) + '\n'
    );
  } catch {
    // Best effort, as above.
  }
  // eslint-disable-next-line no-restricted-syntax -- scripts/ has no env.ts; the time-wrap exports these to its children
  const env = process.env;
  const {
    CI_STEWARD_TIMINGS,
    CI_STEWARD_TIMINGS_FILE,
    CI_STEWARD_HOOK,
    CI_STEWARD_COMMAND,
    CI_STEWARD_RUN_ID,
  } = env;
  if (CI_STEWARD_TIMINGS === '0' || !CI_STEWARD_TIMINGS_FILE) return;
  try {
    appendFileSync(
      CI_STEWARD_TIMINGS_FILE,
      JSON.stringify({
        v: 1,
        e: 'O',
        h: CI_STEWARD_HOOK ?? '',
        c: CI_STEWARD_COMMAND ?? '',
        id: CI_STEWARD_RUN_ID ?? '',
        t,
        o: NOTE_KEYS[refusal.kind],
        d: refusal.status ?? null,
      }) + '\n'
    );
  } catch {
    // Best effort, as the shell function's own write is.
  }
}
