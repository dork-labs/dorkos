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
 *    the outcome was dropped even though the row was not. A retried eval carries
 *    its flag the same way (`retried:error`), so the promotion rule that keys on
 *    repeated retries has something on screen to key on.
 * 2. the footer states how many cases could actually fail the run. A suite whose
 *    every case is quarantined exits 0 with zero gating coverage, which is
 *    indistinguishable from a real pass unless the count is on screen — so
 *    {@link evaluateRunGate} treats gating on ZERO cases as a failure.
 * 3. an eval whose spend the harness could not measure renders as `unmetered`,
 *    never as `$0.0000`. Two measured runs burned about 92 seconds of real
 *    tokens each and printed as free, which made them the cheapest-looking rows
 *    in a table where they were the most expensive.
 *
 * @module evals/report/summary
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  RunSummarySchema,
  describeCredentialSource,
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
 * The status cell for one eval: the outcome, prefixed by every fact that
 * qualifies it. A quarantined eval reports BOTH facts — `quarantined:fail` — so
 * its outcome survives the rendering that exempts it from the gate, and a
 * retried one reports `retried:error` for the same reason.
 *
 * `retried` is the operational signal behind the promotion rule "two
 * infrastructure runs in a row means stop and fix the harness"
 * (`packages/evals/README.md`). A flag that only exists in `results.json` cannot
 * carry a rule that people are supposed to act on: nobody opens the JSON to
 * discover a question they did not know to ask.
 *
 * A `skipped-wrong-tier` row NEVER shows `quarantined`, even when the case it
 * skipped declares one: {@link evaluateRunGate} excludes every wrong-tier
 * result from `attempted` entirely, so it is not in the quarantined COUNT the
 * footer prints either. A row reading `quarantined:skipped-wrong-tier` beside
 * a footer reading "0 quarantined" was the same lie the retried/quarantined
 * fix above exists to prevent, just in the other direction — the row claiming
 * coverage the footer says nothing provided.
 */
function statusLabel(result: EvalResult): string {
  const showsQuarantined = result.quarantined && result.status !== 'skipped-wrong-tier';
  const qualifiers = [
    ...(showsQuarantined ? ['quarantined'] : []),
    ...(result.retried ? ['retried'] : []),
  ];
  return [...qualifiers, result.status].join(':');
}

/**
 * The cost cell for one eval. An eval whose spend never reported renders as
 * `unmetered`: its `costUsd` is 0 only because nothing measured it, and printing
 * `$0.0000` there states the opposite of what is known.
 */
function costLabel(result: EvalResult): string {
  return result.costUnmetered ? 'unmetered' : `$${result.costUsd.toFixed(4)}`;
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

/**
 * Whether an eval's terminal status counts as a failure for its own row.
 *
 * `skipped-over-budget` is one: the run ran out of money before that case got a
 * verdict, which is a run that did not do its job. `skipped-wrong-tier` is NOT,
 * and the difference matters — a credentialed case on a free structural run was
 * never going to run, was never asked to, and reporting it as a failure would
 * make the nightly structural job permanently red for doing exactly the right
 * thing.
 */
function isFailure(result: EvalResult): boolean {
  return (
    result.status === 'fail' || result.status === 'error' || result.status === 'skipped-over-budget'
  );
}

/**
 * The line printed under a row whose sandbox was retained for debugging
 * (DOR-1241) — gating and quarantined failures get the SAME treatment, because
 * a quarantined case's failure is exactly the one a reader opens next. Reports
 * both the sandbox `DORK_HOME` itself (removed by a later `pnpm evals:sweep`)
 * and the copied `logs/` directory beside `results.json` (which survives it),
 * when there was a server log to copy.
 *
 * @param result - The eval result to check for retention.
 * @returns The line to print under the row, or undefined when nothing was
 *   retained.
 */
function retentionLine(result: EvalResult): string | undefined {
  if (!result.retainedSandbox) return undefined;
  const logsNote = result.retainedLogsPath ? `; logs copied to ${result.retainedLogsPath}` : '';
  return `  ↳ retained: ${result.retainedSandbox}${logsNote}`;
}

/**
 * Whether this case was never started because the run booted the wrong tier.
 *
 * Such a case is neither gating nor quarantined-reporting: it produced no
 * evidence at all, so counting it either way would misstate what the run
 * covered.
 */
function isWrongTier(result: EvalResult): boolean {
  return result.status === 'skipped-wrong-tier';
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
    cost: costLabel(r),
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
  const rows = summary.results.flatMap((result, i) => {
    const c = cells[i];
    if (!c) return [];
    const row = `${pad(c.status, w.status)} ${pad(c.id, w.id)} ${pad(c.tier, w.tier)} ${pad(c.isolation, w.isolation)} ${pad(c.cost, w.cost)} ${c.duration}`;
    const retention = retentionLine(result);
    return retention ? [row, retention] : [row];
  });

  const gate = evaluateRunGate(summary);
  const passed = summary.results.filter((r) => r.status === 'pass' && !r.quarantined).length;
  const failed = summary.results.filter((r) => r.status === 'fail' && !r.quarantined).length;
  const errored = summary.results.filter((r) => r.status === 'error' && !r.quarantined).length;
  const skipped = summary.results.filter((r) => r.status === 'skipped-over-budget').length;
  const wrongTier = summary.results.filter(isWrongTier).length;
  // Direction-aware (DOR-1228): every wrong-tier case in ONE run shares the
  // same missing direction relative to the tier the run booted, because a
  // case's declared tier only ever mismatches upward (needs a model this
  // `test-mode` run has none of) or downward (needs `test-mode`'s deterministic
  // controls, which a credentialed run has none of) — never both in one run.
  const wrongTierLabel =
    summary.tier === 'test-mode' ? 'needing a credentialed tier' : 'needing test-mode';

  const footer =
    `${passed} passed, ${failed} failed, ${errored} errored, ${skipped} skipped, ` +
    (wrongTier > 0 ? `${wrongTier} ${wrongTierLabel}, ` : '') +
    `${gate.quarantinedCases} quarantined (${gate.failingQuarantinedCases} of them failing)` +
    ` · $${summary.totalCostUsd.toFixed(4)} / $${summary.budgetUsd.toFixed(2)} budget`;

  const gatingLine =
    gate.gatingCases === 0
      ? `GATING: 0 of ${gate.totalCases} cases gate this run — nothing this run started can fail it, so a green run proves nothing.`
      : `GATING: ${gate.gatingCases} of ${gate.totalCases} cases gate this run; ${gate.quarantinedCases} quarantined case(s) report but cannot fail it.`;

  const lines = [header, ...rows, '', footer, gatingLine];
  if (summary.credentialSource) {
    lines.push(`CREDENTIAL: ${describeCredentialSource(summary.credentialSource)}.`);
  }
  const costLine = costSignalLine(summary);
  if (costLine) lines.push(costLine);
  const unmetered = unmeteredSpendLine(summary);
  if (unmetered) lines.push(unmetered);
  return lines.join('\n');
}

/**
 * Say something about a CREDENTIALED run that reported no cost at all, and say
 * WHICH of the two reasons it was — because the harness now knows.
 *
 * This used to be scaled to the credential instead, on the belief that
 * subscription turns report no per-turn cost and that `$0.0000` on a local run
 * was therefore expected. That belief is false in both directions. The SDK
 * computes `total_cost_usd` from token counts with no auth-mode branch, and ten
 * measured credentialed runs on a local Claude sign-in reported $0.0380 to
 * $0.1220 per case. So the reassuring NOTE was firing on exactly the path where
 * a broken cost signal is most likely to be seen and least likely to be
 * questioned. (On subscription auth the figure is a list-price ESTIMATE of what
 * the tokens would cost through the API, not money billed; the subscription is
 * spent as quota. It is still the only spend number the cap can enforce on.)
 *
 * What replaces it is the distinction the run itself carries:
 *
 * - every zero-cost case is `costUnmetered` ⇒ no turn ever reached the frame
 *   that carries a total. Not a mystery and not a broken signal: those turns
 *   died first. The cap still gated nothing.
 * - at least one case completed a turn and STILL reported nothing ⇒ the cost
 *   signal is missing. That is the symptom worth a warning.
 *
 * `test-mode` is free by design and says nothing.
 *
 * @param summary - The run summary.
 * @returns The line to print, or undefined when there is nothing to say.
 */
function costSignalLine(summary: RunSummary): string | undefined {
  if (summary.tier === 'test-mode') return undefined;
  if (summary.totalCostUsd > 0) return undefined;

  const everyZeroCostCaseIsUnmetered = summary.results.every(
    (r) => r.costUsd > 0 || r.costUnmetered
  );
  if (summary.results.length > 0 && everyZeroCostCaseIsUnmetered) {
    return (
      `WARNING: this ${summary.tier} run reported $0.0000 because no turn survived long enough ` +
      'to report a cost, not because nothing was spent. Every case here is unmetered. The spend ' +
      'cap gated nothing and these results are not evidence about spend.'
    );
  }

  return (
    `WARNING: this ${summary.tier} run reported $0.0000 across every case. A completed turn ` +
    'reports a cumulative cost, so either no turn ran or the cost signal is missing. The spend ' +
    'cap was not exercised, and these results are not evidence about spend.'
  );
}

/**
 * Say that the printed total is a FLOOR when some of the run's evals spent
 * tokens nobody measured.
 *
 * Scoped to the mixed case — a run that reported some real cost AND has
 * unmetered evals — on purpose. That is the reading that lies: a total sits at
 * the bottom of the table looking like the run's spend, while the two priciest
 * turns contributed nothing to it. When the total is $0.0000 instead,
 * {@link costSignalLine} has already said the results are not evidence about
 * spend, and repeating it here would be the second warning that teaches people
 * to skim past the first.
 *
 * @param summary - The run summary.
 * @returns The line to print, or undefined when there is nothing to say.
 */
function unmeteredSpendLine(summary: RunSummary): string | undefined {
  const unmetered = summary.results.filter((r) => r.costUnmetered).length;
  if (unmetered === 0 || summary.totalCostUsd <= 0) return undefined;
  return (
    `SPEND: ${unmetered} of ${summary.results.length} case(s) drove a real turn that never ` +
    `reported a cost, so $${summary.totalCostUsd.toFixed(4)} is a floor, not a total. The ` +
    'budget cap cannot see what those turns spent — a turn killed by the timeout guard is ' +
    'usually the most expensive one in the run.'
  );
}

/**
 * Why a run that started NONE of its selected cases has nothing to show,
 * phrased for the direction the mismatch actually ran (DOR-1228): a
 * `test-mode` run whose every selected case needs a model, or a credentialed
 * run whose every selected case is `test-mode`-only.
 *
 * @param summary - The run summary.
 * @returns The operator-facing reason.
 */
function noCasesStartedReason(summary: RunSummary): string {
  const count = summary.results.length;
  if (summary.tier === 'test-mode') {
    return (
      `This run started none of its ${count} selected case(s): every one of them declares a ` +
      `credentialed runtime and this run booted ${summary.tier}. Run them with ` +
      '`pnpm evals:local --suite <case-id>`, which pays for a real model.'
    );
  }
  return (
    `This run started none of its ${count} selected case(s): every one of them is marked ` +
    `test-mode-only and this run booted ${summary.tier}, which cannot honor a case that leans ` +
    'on a deterministic scenario control no real runtime provides. Run them with ' +
    '`--tier test-mode` instead.'
  );
}

/** How much of a run actually gated, and whether the run must be treated as failed. */
export interface RunGateVerdict {
  /**
   * Every case the run ATTEMPTED — cases skipped for the wrong tier are not
   * counted, because "4 of 12 gate this run" reads as eight cases silently
   * exempted when in fact eight were never started.
   */
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
  // A case skipped for the wrong tier is neither gating nor reporting: nothing
  // ran, so it can neither fail the run nor stand in for coverage. Counting it
  // as gating would be the nastiest version of that mistake — a run whose only
  // "gating" cases were never started would report a confident green.
  const attempted = summary.results.filter((r) => !isWrongTier(r));
  const totalCases = attempted.length;
  const quarantined = attempted.filter((r) => r.quarantined);
  const gating = attempted.filter((r) => !r.quarantined);
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
  if (attempted.length === 0 && summary.results.length > 0) {
    return {
      ...base,
      failed: true,
      reason: noCasesStartedReason(summary),
    };
  }
  if (gating.length === 0) {
    return {
      ...base,
      failed: true,
      reason:
        `This run gated on 0 of ${totalCases} case(s) — every case it started is quarantined, ` +
        'so passing proves nothing. Select a suite with at least one gating case, or promote a ' +
        'case out of quarantine on credentialed evidence.',
    };
  }
  return { ...base, failed: false };
}
