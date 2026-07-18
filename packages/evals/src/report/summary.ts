/**
 * Run-level reporting: the machine-readable `results.json` (validated against
 * {@link RunSummarySchema}) that CI attaches and failure-filing reads, plus a
 * human console table. A quarantined eval is always rendered as `quarantined` —
 * never silently dropped (spec §8, flake policy).
 *
 * @module evals/report/summary
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RunSummarySchema, type EvalResult, type RunSummary } from '../types.js';

/** The results file name written into a run directory. */
export const RESULTS_FILE = 'results.json';

/**
 * Write `results.json` into the run directory, validating the summary against
 * {@link RunSummarySchema} first (a malformed report is a bug, not an artifact).
 *
 * @param runDir - The run's output directory.
 * @param summary - The run summary to persist.
 * @returns The absolute path written.
 */
export async function writeResults(runDir: string, summary: RunSummary): Promise<string> {
  const validated = RunSummarySchema.parse(summary);
  await mkdir(runDir, { recursive: true });
  const file = path.join(runDir, RESULTS_FILE);
  await writeFile(file, JSON.stringify(validated, null, 2) + '\n', 'utf8');
  return file;
}

/** The status cell for one eval — `quarantined` wins over the raw status. */
function statusLabel(result: EvalResult): string {
  return result.quarantined ? 'quarantined' : result.status;
}

/** Pad a cell to a fixed width for the console table. */
function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/**
 * Render a run summary as a fixed-width console table plus a totals footer. Each
 * row shows the status (quarantined evals labeled `quarantined`), id, tier,
 * cost, and duration; the footer sums pass/fail/quarantined and total cost.
 *
 * @param summary - The run summary to render.
 * @returns The table as a multi-line string.
 */
export function formatSummaryTable(summary: RunSummary): string {
  const header = `${pad('STATUS', 20)} ${pad('ID', 26)} ${pad('TIER', 18)} ${pad('COST', 9)} DURATION`;
  const rows = summary.results.map((r) => {
    const cost = `$${r.costUsd.toFixed(4)}`;
    const duration = `${Math.round(r.durationMs)}ms`;
    return `${pad(statusLabel(r), 20)} ${pad(r.id, 26)} ${pad(r.runtimeTier, 18)} ${pad(cost, 9)} ${duration}`;
  });

  const passed = summary.results.filter((r) => r.status === 'pass' && !r.quarantined).length;
  const failed = summary.results.filter((r) => r.status === 'fail' && !r.quarantined).length;
  const errored = summary.results.filter((r) => r.status === 'error' && !r.quarantined).length;
  const skipped = summary.results.filter((r) => r.status === 'skipped-over-budget').length;
  const quarantined = summary.results.filter((r) => r.quarantined).length;

  const footer =
    `${passed} passed, ${failed} failed, ${errored} errored, ${skipped} skipped, ${quarantined} quarantined` +
    ` · $${summary.totalCostUsd.toFixed(4)} / $${summary.budgetUsd.toFixed(2)} budget`;

  return [header, ...rows, '', footer].join('\n');
}

/**
 * Whether a run should fail its gate: any non-quarantined eval that failed,
 * errored, or was skipped over budget gates; quarantined evals never gate.
 *
 * @param summary - The run summary.
 * @returns True when the run must be treated as failed by CI / the CLI exit code.
 */
export function runGateFailed(summary: RunSummary): boolean {
  return summary.results.some(
    (r) =>
      !r.quarantined &&
      (r.status === 'fail' || r.status === 'error' || r.status === 'skipped-over-budget')
  );
}
