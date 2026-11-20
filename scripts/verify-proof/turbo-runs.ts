import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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
 * shows a run where each task that started also finished, and none failed. Every
 * way out of the gate then clears the summaries the run wrote, keeping only the
 * newest unfinished one for the person to read.
 *
 * The counts are turbo's own (`execution` in the run summary, schema version 1):
 * `attempted` is every task that started, `success` the ones that ran and passed,
 * `cached` the cache hits (not counted in `success`), and `failed` the failures.
 * A task cancelled by a signal adds to `attempted` and to nothing else, so
 * `success + cached < attempted` is exactly a run that was cut short.
 */

/**
 * The turbo release whose run summary this file was read against: the meaning of
 * `attempted`, `success`, `cached` and `failed` above is turbo's
 * `crates/turborepo-run-summary/src/execution.rs` at that tag. A test holds it to the
 * turbo version in package.json, so a turbo upgrade fails until someone re-reads that
 * file and moves this along with it.
 */
export const TURBO_SUMMARY_READ_AGAINST = '2.10.13';

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

/** Read one run summary file and judge it. */
function judgeFile(file: string): string | undefined {
  let run: Execution | undefined;
  try {
    run = execution(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    run = undefined;
  }
  return judge(file, run);
}

/** When a file was last written, or 0 when it can no longer be read. */
function modified(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** What {@link watchTurboRuns} returns: the check, and the clean-up after it. */
export interface TurboRunsWatch {
  /**
   * Read the run summaries written since the watch began. Removes nothing.
   *
   * @returns Why the runs do not show a finished gate, or `undefined` when they do.
   */
  unfinished(): string | undefined;
  /**
   * Remove every run summary written since the watch began, except the newest one
   * that does not show a finished run, so the person can read it. Called on every
   * way out of a gate, passed or not, so summaries never pile up in `.turbo/runs`.
   *
   * @returns The path of the summary kept, or `undefined` when none was.
   */
  tidy(): string | undefined;
}

/**
 * Start watching for the run summaries a gate's turbo steps write.
 *
 * @param root - The repository root, where turbo writes `.turbo/runs/`.
 * @param expected - How many turbo runs the gate makes, each with `--summarize`.
 * @returns The check to make after the gate exits 0, and the clean-up after it.
 */
export function watchTurboRuns(root: string, expected: number): TurboRunsWatch {
  const dir = path.join(root, '.turbo', 'runs');
  const before = new Set(summaries(dir));
  const written = () =>
    summaries(dir)
      .filter((name) => !before.has(name))
      .map((name) => path.join(dir, name));
  return {
    unfinished() {
      const files = written();
      if (files.length !== expected) {
        return (
          `expected ${expected} turbo run ${expected === 1 ? 'summary' : 'summaries'} ` +
          `in .turbo/runs, found ${files.length}`
        );
      }
      const reasons = files.map(judgeFile).filter((reason) => reason !== undefined);
      return reasons.length > 0 ? reasons.join('; ') : undefined;
    },
    tidy() {
      const [keep] = written()
        .filter((file) => judgeFile(file) !== undefined)
        .sort((a, b) => modified(b) - modified(a));
      for (const file of written()) if (file !== keep) rmSync(file, { force: true });
      return keep;
    },
  };
}
