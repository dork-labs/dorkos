/**
 * Results summary: `results.json` validates against the `EvalResult`/
 * `RunSummary` schema, the console table never reads better than the JSON beside
 * it, and the gate ignores quarantined failures WITHOUT hiding them.
 *
 * The load-bearing assertions here are the two that were false before: a
 * quarantined failure must be visible AS a failure in the table, and a run that
 * gates on zero cases must FAIL rather than report green.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunSummarySchema, type EvalResult, type RunSummary } from '../../types.js';
import { writeResults, formatSummaryTable, evaluateRunGate } from '../summary.js';

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
  it('renders a quarantined FAILURE as `quarantined:fail`, never as the bare word', () => {
    const table = formatSummaryTable(
      summary([
        result({ id: 'widget-round-trip', status: 'pass' }),
        result({ id: 'connector-slack', status: 'fail', quarantined: true }),
      ])
    );
    // The outcome must survive the quarantine flag. Rendering only `quarantined`
    // under a "0 failed" footer is what hid six failing cases.
    expect(table).toContain('quarantined:fail');
    expect(table).toContain('connector-slack');
    expect(table).not.toMatch(/^quarantined\s/m);
    // It still does not count as a gating failure...
    expect(table).toMatch(/0 failed/);
    // ...but the footer says out loud that a quarantined case IS failing.
    expect(table).toMatch(/1 quarantined \(1 of them failing\)/);
  });

  it('renders a quarantined PASS as `quarantined:pass` (promotion evidence)', () => {
    const table = formatSummaryTable(
      summary([
        result({ id: 'widget-round-trip', status: 'pass' }),
        result({ id: 'governance-approval-gate', status: 'pass', quarantined: true }),
      ])
    );
    expect(table).toContain('quarantined:pass');
    expect(table).toMatch(/1 quarantined \(0 of them failing\)/);
  });

  it('states how many cases actually gate the run', () => {
    const table = formatSummaryTable(
      summary([
        result({ id: 'widget-round-trip', status: 'pass' }),
        result({ id: 'agent-self-edit', status: 'fail', quarantined: true }),
        result({ id: 'config-toggle', status: 'fail', quarantined: true }),
      ])
    );
    expect(table).toMatch(/GATING: 1 of 3 cases gate this run/);
  });

  it('says plainly that a fully quarantined run proves nothing', () => {
    const table = formatSummaryTable(
      summary([
        result({ id: 'connector-gmail', status: 'fail', quarantined: true }),
        result({ id: 'connector-slack', status: 'fail', quarantined: true }),
      ])
    );
    expect(table).toMatch(/GATING: 0 of 2 cases gate this run/);
    expect(table).toMatch(/proves nothing/);
  });

  it('keeps columns aligned for an id longer than the minimum width', () => {
    const table = formatSummaryTable(
      summary([
        result({ id: 'marketplace-search-and-install', status: 'fail', quarantined: true }),
        result({ id: 'widget-round-trip', status: 'pass' }),
      ])
    );
    const [header, longRow, shortRow] = table.split('\n');
    // Every row starts its TIER column at the same offset as the header's.
    const tierColumn = header.indexOf('TIER');
    expect(longRow.indexOf('test-mode')).toBe(tierColumn);
    expect(shortRow.indexOf('test-mode')).toBe(tierColumn);
  });

  it('WARNS when an API-KEY run reported no cost at all', () => {
    // A real turn always reports cumulative cost, so $0.0000 across a whole
    // credentialed run means no turn ran or the signal is missing — either way
    // the spend cap was never exercised. Silence here is the same shape as the
    // cleared-budget defect one layer down: a run that spends nothing looks
    // exactly like a run that spends unmetered.
    const table = formatSummaryTable({
      ...summary([result({ id: 'governance-approval-gate', runtimeTier: 'claude-code-cheap' })]),
      tier: 'claude-code-cheap',
      credentialSource: 'anthropic-api-key',
      totalCostUsd: 0,
    });
    expect(table).toMatch(/WARNING: this claude-code-cheap run reported \$0\.0000/);
    expect(table).toMatch(/not evidence about spend/);
  });

  it('does NOT warn about $0.0000 on a local subscription run, but still says the cap did not gate', () => {
    // Subscription turns report no per-turn cost, so $0.0000 is the EXPECTED
    // reading on the ordinary local path. Warning here would be a false alarm on
    // every developer's run, and a warning that always fires gets ignored — which
    // is how the real API-key symptom would then slip past.
    const table = formatSummaryTable({
      ...summary([result({ id: 'governance-approval-gate', runtimeTier: 'claude-code-cheap' })]),
      tier: 'claude-code-cheap',
      credentialSource: 'local-claude-login',
      totalCostUsd: 0,
    });
    expect(table).not.toMatch(/WARNING/);
    expect(table).toMatch(/NOTE: this run reported \$0\.0000/);
    expect(table).toMatch(/not evidence about spend/);
  });

  it('names the credential the run actually used', () => {
    const table = formatSummaryTable({
      ...summary([result({ id: 'a', runtimeTier: 'claude-code-cheap', costUsd: 0.02 })]),
      tier: 'claude-code-cheap',
      credentialSource: 'local-claude-login',
      totalCostUsd: 0.02,
    });
    // Nobody should have to guess which of the three sources answered.
    expect(table).toMatch(/CREDENTIAL: the Claude sign-in on this machine/);
  });

  it('does NOT warn about cost on a free test-mode run', () => {
    const table = formatSummaryTable(summary([result({ id: 'widget-round-trip' })]));
    expect(table).not.toMatch(/WARNING/);
  });

  it('does NOT warn when a credentialed run actually spent something', () => {
    const table = formatSummaryTable({
      ...summary([result({ id: 'a', runtimeTier: 'claude-code-cheap', costUsd: 0.02 })]),
      tier: 'claude-code-cheap',
      totalCostUsd: 0.02,
    });
    expect(table).not.toMatch(/WARNING/);
  });

  it('reports the isolation each eval actually ran inside', () => {
    const table = formatSummaryTable(
      summary([
        result({ id: 'governance-approval-gate', isolation: 'child-process', quarantined: true }),
        result({ id: 'widget-round-trip', isolation: 'in-process' }),
        result({ id: 'skipped-one', status: 'skipped-over-budget' }),
      ])
    );
    expect(table).toContain('ISOLATION');
    expect(table).toContain('child-process');
    expect(table).toContain('in-process');
    // A case that never launched a server says so rather than claiming a tier.
    expect(table).toContain('not-run');
  });
});

describe('evaluateRunGate', () => {
  it('gates on a real failure but NOT on a quarantined failure', () => {
    expect(evaluateRunGate(summary([result({ status: 'fail' })])).failed).toBe(true);
    const quarantinedFail = evaluateRunGate(
      summary([result({ id: 'a', status: 'pass' }), result({ status: 'fail', quarantined: true })])
    );
    expect(quarantinedFail.failed).toBe(false);
    expect(quarantinedFail.failingQuarantinedCases).toBe(1);
    expect(evaluateRunGate(summary([result({ status: 'pass' })])).failed).toBe(false);
  });

  it('FAILS a run that gated on zero cases, and says why', () => {
    // `--suite connector` and `--suite experimental` select only quarantined
    // cases; both used to exit 0 with no gating coverage at all.
    const verdict = evaluateRunGate(
      summary([
        result({ id: 'connector-gmail', status: 'fail', quarantined: true }),
        result({ id: 'connector-slack', status: 'pass', quarantined: true }),
      ])
    );
    expect(verdict.failed).toBe(true);
    expect(verdict.gatingCases).toBe(0);
    expect(verdict.reason).toMatch(/gated on 0 of 2 case\(s\)/);
  });

  it('gates on a skipped-over-budget eval and names it', () => {
    const verdict = evaluateRunGate(
      summary([result({ id: 'ran-out', status: 'skipped-over-budget' })])
    );
    expect(verdict.failed).toBe(true);
    expect(verdict.reason).toMatch(/ran-out \(skipped-over-budget\)/);
  });

  it('counts coverage even on a clean run', () => {
    const verdict = evaluateRunGate(
      summary([
        result({ id: 'widget-round-trip', status: 'pass' }),
        result({ id: 'governance-approval-gate', status: 'fail', quarantined: true }),
      ])
    );
    expect(verdict).toMatchObject({
      totalCases: 2,
      gatingCases: 1,
      quarantinedCases: 1,
      failingQuarantinedCases: 1,
      failed: false,
    });
  });
});
