/**
 * run-eval orchestrator: the placeholder `test-mode` self-test runs green
 * end-to-end (sandbox → in-process boot → health oracle → transcript + result),
 * the `widget-round-trip` product eval runs green on `test-mode` (a seed turn
 * then a `/ui-action` turn whose injected trigger the oracle asserts), a failing
 * oracle scores `fail`, and a credentialed tier with no `ANTHROPIC_API_KEY`
 * scores a runner `error`, never a false pass.
 *
 * Two more contracts are pinned here because both leaked silently before: the
 * result records the isolation the eval ACTUALLY ran inside, and a QUARANTINED
 * case never retains its sandbox (it fails by design on `test-mode`, so honoring
 * retain-on-failure leaked one sandbox per case per run).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SANDBOX_PREFIX } from '../sandbox.js';
import type { EvalCase } from '../../types.js';
import { httpGetAssert } from '../../oracles/api.js';
import { selfTestCase } from '../../suite/selftest.js';
import { widgetRoundTripCase } from '../../suite/ui.js';
import { BudgetTracker } from '../budget.js';
import { runEval } from '../run-eval.js';

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
    expect(result.oracleResults.every((r) => r.passed)).toBe(true);
    // The transcript captured both the seed turn and the widget-action turn.
    const tx = await stat(path.join(dir, 'widget-round-trip.jsonl'));
    expect(tx.isFile()).toBe(true);
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

  it('scores a credentialed tier with no ANTHROPIC_API_KEY as a runner `error` (never a false pass)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { runDir: dir, tracker } = await fixture();
    const result = await runEval(selfTestCase, {
      tier: 'claude-code-cheap',
      runId: 'r',
      runDir: dir,
      tracker,
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('ANTHROPIC_API_KEY');
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

  it('retains a NON-quarantined failure’s sandbox for debugging', async () => {
    const { runDir: dir, tracker } = await fixture();
    const before = await countSandboxes();
    const failing: EvalCase = {
      ...selfTestCase,
      id: 'selftest-retained',
      oracles: [httpGetAssert('/api/health', { status: 404 })],
    };
    const result = await runEval(failing, { tier: 'test-mode', runId: 'r', runDir: dir, tracker });
    expect(result.status).toBe('fail');
    expect(await countSandboxes()).toBe(before + 1);
  });

  it('NEVER retains a QUARANTINED failure’s sandbox (it fails by design every run)', async () => {
    const { runDir: dir, tracker } = await fixture();
    const before = await countSandboxes();
    const quarantined: EvalCase = {
      ...selfTestCase,
      id: 'selftest-quarantined',
      quarantined: true,
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
    // 76 leaked directories / 22 MB were found on one machine before this.
    expect(await countSandboxes()).toBe(before);
  });
});
