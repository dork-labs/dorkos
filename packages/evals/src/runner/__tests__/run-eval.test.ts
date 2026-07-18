/**
 * run-eval orchestrator: the placeholder `test-mode` self-test runs green
 * end-to-end (sandbox → in-process boot → health oracle → transcript + result),
 * the `widget-round-trip` product eval runs green on `test-mode` (a seed turn
 * then a `/ui-action` turn whose injected trigger the oracle asserts), a failing
 * oracle scores `fail`, and a credentialed tier with no `ANTHROPIC_API_KEY`
 * scores a runner `error`, never a false pass.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EvalCase } from '../../types.js';
import { httpGetAssert } from '../../oracles/api.js';
import { selfTestCase } from '../../suite/selftest.js';
import { widgetRoundTripCase } from '../../suite/ui.js';
import { BudgetTracker } from '../budget.js';
import { runEval } from '../run-eval.js';

let runDir: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (runDir) await rm(runDir, { recursive: true, force: true });
  runDir = undefined;
});

/** A fresh run directory + tracker for one runEval call. */
async function fixture(): Promise<{ runDir: string; tracker: BudgetTracker }> {
  runDir = await mkdtemp(path.join(tmpdir(), 'evals-run-'));
  return { runDir, tracker: new BudgetTracker() };
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
});
