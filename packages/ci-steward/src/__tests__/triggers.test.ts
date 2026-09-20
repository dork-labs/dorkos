/**
 * Every improvement-trigger rule: it fires on the condition it names, with the
 * measured numbers, and it clears when the condition goes away, carrying its
 * first-fired day across runs so it does not nag.
 *
 * The clock is an argument everywhere, and every day in here is a literal
 * relative to `TODAY`, so nothing in this file expires when the calendar moves.
 */
import { rmSync } from 'node:fs';
import { describe, expect, it, afterEach } from 'vitest';
import { emptySnapshot, gateKey, type Latest, type Snapshot, type Verdict } from '../data.ts';
import { loadHandFiles, type HandFiles } from '../load.ts';
import { addDays } from '../time.ts';
import { triage, openDays, type TriageInput, type Triggers } from '../triggers.ts';
import type { LedgerEntry } from '../verdicts.ts';
import { baseSpec, writeRepo } from './fixture.ts';

const TODAY = '2026-09-19';
const NOW = new Date(`${TODAY}T05:00:00Z`);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function files(): HandFiles {
  const dir = writeRepo(baseSpec());
  dirs.push(dir);
  return loadHandFiles(dir).files!;
}

/** A healthy, complete day with nothing in it. */
function snap(date: string, over: Partial<Snapshot> = {}): Snapshot {
  const s = emptySnapshot(date, `${date}T06:00:00Z`, 700);
  return {
    ...s,
    complete: true,
    healthy: true,
    health: { ...s.health, ok: true },
    ...over,
  };
}

/** A day whose one gate ran `runs` times, `failed` of them red, each `seconds` long. */
function gateDay(
  date: string,
  gate: string,
  {
    runs,
    failed = 0,
    seconds = 600,
    timeout,
  }: {
    runs: number;
    failed?: number;
    seconds?: number;
    timeout?: number;
  }
): Snapshot {
  return snap(date, {
    gates: {
      [gateKey(gate, 'merge_group')]: {
        durations: Array.from({ length: runs }, (_, i) => [3600 + i, seconds] as [number, number]),
        conclusions: { success: runs - failed, failure: failed },
        retried: 0,
        runs,
      },
    },
    timeouts: timeout === undefined ? {} : { [gate]: timeout },
  });
}

function latest(over: Partial<Latest> = {}): Latest {
  return {
    schema: 1,
    date: TODAY,
    collected_at: `${TODAY}T05:00:00Z`,
    snapshot: `snapshots/${TODAY}.json`,
    report_ref: null,
    healthy: true,
    failures: [],
    warnings: [],
    api_calls: 40,
    slos: [],
    constraint: { tier: 'none', id: null, reason: 'nothing' },
    local_breaches: [],
    safeguards_ok: true,
    ...over,
  };
}

function input(over: Partial<TriageInput> = {}): TriageInput {
  return {
    files: files(),
    ledger: [],
    verdicts: [],
    latest: latest(),
    snapshots: [],
    prior: null,
    now: NOW,
    ...over,
  };
}

/** Run triage twice: once on the firing condition, once on the cleared one. */
function fireThenClear(fire: Partial<TriageInput>, clear: Partial<TriageInput>) {
  const shared = { files: files() };
  const first = triage(input({ ...shared, ...fire }));
  const second = triage(input({ ...shared, ...clear, prior: first }));
  return { first, second };
}

const ids = (t: Triggers) => t.open.map((x) => x.id);

function entry(over: Partial<LedgerEntry> & { id: string }): LedgerEntry {
  return {
    title: 'An entry',
    kind: 'experiment',
    status: 'proposed',
    actor: 'agent',
    gates: [],
    prs: [],
    'ratchet-release': [],
    'floor-release': [],
    'field-changes': [],
    ...over,
  } as LedgerEntry;
}

function verdict(id: string, v: Verdict['verdict']): Verdict {
  return {
    schema: 1,
    id,
    verdict: v,
    reason: `it came back ${v}`,
    computed_at: `${TODAY}T05:00:00Z`,
    hypothesis_hash: 'abc',
    metric: 'gate.wf.lint.lint.duration_p90',
    anchor: `${TODAY}T00:00:00Z`,
    prs: [1],
    baseline: { value: 6, source: 'ledger' },
    target: 3,
    min_n: 5,
    before: { from: '', to: '', n: 10, value: 6 },
    after: { from: '', to: '', n: 10, value: 5 },
    confounders: [],
    slo: null,
  };
}

describe('trigger rules', () => {
  it('1. fires on an SLO under its floor, red for quality and amber for speed, and clears when it is back', () => {
    const breach = (kind: 'quality' | 'speed') => ({
      latest: latest({
        slos: [
          {
            id: 'queue-green',
            kind,
            from: addDays(TODAY, -6),
            to: TODAY,
            n: 40,
            min_n: 30,
            stats: { share: 0.5 },
            status: 'breach' as const,
            excess_hours: null,
          },
        ],
      }),
    });
    const { first, second } = fireThenClear(breach('quality'), {
      latest: latest({
        slos: [
          {
            id: 'queue-green',
            kind: 'quality',
            from: addDays(TODAY, -6),
            to: TODAY,
            n: 40,
            min_n: 30,
            stats: { share: 0.99 },
            status: 'met',
            excess_hours: null,
          },
        ],
      }),
    });
    expect(ids(first)).toEqual(['slo-floor:queue-green']);
    expect(first.open[0]!.severity).toBe('red');
    expect(first.open[0]!.what).toContain('0.5');
    expect(ids(second)).toEqual([]);
    expect(second.cleared.map((c) => c.id)).toEqual(['slo-floor:queue-green']);
    expect(triage(input(breach('speed'))).open[0]!.severity).toBe('amber');
  });

  it('2. fires when the constraint changes, and only against a previous run', () => {
    const withConstraint = (id: string) =>
      latest({ constraint: { tier: 'speed', id, reason: 'the most excess wait' } });
    const first = triage(input({ latest: withConstraint('pr-feedback') }));
    // The very first run has nothing to compare against, so it never fires.
    expect(ids(first)).toEqual([]);
    const second = triage(input({ latest: withConstraint('queue-build'), prior: first }));
    expect(ids(second)).toEqual(['constraint-changed:pr-feedback->queue-build']);
    const third = triage(input({ latest: withConstraint('queue-build'), prior: second }));
    expect(ids(third)).toEqual([]);
  });

  it('3. fires on a failed or partial verdict, and clears when the entry is reverted', () => {
    const e = entry({ id: '260901-120000', status: 'active' });
    const { first, second } = fireThenClear(
      { ledger: [e], verdicts: [verdict(e.id, 'failed')] },
      { ledger: [{ ...e, status: 'reverted' }], verdicts: [verdict(e.id, 'failed')] }
    );
    expect(ids(first)).toEqual([`verdict:${e.id}`]);
    expect(first.open[0]!.severity).toBe('red');
    expect(ids(second)).toEqual([]);
    const partial = triage(input({ ledger: [e], verdicts: [verdict(e.id, 'partial')] }));
    expect(partial.open[0]!.severity).toBe('amber');
    // A verified verdict is not a trigger.
    expect(ids(triage(input({ ledger: [e], verdicts: [verdict(e.id, 'verified')] })))).toEqual([]);
  });

  it('4. fires when a gate fails at least 1.5x as often as the week before, with enough runs', () => {
    const week = (from: number, runs: number, failed: number) =>
      Array.from({ length: 7 }, (_, i) =>
        gateDay(addDays(TODAY, from + i), 'wf.test.test-shard', { runs, failed })
      );
    const spiking = [...week(-13, 10, 1), ...week(-6, 10, 3)];
    const steady = [...week(-13, 10, 1), ...week(-6, 10, 1)];
    const { first, second } = fireThenClear({ snapshots: spiking }, { snapshots: steady });
    expect(ids(first)).toContain('gate-failure-spike:wf.test.test-shard');
    expect(first.open[0]!.what).toContain('30%');
    expect(ids(second)).not.toContain('gate-failure-spike:wf.test.test-shard');
    // Below the minimum sample, the same ratio says nothing.
    const thin = [...week(-13, 2, 0), ...week(-6, 2, 1)];
    expect(ids(triage(input({ snapshots: thin })))).toEqual([]);
  });

  it('5. fires when a gate gets 25% slower, and when job minutes per merged pull request grow 20%', () => {
    const week = (from: number, seconds: number) =>
      Array.from({ length: 7 }, (_, i) =>
        gateDay(addDays(TODAY, from + i), 'wf.test.test-shard', { runs: 10, seconds })
      );
    const { first, second } = fireThenClear(
      { snapshots: [...week(-13, 600), ...week(-6, 900)] },
      { snapshots: [...week(-13, 600), ...week(-6, 610)] }
    );
    expect(ids(first)).toContain('gate-cost:wf.test.test-shard');
    expect(first.open.find((t) => t.id === 'gate-cost:wf.test.test-shard')!.what).toContain('15');
    expect(ids(second)).not.toContain('gate-cost:wf.test.test-shard');

    const minutes = (from: number, jobMinutes: number) =>
      Array.from({ length: 7 }, (_, i) =>
        snap(addDays(TODAY, from + i), {
          counts: { ...emptySnapshot('x', 'x', 0).counts, merged_prs: 2, job_minutes: jobMinutes },
        })
      );
    const grew = triage(input({ snapshots: [...minutes(-13, 100), ...minutes(-6, 200)] }));
    expect(ids(grew)).toContain('gate-cost:job-minutes-per-merged-pr');
    const flat = triage(input({ snapshots: [...minutes(-13, 100), ...minutes(-6, 101)] }));
    expect(ids(flat)).not.toContain('gate-cost:job-minutes-per-merged-pr');
  });

  it('6. fires when one job caused 3 or more ejections in the window, and clears below that', () => {
    const days = (n: number) => [
      snap(addDays(TODAY, -2), {
        ejections_caused: { 'wf.browser-test.browser-shard': n },
        real_catches: { 'wf.browser-test.browser-shard': 1 },
      }),
    ];
    const { first, second } = fireThenClear({ snapshots: days(3) }, { snapshots: days(2) });
    expect(ids(first)).toEqual(['repeat-ejection:wf.browser-test.browser-shard']);
    expect(first.open[0]!.what).toContain('3 pull requests');
    expect(ids(second)).toEqual([]);
    // An ejection older than the window does not count.
    const old = [
      snap(addDays(TODAY, -9), { ejections_caused: { 'wf.browser-test.browser-shard': 5 } }),
    ];
    expect(ids(triage(input({ snapshots: old })))).toEqual([]);
  });

  it('7. fires red on every red spell on the default branch, open or closed', () => {
    const red = [
      snap(addDays(TODAY, -2), {
        main: [
          {
            sha: 'aaaaaaaa',
            at: `${addDays(TODAY, -2)}T01:00:00Z`,
            done: `${addDays(TODAY, -2)}T01:10:00Z`,
            red: true,
          },
          {
            sha: 'bbbbbbbb',
            at: `${addDays(TODAY, -2)}T02:00:00Z`,
            done: `${addDays(TODAY, -2)}T02:10:00Z`,
            red: false,
          },
        ],
      }),
    ];
    const green = [
      snap(addDays(TODAY, -2), {
        main: [
          {
            sha: 'bbbbbbbb',
            at: `${addDays(TODAY, -2)}T02:00:00Z`,
            done: `${addDays(TODAY, -2)}T02:10:00Z`,
            red: false,
          },
        ],
      }),
    ];
    const { first, second } = fireThenClear({ snapshots: red }, { snapshots: green });
    expect(ids(first)).toEqual(['main-red:aaaaaaaa']);
    expect(first.open[0]!.severity).toBe('red');
    expect(first.open[0]!.what).toContain('60 minutes');
    expect(ids(second)).toEqual([]);
    const stillRed = triage(
      input({
        snapshots: [
          snap(addDays(TODAY, -1), {
            main: [
              {
                sha: 'cccccccc',
                at: `${addDays(TODAY, -1)}T01:00:00Z`,
                done: `${addDays(TODAY, -1)}T01:10:00Z`,
                red: true,
              },
            ],
          }),
        ],
      })
    );
    expect(stillRed.open[0]!.what).toContain('has not gone green');
  });

  it('8. fires when a job uses 90% or more of its own time limit, and clears when it is faster', () => {
    const days = (seconds: number) =>
      Array.from({ length: 2 }, (_, i) =>
        gateDay(addDays(TODAY, -1 - i), 'wf.test.test-shard', {
          runs: 10,
          seconds,
          timeout: 10,
        })
      );
    const { first, second } = fireThenClear({ snapshots: days(570) }, { snapshots: days(300) });
    expect(ids(first)).toEqual(['headroom:wf.test.test-shard']);
    expect(first.open[0]!.severity).toBe('red');
    expect(first.open[0]!.what).toContain('95%');
    expect(ids(second)).toEqual([]);
  });

  it('9. fires when the collector was unhealthy on any of the last 3 days, and clears after 3 good ones', () => {
    const bad = [
      snap(addDays(TODAY, -1), {
        healthy: false,
        health: {
          ...emptySnapshot('x', 'x', 0).health,
          failures: ['the run list came back short'],
        },
      }),
      snap(TODAY),
    ];
    const { first, second } = fireThenClear(
      { snapshots: bad },
      { snapshots: [snap(addDays(TODAY, -1)), snap(TODAY)] }
    );
    expect(ids(first)).toEqual(['collector-health']);
    expect(first.open[0]!.what).toContain('came back short');
    expect(ids(second)).toEqual([]);
    // Older than the window, it no longer fires.
    const old = [
      snap(addDays(TODAY, -9), { healthy: false }),
      snap(addDays(TODAY, -1)),
      snap(TODAY),
    ];
    expect(ids(triage(input({ snapshots: old })))).toEqual([]);
  });

  it('10. fires on an unjudged experiment past its window and on a proposal nobody picked up', () => {
    const active = entry({
      id: '260801-120000',
      status: 'active',
      prs: [1],
      hypothesis: {
        metric: 'gate.wf.lint.lint.duration_p90',
        baseline: 6,
        target: 3,
        after_days: 14,
      },
    });
    const stale = triage(input({ ledger: [active] }));
    expect(ids(stale)).toEqual([`stale-ledger:${active.id}`]);
    expect(stale.open[0]!.what).toContain('2026-08-15');
    // A computed verdict is how it clears.
    const judged = triage(
      input({ ledger: [active], verdicts: [verdict(active.id, 'verified')], prior: stale })
    );
    expect(ids(judged)).toEqual([]);
    // A pending verdict is not a verdict: it stays open.
    expect(
      ids(triage(input({ ledger: [active], verdicts: [verdict(active.id, 'pending')] })))
    ).toEqual([`stale-ledger:${active.id}`]);

    const proposal = entry({ id: '260701-120000', status: 'proposed' });
    expect(ids(triage(input({ ledger: [proposal] })))).toEqual([`stale-ledger:${proposal.id}`]);
    const fresh = entry({ id: '260917-120000', status: 'proposed' });
    expect(ids(triage(input({ ledger: [fresh] })))).toEqual([]);
  });
});

describe('trigger state', () => {
  const breached = {
    latest: latest({
      slos: [
        {
          id: 'queue-green',
          kind: 'quality' as const,
          from: addDays(TODAY, -6),
          to: TODAY,
          n: 40,
          min_n: 30,
          stats: { share: 0.5 },
          status: 'breach' as const,
          excess_hours: null,
        },
      ],
    }),
  };

  it('keeps the day a trigger first fired across runs, so the report can say how long it has been open', () => {
    const day1 = triage(
      input({
        ...breached,
        latest: { ...breached.latest, date: '2026-09-10' },
        now: new Date('2026-09-10T05:00:00Z'),
      })
    );
    const later = triage(
      input({
        ...breached,
        latest: { ...breached.latest, date: TODAY },
        prior: { ...day1, date: '2026-09-10' },
      })
    );
    expect(later.open[0]!.first_fired).toBe(day1.open[0]!.first_fired);
    expect(later.open[0]!.last_fired).toBe(TODAY);
    expect(openDays(later.open[0]!, TODAY)).toBe(9);
  });

  it('names a matching proposed ledger entry rather than proposing the same thing again', () => {
    const t = triage(
      input({
        ...breached,
        ledger: [
          entry({
            id: '260918-120000',
            status: 'proposed',
            hypothesis: {
              metric: 'gate.wf.lint.lint.duration_p90',
              slo: 'queue-green',
              baseline: 1,
              target: 0.5,
              after_days: 14,
            },
          }),
        ],
      })
    );
    expect(t.open[0]!.ledger_entry).toBe('260918-120000');
  });

  it('ranks red before amber, and the untrustworthy-data problem before everything', () => {
    const t = triage(
      input({
        ...breached,
        snapshots: [
          snap(addDays(TODAY, -1), {
            healthy: false,
            health: { ...emptySnapshot('x', 'x', 0).health, failures: ['a truncated fetch'] },
            ejections_caused: { 'wf.test.test-shard': 4 },
          }),
        ],
      })
    );
    expect(t.open.map((x) => x.rule)).toEqual(['collector-health', 'slo-floor', 'repeat-ejection']);
  });
});
