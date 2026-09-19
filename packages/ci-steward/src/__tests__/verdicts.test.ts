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
