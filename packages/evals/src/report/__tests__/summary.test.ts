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
    costUnmetered: false,
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

  it('prints the retained sandbox and copied logs path under a retained row (DOR-1241)', () => {
    const table = formatSummaryTable(
      summary([
        result({ id: 'widget-round-trip', status: 'pass' }),
        result({
          id: 'connector-slack',
          status: 'fail',
          quarantined: true,
          retainedSandbox: '/tmp/dorkos-evals-abc123/.dork',
          retainedLogsPath: 'connector-slack/logs',
        }),
      ])
    );
    // The gating case (no retention) prints no such line; the quarantined
    // failure, which retained under the SAME rule, prints both paths.
    const lines = table.split('\n');
    const rowIndex = lines.findIndex((l) => l.includes('connector-slack'));
    expect(lines[rowIndex + 1]).toBe(
      '  ↳ retained: /tmp/dorkos-evals-abc123/.dork; logs copied to connector-slack/logs'
    );
    expect(table).not.toMatch(/widget-round-trip\n {2}↳/);
  });

  it('prints no retention line for a case nothing was retained for', () => {
    const table = formatSummaryTable(
      summary([result({ id: 'widget-round-trip', status: 'pass' })])
    );
    expect(table).not.toContain('↳ retained');
  });

  it('never shows `quarantined:` on a skipped-wrong-tier row, matching the footer that excludes it (DOR-1228 review, NIT 5)', () => {
    // The row and the footer disagreed before this: a quarantined credentialed
    // case skipped downward or upward showed `quarantined:skipped-wrong-tier`
    // while `evaluateRunGate` (and the footer's quarantined COUNT) excludes
    // every wrong-tier result entirely — the row claiming quarantined coverage
    // the footer said was zero.
    const table = formatSummaryTable(
      summary([
        result({ id: 'widget-round-trip', status: 'pass' }),
        result({
          id: 'rooms-recall-member-said',
          status: 'skipped-wrong-tier',
          quarantined: true,
          runtimeTier: 'claude-code-cheap',
        }),
      ])
    );
    expect(table).toContain('skipped-wrong-tier');
    expect(table).not.toContain('quarantined:skipped-wrong-tier');
    expect(table).toMatch(/0 quarantined \(0 of them failing\)/);
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

  it('WARNS when a credentialed run completed turns and still reported no cost', () => {
    // A completed turn reports cumulative cost, so $0.0000 across a whole
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
    expect(table).toMatch(/WARNING: this claude-code-cheap run reported \$0\.0000 across every/);
    expect(table).toMatch(/not evidence about spend/);
  });

  it('WARNS on a $0.0000 LOCAL SIGN-IN run too, and says the turns died before reporting', () => {
    // The old behaviour printed a reassuring NOTE here, on the belief that
    // subscription turns report no per-turn cost. They do: ten measured runs on
    // a local sign-in reported $0.0380-$0.1220 per case. So the one credential
    // where a broken cost signal is most likely to be seen was the one where the
    // harness talked the reader out of looking.
    const table = formatSummaryTable({
      ...summary([
        result({
          id: 'governance-approval-granted',
          runtimeTier: 'claude-code-cheap',
          status: 'error',
          costUnmetered: true,
        }),
      ]),
      tier: 'claude-code-cheap',
      credentialSource: 'local-claude-login',
      totalCostUsd: 0,
    });
    expect(table).not.toMatch(/NOTE/);
    expect(table).toMatch(/no turn survived long enough to report a cost/);
    expect(table).toMatch(/not because nothing was spent/);
  });

  it('shows a retry on screen, alongside the outcome and the quarantine flag', () => {
    // The promotion rule says two infrastructure runs in a row means stop and
    // fix the harness. A flag that lives only in results.json cannot carry a
    // rule people are meant to act on: nobody opens the JSON to discover a
    // question they did not know to ask.
    const table = formatSummaryTable(
      summary([
        result({ id: 'plain-retry', status: 'error', retried: true }),
        result({
          id: 'governance-approval-granted',
          status: 'error',
          retried: true,
          quarantined: true,
        }),
      ])
    );
    expect(table).toMatch(/retried:error/);
    // Both qualifiers survive together; neither replaces the outcome.
    expect(table).toMatch(/quarantined:retried:error/);
  });

  it('renders an unmetered eval as `unmetered`, never as $0.0000', () => {
    // The two priciest runs of a measured ten printed as the cheapest rows in
    // the table. A cost cell must not state the opposite of what is known.
    const table = formatSummaryTable({
      ...summary([
        result({
          id: 'governance-approval-granted',
          runtimeTier: 'claude-code-cheap',
          status: 'error',
          costUnmetered: true,
          durationMs: 91_776,
        }),
      ]),
      tier: 'claude-code-cheap',
      totalCostUsd: 0,
    });
    expect(table).toMatch(/unmetered/);
    expect(table).not.toMatch(/\$0\.0000\s+91776ms/);
  });

  it('says the printed total is a FLOOR when metered and unmetered cases are mixed', () => {
    // The measured shape: eight cases reported cost, two burned ~92 seconds each
    // and reported nothing. The total at the bottom looks like the run's spend.
    const table = formatSummaryTable({
      ...summary([
        result({ id: 'a', runtimeTier: 'claude-code-cheap', costUsd: 0.038 }),
        result({
          id: 'b',
          runtimeTier: 'claude-code-cheap',
          status: 'error',
          costUnmetered: true,
        }),
      ]),
      tier: 'claude-code-cheap',
      totalCostUsd: 0.038,
    });
    expect(table).toMatch(/SPEND: 1 of 2 case\(s\) drove a real turn that never reported a cost/);
    expect(table).toMatch(/is a floor, not a total/);
  });

  it('does not repeat the floor line when the total is already $0.0000', () => {
    // The zero-total warning has said it. A second line saying the same thing is
    // how a reader learns to skim past the first.
    const table = formatSummaryTable({
      ...summary([
        result({ id: 'a', runtimeTier: 'claude-code-cheap', status: 'error', costUnmetered: true }),
      ]),
      tier: 'claude-code-cheap',
      totalCostUsd: 0,
    });
    expect(table).not.toMatch(/SPEND:/);
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

  it('counts a downward wrong-tier skip as "needing test-mode" (DOR-1228)', () => {
    // The upward direction already reads "needing a credentialed tier" — see
    // suite/__tests__/rooms.test.ts. A `test-mode`-only case skipped on a
    // credentialed run must say the opposite of what it needs, not repeat the
    // upward wording.
    const table = formatSummaryTable({
      ...summary([
        result({ id: 'widget-round-trip', status: 'skipped-wrong-tier', runtimeTier: 'test-mode' }),
        result({ id: 'agent-self-edit', status: 'pass', runtimeTier: 'claude-code-cheap' }),
      ]),
      tier: 'claude-code-cheap',
    });
    expect(table).toMatch(/1 needing test-mode/);
    expect(table).not.toMatch(/needing a credentialed tier/);
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

  it('FAILS a run that started none of its cases, and phrases the reason for the downward direction (DOR-1228)', () => {
    // The upward phrasing ("declares a credentialed runtime") is pinned by
    // suite/__tests__/rooms.test.ts against a real `runSuite` call. This is its
    // mirror: every selected case declares `test-mode` and the run booted
    // `claude-code-cheap`, so the reason must name THAT mismatch, not the
    // upward one.
    const verdict = evaluateRunGate({
      ...summary([result({ id: 'rooms-halt-stops-and-says-so', status: 'skipped-wrong-tier' })]),
      tier: 'claude-code-cheap',
    });
    expect(verdict.failed).toBe(true);
    expect(verdict.gatingCases).toBe(0);
    expect(verdict.reason).toContain('test-mode');
    expect(verdict.reason).not.toContain('credentialed runtime');
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
