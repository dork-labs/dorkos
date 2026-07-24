/**
 * Run a whole suite: select the cases, run each through {@link runEval} under a
 * shared per-run {@link BudgetTracker}, skip the remainder once the run budget
 * is spent, and emit `results.json`. Phase 1 runs cases SERIALLY because the
 * in-process server is a process-level singleton; bounded concurrency arrives
 * with the child-process tier (Phase 2).
 *
 * @module evals/runner/run-suite
 */
import path from 'node:path';
import type { EvalCase, EvalResult, RunSummary, RuntimeTier } from '../types.js';
import { BudgetTracker, DEFAULT_RUN_BUDGET_USD } from './budget.js';
import { runEval } from './run-eval.js';
import { createLauncherResolver, type IsolationTier } from './isolation/resolve-launcher.js';
import { writeResults } from '../report/summary.js';

/** Options for {@link runSuite}. */
export interface RunSuiteOptions {
  /** The tier to boot on (Phase 1: `test-mode`). */
  tier: RuntimeTier;
  /** Per-run budget cap in USD. */
  budgetUsd?: number;
  /** Directory run output (transcripts + `results.json`) is written under. */
  outDir: string;
  /** Explicit run id; defaults to a timestamped id. */
  runId?: string;
  /** Per-turn timeout guard in ms. */
  timeoutMs?: number;
  /** Cheap model for the credentialed tiers (`ANTHROPIC_MODEL`); defaults per the boot. */
  model?: string;
  /**
   * The isolation tier the credentialed evals boot through (`--isolation`).
   * `child-process` (default) spawns a Node subprocess; `docker` runs each eval
   * in a container. Resolved to a launcher by {@link resolveLauncher}, which
   * degrades to `child-process` with a clear message when docker is unavailable.
   */
  isolation?: IsolationTier;
}

/** The outcome of a suite run: the summary and where it was written. */
export interface RunSuiteResult {
  /** The machine-readable run summary. */
  summary: RunSummary;
  /** The directory transcripts + `results.json` were written into. */
  runDir: string;
  /** The absolute path of `results.json`. */
  resultsPath: string;
}

/** A skipped-over-budget result for a case that never ran. */
function skippedResult(evalCase: EvalCase, tier: RuntimeTier): EvalResult {
  return {
    id: evalCase.id,
    title: evalCase.title,
    status: 'skipped-over-budget',
    runtimeTier: tier,
    costClass: evalCase.costClass,
    costUsd: 0,
    durationMs: 0,
    oracleResults: [],
    quarantined: evalCase.quarantined ?? false,
    retried: false,
  };
}

/** Generate a filesystem-safe, sortable run id. */
function defaultRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Run the given cases end-to-end and write `results.json`.
 *
 * @param cases - The eval cases to run (already selected by suite).
 * @param opts - Tier, budget, output dir; see {@link RunSuiteOptions}.
 * @returns The summary, run directory, and results path.
 */
export async function runSuite(cases: EvalCase[], opts: RunSuiteOptions): Promise<RunSuiteResult> {
  const runId = opts.runId ?? defaultRunId();
  const runDir = path.join(opts.outDir, runId);
  const budgetUsd = opts.budgetUsd ?? DEFAULT_RUN_BUDGET_USD;
  const tracker = new BudgetTracker({ runBudgetUsd: budgetUsd });
  const startedAt = new Date().toISOString();
  // Resolves each case's isolation launcher, probing docker at most once per run
  // and degrading to the child-process tier (with a message) when unavailable.
  const launchers = createLauncherResolver({
    ...(opts.isolation ? { isolation: opts.isolation } : {}),
    runId,
  });

  const results: EvalResult[] = [];
  for (const evalCase of cases) {
    if (tracker.isOverRunBudget()) {
      results.push(skippedResult(evalCase, opts.tier));
      continue;
    }
    // `test-mode` boots in-process and never consults a launcher; only the
    // credentialed tiers do, so skip the probe entirely for structural runs.
    const launcher =
      opts.tier === 'test-mode'
        ? undefined
        : await launchers.forCase({ preferDocker: evalCase.preferDocker ?? false });
    results.push(
      await runEval(evalCase, {
        tier: opts.tier,
        runId,
        runDir,
        tracker,
        timeoutMs: opts.timeoutMs,
        model: opts.model,
        ...(launcher ? { launcher } : {}),
      })
    );
  }

  const summary: RunSummary = {
    runId,
    startedAt,
    tier: opts.tier,
    budgetUsd,
    totalCostUsd: tracker.totalCostUsd,
    results,
  };
  const resultsPath = await writeResults(runDir, summary);
  return { summary, runDir, resultsPath };
}
