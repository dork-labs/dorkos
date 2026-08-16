/**
 * The flake policy. Two things are pinned here, and the second one is the whole
 * argument for the first.
 *
 * 1. the infrastructure signature is retried once, and the retry never launders
 *    the second attempt's verdict;
 * 2. NOTHING that carries an oracle verdict can be classified as
 *    infrastructure. The tests below walk every shape a real failure arrives in
 *    — a red oracle, a green-oracle error, a different runner error — and each
 *    must come back false. A predicate that widened to swallow one of them would
 *    turn a product regression into a silent retry, which is the failure this
 *    whole file exists to prevent.
 */
import { describe, it, expect, vi } from 'vitest';
import type { EvalResult, OracleResult } from '../../types.js';
import {
  TURN_TIMEOUT_ERROR,
  isInfrastructureError,
  runWithInfrastructureRetry,
  transcriptNameForAttempt,
} from '../retry.js';

/** A scored result with the governance cases' shape, overridable per test. */
function result(over: Partial<EvalResult> = {}): EvalResult {
  return {
    id: 'governance-approval-granted',
    title: 'Governance — a person approves a destructive uninstall',
    status: 'error',
    runtimeTier: 'claude-code-cheap',
    costClass: 'cheap',
    costUsd: 0,
    costUnmetered: true,
    durationMs: 91_776,
    oracleResults: [],
    quarantined: true,
    retried: false,
    error: TURN_TIMEOUT_ERROR,
    ...over,
  };
}

/** One oracle verdict, for the "an oracle ran" cases. */
function oracle(passed: boolean): OracleResult {
  return { label: 'the tier gate stopped the uninstall', passed };
}

describe('isInfrastructureError', () => {
  it('classifies the measured signature: a turn timeout with zero oracles run', () => {
    // 29 tool calls, 91,776ms, no oracle ever reached. Twice out of ten runs.
    expect(isInfrastructureError(result())).toBe(true);
  });

  it('refuses a red oracle (an oracle verdict is never infrastructure)', () => {
    expect(
      isInfrastructureError(
        result({ status: 'fail', error: undefined, oracleResults: [oracle(false)] })
      )
    ).toBe(false);
  });

  it('refuses ANY result that ran an oracle, even one that errored afterwards', () => {
    // The dangerous near-miss: the product was observed, then something fell
    // over. What was observed is the answer; retrying would discard it.
    expect(isInfrastructureError(result({ oracleResults: [oracle(true)] }))).toBe(false);
  });

  it('refuses a pass', () => {
    expect(
      isInfrastructureError(
        result({ status: 'pass', error: undefined, oracleResults: [oracle(true)] })
      )
    ).toBe(false);
  });

  it('refuses a different runner error, however plausible (a lock, a rejected trigger)', () => {
    // Each of these can be the product breaking, and none of them was measured.
    expect(
      isInfrastructureError(
        result({ error: 'SESSION_LOCKED: Session is locked by another client' })
      )
    ).toBe(false);
    expect(
      isInfrastructureError(result({ error: 'TRIGGER_REJECTED: Trigger POST returned 403' }))
    ).toBe(false);
  });

  it('refuses a near-miss message rather than matching loosely', () => {
    expect(isInfrastructureError(result({ error: 'Turn timed out' }))).toBe(false);
  });

  it('refuses a per-eval budget breach (a runaway turn is a fail, not a flake)', () => {
    expect(
      isInfrastructureError(
        result({
          status: 'fail',
          error: 'Eval exceeded its per-eval budget ceiling (runaway turn).',
        })
      )
    ).toBe(false);
  });

  it('refuses a skipped-over-budget case', () => {
    expect(isInfrastructureError(result({ status: 'skipped-over-budget', error: undefined }))).toBe(
      false
    );
  });
});

describe('runWithInfrastructureRetry', () => {
  it('retries the infrastructure signature once and reports the second attempt', async () => {
    const attempt = vi
      .fn<(n: number) => Promise<EvalResult>>()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ status: 'pass', error: undefined, costUnmetered: false }));

    const final = await runWithInfrastructureRetry(attempt);

    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    expect(final.status).toBe('pass');
    expect(final.retried).toBe(true);
  });

  it('reports the second attempt even when it is WORSE (a retry is not a second chance to pass)', async () => {
    const attempt = vi
      .fn<(n: number) => Promise<EvalResult>>()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(
        result({ status: 'fail', error: undefined, oracleResults: [oracle(false)] })
      );

    const final = await runWithInfrastructureRetry(attempt);

    expect(final.status).toBe('fail');
    expect(final.retried).toBe(true);
  });

  it('keeps a second timeout as an error rather than forgiving it', async () => {
    const attempt = vi
      .fn<(n: number) => Promise<EvalResult>>()
      .mockResolvedValue(result())
      .mockName('attempt');

    const final = await runWithInfrastructureRetry(attempt);

    // Two attempts, still an error: a case that cannot reach its oracles is a
    // harness problem to fix, never a case that quietly stops reporting.
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(final.status).toBe('error');
    expect(final.retried).toBe(true);
  });

  it('never retries anything that is not the signature', async () => {
    const attempt = vi
      .fn<(n: number) => Promise<EvalResult>>()
      .mockResolvedValue(
        result({ status: 'fail', error: undefined, oracleResults: [oracle(false)] })
      );

    const final = await runWithInfrastructureRetry(attempt);

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(final.retried).toBe(false);
  });

  it('does not retry once the run budget is spent (a retry spends again)', async () => {
    const attempt = vi.fn<(n: number) => Promise<EvalResult>>().mockResolvedValue(result());

    const final = await runWithInfrastructureRetry(attempt, { canRetry: () => false });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(final.status).toBe('error');
    expect(final.retried).toBe(false);
  });

  it("carries attempt 1's retained sandbox/logs forward onto the recorded (attempt 2) result (DOR-1241 review, Important 2)", async () => {
    // A double timeout is the DOR-1229 hang class retention exists to
    // diagnose. Both attempts retain their OWN evidence under their own
    // attempt-scoped names (run-eval.ts), but the RECORDED result is always
    // attempt 2's — without this carry-forward, attempt 1's evidence would sit
    // on disk with nothing in results.json pointing at it.
    const attempt = vi
      .fn<(n: number) => Promise<EvalResult>>()
      .mockResolvedValueOnce(
        result({
          retainedSandbox: '/tmp/dorkos-evals-attempt1/.dork',
          retainedLogsPath: 'x.retry/logs',
        })
      )
      .mockResolvedValueOnce(
        result({
          retainedSandbox: '/tmp/dorkos-evals-attempt2/.dork',
          retainedLogsPath: 'x.retry/logs',
        })
      );

    const final = await runWithInfrastructureRetry(attempt);

    // The recorded pointers are attempt 2's own (unchanged from before this
    // fix)...
    expect(final.retainedSandbox).toBe('/tmp/dorkos-evals-attempt2/.dork');
    // ...and attempt 1's are ADDITIONALLY carried forward, never dropped.
    expect(final.priorAttemptRetainedSandbox).toBe('/tmp/dorkos-evals-attempt1/.dork');
    expect(final.priorAttemptRetainedLogsPath).toBe('x.retry/logs');
  });

  it('carries nothing forward when attempt 1 retained nothing (the ordinary retry path)', async () => {
    const attempt = vi
      .fn<(n: number) => Promise<EvalResult>>()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ status: 'pass', error: undefined, costUnmetered: false }));

    const final = await runWithInfrastructureRetry(attempt);

    expect(final.priorAttemptRetainedSandbox).toBeUndefined();
    expect(final.priorAttemptRetainedLogsPath).toBeUndefined();
  });
});

describe('transcriptNameForAttempt', () => {
  it('keeps the first attempt at the expected name and gives the retry its own', () => {
    // Both survive: the first attempt's frames are the evidence FOR the
    // classification, so a retry must not overwrite them.
    expect(transcriptNameForAttempt('governance-approval-granted', 1)).toBe(
      'governance-approval-granted.jsonl'
    );
    expect(transcriptNameForAttempt('governance-approval-granted', 2)).toBe(
      'governance-approval-granted.retry.jsonl'
    );
  });
});
