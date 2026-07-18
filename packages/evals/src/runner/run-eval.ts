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
 * Phase 1 boots the IN-PROCESS `test-mode` server (a process-level singleton, so
 * the caller runs cases serially). The credentialed child-process tiers boot in
 * Phase 2 (task 2.1); this orchestrator scores them as a runner `error` until
 * then rather than pretending to run them.
 *
 * @module evals/runner/run-eval
 */
import { randomUUID } from 'node:crypto';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { EvalCase, EvalResult, OracleContext, OracleResult, RuntimeTier } from '../types.js';
import { createSandbox } from './sandbox.js';
import { startInProcessServer, type HarnessServer } from './harness-server.js';
import { driveConversation, DriveError } from './drive.js';
import { BudgetTracker, evalCostUsd } from './budget.js';
import { writeTranscript } from '../report/transcript.js';

/** Options for {@link runEval}. */
export interface RunEvalOptions {
  /** The tier the run boots on (Phase 1 supports `test-mode` in-process). */
  tier: RuntimeTier;
  /** The run id (transcript directory name). */
  runId: string;
  /** The directory transcripts are written into. */
  runDir: string;
  /** The shared per-run budget tracker (cost is recorded into it). */
  tracker: BudgetTracker;
  /** Per-turn timeout guard in ms. */
  timeoutMs?: number;
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

  // Phase 1 only boots the in-process test-mode server. Score other tiers as a
  // runner error rather than silently passing a check that never ran.
  if (opts.tier !== 'test-mode') {
    result.status = 'error';
    result.error = `Tier '${opts.tier}' requires the credentialed child-process server (Phase 2 / task 2.1).`;
    result.durationMs = Date.now() - start;
    return result;
  }

  const sandbox = await createSandbox();
  let server: HarnessServer | undefined;
  let frames: SseFrame[] = [];
  let sessionId = evalCase.id;
  let failed = false;

  try {
    server = await startInProcessServer({ dorkHome: sandbox.dorkHome });
    const ceiling = evalCase.perEvalCeilingUsd;

    if (turns.length > 0) {
      const drive = await driveConversation({
        baseUrl: server.baseUrl,
        sessionId: randomUUID(),
        cwd: sandbox.projectCwd,
        prompts: turns,
        timeoutMs: opts.timeoutMs,
        abortWhen: ceiling !== undefined ? (fs) => evalCostUsd(fs) > ceiling : undefined,
      });
      frames = drive.frames;
      sessionId = drive.canonicalId;

      if (drive.outcome === 'timeout') {
        result.status = 'error';
        result.error = 'Turn timed out before reaching a terminal frame.';
        failed = true;
      } else if (drive.outcome === 'aborted') {
        result.status = 'fail';
        result.error = 'Eval exceeded its per-eval budget ceiling (runaway turn).';
        failed = true;
      }
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
