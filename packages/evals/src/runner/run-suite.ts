/**
 * Run a whole suite: select the cases, SKIP the ones whose declared runtime the
 * run cannot provide, run the rest through {@link runEval} under a shared
 * per-run {@link BudgetTracker}, retry the one measured infrastructure signature
 * once (`runner/retry.ts`), skip the remainder once the run budget is spent, and
 * emit `results.json`. Phase 1 runs cases SERIALLY because the
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

/** A result for a case that never ran, carrying why. */
function skippedResult(
  evalCase: EvalCase,
  tier: RuntimeTier,
  status: 'skipped-over-budget' | 'skipped-wrong-tier'
): EvalResult {
  return {
    id: evalCase.id,
    title: evalCase.title,
    status,
    // The tier RECORDED is the one the case declares, not the one the run
    // booted: on a wrong-tier skip they differ, and the row's job is to say
    // which tier this case would need.
    runtimeTier: status === 'skipped-wrong-tier' ? evalCase.runtimeTier : tier,
    costClass: evalCase.costClass,
    costUsd: 0,
    costUnmetered: false,
    durationMs: 0,
    oracleResults: [],
    quarantined: evalCase.quarantined ?? false,
    retried: false,
  };
}

/**
 * Whether this case cannot run on the tier the run booted.
 *
 * A case that declares a credentialed runtime is about MODEL behaviour — a real
 * agent choosing a tool, recalling a conversation, refusing an injected
 * instruction. Run against the deterministic `test-mode` runtime it does not
 * become a weaker test; it becomes a different one whose verdict means nothing,
 * and the `rooms-adversarial-injection` case measured that the hard way: it
 * reported `pass` on a test-mode run because a scripted echo obeys no
 * instructions, injected or otherwise.
 *
 * So the declared tier is enforced rather than described. Enforced HERE, at
 * selection, rather than inside {@link runEval}: `runEval` is the single-case
 * primitive that unit tests deliberately drive off-tier, and a guard there would
 * make those tests unable to test anything.
 *
 * One direction only — see {@link EvalCaseMeta}'s `runtimeTier` for why a
 * `test-mode` case still runs on a credentialed tier.
 *
 * @param evalCase - The case being selected.
 * @param tier - The tier the run booted on.
 * @returns True when the case must be skipped.
 */
function needsCredentialedTier(evalCase: EvalCase, tier: RuntimeTier): boolean {
  return tier === 'test-mode' && evalCase.runtimeTier !== 'test-mode';
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
    // Before the budget check: a case that cannot run on this tier was never a
    // spend question, and reporting it as "skipped over budget" would say the
    // run ran out of money rather than that the case needs a model.
    if (needsCredentialedTier(evalCase, opts.tier)) {
      results.push(skippedResult(evalCase, opts.tier, 'skipped-wrong-tier'));
      continue;
    }
    if (tracker.isOverRunBudget()) {
      results.push(skippedResult(evalCase, opts.tier, 'skipped-over-budget'));
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
