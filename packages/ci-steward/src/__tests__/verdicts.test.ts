/**
 * The verdict engine against recorded data (plan §4.4, the phase-1 exit gate).
 *
 * The three backfilled ledger entries are the only past pipeline changes with a
 * quantified hypothesis and a measured outcome. Their inputs were recorded from
 * the GitHub API on 2026-09-19 (fixtures/real-verdict-inputs.json says exactly
 * how) and are replayed here through the real engine, against the real ledger
 * entries and the real ci/ hand files.
 *
 * What the plan expected and what the data says differ, and the test pins the
 * data: #1135 is partial, as expected; #1391 is partial rather than held (queue
 * leg p50 12.2 min against a 10-minute target); #1246 is partial rather than failed,
 * because its recorded metric (queue wait) did improve, while its SLO
 * (wasted-queue-builds) got several times worse, which the verdict reports
 * beside it. That is the case the SLO column exists for.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptySnapshot, gateKey, type Snapshot } from '../data.ts';
import { readLedger } from '../ledger.ts';
import { loadHandFiles } from '../load.ts';
import { addDays, dayOf, daysBetween, secondOfDay } from '../time.ts';
import { computeVerdict, seriesFrom, type LedgerEntry } from '../verdicts.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const { files } = loadHandFiles(REPO);
const ledger = readLedger(REPO, files!);

interface Inputs {
  merged_at: Record<string, string>;
  prs: [number, string, number, number | null, number | null, [string, number][]][];
  builds: Record<string, [number, number]>;
  jobs: Record<string, [string, number, string][]>;
}
const rec = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures', 'real-verdict-inputs.json'), 'utf8')
) as Inputs;

/** One snapshot per recorded day, built from the recorded rows the way collect would fill it. */
function recordedSnapshots(): Map<string, Snapshot> {
  const days = new Map<string, Snapshot>();
  const get = (d: string) => {
    let s = days.get(d);
    if (!s) {
      s = emptySnapshot(d, `${d}T23:59:59Z`, 700);
      s.complete = true;
      s.healthy = true;
      days.set(d, s);
    }
    return s;
  };
  for (const d of daysBetween('2026-08-10', '2026-09-14')) get(d);
  for (const [n, mergedAt, lead, wait, clean, ejections] of rec.prs) {
    const s = get(dayOf(new Date(mergedAt)));
    const at = secondOfDay(mergedAt);
    s.counts.merged_prs += 1;
    s.series.lead_time_min.push([at, lead]);
    if (wait !== null) s.series.queue_wait_min.push([at, wait]);
    if (clean !== null) s.series.queue_build_min.push([at, clean]);
    if (ejections.length && wait !== null) s.series.queue_wait_ejected_min.push([at, wait]);
    for (const [, newCommit] of ejections) {
      s.counts.ejections_failed_checks += 1;
      if (!newCommit) s.counts.wasted_ejections += 1;
    }
    void n;
  }
  // Only the count of non-cancelled builds is recorded (wasted-queue-builds'
  // denominator), so these stand-ins carry no green/red split.
  for (const [d, [total, cancelled]] of Object.entries(rec.builds)) {
    const s = get(d);
    for (let i = 0; i < total; i++) {
      s.queue_builds.push({
        sha: `${d}-${i}`,
        pr: null,
        created_at: `${d}T12:00:00Z`,
        outcome: i < cancelled ? 'cancelled' : 'green',
        failed_gates: [],
      });
    }
  }
  for (const [gate, rows] of Object.entries(rec.jobs)) {
    for (const [completedAt, seconds, event] of rows) {
      const g = (get(dayOf(new Date(completedAt))).gates[gateKey(gate, event)] ??= {
        durations: [],
        conclusions: {},
        retried: 0,
        runs: 0,
      });
      g.durations.push([secondOfDay(completedAt), seconds]);
      g.runs += 1;
      g.conclusions.success = (g.conclusions.success ?? 0) + 1;
    }
  }
  return days;
}

const snaps = recordedSnapshots();
const series = seriesFrom(
  (days) => days.flatMap((d) => (snaps.has(d) ? [snaps.get(d)!] : [])),
  () => []
);
const mergedAt = new Map(Object.entries(rec.merged_at).map(([k, v]) => [Number(k), v]));
const NOW = new Date('2026-09-19T05:00:00Z');
const entry = (id: string) => ledger.find((e) => e.id === id)!;

function verdict(e: LedgerEntry, pool: readonly LedgerEntry[] = [e], now = NOW) {
  return computeVerdict({ entry: e, mergedAt, ledger: pool, files: files!, series, now })!;
}

describe('verdicts on the recorded backfill fixtures', () => {
  it('finds the three backfilled entries in ci/ledger', () => {
    for (const id of ['260819-235925', '260824-121951', '260830-213616'])
      expect(entry(id)?.hypothesis).toBeDefined();
  });

  it('#1391 (queue test sweep in four shards): partial, 26 -> 12.2 min on the queue leg against a 10-minute target', () => {
    const v = verdict(entry('260830-213616'));
    expect(v.verdict).toBe('partial');
    // test-shard did not exist before #1391, so the ledger's baseline stands in.
    expect(v.before.n).toBe(0);
    expect(v.baseline).toEqual({ value: 26, source: 'ledger' });
    expect(v.metric).toBe('gate.wf.test.test-shard.duration_p50@merge_group');
    expect(v.after).toMatchObject({ n: 239, value: 12.2 });
    expect(v.reason).toContain('did not reach it');
  });

  it('#1135 (browser suite in three shards): partial, 43 -> 18.5 min against a 17-minute target', () => {
    const v = verdict(entry('260819-235925'));
    expect(v.verdict).toBe('partial');
    expect(v.baseline).toEqual({ value: 43, source: 'ledger' });
    expect(v.before.n).toBe(0);
    expect(v.after).toMatchObject({ n: 241, value: 18.5 });
  });

  it('#1246 (heavy suites to the queue): partial on queue wait, while wasted-queue-builds got worse', () => {
    const v = verdict(entry('260824-121951'));
    expect(v.verdict).toBe('partial');
    // The before-window had enough data, so it is the baseline, not the ledger's 120.
    expect(v.baseline.source).toBe('before-window');
    expect(v.baseline.value).toBe(41.6);
    expect(v.before.n).toBe(158);
    expect(v.after).toMatchObject({ n: 405, value: 33 });
    expect(v.slo).toMatchObject({ id: 'wasted-queue-builds', movement: 'worse' });
    expect(v.slo).toMatchObject({ before: 0.0367, after: 0.1931 });
  });

  it('#1246 with a planted same-week confounder on the same gate: inconclusive, naming it', () => {
    const e = entry('260824-121951');
    const planted: LedgerEntry = {
      ...e,
      id: '260826-090000',
      title: 'planted',
      prs: [99999],
      gates: ['wf.test.test'],
    };
    const merged = new Map([...mergedAt, [99999, '2026-08-26T09:00:00Z']]);
    const v = computeVerdict({
      entry: e,
      mergedAt: merged,
      ledger: [e, planted],
      files: files!,
      series,
      now: NOW,
    })!;
    expect(v.verdict).toBe('inconclusive');
    expect(v.confounders).toEqual(['260826-090000']);
    expect(v.reason).toContain('260826-090000');
  });

  it('against the whole real ledger, #1135 and #1246 confound each other in turn', () => {
    // #1246 changed browser-test inside #1135's after-window, and #1391 changed
    // test inside #1246's. The rule says inconclusive, and it is right to.
    expect(verdict(entry('260819-235925'), ledger)).toMatchObject({
      verdict: 'inconclusive',
      confounders: ['260824-121951'],
    });
    expect(verdict(entry('260824-121951'), ledger)).toMatchObject({
      verdict: 'inconclusive',
      confounders: ['260830-213616'],
    });
    expect(verdict(entry('260830-213616'), ledger).verdict).toBe('partial');
  });

  it('is pending until the after-window closes, and says when', () => {
    const v = verdict(entry('260830-213616'), undefined, new Date('2026-09-10T00:00:00Z'));
    expect(v.verdict).toBe('pending');
    expect(v.reason).toContain(addDays('2026-08-30', 15));
  });
});

describe('verdict rules on synthetic data', () => {
  const base = entry('260830-213616');
  const withTarget = (target: number): LedgerEntry => ({
    ...base,
    hypothesis: { ...base.hypothesis!, target },
  });

  it('verified when the after-window reaches the target', () => {
    expect(verdict(withTarget(12.5)).verdict).toBe('verified');
  });

  it('failed when it moved less than halfway', () => {
    // 26 -> 12.2 toward a target of 0: 53% of the way is partial; toward -5 (impossible, but a
    // clean way to move the halfway line past 12.2) it is under half.
    expect(verdict(withTarget(0)).verdict).toBe('partial');
    expect(verdict(withTarget(-5)).verdict).toBe('failed');
  });

  it('inconclusive when the after-window sample is below the minimum', () => {
    // Every day collected, and nothing in them.
    const thin = { snapshots: () => [], local: () => [], covered: () => true };
    const v = computeVerdict({
      entry: base,
      mergedAt,
      ledger: [base],
      files: files!,
      series: thin,
      now: NOW,
    })!;
    expect(v.verdict).toBe('inconclusive');
    expect(v.reason).toContain('n=0');
  });

  it('waits (pending) while after-window days are still to be collected, and gives up only past retention', () => {
    const gap = (day: string) =>
      seriesFrom(
        (days) => days.flatMap((d) => (d !== day && snaps.has(d) ? [snaps.get(d)!] : [])),
        () => []
      );
    const at = (now: string) =>
      computeVerdict({
        entry: base,
        mergedAt,
        ledger: [base],
        files: files!,
        series: gap('2026-09-05'),
        now: new Date(now),
      })!;
    expect(at('2026-09-19T05:00:00Z')).toMatchObject({ verdict: 'pending' });
    expect(at('2026-09-19T05:00:00Z').reason).toContain('2026-09-05');
    // 90 days on, Actions no longer has the day: the verdict says so instead of guessing.
    expect(at('2026-12-10T05:00:00Z')).toMatchObject({ verdict: 'inconclusive' });
    expect(at('2026-12-10T05:00:00Z').reason).toContain('never collected');
  });

  it('no verdict for a proposed entry, a hygiene entry, or one whose PR has not merged', () => {
    const e = entry('260830-213616');
    expect(
      computeVerdict({
        entry: { ...e, status: 'proposed' },
        mergedAt,
        ledger,
        files: files!,
        series,
        now: NOW,
      })
    ).toBeNull();
    expect(
      computeVerdict({
        entry: { ...e, hypothesis: undefined },
        mergedAt,
        ledger,
        files: files!,
        series,
        now: NOW,
      })
    ).toBeNull();
    expect(
      computeVerdict({
        entry: { ...e, prs: [424242] },
        mergedAt,
        ledger,
        files: files!,
        series,
        now: NOW,
      })
    ).toBeNull();
  });
});

describe('tracked.time-to-detect: what the main canary buys', () => {
  const ANCHOR = '2026-09-01T00:00:00Z';
  const canaryEntry: LedgerEntry = {
    id: '260901-000000',
    title: 'the main canary',
    kind: 'experiment',
    status: 'active',
    actor: 'agent',
    gates: [],
    prs: [900],
    hypothesis: {
      metric: 'tracked.time-to-detect',
      baseline: 20160,
      target: 720,
      after_days: 7,
    },
    'ratchet-release': [],
    'floor-release': [],
    'field-changes': [],
  };
  const anchored = new Map([[900, ANCHOR]]);

  /**
   * Seven days of canary results, `perDay` rounds a day of each workflow,
   * evenly spaced. The gap between rounds is 24/perDay hours.
   */
  function canaryDays(perDay: number, workflows = ['test.yml', 'browser-test.yml']): Snapshot[] {
    return Array.from({ length: 8 }, (_, i) => {
      const date = addDays('2026-09-01', i);
      const s = emptySnapshot(date, `${date}T23:00:00Z`, 700);
      s.complete = true;
      s.healthy = true;
      s.health.ok = true;
      for (const workflow of workflows)
        for (let k = 0; k < perDay; k += 1) {
          const hour = String(Math.floor((24 / perDay) * k)).padStart(2, '0');
          s.canary.push({
            workflow,
            sha: `${date}-${k}`.slice(0, 12),
            event: 'schedule',
            started: `${date}T${hour}:00:00Z`,
            done: `${date}T${hour}:30:00Z`,
            red: false,
          });
        }
      return s;
    });
  }

  const verdictOn = (snapshots: Snapshot[]) =>
    computeVerdict({
      entry: canaryEntry,
      mergedAt: anchored,
      ledger: [canaryEntry],
      files: files!,
      series: seriesFrom(
        (days) => snapshots.filter((s) => days.includes(s.date)),
        () => []
      ),
      now: new Date('2026-09-20T05:00:00Z'),
    })!;

  it('measures from the previous run s START, per workflow, not across workflows', () => {
    // Four rounds a day of each of two workflows, each run half an hour long:
    // the hiding window per workflow is 6 h of gap PLUS the earlier run s own
    // 30 minutes, because that run tested the tree it checked out at its
    // start. 390, not 360. It stays 390 whatever the second workflow does — an
    // interleaved 3 h would be a lie about either one s blind spot.
    const v = verdictOn(canaryDays(4));
    expect(v.after.value).toBe(390);
    expect(v.verdict).toBe('verified');
  });

  it('does not read green when the schedule thins out, which is the whole risk being tested', () => {
    // One round a day: a break can hide 24.5 h, twice the 12 h target. Against
    // a baseline of "never ran against main at all" that is `partial` — a real
    // improvement that missed, which is the honest answer, and the one that
    // says the crons were throttled rather than that the canary works.
    const v = verdictOn(canaryDays(1));
    expect(v.after.value).toBe(1470);
    expect(v.verdict).toBe('partial');
  });

  it('is inconclusive rather than green when the canary stopped running', () => {
    // No results at all reads as no data, never as "nothing was detected late".
    const v = verdictOn(canaryDays(0));
    expect(v.after.value).toBeNull();
    expect(v.verdict).toBe('inconclusive');
  });
});
