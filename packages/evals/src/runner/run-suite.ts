/**
 * Run a whole suite: select the cases, SKIP the ones that cannot run on the
 * tier the run booted — a case declaring a credentialed runtime on a
 * `test-mode` run, or a `testModeOnly` case on a credentialed run (DOR-1228)
 * — run the rest through {@link runEval} under a shared per-run
 * {@link BudgetTracker}, retry the one measured infrastructure signature once
 * (`runner/retry.ts`), skip the remainder once the run budget is spent, and
 * emit `results.json`. Phase 1 runs cases SERIALLY because the
 * in-process server is a process-level singleton; bounded concurrency arrives
 * with the child-process tier (Phase 2).
 *
 * @module evals/runner/run-suite
 */
import path from 'node:path';
import {
  describeCredentialSource,
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_PROVIDER_ID,
  PAID_PROVIDER_RUN_BUDGET_USD,
  type EvalCase,
  type EvalResult,
  type EvalRuntime,
  type EvalStatus,
  type RunSummary,
  type RuntimeTier,
} from '../types.js';
import { BudgetTracker, DEFAULT_RUN_BUDGET_USD } from './budget.js';
import { runEval } from './run-eval.js';
import {
  canPinControlledClaudeConfig,
  inheritedClaudeConfigNotice,
  resolveHostClaudeConfigDir,
} from './claude-config.js';
import { DEFAULT_CHEAP_MODEL } from './harness-server.js';
import { noOpenCodeBinaryMessage, resolveHostOpenCodeBinary } from './opencode-sandbox.js';
import { runWithInfrastructureRetry, transcriptNameForAttempt } from './retry.js';
import { createLauncherResolver, type IsolationTier } from './isolation/resolve-launcher.js';
import {
  paidProviderRefusesDockerMessage,
  resolveModelCredential,
  resolvePaidProviderCredential,
  spendsOnExternalProvider,
  type ModelCredential,
} from './credentials.js';
import { writeResults } from '../report/summary.js';

/**
 * The `real-provider` tier's default runtime. OpenCode is the only DorkOS
 * runtime that fronts arbitrary providers (ADR-0308 + ADR-0315), so it is the
 * only thing "reach OpenRouter" can currently mean — named here rather than
 * assumed, so a second such runtime is a one-line change with a visible default.
 */
const PAID_PROVIDER_DEFAULT_RUNTIME: EvalRuntime = 'opencode';

/**
 * A paid run that must not start at all — nobody armed it, or it was asked for
 * an isolation tier that cannot reach the network.
 *
 * Thrown BEFORE any sandbox, server or turn, and distinct from a per-case runner
 * error on purpose: no case was attempted, so there is no `results.json` to
 * write and nothing to report a verdict about. The CLI turns it into a message
 * and a non-zero exit.
 */
export class PaidTierRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaidTierRefusedError';
  }
}

/**
 * The spend ceiling a run gets when nobody passed `--budget`.
 *
 * A FUNCTION rather than an inline ternary at the call site, and that is the
 * whole point: arming a real paid run needs the module-scope opt-in flag, which
 * no test can stub, so the paid branch of an inline expression is unreachable
 * from the suite and executed by no test at all. Someone "simplifying" it back to
 * `paid ? PAID… : DEFAULT…` would leave every test green while an armed
 * `--tier claude-code-cheap --runtime opencode` run silently regained the $3
 * ceiling — the exact bug this shape exists to prevent. Pulled out here, both
 * branches are a four-line table test.
 *
 * The paid ceiling is a tripwire for a runaway loop, not an allowance: these
 * turns cost fractions of a cent, so it sits two orders of magnitude under the
 * credentialed default. It keys on the same predicate as the gate, because a run
 * that spends on a provider is exactly the run that needs the tighter bound.
 *
 * @param tier - The tier the run booted.
 * @param runtime - The agent runtime the run resolved, if any.
 * @param provider - The provider the run resolved, if any.
 * @returns The default per-run cap in USD.
 */
export function defaultRunBudgetUsd(
  tier: RuntimeTier,
  runtime: string | undefined,
  provider: string | undefined
): number {
  return spendsOnExternalProvider(tier, runtime, provider)
    ? PAID_PROVIDER_RUN_BUDGET_USD
    : DEFAULT_RUN_BUDGET_USD;
}

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
  /**
   * Model every credentialed case runs on (`--model`). Defaults per tier:
   * {@link DEFAULT_CHEAP_MODEL} on claude-code, {@link DEFAULT_OPENROUTER_MODEL}
   * on `real-provider`.
   */
  model?: string;
  /**
   * The agent runtime every session binds to (`--runtime`). Defaults to
   * {@link PAID_PROVIDER_DEFAULT_RUNTIME} on `real-provider` and to the server's
   * own default (claude-code) everywhere else.
   */
  runtime?: EvalRuntime;
  /** Model provider for a runtime that fronts several (`--provider`). */
  provider?: string;
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
  status: Extract<
    EvalStatus,
    'skipped-over-budget' | 'skipped-wrong-tier' | 'skipped-wrong-runtime'
  >
): EvalResult {
  return {
    id: evalCase.id,
    title: evalCase.title,
    status,
    // The tier RECORDED is the one the case declares, not the one the run
    // booted: on a wrong-tier skip they differ, and the row's job is to say
    // which tier this case would need.
    runtimeTier: status === 'skipped-wrong-tier' ? evalCase.runtimeTier : tier,
    // Same reasoning one line up: a wrong-RUNTIME row's job is to name the
    // runtime this case would need, not the one the run happened to boot.
    ...(status === 'skipped-wrong-runtime' && evalCase.runtime
      ? { runtime: evalCase.runtime }
      : {}),
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
 * Whether this case must be skipped on the tier the run booted.
 *
 * UPWARD (the case needs more than the run has): a case that declares a
 * credentialed runtime is about MODEL behaviour — a real agent choosing a
 * tool, recalling a conversation, refusing an injected instruction. Run
 * against the deterministic `test-mode` runtime it does not become a weaker
 * test; it becomes a different one whose verdict means nothing, and the
 * `rooms-adversarial-injection` case measured that the hard way: it reported
 * `pass` on a test-mode run because a scripted echo obeys no instructions,
 * injected or otherwise.
 *
 * DOWNWARD (the case structurally CANNOT run anywhere but `test-mode`,
 * DOR-1228): merely declaring `runtimeTier: 'test-mode'` is NOT by itself a
 * reason to skip downward. `widget-round-trip`'s `/ui-action` trigger is
 * runtime-agnostic by construction and is MEANT to run — and gate — on a
 * credentialed tier too; skipping it there would remove coverage rather than
 * a lie. That coverage caught a real bug: DOR-1239 is a genuine
 * `409 SESSION_LOCKED` a credentialed `widget-round-trip` run can hit (a race
 * between a widget action and its own seed turn's lock release), and an
 * earlier version of this fix skipped the case downward on the strength of
 * its declared tier alone — which would have hidden that race again, not
 * reported it. Only a case marked {@link EvalCaseMeta.testModeOnly} — one that
 * leans on a mechanism only `test-mode` offers, with no real-runtime
 * equivalent at all — skips downward. `rooms-halt-stops-and-says-so` is the
 * one case that needs it today: it needs a turn that holds still until Stop
 * interrupts it, which only the `long-turn` scenario control
 * (`POST /api/test/scenario`) provides deterministically; without the flag it
 * used to throw its own "test-mode only" error on a forced credentialed run,
 * landing as `error` and gating the run for a case that was never asked to
 * run there.
 *
 * So the declared tier is enforced rather than described. Enforced HERE, at
 * selection, rather than inside {@link runEval}: `runEval` is the single-case
 * primitive that unit tests deliberately drive off-tier, and a guard there
 * would make those tests unable to test anything.
 *
 * @param evalCase - The case being selected.
 * @param tier - The tier the run booted on.
 * @returns True when the case must be skipped.
 */
function tierMismatch(evalCase: EvalCase, tier: RuntimeTier): boolean {
  const needsCredentialedTier = tier === 'test-mode' && evalCase.runtimeTier !== 'test-mode';
  const needsTestMode = tier !== 'test-mode' && (evalCase.testModeOnly ?? false);
  return needsCredentialedTier || needsTestMode;
}

/**
 * Whether this case names a runtime it is ABOUT and the run booted a different
 * one.
 *
 * The same enforced-rather-than-described rule as {@link tierMismatch}, one
 * dimension over. A case that pins an OpenRouter model id run against
 * `claude-code` would not be a weaker test; it would be a test of nothing whose
 * red says "the model was not the one we pinned" about a runtime that was never
 * asked to use it.
 *
 * Absent `runtime` never mismatches — that is the cross-runtime default, and the
 * whole reason the `chat` suite exists.
 *
 * @param evalCase - The case being selected.
 * @param runtime - The runtime the run booted, if any.
 * @returns True when the case must be skipped.
 */
function runtimeMismatch(evalCase: EvalCase, runtime: EvalRuntime | undefined): boolean {
  if (!evalCase.runtime) return false;
  // A `test-mode` run boots no agent runtime at all; such a case is already
  // skipped upward by `tierMismatch`, so this stays quiet rather than
  // double-reporting the same skip under a second, less useful reason.
  if (!runtime) return false;
  return evalCase.runtime !== runtime;
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
  const paid = opts.tier === 'real-provider';
  const runId = opts.runId ?? defaultRunId();
  const runDir = path.join(opts.outDir, runId);
  const startedAt = new Date().toISOString();
  // Resolves each case's isolation launcher, probing docker at most once per run
  // and degrading to the child-process tier (with a message) when unavailable.
  const notify =
    opts.notify ??
    ((message: string) => {
      process.stderr.write(`${message}\n`);
    });

  // Docker eval containers have NO network by design (ADR 260725-133222) and
  // this tier has to reach openrouter.ai. Refused BEFORE the money question,
  // deliberately: this is a fault in the command that was typed, and it cannot
  // be fixed by producing a key, so answering it first is the more useful order.
  // `auto` never reaches for a container on this tier either — a silent degrade
  // would hand an operator who asked for containment a bare-host turn.
  if (
    opts.isolation === 'docker' &&
    spendsOnExternalProvider(opts.tier, opts.runtime, opts.provider)
  ) {
    throw new PaidTierRefusedError(paidProviderRefusesDockerMessage());
  }
  const isolation: IsolationTier | undefined = paid ? 'child-process' : opts.isolation;

  // The runtime + provider + model triple, resolved ONCE so every case, the
  // summary, and the sandbox config agree about what answered this run — and
  // resolved BEFORE the credential question, because it is what decides which
  // credential question to ask.
  //
  // Resolved to a CONCRETE runtime rather than left undefined on the credentialed
  // tiers, and that matters twice over: the run can then RECORD what answered it,
  // and `runtimeMismatch` below has something to compare a case's declared
  // runtime against. Left undefined, a case written about OpenCode would run
  // silently on claude-code and red about a model claude-code was never asked to
  // use. `claude-code` is the honest default because it is the config schema's
  // own (`runtimes.default`), which an eval sandbox boots with.
  const runtime: EvalRuntime | undefined =
    opts.tier === 'test-mode'
      ? undefined
      : (opts.runtime ?? (paid ? PAID_PROVIDER_DEFAULT_RUNTIME : 'claude-code'));
  // An OpenCode boot ALWAYS names a provider, on every tier. Defaulting this
  // only on `real-provider` was the hole: `--tier claude-code-cheap --runtime
  // opencode` left it undefined here and `harness-server.ts` defaulted it back
  // to `openrouter` on the way into the sandbox config, so the run wrote a
  // provider credential reference with nobody having passed the spend gate.
  const provider =
    opts.provider ?? (paid || runtime === 'opencode' ? OPENROUTER_PROVIDER_ID : undefined);
  const model =
    opts.model ??
    (opts.tier === 'test-mode'
      ? undefined
      : paid || runtime === 'opencode'
        ? DEFAULT_OPENROUTER_MODEL
        : DEFAULT_CHEAP_MODEL);

  // Resolve the model credential ONCE for the whole run: probing the local
  // `claude` sign-in costs a subprocess, and the answer cannot change mid-run.
  // `test-mode` needs no credential and never probes. A credentialed run that
  // resolves nothing still proceeds to `runEval`, which errors each case with the
  // fix-it message rather than silently passing.
  //
  // WHICH question gets asked follows the MONEY, not the tier string
  // ({@link spendsOnExternalProvider}). Keying it on `tier === 'real-provider'`
  // was a hole a reviewer walked straight through: `--tier claude-code-cheap
  // --runtime opencode --model openrouter/…` reached OpenRouter with
  // DORKOS_EVALS_PAID_PROVIDER never set, and then recorded
  // `credentialSource: 'anthropic-…'`, so the run named the wrong bill as well
  // as skipping the gate.
  let credential: ModelCredential | undefined;
  if (spendsOnExternalProvider(opts.tier, runtime, provider)) {
    const gate = resolvePaidProviderCredential();
    if (!gate.ok && gate.reason === 'no-opt-in') throw new PaidTierRefusedError(gate.message);
    // `no-key` deliberately falls through with NO credential: `runEval`'s
    // credential gate then errors every case with the fix-it message, so a run
    // somebody armed can never report a pass it did not earn.
    credential = gate.ok ? gate.credential : undefined;
  } else if (opts.tier !== 'test-mode') {
    credential = await resolveModelCredential();
  }
  if (credential) {
    notify(`Reaching the model through ${describeCredentialSource(credential.source)}.`);
    // Say ONCE, up front, whether this run's turns are measured under an empty
    // user-level Claude configuration or under the operator's own. A run whose
    // absolute numbers are machine-relative has to announce it — that silence is
    // the whole of DOR-1712. The per-eval provisioning re-derives this against
    // each sandbox; here it is only a statement about the run.
    if (!(await canPinControlledClaudeConfig({ credentialIsPortable: credential.portable }))) {
      notify(inheritedClaudeConfigNotice(resolveHostClaudeConfigDir()));
    }
  }

  const budgetUsd = opts.budgetUsd ?? defaultRunBudgetUsd(opts.tier, runtime, provider);
  const tracker = new BudgetTracker({ runBudgetUsd: budgetUsd });

  // An OpenCode sandbox cannot find a binary on its own — its DORK_HOME is
  // empty and `opencode` is not on PATH on a machine that provisioned it
  // through DorkOS. Resolved once, from the HOST home, before anything boots.
  let openCodeBinaryPath: string | undefined;
  if (runtime === 'opencode') {
    openCodeBinaryPath = resolveHostOpenCodeBinary();
    if (!openCodeBinaryPath) throw new PaidTierRefusedError(noOpenCodeBinaryMessage());
  }

  const launchers = createLauncherResolver({
    ...(isolation ? { isolation } : {}),
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
    // run ran out of money rather than that the tiers do not match.
    if (tierMismatch(evalCase, opts.tier)) {
      results.push(skippedResult(evalCase, opts.tier, 'skipped-wrong-tier'));
      continue;
    }
    // Checked after the tier and before the budget, for the same reason: a case
    // written about another runtime was never a spend question either.
    if (runtimeMismatch(evalCase, runtime)) {
      results.push(skippedResult(evalCase, opts.tier, 'skipped-wrong-runtime'));
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
            model,
            ...(runtime ? { runtime } : {}),
            ...(provider ? { provider } : {}),
            ...(openCodeBinaryPath ? { openCodeBinaryPath } : {}),
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
    // The RESOLVED triple — model, runtime, provider — resolved ONCE above, so
    // the recorded values are the ones the boot was handed rather than what was
    // typed. A case that pinned its OWN model (`EvalCase.model`) is the one
    // exception, and it is legible on that case's transcript rather than here:
    // this line is about what the RUN was pointed at. Omitted on `test-mode`,
    // which reaches no model and boots no agent runtime.
    ...(model ? { model } : {}),
    ...(runtime ? { runtime } : {}),
    ...(provider ? { provider } : {}),
    ...(credential ? { credentialSource: credential.source } : {}),
    budgetUsd,
    totalCostUsd: tracker.totalCostUsd,
    results,
  };
  const resultsPath = await writeResults(runDir, summary);
  return { summary, runDir, resultsPath };
}
