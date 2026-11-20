import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Whether the turbo runs a gate made all finished (DOR-4616).
 *
 * turbo's exit code is not enough. A turbo that is stopped by a signal shuts its
 * tasks down, prints its summary and returns the run's result, and a task it
 * cancelled is not a failure, so the run can exit 0 with tasks that never
 * finished: one `pnpm verify` stopped with TERM printed "29 successful, 35 total"
 * and exited 0, and a proof was recorded for it. So each turbo step in a gate runs
 * with `--summarize`, which writes the run's own counts to
 * `.turbo/runs/<id>.json`, and a proof is recorded only when every one of them
 * shows a run where each task that started also finished, and none failed.
 *
 * The counts are turbo's own (`execution` in the run summary, schema version 1):
 * `attempted` is every task that started, `success` the ones that ran and passed,
 * `cached` the cache hits (not counted in `success`), and `failed` the failures.
 * A task cancelled by a signal adds to `attempted` and to nothing else, so
 * `success + cached < attempted` is exactly a run that was cut short.
 */

/** The fields of turbo's `execution` block this check reads. */
interface Execution {
  attempted: number;
  success: number;
  cached: number;
  failed: number;
  exitCode: number;
}

const COUNTS = ['attempted', 'success', 'cached', 'failed', 'exitCode'] as const;

/** turbo's `execution` block, or `undefined` when the file does not hold one. */
function execution(summary: unknown): Execution | undefined {
  if (typeof summary !== 'object' || summary === null) return undefined;
  const block = (summary as { execution?: unknown }).execution;
  if (typeof block !== 'object' || block === null) return undefined;
  const record = block as Record<string, unknown>;
  return COUNTS.every((key) => Number.isInteger(record[key]))
    ? (record as unknown as Execution)
    : undefined;
}

/** The run summary files in `dir`, by name; none when it does not exist yet. */
function summaries(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}

/** Why one run summary does not show a finished run, or `undefined` when it does. */
function judge(file: string, run: Execution | undefined): string | undefined {
  const name = path.basename(file);
  if (!run) return `turbo's run summary ${name} could not be read`;
  const finished = run.success + run.cached;
  if (run.failed > 0 || finished !== run.attempted || run.exitCode !== 0) {
    return (
      `turbo's run summary ${name} shows ${finished} of ${run.attempted} tasks finished, ` +
      `${run.failed} failed, exit code ${run.exitCode}`
    );
  }
  return undefined;
}

/** What {@link watchTurboRuns} returns: the check to make once the gate exits 0. */
export interface TurboRunsWatch {
  /**
   * Read the run summaries written since the watch began. Each one that shows a
   * finished run is removed; one that does not is kept, so the person can read it.
   *
   * @returns Why the runs do not show a finished gate, or `undefined` when they do.
   */
  unfinished(): string | undefined;
}

/**
 * Start watching for the run summaries a gate's turbo steps write.
 *
 * @param root - The repository root, where turbo writes `.turbo/runs/`.
 * @param expected - How many turbo runs the gate makes, each with `--summarize`.
 * @returns The check to make after the gate exits 0.
 */
export function watchTurboRuns(root: string, expected: number): TurboRunsWatch {
  const dir = path.join(root, '.turbo', 'runs');
  const before = new Set(summaries(dir));
  return {
    unfinished() {
      const written = summaries(dir)
        .filter((name) => !before.has(name))
        .map((name) => path.join(dir, name));
      if (written.length !== expected) {
        return (
          `expected ${expected} turbo run ${expected === 1 ? 'summary' : 'summaries'} ` +
          `in .turbo/runs, found ${written.length}`
        );
      }
      const reasons: string[] = [];
      for (const file of written) {
        let run: Execution | undefined;
        try {
          run = execution(JSON.parse(readFileSync(file, 'utf8')));
        } catch {
          run = undefined;
        }
        const reason = judge(file, run);
        if (reason) reasons.push(reason);
        else rmSync(file, { force: true });
      }
      return reasons.length > 0 ? reasons.join('; ') : undefined;
    },
  };
}
