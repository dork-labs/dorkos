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
 * the isolation launcher, gated on a resolved model credential (`runner/
 * credentials.ts`: an API key, a subscription token, or the `claude` sign-in on
 * this machine). No credential at all is a runner `error`, never a false pass.
 *
 * @module evals/runner/run-eval
 */
import { randomUUID } from 'node:crypto';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type {
  EvalCase,
  EvalResult,
  EvalRuntime,
  IsolationRecord,
  OracleContext,
  OracleResult,
  RoomFacts,
  RuntimeTier,
} from '../types.js';
import { emptyApprovalLog } from '../types.js';
import { ApprovalDriver } from './approval-driver.js';
import { createSandbox, type Sandbox } from './sandbox.js';
import { onInterrupt } from './interrupt.js';
import {
  startInProcessServer,
  startChildProcessServer,
  type HarnessServer,
} from './harness-server.js';
import type { IsolationLauncher } from './isolation/index.js';
import { driveConversation, driveWidgetAction, DriveError, type TurnOutcome } from './drive.js';
import { BudgetTracker, evalCostSignal, evalCostUsd } from './budget.js';
import { TURN_TIMEOUT_ERROR } from './retry.js';
import {
  resolveModelCredential,
  resolvePaidProviderCredential,
  spendsOnExternalProvider,
  noCredentialMessage,
  dockerNeedsPortableCredentialMessage,
  type ModelCredential,
} from './credentials.js';
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
  /**
   * The run's model for the credentialed tiers, overridden per case by
   * {@link EvalCase.model}. Defaults per the boot on claude-code; required (and
   * supplied by the caller) on OpenCode.
   */
  model?: string;
  /**
   * The agent runtime every session in this eval binds to. Omitted ⇒ the
   * server's own default, which is `claude-code`.
   */
  runtime?: EvalRuntime;
  /** Model provider for a runtime that fronts several (`openrouter` on OpenCode). */
  provider?: string;
  /**
   * Absolute path to the host's `opencode` binary, resolved once per run. Only
   * read on an OpenCode boot, where the sandbox cannot find one itself.
   */
  openCodeBinaryPath?: string;
  /**
   * The isolation launcher the credentialed tiers boot through (`--isolation`).
   * Omitted ⇒ the default child-process tier. `test-mode` runs in-process and
   * ignores this.
   */
  launcher?: IsolationLauncher;
  /**
   * The model credential this eval authenticates with. {@link runSuite} resolves
   * it ONCE per run and passes it here, so a suite never re-probes the local
   * `claude` sign-in per case. Omitted ⇒ resolve on demand (direct callers and
   * tests). `test-mode` ignores it.
   */
  credential?: ModelCredential;
  /**
   * The transcript file name (without a directory) this attempt writes into.
   * Defaults to `<eval id>.jsonl`.
   *
   * The retry policy (`runner/retry.ts`) sets it so a second attempt cannot
   * overwrite the first one's frames — the transcript of the attempt that got
   * classified as infrastructure is the only evidence FOR that classification,
   * and a reader who cannot open it has to take it on trust.
   */
  transcriptName?: string;
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
    costUnmetered: false,
    durationMs: 0,
    oracleResults: [],
    quarantined: evalCase.quarantined ?? false,
    retried: false,
  };
}

/**
 * The isolation this eval's server will actually run inside — recorded on the
 * result, so a `preferDocker` case that silently degraded is legible in
 * `results.json` rather than only in one line of stderr.
 *
 * `test-mode` always boots in-process and never consults a launcher; a
 * credentialed run with no launcher is the child-process default; a launcher is
 * whatever tier the resolver actually produced.
 *
 * @param tier - The runtime tier the run booted on.
 * @param launcher - The launcher the resolver chose, if any.
 * @returns The isolation to record.
 */
function isolationOf(tier: RuntimeTier, launcher?: IsolationLauncher): IsolationRecord {
  if (tier === 'test-mode') return 'in-process';
  return launcher?.id === 'docker' ? 'docker' : 'child-process';
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
 * Why this credentialed eval cannot run, or `undefined` when it can.
 *
 * Fail-closed in both branches: a run with no credential at all, and a docker-tier
 * run whose only credential is the local sign-in (which the container cannot see,
 * by design), are BOTH runner errors reported before anything boots. Neither is
 * ever allowed to look like a pass.
 *
 * @param tier - The runtime tier the run booted on.
 * @param isolation - The isolation this eval would actually run inside.
 * @param credential - The resolved credential, if any.
 * @returns The runner-error message, or undefined when the eval may proceed.
 */
function credentialGateError(
  tier: RuntimeTier,
  isolation: IsolationRecord,
  credential: ModelCredential | undefined,
  paidRefusal: string | undefined
): string | undefined {
  if (!credential) return paidRefusal ?? noCredentialMessage(tier);
  if (isolation === 'docker' && !credential.portable) {
    return dockerNeedsPortableCredentialMessage();
  }
  return undefined;
}

/**
 * The credential this eval will authenticate with, and — on the paid tier — the
 * refusal to report when there is none.
 *
 * The split is the fail-closed rule, and it is NOT cosmetic: falling back to
 * {@link resolveModelCredential} on a paid-provider eval would let an ANTHROPIC
 * credential (or merely being signed in to `claude`) satisfy a gate about
 * spending on OpenRouter. Measured while building this tier: with
 * `DORKOS_EVALS_PAID_PROVIDER=1` and no `OPENROUTER_API_KEY`, five of six cases
 * booted real servers and drove turns, because the local `claude` sign-in
 * answered the ladder. Nothing was billed only because the sandbox had no
 * OpenRouter key to spend — which is luck, not a gate.
 *
 * Which side of the split a run lands on follows the MONEY, not the tier string
 * — see {@link spendsOnExternalProvider} for the command that proved the
 * difference matters.
 *
 * @param tier - The tier this eval runs on.
 * @param provided - A credential the suite already resolved once for the run.
 * @returns The credential to boot with, and any paid-tier refusal message.
 */
async function resolveCredentialFor(
  tier: RuntimeTier,
  provided: ModelCredential | undefined,
  runtime: string | undefined,
  provider: string | undefined
): Promise<{ credential?: ModelCredential; paidRefusal?: string }> {
  if (tier === 'test-mode') return {};
  if (provided) return { credential: provided };
  if (spendsOnExternalProvider(tier, runtime, provider)) {
    const gate = resolvePaidProviderCredential();
    return gate.ok ? { credential: gate.credential } : { paidRefusal: gate.message };
  }
  const credential = await resolveModelCredential();
  return credential ? { credential } : {};
}

/**
 * Boot the harness server for `tier`: in-process for `test-mode`, else the
 * credentialed child-process server (whose credential prerequisite the caller
 * has already checked via {@link credentialGateError}).
 *
 * @param tier - The runtime tier.
 * @param dorkHome - The sandbox `DORK_HOME`.
 * @param opts - The model, the credential env, and the case's own server env.
 * @returns The running {@link HarnessServer}.
 */
function bootServerForTier(
  tier: RuntimeTier,
  dorkHome: string,
  opts: {
    model?: string;
    runtime?: EvalRuntime;
    provider?: string;
    openCodeBinaryPath?: string;
    credentialEnv?: Record<string, string>;
    env?: Record<string, string>;
    launcher?: IsolationLauncher;
  }
): Promise<HarnessServer> {
  if (tier === 'test-mode') return startInProcessServer({ dorkHome });
  return startChildProcessServer({
    dorkHome,
    model: opts.model,
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.openCodeBinaryPath ? { openCodeBinaryPath: opts.openCodeBinaryPath } : {}),
    // The credential env goes FIRST so a case's own `serverEnv` stays the last
    // word on everything else, exactly as before.
    env: { ...opts.credentialEnv, ...opts.env },
    ...(opts.launcher ? { launcher: opts.launcher } : {}),
  });
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
    result.error = TURN_TIMEOUT_ERROR;
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
 * Best-effort copy of the sandbox's `logs/` directory into
 * `<runDir>/<destName>/logs/`, so the evidence a failing case needs survives
 * BOTH a later `pnpm evals:sweep` (which still removes the retained sandbox
 * itself) and the `test-mode` tier, whose in-process boot never calls
 * `initLogger` and so never writes one at all.
 *
 * NEVER THROWS (DOR-1241 review, Blocker 1). A missing source directory means
 * this tier wrote no server log and is silent; anything else — an EACCES, or
 * an ENOSPC that retention itself is the likeliest source of — is a warning on
 * stderr, not a rejection. This is a best-effort debugging aid layered onto a
 * case that already has a verdict; letting a copy failure reject `runEval`
 * would crash the run trying to report that verdict (and every other case's
 * already-written result along with it — `runSuite`'s per-case loop has
 * nothing that catches this).
 *
 * @param sandbox - The eval's sandbox (source: `<dorkHome>/logs`).
 * @param runDir - The run's output directory (`results.json`'s directory).
 * @param destName - The destination subfolder, attempt-scoped (the same name
 *   `transcriptNameForAttempt` gives the transcript, minus `.jsonl`) so a
 *   retry's second attempt cannot overwrite the first one's logs.
 * @returns The copied directory's path relative to `runDir`, or `undefined`
 *   when there was nothing to copy or the copy failed.
 */
async function retainLogs(
  sandbox: Pick<Sandbox, 'dorkHome'>,
  runDir: string,
  destName: string
): Promise<string | undefined> {
  const source = path.join(sandbox.dorkHome, 'logs');
  const destRelative = path.join(destName, 'logs');
  try {
    await cp(source, path.join(runDir, destRelative), { recursive: true });
    return destRelative;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      process.stderr.write(
        `[evals] could not copy logs for ${destName}: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
    return undefined;
  }
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

  // Credentialed tiers need a way to reach a model; having none is a RUNNER
  // error (never a false pass), reported before any sandbox/server is spun up.
  const isolation = isolationOf(opts.tier, opts.launcher);
  const { credential, paidRefusal } = await resolveCredentialFor(
    opts.tier,
    opts.credential,
    opts.runtime,
    opts.provider
  );
  if (opts.tier !== 'test-mode') {
    const gateError = credentialGateError(opts.tier, isolation, credential, paidRefusal);
    if (gateError) {
      result.status = 'error';
      result.error = gateError;
      result.durationMs = Date.now() - start;
      return result;
    }
  }

  result.isolation = isolation;
  if (opts.runtime) result.runtime = opts.runtime;

  const sandbox = await createSandbox();
  let server: HarnessServer | undefined;
  let frames: SseFrame[] = [];
  let room: RoomFacts | undefined;
  let sessionId: string = randomUUID();
  // One client identity for the whole eval, shared by the multi-turn
  // conversation AND a trailing widget turn — matching what a real cockpit
  // client sends. That guarantees the conversation's OWN turns never collide
  // (SessionTurnQueue makes a later `/messages` trigger from the SAME client
  // wait rather than race the lock). A trailing widget turn is NOT covered the
  // same way: `/ui-action` opts out of that queue and can still 409 under this
  // same client id, in the window between a turn's `turn_end` frame and its
  // runtime stream fully settling (DOR-1239; see
  // `drive.ts`'s `DriveWidgetActionOptions.clientId`).
  const clientId = randomUUID();
  let failed = false;
  let approvalDriver: ApprovalDriver | undefined;
  // True once a trigger has been POSTed to a real runtime — from that instant
  // the eval may have spent money, whether or not it ever reports a cost.
  let turnAttempted = false;

  // Ctrl-C mid-run must not leave a container running or a sandbox on disk. The
  // handler disposes UNCONDITIONALLY (an interrupt is not a failure to debug).
  const releaseInterrupt = onInterrupt(async () => {
    await server?.dispose({ failed: false });
    await sandbox.cleanup({ failed: false });
  });

  try {
    // Seed the sandbox BEFORE the server boots or any turn runs — a case that
    // needs pre-existing on-disk state (e.g. the newborn agent the interview
    // eval rewrites the soul of) installs it here into the fresh sandbox.
    await evalCase.seed?.(sandbox);

    server = await bootServerForTier(opts.tier, sandbox.dorkHome, {
      // A case may pin its OWN model (the terminal-failure case needs an
      // unreachable one) without moving the rest of the run off the pin.
      model: evalCase.model ?? opts.model,
      ...(opts.runtime ? { runtime: opts.runtime } : {}),
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.openCodeBinaryPath ? { openCodeBinaryPath: opts.openCodeBinaryPath } : {}),
      ...(credential ? { credentialEnv: credential.env } : {}),
      ...(evalCase.serverEnv ? { env: evalCase.serverEnv } : {}),
      ...(opts.launcher ? { launcher: opts.launcher } : {}),
    });
    // The cwd a turn runs in must be a path the SERVER can validate against its
    // own filesystem boundary. Local tiers see the host sandbox; the docker tier
    // sees it at its container mount point and reports that as `projectCwd`.
    // Oracles are unaffected — they always read the host sandbox.
    const driveCwd = server.projectCwd ?? sandbox.projectCwd;
    const ceiling = evalCase.perEvalCeilingUsd;
    const abortWhen =
      ceiling !== undefined ? (fs: SseFrame[]) => evalCostUsd(fs) > ceiling : undefined;

    // A case that drives a real tool parks on an approval prompt nobody would
    // otherwise answer (DOR-498). The driver answers within the case's policy and
    // hands its record to the oracles; a case without a policy gets no driver and
    // an empty log, which is correct for a turn that runs no tools.
    const probeBeforeDecision = evalCase.probeBeforeDecision;
    if (evalCase.approvalPolicy) {
      approvalDriver = new ApprovalDriver({
        baseUrl: server.baseUrl,
        policy: evalCase.approvalPolicy,
        ...(probeBeforeDecision ? { probe: () => probeBeforeDecision(sandbox) } : {}),
      });
      approvalDriver.start();
    }
    const driver = approvalDriver;
    const onFrames = driver ? (fs: SseFrame[], id: string) => driver.observe(fs, id) : undefined;

    if (turns.length > 0) {
      turnAttempted = true;
      const drive = await driveConversation({
        baseUrl: server.baseUrl,
        sessionId,
        cwd: driveCwd,
        prompts: turns,
        clientId,
        timeoutMs: opts.timeoutMs,
        abortWhen,
        onFrames,
        ...(opts.runtime ? { runtime: opts.runtime } : {}),
      });
      frames = drive.frames;
      sessionId = drive.canonicalId;
      failed = applyNonDoneOutcome(result, drive.outcome);
    }

    // A widget-round-trip case POSTs its action AFTER the prompt(s) established
    // the session — a fresh turn on the runtime-agnostic /ui-action channel.
    if (!failed && evalCase.widgetAction) {
      turnAttempted = true;
      const widget = await driveWidgetAction({
        baseUrl: server.baseUrl,
        sessionId,
        action: evalCase.widgetAction,
        cwd: driveCwd,
        clientId,
        timeoutMs: opts.timeoutMs,
        abortWhen,
        onFrames,
      });
      frames = [...frames, ...widget.frames];
      sessionId = widget.canonicalId;
      failed = applyNonDoneOutcome(result, widget.outcome);
    }

    // A ROOM case drives the room API instead of a session (DOR-1217). Its
    // frames REPLACE whatever the session drive collected — which is nothing, a
    // room case carries no prompt — because the oracles that read them are the
    // room ones, and mixing two stream vocabularies in one array would make
    // every frame predicate ambiguous.
    if (!failed && evalCase.roomScript) {
      turnAttempted = true;
      const scripted = await evalCase.roomScript({
        baseUrl: server.baseUrl,
        sandbox,
        cwd: driveCwd,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      frames = scripted.frames;
      room = scripted.room;
    }

    // Stop the driver BEFORE the oracles read its log: a decision POSTed in the
    // last moments of a turn must be recorded, or a case would fail on evidence
    // that was still being written.
    await approvalDriver?.stop();

    // Record cost even on a boot-only case (0 for test-mode). A per-run breach is
    // surfaced via the tracker for the caller to skip the remaining evals.
    const verdict = opts.tracker.record(frames, { perEvalCeilingUsd: ceiling });
    result.costUsd = verdict.evalCostUsd;

    const ctx: OracleContext = {
      sandbox,
      baseUrl: server.baseUrl,
      sessionId,
      frames,
      approvals: approvalDriver?.log ?? emptyApprovalLog(),
      ...(room ? { room } : {}),
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
    // Idempotent — already stopped on the happy path; this is the timeout/throw
    // path, where an unstopped poll timer would keep the process alive.
    await approvalDriver?.stop();
    result.durationMs = Date.now() - start;
    // A credentialed turn that never reported a cost SPENT something the harness
    // cannot measure. Recorded here rather than beside `tracker.record` so the
    // paths that skip it — a timeout, a thrown DriveError — are covered too:
    // those are the expensive ones, and they were the ones reporting $0.0000.
    result.costUnmetered =
      turnAttempted && opts.tier !== 'test-mode' && evalCostSignal(frames) === null;
    // Also the name the retained logs land under (below) — attempt-scoped, the
    // same way `transcriptNameForAttempt` scopes the transcript, so a retry's
    // second attempt cannot overwrite the first one's evidence (DOR-1241
    // review, Important 2). Captured in a local rather than re-read off
    // `result.transcript` so the type stays a plain `string` across the
    // `await` below.
    const transcriptName = opts.transcriptName ?? `${evalCase.id}.jsonl`;
    result.transcript = transcriptName;
    await writeTranscript(opts.runDir, {
      runId: opts.runId,
      evalId: evalCase.id,
      ...(opts.transcriptName ? { fileName: opts.transcriptName } : {}),
      title: evalCase.title,
      startedAt: startedAt.toISOString(),
      prompts: turns,
      frames,
      oracleResults: result.oracleResults,
      rubricResult: result.rubricResult,
      ...(approvalDriver ? { approvals: approvalDriver.log } : {}),
      ...(room ? { room } : {}),
    });
    // A failed outcome retains its evidence — GATING or QUARANTINED alike
    // (DOR-1241). A quarantined case fails BY DESIGN on `test-mode` (its
    // oracles need real MCP tools), but on a credentialed tier a quarantined
    // red is exactly the failure someone needs to read next; deleting its
    // sandbox took the server log that would have explained it (DOR-1229's
    // hang was found by mirroring `{DORK_HOME}/logs/dorkos.log` out from under
    // a live run). One retention rule, no quarantine exception — this also
    // fixes container retention on the docker tier, whose `dispose({ failed
    // })` reads the same flag.
    const retain = failed;
    // Nested try/finally (DOR-1241 review, Blocker 1): `retainLogs` no longer
    // throws, but disposal/retention staying INSIDE its own try means a fault
    // neither of them anticipated still cannot skip cleanup — a leaked sandbox
    // and a leaked SIGTERM handler must never be the price of a best-effort
    // debugging aid going wrong.
    try {
      await server?.dispose({ failed: retain });
      if (retain) {
        result.retainedSandbox = sandbox.dorkHome;
        result.retainedLogsPath = await retainLogs(
          sandbox,
          opts.runDir,
          transcriptName.replace(/\.jsonl$/, '')
        );
      }
    } finally {
      await sandbox.cleanup({ failed: retain });
      releaseInterrupt();
    }
  }

  return result;
}
