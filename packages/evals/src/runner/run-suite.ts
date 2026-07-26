/**
 * Run a whole suite: select the cases, run each through {@link runEval} under a
 * shared per-run {@link BudgetTracker}, retry the one measured infrastructure
 * signature once (`runner/retry.ts`), skip the remainder once the run budget is
 * spent, and emit `results.json`. Phase 1 runs cases SERIALLY because the
 * in-process server is a process-level singleton; bounded concurrency arrives
 * with the child-process tier (Phase 2).
 *
 * @module evals/runner/run-suite
 */
import path from 'node:path';
import {
  describeCredentialSource,
  type EvalCase,
  type EvalResult,
  type RunSummary,
  type RuntimeTier,
} from '../types.js';
import { BudgetTracker, DEFAULT_RUN_BUDGET_USD } from './budget.js';
import { runEval } from './run-eval.js';
import { runWithInfrastructureRetry, transcriptNameForAttempt } from './retry.js';
import { createLauncherResolver, type IsolationTier } from './isolation/resolve-launcher.js';
import { resolveModelCredential } from './credentials.js';
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
  /** Sink for the one-line credential notice. Defaults to `process.stderr`. */
  notify?: (message: string) => void;
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
    costUnmetered: false,
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
  const notify =
    opts.notify ??
    ((message: string) => {
      process.stderr.write(`${message}\n`);
    });

  // Resolve the model credential ONCE for the whole run: probing the local
  // `claude` sign-in costs a subprocess, and the answer cannot change mid-run.
  // `test-mode` needs no credential and never probes. A credentialed run that
  // resolves nothing still proceeds to `runEval`, which errors each case with the
  // fix-it message rather than silently passing.
  const credential = opts.tier === 'test-mode' ? undefined : await resolveModelCredential();
  if (credential) {
    notify(`Reaching the model through ${describeCredentialSource(credential.source)}.`);
  }

  const launchers = createLauncherResolver({
    ...(opts.isolation ? { isolation: opts.isolation } : {}),
    runId,
    notify,
    // A container cannot see the machine's `claude` sign-in, so under `auto` a
    // non-portable credential declines docker exactly like a missing daemon does.
    ...(credential ? { credentialIsPortable: credential.portable } : {}),
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
    // A turn that timed out before any oracle ran is infrastructure, not a
    // verdict, and it gets exactly one more attempt (`runner/retry.ts`). The
    // budget guard is the retry's brake: a second attempt spends again.
    results.push(
      await runWithInfrastructureRetry(
        (attemptNumber) =>
          runEval(evalCase, {
            tier: opts.tier,
            runId,
            runDir,
            tracker,
            timeoutMs: opts.timeoutMs,
            model: opts.model,
            transcriptName: transcriptNameForAttempt(evalCase.id, attemptNumber),
            ...(launcher ? { launcher } : {}),
            ...(credential ? { credential } : {}),
          }),
        { canRetry: () => !tracker.isOverRunBudget() }
      )
    );
  }

  const summary: RunSummary = {
    runId,
    startedAt,
    tier: opts.tier,
    ...(credential ? { credentialSource: credential.source } : {}),
    budgetUsd,
    totalCostUsd: tracker.totalCostUsd,
    results,
  };
  const resultsPath = await writeResults(runDir, summary);
  return { summary, runDir, resultsPath };
}
