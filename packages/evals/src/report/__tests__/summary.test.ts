/**
 * Results summary: `results.json` validates against the `EvalResult`/
 * `RunSummary` schema, a quarantined eval renders as `quarantined` (never
 * dropped), and the gate ignores quarantined failures.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunSummarySchema, type EvalResult, type RunSummary } from '../../types.js';
import { writeResults, formatSummaryTable, runGateFailed } from '../summary.js';

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

function result(over: Partial<EvalResult>): EvalResult {
  return {
    id: 'x',
    title: 'X',
    status: 'pass',
    runtimeTier: 'test-mode',
    costClass: 'free',
    costUsd: 0,
    durationMs: 12,
    oracleResults: [],
    quarantined: false,
    retried: false,
    ...over,
  };
}

function summary(results: EvalResult[]): RunSummary {
  return {
    runId: 'run-1',
    startedAt: '2026-07-18T00:00:00.000Z',
    tier: 'test-mode',
    budgetUsd: 3,
    totalCostUsd: results.reduce((n, r) => n + r.costUsd, 0),
    results,
  };
}

describe('writeResults', () => {
  it('writes a results.json that validates against RunSummarySchema', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'evals-sum-'));
    const file = await writeResults(dir, summary([result({ id: 'a' })]));
    const parsed = RunSummarySchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    expect(parsed.success).toBe(true);
  });
});

describe('formatSummaryTable', () => {
  it('renders a quarantined eval as `quarantined`, never as its raw fail status', () => {
    const table = formatSummaryTable(
      summary([result({ id: 'connector-slack', status: 'fail', quarantined: true })])
    );
    expect(table).toContain('quarantined');
    expect(table).toContain('connector-slack');
    // Its failure still counts under the quarantined tally, not the failed one.
    expect(table).toMatch(/0 failed/);
    expect(table).toMatch(/1 quarantined/);
  });
});

describe('runGateFailed', () => {
  it('gates on a real failure but NOT on a quarantined failure', () => {
    expect(runGateFailed(summary([result({ status: 'fail' })]))).toBe(true);
    expect(runGateFailed(summary([result({ status: 'fail', quarantined: true })]))).toBe(false);
    expect(runGateFailed(summary([result({ status: 'pass' })]))).toBe(false);
  });
});
