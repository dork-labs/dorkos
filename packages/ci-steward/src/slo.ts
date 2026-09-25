/**
 * Every SLO in `ci/slos.yaml`, computed over a span of daily snapshots per its
 * `definition` block, and judged against its floor and objective.
 *
 * Each SLO reads one population from the snapshots (see `data.ts` for what a
 * snapshot holds). A reading is `insufficient` below the SLO's `min_n`, so a
 * quiet weekend never reads as a breach or a win.
 */
import { gateDays, mergePathGates, type LocalDay, type SloReading, type Snapshot } from './data.ts';
import { mainEpisodes } from './main-episodes.ts';
import type { Config, Slos } from './schemas.ts';
import { addDays, quantile, round } from './time.ts';

type Slo = Slos['slos'][number];
type Threshold = NonNullable<Slo['floor']>[number];

/** The inputs one reading needs. */
export interface SloInputs {
  snapshots: readonly Snapshot[];
  local: readonly LocalDay[];
  /** The agent tool ceiling in seconds: what a killed push cost (local-push's conversion). */
  toolCeilingSeconds: number;
  /** First day of the window. Pass snapshots from 27 days before `to`: main-green reads 28 days. */
  from: string;
  to: string;
  /**
   * Deadlines that fire inside a gate's job before its `timeout-minutes`, in
   * minutes by gate (`deadlines:` in ci/config.yaml). `headroom` reads each gate
   * against the smaller of the two. Omitted, every gate reads against its own
   * timeout, as it did before the deadlines were recorded.
   */
  deadlines?: Readonly<Record<string, number>>;
  /**
   * What `flaky-test-runs` can see: the gates whose reports it reads, and the
   * gates that run tests it cannot read. With it, a failed queue job in one of
   * the second is coverage the SLO does not have, and it reads `unmeasured`
   * instead of a share over the tests it did see. Omitted (a verdict's own
   * reading), the share is reported as before.
   */
  flakyCoverage?: FlakyCoverage;
}

/** What `flaky-test-runs` can and cannot see, by gate. */
export interface FlakyCoverage {
  /** Gates whose retry-aware test reports the collector reads (`collect.artifacts`). */
  reported: ReadonlySet<string>;
  /** Gates that run tests with no report it can read (`collect.blind_test_gates`). */
  blind: ReadonlySet<string>;
}

/**
 * The two readings the repo's own files decide: each gate's inner deadline,
 * and what `flaky-test-runs` can see. Every caller that shows an SLO to a
 * person passes both, so the report, `/ci-status` and the triggers read one
 * ruler.
 *
 * @param config - Parsed `ci/config.yaml`.
 */
export function sloRuler(config: Config): Required<Pick<SloInputs, 'deadlines' | 'flakyCoverage'>> {
  return {
    deadlines: deadlineMinutes(config),
    flakyCoverage: {
      reported: new Set(config.collect.artifacts.map((a) => a.gate)),
      blind: new Set(Object.keys(config.collect.blind_test_gates)),
    },
  };
}

/**
 * The inner deadlines of `ci/config.yaml`, in minutes by gate.
 *
 * @param config - Parsed `ci/config.yaml`.
 */
export function deadlineMinutes(config: Config): Record<string, number> {
  return Object.fromEntries(config.deadlines.map((d) => [d.gate, d.minutes]));
}

/**
 * A gate's effective deadline on one day: its recorded timeout, or a deadline
 * inside the job that fires first. A day with no recorded timeout (a
 * backfilled day) stays unmeasured whatever the deadlines say.
 *
 * @param timeouts - The day's recorded `timeout-minutes` by gate.
 * @param deadlines - Inner deadlines by gate.
 */
export function effectiveTimeouts(
  timeouts: Readonly<Record<string, number>>,
  deadlines: Readonly<Record<string, number>> = {}
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [gate, t] of Object.entries(timeouts)) {
    const inner = deadlines[gate];
    out[gate] = inner !== undefined && inner > 0 ? Math.min(t, inner) : t;
  }
  return out;
}

/**
 * `flaky-test-runs`: executions that failed and then passed on their retry,
 * over the executions in the sampled reports.
 *
 * The share can only see jobs that write a report the collector reads, with a
 * retry to pass on. A failed queue job in a gate that runs tests it cannot
 * read — a Playwright suite at `retries: 0`, a Windows job with no report —
 * could be a flake or a break and this SLO cannot tell, so when the window has
 * any, the reading is `unmeasured` and says how many, rather than a share of 0
 * that claims tests it never saw. The share stays in the stats for what it
 * does cover. A failure in a gate that runs no tests (lint, a fan-in's own
 * step, a docs drift check) says nothing about flakes and is not counted.
 *
 * @param inp - The inputs.
 * @param c - Sums a count over the window.
 */
function flakyTestRuns(inp: SloInputs, c: (k: CountKey) => number): Raw {
  if (c('flaky_builds_sampled') === 0)
    return { n: 0, stats: {}, unmeasured: 'no queue build test reports sampled in the window' };
  const r = share(c('test_flaky'), c('test_executions'));
  r.note = `${c('flaky_builds_sampled')} queue builds sampled`;
  const cov = inp.flakyCoverage;
  if (!cov) return r;
  const unseen = new Map<string, number>();
  let failed = 0;
  for (const b of inp.snapshots.flatMap((s) => s.queue_builds)) {
    if (b.outcome !== 'red') continue;
    for (const g of new Set(b.failed_gates)) {
      if (cov.reported.has(g)) failed += 1;
      else if (cov.blind.has(g)) {
        failed += 1;
        unseen.set(g, (unseen.get(g) ?? 0) + 1);
      }
    }
  }
  const blind = sum([...unseen.values()]);
  r.stats.failed_jobs = failed;
  r.stats.unreported_failed_jobs = blind;
  if (blind > 0) {
    const worst = [...unseen]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .map(([g, k]) => `${g} ${k}`)
      .join(', ');
    r.unmeasured = `coverage unknown: ${blind} of ${failed} failed queue test jobs wrote no retry-aware report (${worst}); share ${r.stats.share ?? 0} is over the reported suites only`;
  }
  return r;
}

type CountKey = Exclude<keyof Snapshot['counts'], 'repeat_ejections'>;

interface Raw {
  n: number;
  stats: Record<string, number>;
  /** Per-item values in the objective's unit, for the excess wait-hours conversion. */
  items?: number[];
  /** Extra hours added to the conversion (killed runs, wasted builds). */
  extraHours?: number;
  unmeasured?: string;
  note?: string;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const setStat = (stats: Record<string, number>, k: string, v: number | null, places = 2) => {
  if (v !== null && Number.isFinite(v)) stats[k] = round(v, places);
};

function samples(inp: SloInputs, key: keyof Snapshot['series']): number[] {
  return inp.snapshots.flatMap((s) => s.series[key].map((x) => x[1]));
}

function distribution(xs: number[]): Raw {
  const stats: Record<string, number> = {};
  setStat(stats, 'p50', quantile(xs, 0.5), 1);
  setStat(stats, 'p90', quantile(xs, 0.9), 1);
  return { n: xs.length, stats, items: xs };
}

function share(num: number, den: number): Raw {
  const stats: Record<string, number> = {};
  if (den > 0) setStat(stats, 'share', num / den, 4);
  return { n: den, stats };
}

/**
 * Red episodes on the default branch (`mainEpisodes`): one starts when a push
 * workflow goes red on `main` and ends when that same workflow goes green
 * there again, not at the next commit that merely did not run it.
 *
 * @param inp - The inputs.
 */
function mainGreen(inp: SloInputs): Raw {
  const commits = inp.snapshots.flatMap((s) => s.main);
  const episodes = mainEpisodes(commits);
  // An unresolved spell (its workflow stopped reporting) counts, but has no
  // restore time to contribute.
  const restores = episodes.flatMap((e) =>
    e.closed && !e.unresolved ? [(Date.parse(e.closed) - Date.parse(e.opened)) / 60_000] : []
  );
  const stats: Record<string, number> = { red_episodes: episodes.length };
  // No red episode means nothing waited to be restored: 0, not "no data".
  setStat(stats, 'restore_p90', episodes.length === 0 ? 0 : quantile(restores, 0.9), 1);
  return {
    n: commits.length,
    stats,
    note: episodes.at(-1)?.closed === null ? 'main is red at the end of the window' : undefined,
  };
}

/**
 * The worst gate's p95 of duration over its deadline, each run against the
 * timeout recorded on its own day (a backfilled day records none), or against
 * a deadline inside the job that fires first (`effectiveTimeouts`).
 *
 * @param inp - The inputs.
 * @param minN - Runs a gate needs before it counts.
 */
function headroom(inp: SloInputs, minN: number): Raw {
  let worst: { gate: string; ratio: number } | null = null;
  let n = 0;
  const ratios = new Map<string, number[]>();
  const onPath = mergePathGates(inp.snapshots);
  for (const s of inp.snapshots) {
    for (const [gate, timeout] of Object.entries(effectiveTimeouts(s.timeouts, inp.deadlines))) {
      const list = ratios.get(gate) ?? [];
      // Unqualified, so a gate that runs on the merge path is read over that
      // population only and not over the main canary's runs of the same job.
      // A gate that runs on nothing but a schedule — merge-tail's arm, evals,
      // CodeQL, the collector itself — keeps every sample, because otherwise
      // this tripwire would stop watching the four jobs whose timeouts nothing
      // else looks at. Membership is decided over the WHOLE window, never per
      // day; `mergePathGates` says why.
      for (const g of gateDays(s.gates, gate, undefined, onPath))
        for (const [, sec] of g.durations) list.push(sec / 60 / timeout);
      ratios.set(gate, list);
    }
  }
  for (const [gate, rs] of [...ratios].sort(([a], [b]) => a.localeCompare(b))) {
    if (rs.length < minN) continue;
    n += rs.length;
    const ratio = quantile(rs, 0.95)!;
    if (!worst || ratio > worst.ratio) worst = { gate, ratio };
  }
  const stats: Record<string, number> = {};
  if (worst) setStat(stats, 'p95_over_timeout', worst.ratio, 3);
  return { n, stats, note: worst ? `worst gate ${worst.gate}` : undefined };
}

function local(inp: SloInputs, hook: string): Raw {
  const days = inp.local.flatMap((d) => (d.hooks[hook] ? [d.hooks[hook]] : []));
  if (days.length === 0)
    return { n: 0, stats: {}, unmeasured: 'no local export in the window yet' };
  const durations = days.flatMap((h) => h.durations.map((x) => x[1]));
  const killed = sum(days.map((h) => h.killed));
  const n = durations.length + killed;
  const stats: Record<string, number> = {};
  setStat(stats, 'p90', quantile(durations, 0.9), 1);
  if (n > 0) setStat(stats, 'killed_share', killed / n, 4);
  return { n, stats, items: durations, extraHours: (killed * inp.toolCeilingSeconds) / 3600 };
}

/**
 * Read one SLO's population and statistics.
 *
 * @param slo - The SLO definition.
 * @param inp - The inputs.
 */
function raw(slo: Slo, inp: SloInputs): Raw {
  const s = inp.snapshots;
  const c = (k: CountKey) => sum(s.map((x) => x.counts[k]));
  switch (slo.id) {
    case 'headroom':
      return headroom(inp, slo.definition.min_n);
    case 'queue-green': {
      const done = s
        .flatMap((x) => x.queue_builds)
        .filter((b) => b.outcome === 'green' || b.outcome === 'red');
      return share(done.filter((b) => b.outcome === 'green').length, done.length);
    }
    case 'wasted-queue-builds': {
      const builds = s
        .flatMap((x) => x.queue_builds)
        .filter((b) => b.outcome === 'green' || b.outcome === 'red').length;
      const r = share(c('wasted_ejections'), builds);
      const ejected = quantile(samples(inp, 'queue_wait_ejected_min'), 0.5);
      const clean = quantile(samples(inp, 'queue_build_min'), 0.5);
      r.items = [];
      r.extraHours =
        ejected !== null && clean !== null
          ? (c('wasted_ejections') * Math.max(0, ejected - clean)) / 60
          : 0;
      return r;
    }
    case 'flaky-test-runs':
      return flakyTestRuns(inp, c);
    case 'main-green':
      return mainGreen(inp);
    case 'review-completes':
      return share(c('review_first_ok'), c('review_shas'));
    case 'review-recovery': {
      const xs = samples(inp, 'review_recovery_min');
      const stats: Record<string, number> = {};
      setStat(stats, 'p90', quantile(xs, 0.9), 1);
      return { n: xs.length, stats };
    }
    case 'pr-feedback':
      return distribution(samples(inp, 'pr_feedback_min'));
    case 'queue-build':
      return distribution(samples(inp, 'queue_build_min'));
    case 'lead-time':
      return distribution(samples(inp, 'lead_time_min'));
    case 'local-commit':
      return local(inp, 'pre-commit');
    case 'local-push':
      return local(inp, 'pre-push');
    default:
      return { n: 0, stats: {}, unmeasured: `the collector has no computation for SLO ${slo.id}` };
  }
}

/**
 * True when a statistic meets a threshold. A missing statistic never meets one.
 *
 * @param stats - The reading's statistics.
 * @param t - The threshold.
 */
function meets(stats: Readonly<Record<string, number>>, t: Threshold): boolean {
  const v = stats[t.stat];
  if (v === undefined) return false;
  switch (t.op) {
    case '<=':
      return v <= t.value;
    case '>=':
      return v >= t.value;
    case '<':
      return v < t.value;
    case '>':
      return v > t.value;
  }
}

/** The SLOs the constraint's speed tier ranks by excess wait-hours. */
const WAIT_RANKED = new Set([
  'pr-feedback',
  'queue-build',
  'lead-time',
  'local-commit',
  'local-push',
  'wasted-queue-builds',
]);

/**
 * Excess wait-hours against the objective (plan §4.4 conversions): the sum,
 * over the population, of each item's time beyond the tail objective, plus the
 * SLO's extra hours (killed pushes at the tool ceiling; wasted queue builds at
 * the ejected-minus-clean median).
 *
 * @param slo - The SLO.
 * @param r - Its raw reading.
 */
function excessHours(slo: Slo, r: Raw): number | null {
  if (!WAIT_RANKED.has(slo.id)) return null;
  const tail = slo.objective.find((t) => t.stat === 'p90') ?? slo.objective[0]!;
  const perHour = tail.unit === 'seconds' ? 3600 : 60;
  const items = r.items ?? [];
  const over = sum(items.map((t) => Math.max(0, t - tail.value))) / perHour;
  return round(over + (r.extraHours ?? 0), 2);
}

/**
 * Compute every SLO over a span.
 *
 * @param slos - `ci/slos.yaml`.
 * @param floors - Current floors by SLO id and stat (floors.json), falling back to ci/slos.yaml.
 * @param inp - The inputs.
 */
export function computeSlos(
  slos: Slos,
  floors: Readonly<Record<string, Readonly<Record<string, number>>>>,
  inp: SloInputs
): SloReading[] {
  return slos.slos.map((slo) => {
    // main-green reads a 28-day rolling window (its definition); every other
    // SLO reads [from, to]. Callers pass 28 days of snapshots for that reason.
    const from = slo.id === 'main-green' ? addDays(inp.to, -27) : inp.from;
    const span: SloInputs = {
      ...inp,
      from,
      snapshots: inp.snapshots.filter((s) => s.date >= from && s.date <= inp.to),
      local: inp.local.filter((d) => d.date >= from && d.date <= inp.to),
    };
    const r = raw(slo, span);
    const min = slo.definition.min_n;
    const floor = (slo.floor ?? []).map((t) => ({
      ...t,
      value: floors[slo.id]?.[t.stat] ?? t.value,
    }));
    let status: SloReading['status'];
    if (r.unmeasured) status = 'unmeasured';
    else if (r.n < min) status = 'insufficient';
    else if (slo.objective.every((t) => meets(r.stats, t))) status = 'met';
    else if (floor.every((t) => meets(r.stats, t))) status = 'ok';
    else status = 'breach';
    const reading: SloReading = {
      id: slo.id,
      kind: slo.kind,
      from: span.from,
      to: span.to,
      n: r.n,
      min_n: min,
      stats: r.stats,
      status,
      excess_hours:
        status === 'unmeasured' || status === 'insufficient' ? null : excessHours(slo, r),
    };
    const note = r.unmeasured ?? r.note;
    if (note) reading.note = note;
    return reading;
  });
}
