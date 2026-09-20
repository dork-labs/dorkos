/**
 * `ci-steward verdicts`: did each pipeline change do what its ledger entry
 * said it would? Computed by code from the snapshots, never written by a model
 * (plan §4.4).
 *
 * For each entry with a hypothesis and a merged PR:
 *
 * 1. The anchor is the merge time of the entry's last merged PR. The before-
 *    window is the `before_days` × 24 h before it and the after-window the
 *    `after_days` × 24 h after it, both cut at the merge instant. Metrics built
 *    from timed samples (durations, waits) use those exact edges; metrics kept
 *    as daily counts (failure and retry rates, catches, SLO shares) read only
 *    the whole days inside each window, so the merge day counts for neither.
 * 2. `pending` while the after-window is still open, or while any of its days
 *    has no complete snapshot the collector can still fetch (its backfill);
 *    `inconclusive` if such a day is past Actions' 90-day retention.
 * 3. `inconclusive`, checked first, naming why: another ledger entry touching
 *    one of the same gates merged inside the after-window (a confounder), or
 *    the after-window's sample is below the minimum.
 * 4. `verified` when the after-window reached the target.
 * 5. `partial` when it missed the target but moved at least halfway from the
 *    baseline toward it. The baseline is the before-window's own reading when
 *    that has enough data, else the ledger's `baseline` (say, when the gate did
 *    not exist before the change).
 * 6. `failed` otherwise.
 *
 * The SLO the entry names is read over the same two windows and reported
 * beside the verdict, so a gate that got faster while its SLO got worse shows.
 *
 * A final verdict is sticky: it is recomputed only when its hypothesis changes,
 * because Actions data older than 90 days can no longer be re-read.
 */
import { createHash } from 'node:crypto';
import { gateDays, type LocalDay, type Snapshot, type TimedSample, type Verdict } from './data.ts';
import type { HandFiles } from './load.ts';
import { computeSlos } from './slo.ts';
import type { LedgerFrontmatter } from './schemas.ts';
import { addDays, dayOf, dayRange, daysBetween, minutesBetween, quantile, round } from './time.ts';

/** A parsed ledger entry. */
export type LedgerEntry = LedgerFrontmatter;

/** A metric's reading over one window. */
interface MetricReading {
  n: number;
  value: number | null;
}

/** What the engine reads a window from. */
export interface Series {
  snapshots(from: string, to: string): Snapshot[];
  local(from: string, to: string): LocalDay[];
  /** True when the day has a complete snapshot (every SHA fetched, not late). */
  covered(day: string): boolean;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const DAY_MS = 86_400_000;

/** A verdict window, `[from, to)`, as ISO instants. */
interface Window {
  from: string;
  to: string;
}

/**
 * The days a window touches, and the days it covers whole. Samples carry a
 * time and are cut at the window's exact edges; counts are kept per day, so
 * they come from the whole days only (the merge day is in neither window).
 *
 * @param w - The window.
 */
function windowDays(w: Window): { touched: string[]; whole: string[] } {
  const from = Date.parse(w.from);
  const to = Date.parse(w.to);
  if (!(to > from)) return { touched: [], whole: [] };
  const touched = daysBetween(dayOf(new Date(from)), dayOf(new Date(to - 1)));
  const whole = touched.filter((d) => {
    const start = Date.parse(`${d}T00:00:00Z`);
    return start >= from && start + 86_400_000 <= to;
  });
  return { touched, whole };
}

/**
 * The values of timed samples that fall inside a window.
 *
 * @param days - The snapshots or exports the samples come from.
 * @param pick - The samples of one day.
 * @param w - The window.
 */
function within<T extends { date: string }>(
  days: readonly T[],
  pick: (d: T) => readonly TimedSample[],
  w: Window
): number[] {
  const from = Date.parse(w.from);
  const to = Date.parse(w.to);
  return days.flatMap((d) => {
    const base = Date.parse(`${d.date}T00:00:00Z`);
    return pick(d).flatMap(([sec, v]) => {
      const t = base + sec * 1000;
      return t >= from && t < to ? [v] : [];
    });
  });
}

/**
 * `tracked.time-to-detect`: how long a break on `main` can go unseen.
 *
 * A break lands between two canary results, so the longest it can hide is the
 * gap from the previous result of that workflow to the moment this one
 * finished. That is what is measured here, per result, and reported as p90 —
 * an upper bound on time-to-detect that can be computed every day, from days
 * on which nothing broke at all. Measuring the real thing instead (merge →
 * first red canary) would need a break to measure, and `main` is usually
 * green: an honest metric has to be readable when the pipeline is healthy.
 *
 * Per workflow, because the four canary legs are throttled independently and a
 * gap in one is a blind spot whatever the others did. The first result of each
 * workflow in the window has no predecessor and is skipped rather than
 * measured against midnight.
 *
 * @param snaps - The window's whole days.
 */
function canaryDetect(snaps: readonly Snapshot[]): MetricReading {
  const byWorkflow = new Map<string, string[]>();
  for (const r of snaps.flatMap((s) => s.canary)) {
    const list = byWorkflow.get(r.workflow) ?? [];
    list.push(r.done);
    byWorkflow.set(r.workflow, list);
  }
  const gaps: number[] = [];
  for (const dones of byWorkflow.values()) {
    dones.sort();
    for (let i = 1; i < dones.length; i += 1) gaps.push(minutesBetween(dones[i - 1]!, dones[i]!));
  }
  return { n: gaps.length, value: round1(quantile(gaps, 0.9)) };
}

/**
 * Read a catalogue metric over a window.
 *
 * @param id - The metric id (ci/metrics.yaml).
 * @param files - The hand files.
 * @param series - The snapshots.
 * @param w - The window.
 */
function readMetric(id: string, files: HandFiles, series: Series, w: Window): MetricReading {
  const { touched, whole } = windowDays(w);
  const snaps = touched.length ? series.snapshots(touched[0]!, touched.at(-1)!) : [];
  const wholeSnaps = snaps.filter((s) => whole.includes(s.date));
  if (id.startsWith('gate.')) {
    // gate.<gate-id>.<metric>[@<event>]: the qualifier keeps one leg of the gate.
    const [body, event] = id.slice(5).split('@') as [string, string | undefined];
    const cut = body.lastIndexOf('.');
    const gate = body.slice(0, cut);
    const metric = body.slice(cut + 1);
    const days = wholeSnaps.flatMap((s) => gateDays(s.gates, gate, event));
    const c = (k: string) => sum(days.map((g) => g.conclusions[k] ?? 0));
    const minutes = () =>
      within(snaps, (s) => gateDays(s.gates, gate, event).flatMap((g) => g.durations), w).map(
        (x) => x / 60
      );
    switch (metric) {
      case 'duration_p50': {
        const d = minutes();
        return { n: d.length, value: round1(quantile(d, 0.5)) };
      }
      case 'duration_p90': {
        const d = minutes();
        return { n: d.length, value: round1(quantile(d, 0.9)) };
      }
      case 'failure_rate': {
        const done = sum(days.map((g) => g.runs)) - c('cancelled') - c('skipped');
        return { n: done, value: done ? round((c('failure') + c('timed_out')) / done, 4) : null };
      }
      case 'retry_rate': {
        const runs = sum(days.map((g) => g.runs));
        return { n: runs, value: runs ? round(sum(days.map((g) => g.retried)) / runs, 4) : null };
      }
      case 'real_catches':
        return {
          n: wholeSnaps.length,
          value: sum(wholeSnaps.map((s) => s.real_catches[gate] ?? 0)),
        };
      case 'ejections_caused':
        return {
          n: wholeSnaps.length,
          value: sum(wholeSnaps.map((s) => s.ejections_caused[gate] ?? 0)),
        };
      default:
        return { n: 0, value: null };
    }
  }
  if (id.startsWith('hook.')) {
    const [, hook, metric] = id.split('.') as [string, string, string];
    const local = touched.length ? series.local(touched[0]!, touched.at(-1)!) : [];
    const durations = within(local, (d) => d.hooks[hook]?.durations ?? [], w);
    if (metric === 'duration_p90')
      return { n: durations.length, value: round1(quantile(durations, 0.9)) };
    const killed = sum(
      local.filter((d) => whole.includes(d.date)).map((d) => d.hooks[hook]?.killed ?? 0)
    );
    const n = durations.length + killed;
    return { n, value: n ? round(killed / n, 4) : null };
  }
  if (id === 'queue.queue_wait') {
    const xs = within(snaps, (s) => s.series.queue_wait_min, w);
    return { n: xs.length, value: round1(quantile(xs, 0.5)) };
  }
  if (id === 'queue.batch_wasted_share') {
    const builds = snaps
      .flatMap((s) => s.queue_builds)
      .filter((b) => b.created_at >= w.from && b.created_at < w.to);
    return {
      n: builds.length,
      value: builds.length
        ? round(builds.filter((b) => b.outcome === 'cancelled').length / builds.length, 4)
        : null,
    };
  }
  if (id === 'tracked.time-to-detect') return canaryDetect(wholeSnaps);
  if (id === 'tracked.job-minutes-per-merged-pr' || id === 'tracked.review-runs-per-merged-pr') {
    const merged = sum(wholeSnaps.map((s) => s.counts.merged_prs));
    const top = sum(
      wholeSnaps.map((s) =>
        id === 'tracked.job-minutes-per-merged-pr' ? s.counts.job_minutes : s.counts.review_runs
      )
    );
    return { n: merged, value: merged ? round(top / merged, 1) : null };
  }
  const slo = files.slos?.slos.find((s) => s.id === id);
  if (slo && whole.length) {
    // An SLO is defined over whole days, so it reads the window's whole days.
    const from = whole[0]!;
    const to = whole.at(-1)!;
    const r = computeSlos(
      { slos: [slo] },
      {},
      {
        snapshots: series.snapshots(addDays(to, -27), to),
        local: series.local(from, to),
        toolCeilingSeconds: files.config.local.tool_ceiling_seconds,
        from,
        to,
      }
    )[0]!;
    const stat = slo.objective[0]!.stat;
    return { n: r.status === 'unmeasured' ? 0 : r.n, value: r.stats[stat] ?? null };
  }
  return { n: 0, value: null };
}

function round1(x: number | null): number | null {
  return x === null ? null : round(x, 1);
}

/**
 * Whether lower is better for a metric: true for durations, rates, waits and
 * shares whose objective is an upper bound; false for catches and for SLOs
 * whose objective is a lower bound.
 *
 * @param id - The metric id.
 * @param files - The hand files.
 */
function lowerIsBetter(id: string, files: HandFiles): boolean {
  if (id.endsWith('.real_catches')) return false;
  const slo = files.slos?.slos.find((s) => s.id === id);
  if (slo) return slo.objective[0]!.op.startsWith('<');
  return true;
}

/**
 * The digest a sticky verdict is keyed on.
 *
 * @param e - The ledger entry.
 */
export function hypothesisHash(e: LedgerEntry): string {
  const h = e.hypothesis!;
  const body = JSON.stringify([
    h.metric,
    h.slo ?? null,
    h.baseline,
    h.target,
    h.after_days,
    [...e.prs].sort(),
    [...e.gates].sort(),
  ]);
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

/** Inputs to one verdict. */
export interface VerdictInput {
  entry: LedgerEntry;
  /** Merge time of every ledger entry's PRs: pr -> ISO time, absent when unmerged. */
  mergedAt: ReadonlyMap<number, string>;
  /** Every ledger entry, for the confounder check. */
  ledger: readonly LedgerEntry[];
  files: HandFiles;
  series: Series;
  now: Date;
}

/** The anchor of an entry: its last merged PR's merge time, or `null`. */
function anchorOf(e: LedgerEntry, mergedAt: ReadonlyMap<number, string>): string | null {
  return (
    e.prs
      .flatMap((p) => (mergedAt.has(p) ? [mergedAt.get(p)!] : []))
      .sort()
      .at(-1) ?? null
  );
}

/**
 * Compute one entry's verdict, or `null` when it has no verdict to compute
 * (no hypothesis, withdrawn, or not merged yet).
 *
 * @param inp - The inputs.
 */
export function computeVerdict(inp: VerdictInput): Verdict | null {
  const { entry: e, files, series, now } = inp;
  const h = e.hypothesis;
  if (!h || e.status === 'withdrawn' || e.status === 'proposed') return null;
  const anchor = anchorOf(e, inp.mergedAt);
  if (!anchor) return null;
  const at = Date.parse(anchor);
  const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
  const before: Window = {
    from: iso(at - files.config.verdicts.before_days * DAY_MS),
    to: iso(at),
  };
  const after: Window = { from: iso(at), to: iso(at + h.after_days * DAY_MS) };
  const slo = files.slos?.slos.find((s) => s.id === h.metric);
  const minN = slo ? slo.definition.min_n : files.config.verdicts.min_n;
  const read = (w: Window) => readMetric(h.metric, files, series, w);
  const b = read(before);
  const a = read(after);
  // A window with a day the collector has not (yet) finished would be judged on
  // part of its data. Local hook metrics come from exports, not snapshots.
  const missing = (w: Window) =>
    h.metric.startsWith('hook.') ? [] : windowDays(w).touched.filter((d) => !series.covered(d));
  const beforeMissing = missing(before);
  const afterMissing = missing(after);
  const useBefore = beforeMissing.length === 0 && b.n >= minN && b.value !== null;
  const cfg = files.config.collect;
  // Days older than this will never be collected: before the backfill's start,
  // or past Actions' 90-day retention.
  const collectableFrom = [
    cfg.backfill_from ?? addDays(dayOf(now), -files.config.collect.lookback_days),
    addDays(dayOf(now), -89),
  ].sort()[1]!;
  const baseline = useBefore ? b.value : h.baseline;
  const lower = lowerIsBetter(h.metric, files);
  const confounders = inp.ledger
    .filter(
      (o) => o.id !== e.id && o.status !== 'withdrawn' && o.gates.some((g) => e.gates.includes(g))
    )
    .filter((o) => {
      const t = anchorOf(o, inp.mergedAt);
      return (
        t !== null &&
        Date.parse(t) >= Date.parse(after.from) &&
        Date.parse(t) < Date.parse(after.to)
      );
    })
    .map((o) => o.id)
    .sort();
  let sloBlock: Verdict['slo'] = null;
  const sloDef = h.slo ? files.slos?.slos.find((s) => s.id === h.slo) : undefined;
  if (h.slo && sloDef) {
    const sb = readMetric(h.slo, files, series, before);
    const sa = readMetric(h.slo, files, series, after);
    const sloLower = lowerIsBetter(h.slo, files);
    const movement =
      sb.value === null || sa.value === null
        ? 'unknown'
        : sa.value === sb.value
          ? 'flat'
          : sa.value < sb.value === sloLower
            ? 'better'
            : 'worse';
    sloBlock = {
      id: h.slo,
      stat: sloDef.objective[0]!.stat,
      before: sb.value,
      after: sa.value,
      movement,
    };
  }
  // The day holding the after-window's end is collected the next morning.
  const closesAt = addDays(dayOf(new Date(Date.parse(after.to) - 1)), 1);
  let verdict: Verdict['verdict'];
  let reason: string;
  const fmt = (x: number | null) => (x === null ? 'no data' : String(x));
  if (dayOf(now) < closesAt) {
    verdict = 'pending';
    reason = `The after-window runs to ${after.to}; the verdict is computed on ${closesAt}.`;
  } else if (confounders.length) {
    verdict = 'inconclusive';
    reason = `Confounded: ${confounders.join(', ')} changed the same gate inside the after-window (${after.from} to ${after.to}), so the movement cannot be attributed to this change alone.`;
  } else if (afterMissing.some((d) => d >= collectableFrom)) {
    verdict = 'pending';
    reason = `Waiting: ${afterMissing.length} of ${windowDays(after).touched.length} after-window days not collected (${dayRange(afterMissing)}); backfill reaches them first.`;
  } else if (afterMissing.length) {
    verdict = 'inconclusive';
    reason = `Missing: ${afterMissing.length} of ${windowDays(after).touched.length} after-window days never collected, and Actions no longer keeps them (${dayRange(afterMissing)}).`;
  } else if (a.n < minN || a.value === null) {
    verdict = 'inconclusive';
    reason = `Too little data: n=${a.n} in the after-window (${after.from} to ${after.to}), below the minimum of ${minN}.`;
  } else if (lower ? a.value <= h.target : a.value >= h.target) {
    verdict = 'verified';
    reason = `${h.metric} reached ${a.value} against a target of ${h.target} (baseline ${fmt(baseline)}).`;
  } else if (
    baseline !== null &&
    (lower
      ? a.value <= baseline - (baseline - h.target) / 2
      : a.value >= baseline + (h.target - baseline) / 2)
  ) {
    verdict = 'partial';
    const moved = Math.round((Math.abs(baseline - a.value) / Math.abs(baseline - h.target)) * 100);
    reason = `${h.metric} moved from ${baseline} to ${a.value}, ${moved}% of the way to the target of ${h.target}, but did not reach it.`;
  } else {
    verdict = 'failed';
    reason = `${h.metric} is ${a.value} against a target of ${h.target}, less than halfway from the baseline of ${fmt(baseline)}.`;
  }
  return {
    schema: 1,
    id: e.id,
    verdict,
    reason,
    computed_at: now.toISOString(),
    hypothesis_hash: hypothesisHash(e),
    metric: h.metric,
    anchor,
    prs: [...e.prs],
    baseline: { value: baseline, source: useBefore ? 'before-window' : 'ledger' },
    target: h.target,
    min_n: minN,
    before: { ...before, ...b },
    after: { ...after, ...a },
    confounders,
    slo: sloBlock,
  };
}

/**
 * A `Series` over a data directory's snapshots and local exports.
 *
 * @param load - Loads the snapshots for a list of days.
 * @param loadLocal - Loads the local exports for a list of days.
 */
export function seriesFrom(
  load: (days: string[]) => Snapshot[],
  loadLocal: (days: string[]) => LocalDay[]
): Series {
  return {
    snapshots: (from, to) => (from > to ? [] : load(daysBetween(from, to))),
    local: (from, to) => (from > to ? [] : loadLocal(daysBetween(from, to))),
    covered: (day) => load([day])[0]?.complete === true,
  };
}
