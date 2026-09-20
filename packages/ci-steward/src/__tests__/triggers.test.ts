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
import { loadWorkflows, type WorkflowModel } from '../workflows.ts';
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

/** A throwaway repo: the hand files and the workflows the rules read. */
function repo(): { files: HandFiles; workflows: readonly WorkflowModel[] } {
  const dir = writeRepo(baseSpec());
  dirs.push(dir);
  return {
    files: loadHandFiles(dir).files!,
    workflows: loadWorkflows(dir, '.github/workflows', () => undefined),
  };
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
    ...repo(),
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
  const shared = repo();
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
    // A share reads as a percentage, here as on the page.
    expect(first.open[0]!.what).toContain('50%');
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

  it('4. fires when a gate fails half again as often as the week before, and clears when it settles', () => {
    const week = (from: number, runs: number, failed: number) =>
      Array.from({ length: 7 }, (_, i) =>
        gateDay(addDays(TODAY, from + i), 'wf.test.test-shard', { runs, failed })
      );
    const spiking = [...week(-13, 20, 1), ...week(-6, 20, 3)];
    const steady = [...week(-13, 20, 1), ...week(-6, 20, 1)];
    const { first, second } = fireThenClear({ snapshots: spiking }, { snapshots: steady });
    expect(ids(first)).toContain('gate-failure-spike:wf.test.test-shard');
    expect(first.open[0]!.what).toContain('15%');
    expect(first.open[0]!.what).toContain('5%');
    // The text says what was compared, so "the week before" is checkable.
    expect(first.open[0]!.what).toContain('7d vs 7d');
    expect(ids(second)).not.toContain('gate-failure-spike:wf.test.test-shard');
    // Below the minimum sample, the same ratio says nothing.
    const thin = [...week(-13, 2, 0), ...week(-6, 2, 1)];
    expect(ids(triage(input({ snapshots: thin })))).toEqual([]);
  });

  it('4b. fires on the rate alone when there was nothing to divide by', () => {
    const week = (from: number, runs: number, failed: number) =>
      Array.from({ length: 7 }, (_, i) =>
        gateDay(addDays(TODAY, from + i), 'wf.test.test-shard', { runs, failed })
      );
    // 0% to 50% is the biggest spike there is, and no ratio can express it.
    const t = triage(input({ snapshots: [...week(-13, 20, 0), ...week(-6, 20, 10)] }));
    expect(ids(t)).toContain('gate-failure-spike:wf.test.test-shard');
    expect(t.open[0]!.what).toContain('against none at all the week before');
  });

  it('4c. refuses to call one backfilled day "the week before"', () => {
    const week = (from: number, runs: number, failed: number) =>
      Array.from({ length: 7 }, (_, i) =>
        gateDay(addDays(TODAY, from + i), 'wf.test.test-shard', { runs, failed })
      );
    // Seven days against one is what the live branch looked like mid-backfill.
    const oneDay = [gateDay(addDays(TODAY, -7), 'wf.test.test-shard', { runs: 20, failed: 1 })];
    expect(ids(triage(input({ snapshots: [...oneDay, ...week(-6, 20, 5)] })))).toEqual([]);
    // Five days in each window is enough to speak.
    const five = (from: number, runs: number, failed: number) =>
      Array.from({ length: 5 }, (_, i) =>
        gateDay(addDays(TODAY, from + i), 'wf.test.test-shard', { runs, failed })
      );
    expect(ids(triage(input({ snapshots: [...five(-11, 20, 1), ...five(-4, 20, 5)] })))).toContain(
      'gate-failure-spike:wf.test.test-shard'
    );
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

  it('6. fires when one leg was among the failing checks on 3 or more ejections, and clears below that', () => {
    const day = (n: number) => [
      snap(addDays(TODAY, -2), {
        counts: { ...emptySnapshot('x', 'x', 0).counts, ejections_failed_checks: n },
        ejections_caused: { 'wf.browser-test.browser-shard': n },
        real_catches: { 'wf.browser-test.browser-shard': 1 },
      }),
    ];
    const { first, second } = fireThenClear({ snapshots: day(3) }, { snapshots: day(2) });
    expect(ids(first)).toEqual(['repeat-ejection:wf.browser-test.browser-shard']);
    expect(first.open[0]!.what).toContain('failed on 3 of 3 queue ejections');
    expect(first.open[0]!.what).toContain('1 real');
    expect(ids(second)).toEqual([]);
    // An ejection older than the window does not count.
    const old = [
      snap(addDays(TODAY, -9), { ejections_caused: { 'wf.browser-test.browser-shard': 5 } }),
    ];
    expect(ids(triage(input({ snapshots: old })))).toEqual([]);
  });

  it('6b-guard. refuses to fold when the fan-in carries fewer ejections than its shard', () => {
    // A fan-in without `if: always()` is SKIPPED by a red dependency rather
    // than failed. Folding into it would then lose the shard's ejections, and
    // its own count is what gives that away.
    const t = triage(
      input({
        snapshots: [
          snap(addDays(TODAY, -2), {
            counts: { ...emptySnapshot('x', 'x', 0).counts, ejections_failed_checks: 9 },
            ejections_caused: { 'wf.test.test': 4, 'wf.test.test-shard': 8 },
            real_catches: { 'wf.test.test-shard': 3 },
          }),
        ],
      })
    );
    // Both stand on their own rather than one swallowing the other.
    expect(ids(t)).toEqual(['repeat-ejection:wf.test.test', 'repeat-ejection:wf.test.test-shard']);
    expect(t.open.map((x) => x.what).join(' ')).toContain('failed on 8 of 9');
    expect(t.open.map((x) => x.what).join(' ')).not.toContain('(with ');
  });

  it('6b. counts a fan-in and the shards it waits on once, not twice', () => {
    // The census makes an always() fan-in read needs.<job>.result, so it is red
    // whenever a shard is: the collector records both, and two rows would claim
    // twice the ejections there were.
    const snaps = [
      snap(addDays(TODAY, -2), {
        counts: { ...emptySnapshot('x', 'x', 0).counts, ejections_failed_checks: 5 },
        ejections_caused: { 'wf.test.test': 5, 'wf.test.test-shard': 4 },
        real_catches: { 'wf.test.test': 2, 'wf.test.test-shard': 2 },
      }),
    ];
    const t = triage(input({ snapshots: snaps }));
    expect(ids(t)).toEqual(['repeat-ejection:wf.test.test']);
    expect(t.open[0]!.what).toContain('wf.test.test (with wf.test.test-shard)');
    expect(t.open[0]!.what).toContain('on 5 of 5');
    // Never more than the ejections there were.
    expect(t.open[0]!.what).not.toContain('9');
  });

  it('7. is red only while main is still red, and amber for a spell that already recovered', () => {
    const at = (d: number, h: number) => `${addDays(TODAY, d)}T0${h}:00:00Z`;
    const recovered = [
      snap(addDays(TODAY, -2), {
        main: [
          { sha: 'aaaaaaaa', at: at(-2, 1), done: at(-2, 1), red: true },
          { sha: 'bbbbbbbb', at: at(-2, 2), done: at(-2, 2), red: false },
        ],
      }),
    ];
    const green = [
      snap(addDays(TODAY, -2), {
        main: [{ sha: 'bbbbbbbb', at: at(-2, 2), done: at(-2, 2), red: false }],
      }),
    ];
    const { first, second } = fireThenClear({ snapshots: recovered }, { snapshots: green });
    expect(ids(first)).toEqual(['main-red:aaaaaaaa']);
    // It healed. Worth knowing, not worth a red light for the rest of the week.
    expect(first.open[0]!.severity).toBe('amber');
    expect(first.open[0]!.what).toContain('main red 60 min (aaaaaaa)');
    expect(ids(second)).toEqual([]);
  });

  it('7b. keeps an open red spell red once its commit has aged out of the 7-day window', () => {
    // The commit is 20 days old; nothing green has landed since. Reading only
    // the last 7 days would have called this fixed on the window edge.
    const stillRed = [
      snap(addDays(TODAY, -20), {
        main: [
          {
            sha: 'cccccccc',
            at: `${addDays(TODAY, -20)}T01:00:00Z`,
            done: `${addDays(TODAY, -20)}T01:10:00Z`,
            red: true,
          },
        ],
      }),
    ];
    const t = triage(input({ snapshots: stillRed }));
    expect(ids(t)).toEqual(['main-red-open:cccccccc']);
    expect(t.open[0]!.severity).toBe('red');
    expect(t.open[0]!.what).toContain('still red');
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

  it('names a proposed entry only when the gate AND the metric match', () => {
    const covering = entry({
      id: '260918-120000',
      status: 'proposed',
      hypothesis: {
        metric: 'gate.wf.lint.lint.duration_p90',
        slo: 'queue-green',
        baseline: 1,
        target: 0.5,
        after_days: 14,
      },
    });
    expect(triage(input({ ...breached, ledger: [covering] })).open[0]!.ledger_entry).toBe(
      '260918-120000'
    );
    // An entry that merely lists many gates is not an answer to every trigger
    // on any of them: its hypothesis has to measure the gate that fired.
    const scattergun = entry({
      id: '260918-130000',
      status: 'proposed',
      gates: ['wf.lint.lint', 'wf.test.test', 'wf.test.test-shard'],
      hypothesis: {
        metric: 'gate.wf.lint.lint.duration_p90',
        baseline: 1,
        target: 0.5,
        after_days: 14,
      },
    });
    const ejected = triage(
      input({
        ledger: [scattergun],
        snapshots: [
          snap(addDays(TODAY, -2), {
            counts: { ...emptySnapshot('x', 'x', 0).counts, ejections_failed_checks: 4 },
            ejections_caused: { 'wf.test.test-shard': 4 },
          }),
        ],
      })
    );
    expect(ids(ejected)).toEqual(['repeat-ejection:wf.test.test-shard']);
    expect(ejected.open[0]!.ledger_entry).toBeNull();
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
