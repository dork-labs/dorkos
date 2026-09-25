/**
 * The 2026-09-25 ruler: `headroom` against the deadline that actually fires,
 * and `flaky-test-runs` that says "coverage unknown" instead of claiming a
 * share over tests it never saw. Both read the repo's own files (`sloRuler`),
 * so the last block pins those files to the facts they restate.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { emptySnapshot, SnapshotSchema, type Snapshot } from '../data.ts';
import { floorValues } from '../floors.ts';
import { loadHandFiles } from '../load.ts';
import { computeSlos, effectiveTimeouts, sloRuler, type SloInputs } from '../slo.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const { files } = loadHandFiles(REPO);
const slos = files!.slos!;

function reading(id: string, snapshots: Snapshot[], extra: Partial<SloInputs> = {}) {
  return computeSlos({ slos: slos.slos.filter((s) => s.id === id) }, floorValues(slos, null), {
    snapshots,
    local: [],
    toolCeilingSeconds: 600,
    from: '2026-09-19',
    to: '2026-09-19',
    ...extra,
  })[0]!;
}

describe('headroom reads each gate against the deadline that fires first', () => {
  const day = (): Snapshot => {
    const s = emptySnapshot('2026-09-19', '2026-09-19T23:00:00Z', 700);
    // Twenty browser shards at 27 minutes: 60% of the 45-minute job timeout,
    // 90% of Playwright's 30-minute globalTimeout.
    s.gates['wf.browser-test.browser-shard@merge_group'] = {
      durations: Array.from({ length: 20 }, (_, i) => [i, 27 * 60] as [number, number]),
      conclusions: { success: 20 },
      retried: 0,
      runs: 20,
    };
    s.timeouts = { 'wf.browser-test.browser-shard': 45 };
    return s;
  };

  it('reads the job timeout when no inner deadline is given', () => {
    expect(reading('headroom', [day()]).stats.p95_over_timeout).toBe(0.6);
  });

  it('reads the inner deadline when one fires first', () => {
    const r = reading('headroom', [day()], { deadlines: { 'wf.browser-test.browser-shard': 30 } });
    expect(r.stats.p95_over_timeout).toBe(0.9);
    expect(r.status).toBe('ok');
  });

  it('never loosens a deadline, and leaves a backfilled day unmeasured', () => {
    expect(effectiveTimeouts({ a: 45, b: 20 }, { a: 30, b: 60 })).toEqual({ a: 30, b: 20 });
    expect(effectiveTimeouts({}, { a: 30 })).toEqual({});
  });
});

describe('flaky-test-runs says coverage unknown when a failed job wrote no report it reads', () => {
  const ruler = sloRuler(files!.config);
  const day = (failed: string[][]): Snapshot => {
    const s = emptySnapshot('2026-09-19', '2026-09-19T23:00:00Z', 700);
    s.counts.flaky_builds_sampled = 10;
    s.counts.test_executions = 5000;
    s.counts.test_flaky = 0;
    s.queue_builds = failed.map((gates, i) => ({
      sha: `b${i}`,
      pr: i,
      created_at: '2026-09-19T12:00:00Z',
      outcome: 'red' as const,
      failed_gates: gates,
    }));
    return s;
  };

  it('counts test jobs only: a fan-in, lint or a drift check says nothing about flakes', () => {
    const r = reading(
      'flaky-test-runs',
      [
        day([
          ['wf.browser-test.browser-shard', 'wf.browser-test.browser-test'],
          ['wf.browser-test.browser-test'],
          ['wf.browser-test.copy-spec-drift'],
          ['wf.lint.lint'],
          [],
        ]),
      ],
      ruler
    );
    expect(r.status).toBe('met');
    expect(r.stats).toEqual({ share: 0, failed_jobs: 1, unreported_failed_jobs: 0 });
  });

  it('keeps the share when every failed job is one it reads', () => {
    const r = reading(
      'flaky-test-runs',
      [day([['wf.browser-test.browser-shard', 'wf.browser-test.browser-test']])],
      ruler
    );
    expect(r.status).toBe('met');
    expect(r.stats).toEqual({ share: 0, failed_jobs: 1, unreported_failed_jobs: 0 });
  });

  it('reads unmeasured, and names what it cannot see, when one is not', () => {
    const r = reading(
      'flaky-test-runs',
      [
        day([
          ['wf.test.community-packaged', 'wf.test.test'],
          ['wf.credential-free-build.credential-free-build'],
          ['wf.test.test-shard', 'wf.test.test', 'wf.test.community-packaged'],
        ]),
      ],
      ruler
    );
    expect(r.status).toBe('unmeasured');
    expect(r.stats).toEqual({ share: 0, failed_jobs: 4, unreported_failed_jobs: 3 });
    expect(r.note).toBe(
      'coverage unknown: 3 of 4 failed queue test jobs wrote no retry-aware report (wf.test.community-packaged 2, wf.credential-free-build.credential-free-build 1); share 0 is over the reported suites only'
    );
    expect(r.excess_hours).toBeNull();
  });

  it('reads the share exactly as before when no ruler is passed (a verdict)', () => {
    const r = reading('flaky-test-runs', [
      day([['wf.credential-free-build.credential-free-build']]),
    ]);
    expect(r.status).toBe('met');
    expect(r.stats).toEqual({ share: 0 });
  });
});

describe('the recorded week 2026-09-12..18 under the new ruler', () => {
  const recorded = JSON.parse(
    gunzipSync(
      readFileSync(path.join(import.meta.dirname, 'fixtures', 'week-2026-09-12.snapshots.json.gz'))
    ).toString('utf8')
  ) as { days: Record<string, unknown> };
  const snapshots = Object.values(recorded.days).map((d) => SnapshotSchema.parse(d));
  const readings = computeSlos(slos, floorValues(slos, null), {
    ...sloRuler(files!.config),
    snapshots,
    local: [],
    toolCeilingSeconds: 600,
    from: '2026-09-12',
    to: '2026-09-18',
  });
  const byId = new Map(readings.map((r) => [r.id, r]));

  // slo.test.ts pins the same week under the old ruler: headroom 0.651, and
  // flaky-test-runs `met` at 0.5%. These are the two readings that move.
  it('moves headroom to the browser shard against its Playwright deadline', () => {
    expect(byId.get('headroom')).toMatchObject({
      status: 'breach',
      stats: { p95_over_timeout: 0.977 },
      note: 'worst gate wf.browser-test.browser-shard',
    });
  });

  it('turns flaky-test-runs from met into coverage unknown', () => {
    const r = byId.get('flaky-test-runs')!;
    expect(r.status).toBe('unmeasured');
    expect(r.stats.share).toBe(0.005);
    expect(r.note).toMatch(/^coverage unknown: \d+ of \d+ failed queue test jobs/);
  });
});

describe('the ruler files agree with what they restate', () => {
  const gates = new Set(files!.gates!.gates.map((g) => g.id));

  it('names only gates that exist', () => {
    for (const a of files!.config.collect.artifacts) expect(gates).toContain(a.gate);
    for (const d of files!.config.deadlines) expect(gates).toContain(d.gate);
    for (const g of Object.keys(files!.config.collect.blind_test_gates)) expect(gates).toContain(g);
    // A gate is either read or blind, never both.
    for (const a of files!.config.collect.artifacts)
      expect(files!.config.collect.blind_test_gates).not.toHaveProperty([a.gate]);
  });

  it("records the browser shard's deadline exactly as playwright.config.ts derives it", () => {
    // globalTimeout = ceil((boot + (suite - boot) / shards) * headroom / 5) * 5
    // minutes, with shards from browser-test.yml's matrix (E2E_SHARD_TOTAL).
    const cfg = readFileSync(path.join(REPO, 'apps/e2e/playwright.config.ts'), 'utf8');
    const num = (name: string) => Number(new RegExp(`const ${name} = ([\\d.]+);`).exec(cfg)![1]);
    const wf = readFileSync(path.join(REPO, '.github/workflows/browser-test.yml'), 'utf8');
    const shards = /shard: \[([\d, ]+)\]/.exec(wf)![1]!.split(',').length;
    const boot = num('LEG_BOOT_MINUTES');
    const healthy = boot + (num('UNSHARDED_SUITE_MINUTES') - boot) / shards;
    const minutes = Math.ceil((healthy * num('GLOBAL_TIMEOUT_HEADROOM')) / 5) * 5;
    // The derivation itself, so a change to its SHAPE (not only its inputs)
    // fails here instead of leaving the recomputation above stale.
    expect(cfg).toContain(
      'LEG_BOOT_MINUTES + (UNSHARDED_SUITE_MINUTES - LEG_BOOT_MINUTES) / SHARD_TOTAL'
    );
    expect(cfg).toContain(
      'Math.ceil((HEALTHY_SHARD_MINUTES * GLOBAL_TIMEOUT_HEADROOM) / 5) * 5 * 60_000'
    );
    expect(cfg).toContain('globalTimeout: CI ? SHARD_GLOBAL_TIMEOUT_MS : undefined');
    expect(wf).toContain('E2E_SHARD_TOTAL: ${{ strategy.job-total }}');
    expect(files!.config.deadlines).toContainEqual(
      expect.objectContaining({ gate: 'wf.browser-test.browser-shard', minutes })
    );
  });
});
