/**
 * run-eval orchestrator: the placeholder `test-mode` self-test runs green
 * end-to-end (sandbox → in-process boot → health oracle → transcript + result),
 * the `widget-round-trip` product eval runs green on `test-mode` (a seed turn
 * then a `/ui-action` turn whose injected trigger the oracle asserts), a failing
 * oracle scores `fail`, and a credentialed tier with NO way at all to reach a
 * model scores a runner `error`, never a false pass.
 *
 * The credential gate is the fail-closed contract and it is pinned twice here.
 * The definition of "credentialed" widened (an API key, a subscription token, or
 * the `claude` sign-in on this machine), but "nothing resolved ⇒ runner error"
 * did not move. The second pin is the docker tier, which cannot use the local
 * sign-in — the container is deliberately cut off from the host's credentials, so
 * a local-only credential there is an error rather than a quiet downgrade.
 *
 * Two more contracts are pinned here because both leaked silently before: the
 * result records the isolation the eval ACTUALLY ran inside, and — since
 * DOR-1241 — retention no longer excepts quarantined cases: a QUARANTINED
 * failure retains its sandbox (and copies its server `logs/` into the run
 * directory) exactly like a gating one, because a quarantined case's failure
 * is exactly the one someone needs to read next. Only a PASS, quarantined or
 * not, still tears everything down.
 *
 * A third contract, pinned after DOR-1241's first review round: a log-copy
 * failure that is NOT a missing directory (EACCES, ENOSPC) must never crash
 * the case it happened on — `retainLogs` is best-effort, so the case's result
 * still reports its real status, `retainedSandbox` still points at the
 * sandbox, and the interrupt handler still releases. And a retried case's two
 * attempts must not clobber each other's copied logs, mirroring the
 * transcript's own attempt-scoped naming.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hasLocalClaudeLogin } from '@dorkos/server/services/runtimes/claude-code/auth-probe';
import { SANDBOX_PREFIX } from '../sandbox.js';
import { sweepStrays } from '../sweep.js';
import { liveDisposerCount } from '../interrupt.js';
import type { EvalCase, EvalSandbox } from '../../types.js';
import type { IsolationLauncher } from '../isolation/index.js';
import { httpGetAssert } from '../../oracles/api.js';
import { selfTestCase } from '../../suite/selftest.js';
import { widgetRoundTripCase } from '../../suite/ui.js';
import { BudgetTracker } from '../budget.js';
import { transcriptNameForAttempt } from '../retry.js';
import { runEval } from '../run-eval.js';

// The local-sign-in probe shells out to the real `claude` binary. Left real, this
// file's credential-gate tests would pass or fail depending on whether whoever
// ran them happens to be signed in — and on a signed-in machine the "no
// credential" test would boot a real credentialed server and spend money.
vi.mock('@dorkos/server/services/runtimes/claude-code/auth-probe', () => ({
  hasLocalClaudeLogin: vi.fn(async () => false),
}));
const mockedLocalLogin = vi.mocked(hasLocalClaudeLogin);

// `cp` wrapped over the REAL implementation: every test gets the genuine
// filesystem behavior (including a genuine ENOENT for a case with no
// `logs/` dir) unless a test queues a one-shot rejection with
// `mockRejectedValueOnce` to simulate a non-ENOENT copy failure (EACCES).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, cp: vi.fn(actual.cp) };
});
const mockedCp = vi.mocked(cp);

let runDir: string | undefined;
/**
 * A private temp root for THIS test's sandboxes.
 *
 * Several tests here fail an eval on purpose, and a non-quarantined failure
 * legitimately RETAINS its sandbox — so the suite used to leak one temp directory
 * per run, the very thing the retention fix is about. Counting sandboxes in the
 * shared OS temp dir is not a safe way to clean up after them: vitest runs test
 * FILES in parallel, so a count-and-delete would race, and could delete another
 * file's live sandbox. Stubbing `TMPDIR` makes this file hermetic instead —
 * `os.tmpdir()` reads it per call, so every sandbox `runEval` creates here lands
 * in a directory only this test owns.
 */
let sandboxRoot: string | undefined;

beforeEach(async () => {
  sandboxRoot = await mkdtemp(path.join(tmpdir(), 'evals-sandbox-root-'));
  vi.stubEnv('TMPDIR', sandboxRoot);
  // Neither pinned credential variable is set for this file unless a test says so.
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
  mockedLocalLogin.mockResolvedValue(false);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (runDir) await rm(runDir, { recursive: true, force: true });
  runDir = undefined;
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
  sandboxRoot = undefined;
});

/** A fresh run directory + tracker for one runEval call. */
async function fixture(): Promise<{ runDir: string; tracker: BudgetTracker }> {
  // NOT under the stubbed TMPDIR: the run dir holds transcripts, and keeping it
  // out of the sandbox root keeps the sandbox count unambiguous.
  runDir = await mkdtemp(path.join('/tmp', 'evals-run-'));
  return { runDir, tracker: new BudgetTracker() };
}

/** How many sandboxes this test's private temp root holds. */
async function countSandboxes(): Promise<number> {
  const entries = await readdir(sandboxRoot ?? tmpdir());
  return entries.filter((e) => e.startsWith(SANDBOX_PREFIX)).length;
}

describe('runEval', () => {
  it('runs the placeholder test-mode self-test green and writes a transcript', async () => {
    const { runDir: dir, tracker } = await fixture();
    const result = await runEval(selfTestCase, {
      tier: 'test-mode',
      runId: 'run-1',
      runDir: dir,
      tracker,
    });

    expect(result.status).toBe('pass');
    expect(result.costUsd).toBe(0);
    expect(result.oracleResults.every((r) => r.passed)).toBe(true);
    // A JSONL transcript was written for the eval.
    const tx = await stat(path.join(dir, 'harness-selftest.jsonl'));
    expect(tx.isFile()).toBe(true);
  });

  it('runs the widget-round-trip product eval green on test-mode (the injected action reaches a new turn)', async () => {
    const { runDir: dir, tracker } = await fixture();
    const result = await runEval(widgetRoundTripCase, {
      tier: 'test-mode',
      runId: 'run-widget',
      runDir: dir,
      tracker,
    });

    expect(result.status).toBe('pass');
    expect(result.costUsd).toBe(0);
    // `test-mode` is free BY DESIGN, so its $0 is a measurement, not a gap.
    expect(result.costUnmetered).toBe(false);
    expect(result.oracleResults.every((r) => r.passed)).toBe(true);
    // The transcript captured both the seed turn and the widget-action turn.
    const tx = await stat(path.join(dir, 'widget-round-trip.jsonl'));
    expect(tx.isFile()).toBe(true);
  });

  it('writes a retry attempt to its own transcript rather than over the first one', async () => {
    // The first attempt's frames are the only evidence for classifying it as
    // infrastructure. A retry that overwrote them would make the classification
    // unverifiable by the person it is asking to trust it.
    const { runDir: dir, tracker } = await fixture();
    const result = await runEval(selfTestCase, {
      tier: 'test-mode',
      runId: 'run-retry',
      runDir: dir,
      tracker,
      transcriptName: transcriptNameForAttempt(selfTestCase.id, 2),
    });

    expect(result.transcript).toBe('harness-selftest.retry.jsonl');
    expect((await stat(path.join(dir, 'harness-selftest.retry.jsonl'))).isFile()).toBe(true);
    await expect(stat(path.join(dir, 'harness-selftest.jsonl'))).rejects.toThrow();
  });

  it('scores `fail` when an oracle does not pass (a broken assertion is caught)', async () => {
    const { runDir: dir, tracker } = await fixture();
    const failing: EvalCase = {
      ...selfTestCase,
      id: 'selftest-failing',
      oracles: [httpGetAssert('/api/health', { status: 404 })],
    };
    const result = await runEval(failing, { tier: 'test-mode', runId: 'r', runDir: dir, tracker });
    expect(result.status).toBe('fail');
  });

  it('scores a credentialed tier with NO credential at all as a runner `error` (never a false pass)', async () => {
    // No API key, no subscription token, and `claude` is not signed in — the
    // widened definition of "credentialed" still has to fail closed here.
    const { runDir: dir, tracker } = await fixture();
    const result = await runEval(selfTestCase, {
      tier: 'claude-code-cheap',
      runId: 'r',
      runDir: dir,
      tracker,
    });
    expect(result.status).toBe('error');
    // It refused before booting anything, so nothing was spent — an error is not
    // automatically unmetered spend, or the flag would mean nothing.
    expect(result.costUnmetered).toBe(false);
    // The message names every way to fix it, not only the env var — a developer
    // who is simply signed out should be told to sign in, not sent hunting for a key.
    expect(result.error).toContain('ANTHROPIC_API_KEY');
    expect(result.error).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(result.error).toContain('claude auth login');
  });

  it('scores the docker tier with only a local `claude` sign-in as a runner `error`', async () => {
    // The container gets a curated env and no host home, so the local sign-in
    // cannot reach it. Mounting host credentials in would undo the containment
    // the docker tier exists for, so this is an error with a fix, not a downgrade.
    mockedLocalLogin.mockResolvedValue(true);
    const dockerLauncher = { id: 'docker', launch: vi.fn() } as unknown as IsolationLauncher;
    const { runDir: dir, tracker } = await fixture();
    const result = await runEval(selfTestCase, {
      tier: 'claude-code-cheap',
      runId: 'r',
      runDir: dir,
      tracker,
      launcher: dockerLauncher,
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('ANTHROPIC_API_KEY');
    expect(result.error).toContain('--isolation child-process');
    // It refused BEFORE launching anything — that is what makes it fail closed.
    expect(dockerLauncher.launch).not.toHaveBeenCalled();
  });

  it('records the isolation the eval actually ran inside', async () => {
    const { runDir: dir, tracker } = await fixture();
    const result = await runEval(selfTestCase, {
      tier: 'test-mode',
      runId: 'run-iso',
      runDir: dir,
      tracker,
    });
    // Whoever promotes a case out of quarantine reads this to know whether the
    // destructive turn ran in a container or on the bare host.
    expect(result.isolation).toBe('in-process');
  });

  /** Seeds a `logs/dorkos.log` file with `content` into the sandbox, mimicking `initLogger()` output. */
  function seedLogsWithContent(sandbox: EvalSandbox, content: string): Promise<void> {
    return mkdir(path.join(sandbox.dorkHome, 'logs'), { recursive: true }).then(() =>
      writeFile(path.join(sandbox.dorkHome, 'logs', 'dorkos.log'), content, 'utf8')
    );
  }

  /** Seeds a `logs/dorkos.log` file into the sandbox, mimicking a real boot's `initLogger()` output. */
  function seedLogs(sandbox: EvalSandbox): Promise<void> {
    return seedLogsWithContent(sandbox, '{"msg":"boot"}\n');
  }

  it('retains a NON-quarantined (gating) failure’s sandbox, and copies its logs into the run dir', async () => {
    const { runDir: dir, tracker } = await fixture();
    const before = await countSandboxes();
    const failing: EvalCase = {
      ...selfTestCase,
      id: 'selftest-retained',
      seed: seedLogs,
      oracles: [httpGetAssert('/api/health', { status: 404 })],
    };
    const result = await runEval(failing, { tier: 'test-mode', runId: 'r', runDir: dir, tracker });
    expect(result.status).toBe('fail');
    expect(await countSandboxes()).toBe(before + 1);
    expect(result.retainedSandbox).toBeTruthy();
    expect((await stat(result.retainedSandbox ?? '')).isDirectory()).toBe(true);
    expect(result.retainedLogsPath).toBe(path.join('selftest-retained', 'logs'));
    const copied = await readFile(
      path.join(dir, result.retainedLogsPath ?? '', 'dorkos.log'),
      'utf8'
    );
    expect(copied).toBe('{"msg":"boot"}\n');
  });

  it('retains a QUARANTINED failure’s sandbox too, and copies its logs (DOR-1241)', async () => {
    // Before DOR-1241 a quarantined failure was cleaned up exactly like a pass,
    // which is what deleted the server log that would have explained a
    // quarantined red — the very case whose failure someone needs to read next.
    const { runDir: dir, tracker } = await fixture();
    const before = await countSandboxes();
    const quarantined: EvalCase = {
      ...selfTestCase,
      id: 'selftest-quarantined-fail',
      quarantined: true,
      seed: seedLogs,
      oracles: [httpGetAssert('/api/health', { status: 404 })],
    };
    const result = await runEval(quarantined, {
      tier: 'test-mode',
      runId: 'r',
      runDir: dir,
      tracker,
    });
    expect(result.status).toBe('fail');
    expect(result.quarantined).toBe(true);
    expect(await countSandboxes()).toBe(before + 1);
    expect(result.retainedSandbox).toBeTruthy();
    expect(result.retainedLogsPath).toBe(path.join('selftest-quarantined-fail', 'logs'));
    const copied = await readFile(
      path.join(dir, result.retainedLogsPath ?? '', 'dorkos.log'),
      'utf8'
    );
    expect(copied).toBe('{"msg":"boot"}\n');
  });

  it('cleans up a QUARANTINED case that PASSES, exactly like before', async () => {
    const { runDir: dir, tracker } = await fixture();
    const before = await countSandboxes();
    const quarantinedPass: EvalCase = {
      ...selfTestCase,
      id: 'selftest-quarantined-pass',
      quarantined: true,
    };
    const result = await runEval(quarantinedPass, {
      tier: 'test-mode',
      runId: 'r',
      runDir: dir,
      tracker,
    });
    expect(result.status).toBe('pass');
    expect(result.quarantined).toBe(true);
    expect(result.retainedSandbox).toBeUndefined();
    expect(result.retainedLogsPath).toBeUndefined();
    // No leak on the pass path — quarantined or not.
    expect(await countSandboxes()).toBe(before);
  });

  it('a retained sandbox is still swept by `pnpm evals:sweep` (retention is not permanent)', async () => {
    const { runDir: dir, tracker } = await fixture();
    const quarantined: EvalCase = {
      ...selfTestCase,
      id: 'selftest-quarantined-swept',
      quarantined: true,
      oracles: [httpGetAssert('/api/health', { status: 404 })],
    };
    const result = await runEval(quarantined, {
      tier: 'test-mode',
      runId: 'r',
      runDir: dir,
      tracker,
    });
    expect(result.retainedSandbox).toBeTruthy();
    expect(await countSandboxes()).toBe(1);

    const report = await sweepStrays({ tempRoot: sandboxRoot });
    expect(report.sandboxes).toHaveLength(1);
    expect(await countSandboxes()).toBe(0);
    // `retainedSandbox` is `<sandbox root>/.dork` — the sweep removed the whole
    // sandbox root above it, so the retained path itself is gone too.
    await expect(stat(result.retainedSandbox ?? '')).rejects.toThrow();
  });

  it('a non-ENOENT log-copy failure (EACCES) does not crash the run (DOR-1241 review, Blocker 1)', async () => {
    // Reproduces the reviewer's finding: fs.cp rejecting for a reason OTHER
    // than "nothing to copy" used to propagate out of runEval's finally block
    // entirely, skipping sandbox.cleanup and releaseInterrupt and rejecting
    // the whole case — which, one level up, would have taken runSuite's
    // results.json down with it, every already-passed case included.
    mockedCp.mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied, mkdir'), { code: 'EACCES' })
    );
    const disposersBefore = liveDisposerCount();
    const { runDir: dir, tracker } = await fixture();
    const before = await countSandboxes();
    const failing: EvalCase = {
      ...selfTestCase,
      id: 'selftest-eacces',
      seed: seedLogs,
      oracles: [httpGetAssert('/api/health', { status: 404 })],
    };

    const result = await runEval(failing, { tier: 'test-mode', runId: 'r', runDir: dir, tracker });

    // The case's real verdict survives the copy failure untouched.
    expect(result.status).toBe('fail');
    // The sandbox pointer is still recorded — retention itself did not fail,
    // only the best-effort logs copy layered on top of it.
    expect(result.retainedSandbox).toBeTruthy();
    expect(await countSandboxes()).toBe(before + 1);
    // The logs copy that failed leaves no path behind, rather than pointing at
    // something that was never actually copied.
    expect(result.retainedLogsPath).toBeUndefined();
    // No leaked SIGTERM/SIGINT disposer — cleanup's nested finally ran.
    expect(liveDisposerCount()).toBe(disposersBefore);
  });

  it("a retried case's two attempts do not clobber each other's copied logs (DOR-1241 review, Important 2)", async () => {
    // Mirrors `transcriptNameForAttempt`'s own naming, which run-eval.ts now
    // threads into the logs destination too. Simulates what
    // `runWithInfrastructureRetry` drives: the same case id, twice, under its
    // two attempt-scoped transcript names.
    const { runDir: dir, tracker } = await fixture();
    const failing: EvalCase = {
      ...selfTestCase,
      id: 'selftest-retry-logs',
      oracles: [httpGetAssert('/api/health', { status: 404 })],
    };

    const attempt1Result = await runEval(
      { ...failing, seed: (sandbox) => seedLogsWithContent(sandbox, 'attempt 1\n') },
      {
        tier: 'test-mode',
        runId: 'r',
        runDir: dir,
        tracker,
        transcriptName: transcriptNameForAttempt('selftest-retry-logs', 1),
      }
    );
    const attempt2Result = await runEval(
      { ...failing, seed: (sandbox) => seedLogsWithContent(sandbox, 'attempt 2\n') },
      {
        tier: 'test-mode',
        runId: 'r',
        runDir: dir,
        tracker,
        transcriptName: transcriptNameForAttempt('selftest-retry-logs', 2),
      }
    );

    expect(attempt1Result.retainedLogsPath).toBe(path.join('selftest-retry-logs', 'logs'));
    expect(attempt2Result.retainedLogsPath).toBe(path.join('selftest-retry-logs.retry', 'logs'));
    expect(attempt1Result.retainedLogsPath).not.toBe(attempt2Result.retainedLogsPath);

    // Both attempts' logs are independently readable — neither overwrote the other.
    const log1 = await readFile(
      path.join(dir, attempt1Result.retainedLogsPath ?? '', 'dorkos.log'),
      'utf8'
    );
    const log2 = await readFile(
      path.join(dir, attempt2Result.retainedLogsPath ?? '', 'dorkos.log'),
      'utf8'
    );
    expect(log1).toBe('attempt 1\n');
    expect(log2).toBe('attempt 2\n');
  });
});
