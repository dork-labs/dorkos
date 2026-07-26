/**
 * Run-level reporting: the machine-readable `results.json` (validated against
 * {@link RunSummarySchema}) that CI attaches and failure-filing reads, plus a
 * human console table.
 *
 * ## THE CONSOLE TABLE IS WHAT PEOPLE READ
 *
 * `results.json` is a CI artifact with a retention window; the Actions log is
 * what a human actually looks at. So the table must never be more flattering
 * than the JSON beside it. Two rules follow, and both used to be broken:
 *
 * 1. a quarantined eval renders as `quarantined:<status>` — the quarantine flag
 *    is reported ALONGSIDE the outcome, never INSTEAD of it. Rendering the bare
 *    word `quarantined` under a footer reading "0 failed" hid six failing cases;
 *    the outcome was dropped even though the row was not.
 * 2. the footer states how many cases could actually fail the run. A suite whose
 *    every case is quarantined exits 0 with zero gating coverage, which is
 *    indistinguishable from a real pass unless the count is on screen — so
 *    {@link evaluateRunGate} treats gating on ZERO cases as a failure.
 *
 * @module evals/report/summary
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  RunSummarySchema,
  describeCredentialSource,
  isSubscriptionBilled,
  type EvalResult,
  type RunSummary,
} from '../types.js';

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

/**
 * The status cell for one eval. A quarantined eval reports BOTH facts —
 * `quarantined:fail` — so its outcome survives the rendering that exempts it
 * from the gate.
 */
function statusLabel(result: EvalResult): string {
  return result.quarantined ? `quarantined:${result.status}` : result.status;
}

/** Pad a cell to a fixed width for the console table. */
function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/** Minimum widths for the table's variable-width columns. */
const MIN_WIDTHS = { status: 20, id: 26, tier: 18, cost: 9 } as const;

/** Widen a column to the longest value it must hold, never below its minimum. */
function columnWidth(values: string[], minimum: number): number {
  return values.reduce((widest, v) => Math.max(widest, v.length), minimum);
}

/** Whether an eval's terminal status counts as a failure for its own row. */
function isFailure(result: EvalResult): boolean {
  return (
    result.status === 'fail' || result.status === 'error' || result.status === 'skipped-over-budget'
  );
}

/**
 * Render a run summary as a console table plus a totals footer and a GATING
 * line. Each row shows the status (a quarantined eval as `quarantined:<status>`),
 * id, tier, isolation, cost, and duration. Columns widen to fit their longest
 * value, so a long case id cannot shift the row out of alignment.
 *
 * The footer says how many quarantined evals are failing, and the GATING line
 * says how many of the run's cases could fail it at all — the one number that
 * tells a reader whether a green run proved anything.
 *
 * @param summary - The run summary to render.
 * @returns The table as a multi-line string.
 */
export function formatSummaryTable(summary: RunSummary): string {
  const cells = summary.results.map((r) => ({
    status: statusLabel(r),
    id: r.id,
    tier: r.runtimeTier,
    isolation: r.isolation ?? 'not-run',
    cost: `$${r.costUsd.toFixed(4)}`,
    duration: `${Math.round(r.durationMs)}ms`,
  }));

  const w = {
    status: columnWidth(
      cells.map((c) => c.status),
      MIN_WIDTHS.status
    ),
    id: columnWidth(
      cells.map((c) => c.id),
      MIN_WIDTHS.id
    ),
    tier: columnWidth(
      cells.map((c) => c.tier),
      MIN_WIDTHS.tier
    ),
    isolation: columnWidth(
      cells.map((c) => c.isolation),
      'ISOLATION'.length
    ),
    cost: columnWidth(
      cells.map((c) => c.cost),
      MIN_WIDTHS.cost
    ),
  };

  const header = `${pad('STATUS', w.status)} ${pad('ID', w.id)} ${pad('TIER', w.tier)} ${pad('ISOLATION', w.isolation)} ${pad('COST', w.cost)} DURATION`;
  const rows = cells.map(
    (c) =>
      `${pad(c.status, w.status)} ${pad(c.id, w.id)} ${pad(c.tier, w.tier)} ${pad(c.isolation, w.isolation)} ${pad(c.cost, w.cost)} ${c.duration}`
  );

  const gate = evaluateRunGate(summary);
  const passed = summary.results.filter((r) => r.status === 'pass' && !r.quarantined).length;
  const failed = summary.results.filter((r) => r.status === 'fail' && !r.quarantined).length;
  const errored = summary.results.filter((r) => r.status === 'error' && !r.quarantined).length;
  const skipped = summary.results.filter((r) => r.status === 'skipped-over-budget').length;

  const footer =
    `${passed} passed, ${failed} failed, ${errored} errored, ${skipped} skipped, ` +
    `${gate.quarantinedCases} quarantined (${gate.failingQuarantinedCases} of them failing)` +
    ` · $${summary.totalCostUsd.toFixed(4)} / $${summary.budgetUsd.toFixed(2)} budget`;

  const gatingLine =
    gate.gatingCases === 0
      ? `GATING: 0 of ${gate.totalCases} cases gate this run — every case is quarantined, so a green run proves nothing.`
      : `GATING: ${gate.gatingCases} of ${gate.totalCases} cases gate this run; ${gate.quarantinedCases} quarantined case(s) report but cannot fail it.`;

  const lines = [header, ...rows, '', footer, gatingLine];
  if (summary.credentialSource) {
    lines.push(`CREDENTIAL: ${describeCredentialSource(summary.credentialSource)}.`);
  }
  const costLine = costSignalLine(summary);
  if (costLine) lines.push(costLine);
  return lines.join('\n');
}

/**
 * Say something about a CREDENTIALED run that reported no cost at all, scaled to
 * WHICH credential it used. Getting this wrong in either direction is a real
 * failure: a warning that always fires teaches people to ignore it, and a warning
 * that never fires hides a broken cost signal.
 *
 * - On an **API key**, a real turn always reports a cumulative cost, so
 *   `$0.0000` means either no turn ran or the cost signal never arrived. Both
 *   mean the spend cap was never exercised, which on screen is indistinguishable
 *   from spending unmetered. That is a WARNING.
 * - On **subscription auth** (a `claude setup-token` token, or the machine's own
 *   Claude sign-in), `$0.0000` is the expected reading: those turns are paid for
 *   by the subscription and report no per-turn cost. Warning there would be a
 *   false alarm on the ordinary local path. It is still worth saying out loud
 *   that the cap did not gate anything, so this is a NOTE.
 * - `test-mode` is free by design and says nothing.
 *
 * @param summary - The run summary.
 * @returns The line to print, or undefined when there is nothing to say.
 */
function costSignalLine(summary: RunSummary): string | undefined {
  if (summary.tier === 'test-mode') return undefined;
  if (summary.totalCostUsd > 0) return undefined;

  if (summary.credentialSource && isSubscriptionBilled(summary.credentialSource)) {
    return (
      'NOTE: this run reported $0.0000 because subscription turns do not report a per-turn ' +
      'cost. That is expected here, but it does mean the spend cap never gated anything, so ' +
      'these results are not evidence about spend.'
    );
  }

  return (
    `WARNING: this ${summary.tier} run reported $0.0000 across every case, and it was not on ` +
    'subscription auth. A real turn reports cost, so either no turn ran or the cost signal is ' +
    'missing. The spend cap was not exercised, and these results are not evidence about spend.'
  );
}

/** How much of a run actually gated, and whether the run must be treated as failed. */
export interface RunGateVerdict {
  /** Every case in the run. */
  totalCases: number;
  /** Cases that could fail the run (non-quarantined). */
  gatingCases: number;
  /** Cases exempt from the gate. */
  quarantinedCases: number;
  /** Quarantined cases that DID fail — reported, never gating. */
  failingQuarantinedCases: number;
  /** True when CI / the CLI must treat this run as failed. */
  failed: boolean;
  /** Why it failed, in operator language; omitted when it did not. */
  reason?: string;
}

/**
 * Decide a run's gate and report the coverage behind that decision.
 *
 * A run fails when a gating eval failed, errored, or was skipped over budget —
 * OR when the run gated on NO cases at all. The second clause is the important
 * one: `--suite connector` and `--suite experimental` each select only
 * quarantined cases, so before this they exited 0 with zero gating coverage,
 * which on a CI dashboard is indistinguishable from a suite that passed.
 * Quarantined failures still never gate; they are reported by
 * {@link formatSummaryTable} and counted here.
 *
 * @param summary - The run summary.
 * @returns The {@link RunGateVerdict} for this run.
 */
export function evaluateRunGate(summary: RunSummary): RunGateVerdict {
  const totalCases = summary.results.length;
  const quarantined = summary.results.filter((r) => r.quarantined);
  const gating = summary.results.filter((r) => !r.quarantined);
  const failingGating = gating.filter(isFailure);

  const base = {
    totalCases,
    gatingCases: gating.length,
    quarantinedCases: quarantined.length,
    failingQuarantinedCases: quarantined.filter(isFailure).length,
  };

  if (failingGating.length > 0) {
    return {
      ...base,
      failed: true,
      reason: `${failingGating.length} gating eval(s) did not pass: ${failingGating.map((r) => `${r.id} (${r.status})`).join(', ')}`,
    };
  }
  if (gating.length === 0) {
    return {
      ...base,
      failed: true,
      reason:
        `This run gated on 0 of ${totalCases} case(s) — every selected case is quarantined, ` +
        'so passing proves nothing. Select a suite with at least one gating case, or promote a ' +
        'case out of quarantine on credentialed evidence.',
    };
  }
  return { ...base, failed: false };
}
