/**
 * The end-to-end orchestrator for ONE eval case: seed a sandbox → boot the
 * harness server for the run's tier → drive the prompt(s) (when the case has
 * any) → run every oracle (and the rubric, when present) → score → write the
 * transcript and result → tear down.
 *
 * An eval passes iff every oracle passes AND the rubric (when present) clears
 * its threshold. Runner errors (a `409 SESSION_LOCKED`, a boot/turn timeout, a
 * budget abort) are scored distinctly from an oracle failure so an infra flake
 * is never read as a product regression.
 *
 * The server is booted per TIER: `test-mode` runs IN-PROCESS (a process-level
 * singleton, so those cases run serially); the credentialed tiers
 * (`claude-code-cheap` / `real-provider`) boot the server OUT OF PROCESS through
 * the isolation launcher, gated on `ANTHROPIC_API_KEY` — a missing key is a
 * runner `error`, never a false pass.
 *
 * @module evals/runner/run-eval
 */
import { randomUUID } from 'node:crypto';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { EvalCase, EvalResult, OracleContext, OracleResult, RuntimeTier } from '../types.js';
import { createSandbox } from './sandbox.js';
import {
  startInProcessServer,
  startChildProcessServer,
  type HarnessServer,
} from './harness-server.js';
import { driveConversation, driveWidgetAction, DriveError, type TurnOutcome } from './drive.js';
import { BudgetTracker, evalCostUsd } from './budget.js';
import { writeTranscript } from '../report/transcript.js';

/** Options for {@link runEval}. */
export interface RunEvalOptions {
  /** The tier the run boots on (`test-mode` in-process; credentialed = child-process). */
  tier: RuntimeTier;
  /** The run id (transcript directory name). */
  runId: string;
  /** The directory transcripts are written into. */
  runDir: string;
  /** The shared per-run budget tracker (cost is recorded into it). */
  tracker: BudgetTracker;
  /** Per-turn timeout guard in ms. */
  timeoutMs?: number;
  /** Cheap model for the credentialed tiers (`ANTHROPIC_MODEL`); defaults per the boot. */
  model?: string;
}

/** Normalize an eval case's prompt into an ordered list (empty ⇒ no drive). */
function prompts(evalCase: EvalCase): string[] {
  const raw = Array.isArray(evalCase.prompt) ? evalCase.prompt : [evalCase.prompt];
  return raw.filter((p) => p.trim() !== '');
}

/** Build the base EvalResult skeleton for a case (status filled in by the caller). */
function baseResult(evalCase: EvalCase, tier: RuntimeTier): EvalResult {
  return {
    id: evalCase.id,
    title: evalCase.title,
    status: 'error',
    runtimeTier: tier,
    costClass: evalCase.costClass,
    costUsd: 0,
    durationMs: 0,
    oracleResults: [],
    quarantined: evalCase.quarantined ?? false,
    retried: false,
  };
}

/** Run every oracle against the context; ALL must pass. */
async function runOracles(evalCase: EvalCase, ctx: OracleContext): Promise<OracleResult[]> {
  const results: OracleResult[] = [];
  for (const oracle of evalCase.oracles) {
    results.push(await oracle(ctx));
  }
  return results;
}

/** The credentialed tiers' `ANTHROPIC_API_KEY` — a runner/CI secret, not a DorkOS config field. */
function anthropicApiKey(): string | undefined {
  // eslint-disable-next-line no-restricted-syntax -- the credentialed tier's API key is a CI/runner secret read once here (the harness-server env carve-out pattern), not an app config value.
  return process.env.ANTHROPIC_API_KEY;
}

/**
 * Boot the harness server for `tier`: in-process for `test-mode`, else the
 * credentialed child-process server (its `ANTHROPIC_API_KEY` prerequisite is
 * checked by the caller before this runs).
 *
 * @param tier - The runtime tier.
 * @param dorkHome - The sandbox `DORK_HOME`.
 * @param opts - The model + api key for a credentialed boot.
 * @returns The running {@link HarnessServer}.
 */
function bootServerForTier(
  tier: RuntimeTier,
  dorkHome: string,
  opts: { model?: string; apiKey?: string }
): Promise<HarnessServer> {
  if (tier === 'test-mode') return startInProcessServer({ dorkHome });
  return startChildProcessServer({ dorkHome, anthropicApiKey: opts.apiKey, model: opts.model });
}

/**
 * Fold a non-`done` drive outcome onto the result. A `timeout` is a runner
 * `error` (an infra flake, never a product regression); an `aborted` turn
 * breached the per-eval ceiling and fails the eval.
 *
 * @param result - The result being scored (mutated in place).
 * @param outcome - The turn outcome.
 * @returns True if the turn failed the eval (caller should skip oracles).
 */
function applyNonDoneOutcome(result: EvalResult, outcome: TurnOutcome): boolean {
  if (outcome === 'timeout') {
    result.status = 'error';
    result.error = 'Turn timed out before reaching a terminal frame.';
    return true;
  }
  if (outcome === 'aborted') {
    result.status = 'fail';
    result.error = 'Eval exceeded its per-eval budget ceiling (runaway turn).';
    return true;
  }
  return false;
}

/**
 * Run one eval case end-to-end and return its scored {@link EvalResult}. Always
 * writes a transcript (prompt(s) + frames + oracle/rubric results). Never
 * throws for an eval failure — only truly unexpected internal faults propagate.
 *
 * @param evalCase - The case to run.
 * @param opts - Tier, run id/dir, budget tracker; see {@link RunEvalOptions}.
 * @returns The scored result.
 */
export async function runEval(evalCase: EvalCase, opts: RunEvalOptions): Promise<EvalResult> {
  const startedAt = new Date();
  const start = startedAt.getTime();
  const result = baseResult(evalCase, opts.tier);
  const turns = prompts(evalCase);

  // Credentialed tiers need a real key; a missing one is a RUNNER error (never a
  // false pass), reported before any sandbox/server is spun up.
  const apiKey = anthropicApiKey();
  if (opts.tier !== 'test-mode' && !apiKey) {
    result.status = 'error';
    result.error = `Tier '${opts.tier}' requires ANTHROPIC_API_KEY (credentialed child-process server).`;
    result.durationMs = Date.now() - start;
    return result;
  }

  const sandbox = await createSandbox();
  let server: HarnessServer | undefined;
  let frames: SseFrame[] = [];
  let sessionId: string = randomUUID();
  let failed = false;

  try {
    server = await bootServerForTier(opts.tier, sandbox.dorkHome, { model: opts.model, apiKey });
    const ceiling = evalCase.perEvalCeilingUsd;
    const abortWhen =
      ceiling !== undefined ? (fs: SseFrame[]) => evalCostUsd(fs) > ceiling : undefined;

    if (turns.length > 0) {
      const drive = await driveConversation({
        baseUrl: server.baseUrl,
        sessionId,
        cwd: sandbox.projectCwd,
        prompts: turns,
        timeoutMs: opts.timeoutMs,
        abortWhen,
      });
      frames = drive.frames;
      sessionId = drive.canonicalId;
      failed = applyNonDoneOutcome(result, drive.outcome);
    }

    // A widget-round-trip case POSTs its action AFTER the prompt(s) established
    // the session — a fresh turn on the runtime-agnostic /ui-action channel.
    if (!failed && evalCase.widgetAction) {
      const widget = await driveWidgetAction({
        baseUrl: server.baseUrl,
        sessionId,
        action: evalCase.widgetAction,
        cwd: sandbox.projectCwd,
        timeoutMs: opts.timeoutMs,
        abortWhen,
      });
      frames = [...frames, ...widget.frames];
      sessionId = widget.canonicalId;
      failed = applyNonDoneOutcome(result, widget.outcome);
    }

    // Record cost even on a boot-only case (0 for test-mode). A per-run breach is
    // surfaced via the tracker for the caller to skip the remaining evals.
    const verdict = opts.tracker.record(frames, { perEvalCeilingUsd: ceiling });
    result.costUsd = verdict.evalCostUsd;

    const ctx: OracleContext = {
      sandbox,
      baseUrl: server.baseUrl,
      sessionId,
      frames,
    };

    if (!failed) {
      result.oracleResults = await runOracles(evalCase, ctx);
      const oraclesPassed = result.oracleResults.every((r) => r.passed);

      let rubricPassed = true;
      if (evalCase.rubric) {
        const rubricResult = await evalCase.rubric.evaluate(ctx);
        result.rubricResult = rubricResult;
        rubricPassed = rubricResult.passed;
      }

      if (verdict.exceededEvalCeiling) {
        result.status = 'fail';
        result.error = 'Eval exceeded its per-eval budget ceiling.';
        failed = true;
      } else {
        result.status = oraclesPassed && rubricPassed ? 'pass' : 'fail';
        failed = result.status !== 'pass';
      }
    }
  } catch (err) {
    result.status = 'error';
    result.error =
      err instanceof DriveError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    failed = true;
  } finally {
    result.durationMs = Date.now() - start;
    result.transcript = `${evalCase.id}.jsonl`;
    await writeTranscript(opts.runDir, {
      runId: opts.runId,
      evalId: evalCase.id,
      title: evalCase.title,
      startedAt: startedAt.toISOString(),
      prompts: turns,
      frames,
      oracleResults: result.oracleResults,
      rubricResult: result.rubricResult,
    });
    await server?.dispose();
    await sandbox.cleanup({ failed });
  }

  return result;
}
