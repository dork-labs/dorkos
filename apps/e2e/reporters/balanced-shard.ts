/**
 * Duration-balanced shard assignment for the browser suite.
 *
 * WHY. Playwright's built-in `--shard=i/N` cuts the suite into N runs of equal
 * TEST COUNT, in collection order. This suite's collection order is the
 * `projects` array, and the test-mode projects (`chromium-mock`,
 * `chromium-connections`, `chromium-rooms-agents` …) sit after the one big
 * cockpit project. Their tests run about 40% longer than a cockpit test, so an
 * equal count put ~20 minutes of test time on shard 3 against ~14 on shard 1
 * and ran shard 3 at 92% of its 30-minute `globalTimeout` (queue builds
 * 2026-09-16..23; ledger `ci/ledger/260923-095643-balance-browser-shards.md`).
 *
 * WHAT. Every (project, spec file) pair is one unit, estimated from measured
 * CI durations in `shard-timings.json`, and the units are dealt out
 * heaviest-first to whichever shard is lightest so far (the LPT rule). A unit
 * is never split, so a file's `beforeAll`, its serial describes and its
 * worker-scoped fixtures behave exactly as in an unsharded run.
 *
 * AS THE SUITE GROWS. Nothing here names a spec. A unit the timings file has
 * never seen is estimated as its test count times its project's measured
 * per-test time, and a known unit whose test count changed is scaled by the
 * same per-test rate — so a new spec lands on the lightest shard at a
 * realistic weight rather than skewing the tail of a count-based cut. The
 * timings only need a refresh (`pnpm --filter @dorkos/e2e shard-timings`)
 * when real durations drift away from the recorded ones.
 *
 * DETERMINISM IS THE CORRECTNESS PROPERTY. Each shard runs this on its own
 * runner and keeps only its own units, so every shard must compute the SAME
 * partition, or a unit runs twice or never. The inputs are the collected suite
 * (identical per checkout and flags) and the committed timings file; ties are
 * broken by the unit key and then the lowest shard index, never by insertion
 * order or anything machine-dependent. The fan-in's
 * `scripts/assert-browser-tests-executed.sh` then proves the result: every
 * spec file ran, and no test ran in two shards.
 */

/** One schedulable piece of the suite: every test of one spec file within one project. */
export interface ShardUnit {
  /** `<project>|<file relative to testDir, posix separators>`. */
  key: string;
  /** Project name, the fallback rate's bucket for a unit with no timing. */
  project: string;
  /** How many tests this unit holds in the current collection. */
  tests: number;
}

/** A unit's measured cost: total test seconds, and how many tests produced it. */
export interface UnitTiming {
  seconds: number;
  tests: number;
}

/** The committed timings file. */
export interface ShardTimings {
  /** Where the numbers came from, for whoever refreshes them next. */
  source: { generated: string; runs: string[] };
  units: Record<string, UnitTiming>;
}

/** A unit with the weight the partition used for it. */
export interface WeightedUnit extends ShardUnit {
  /** Estimated seconds. */
  weight: number;
  /** `measured` from its own timing, `project` or `suite` rate, or `count` with no timings at all. */
  basis: 'measured' | 'project' | 'suite' | 'count';
}

/** Builds the unit key the timings file and the reporter share. */
export function unitKey(project: string, file: string): string {
  return `${project}|${file.split('\\').join('/')}`;
}

function rate(entries: UnitTiming[]): number | undefined {
  let seconds = 0;
  let tests = 0;
  for (const e of entries) {
    seconds += e.seconds;
    tests += e.tests;
  }
  // Zero seconds is a real measurement — the opt-in auth spec skips every
  // test in CI — and must weigh nothing, not fall through to a project rate.
  return tests > 0 ? seconds / tests : undefined;
}

/**
 * Estimates each unit's seconds from the timings: its own measured per-test
 * rate, else its project's, else the whole suite's, times its current test
 * count. With no usable timings at all every test weighs 1 — Playwright's own
 * count-based cut, so a missing file degrades to today's behaviour, not worse.
 */
export function weighUnits(units: ShardUnit[], timings: ShardTimings | undefined): WeightedUnit[] {
  const known = timings?.units ?? {};
  const byProject = new Map<string, UnitTiming[]>();
  for (const [key, t] of Object.entries(known)) {
    const project = key.slice(0, key.indexOf('|'));
    byProject.set(project, [...(byProject.get(project) ?? []), t]);
  }
  const suiteRate = rate(Object.values(known));
  return units.map((u) => {
    const own = known[u.key];
    const ownRate = own ? rate([own]) : undefined;
    if (ownRate !== undefined) return { ...u, weight: ownRate * u.tests, basis: 'measured' };
    const projectRate = rate(byProject.get(u.project) ?? []);
    if (projectRate !== undefined) return { ...u, weight: projectRate * u.tests, basis: 'project' };
    if (suiteRate !== undefined) return { ...u, weight: suiteRate * u.tests, basis: 'suite' };
    return { ...u, weight: u.tests, basis: 'count' };
  });
}

/**
 * Deals units to `total` shards, heaviest first, each to the currently
 * lightest shard (ties: lowest index). Returns one array of units per shard,
 * index 0 being shard 1. Pure and order-independent: the input order does not
 * affect the result.
 */
export function partition(units: WeightedUnit[], total: number): WeightedUnit[][] {
  if (!Number.isInteger(total) || total < 1)
    throw new Error(`shard total must be a positive integer, got ${total}`);
  const keys = new Set<string>();
  for (const u of units) {
    if (keys.has(u.key)) throw new Error(`duplicate shard unit ${u.key}`);
    keys.add(u.key);
  }
  const sorted = [...units].sort(
    (a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
  const shards: WeightedUnit[][] = Array.from({ length: total }, () => []);
  const loads = new Array<number>(total).fill(0);
  for (const u of sorted) {
    let lightest = 0;
    for (let i = 1; i < total; i++) if (loads[i] < loads[lightest]) lightest = i;
    shards[lightest].push(u);
    loads[lightest] += u.weight;
  }
  return shards;
}

/** Sum of a shard's estimated seconds. */
export function load(units: WeightedUnit[]): number {
  return units.reduce((a, u) => a + u.weight, 0);
}

/** The slice of Playwright's JSON report the timings are built from. */
interface ReportSuite {
  file?: string;
  specs?: Array<{ tests?: Array<{ projectName: string; results?: Array<{ duration?: number }> }> }>;
  suites?: ReportSuite[];
}

/** The slice of a Playwright JSON report {@link buildTimings} reads. */
export interface ReportLike {
  suites: ReportSuite[];
}

/**
 * Builds a timings file from Playwright JSON reports, grouped by run: each
 * inner array is one CI run's shard reports. A unit's seconds are the MEDIAN
 * over runs of its summed attempt durations (so a retry costs what it cost,
 * but one slow run does not set the weight), and its test count is the
 * largest seen. A unit is keyed by its top-level file suite, which is the file
 * Playwright loaded — a module a spec imports reports its tests under the spec.
 */
export function buildTimings(
  runs: Array<{ id: string; reports: ReportLike[] }>,
  generated: string
): ShardTimings {
  const perRun = new Map<string, number[]>();
  const counts = new Map<string, number>();
  for (const run of runs) {
    const seconds = new Map<string, number>();
    const tests = new Map<string, number>();
    for (const report of run.reports) {
      for (const top of report.suites) {
        const walk = (s: ReportSuite) => {
          for (const spec of s.specs ?? []) {
            for (const t of spec.tests ?? []) {
              const key = unitKey(t.projectName, top.file ?? '');
              const ms = (t.results ?? []).reduce((a, r) => a + (r.duration ?? 0), 0);
              seconds.set(key, (seconds.get(key) ?? 0) + ms / 1000);
              tests.set(key, (tests.get(key) ?? 0) + 1);
            }
          }
          for (const c of s.suites ?? []) walk(c);
        };
        walk(top);
      }
    }
    for (const [key, s] of seconds) perRun.set(key, [...(perRun.get(key) ?? []), s]);
    for (const [key, n] of tests) counts.set(key, Math.max(counts.get(key) ?? 0, n));
  }
  const units: Record<string, UnitTiming> = {};
  for (const key of [...perRun.keys()].sort()) {
    const xs = [...perRun.get(key)!].sort((a, b) => a - b);
    const mid = Math.floor(xs.length / 2);
    const median = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
    units[key] = { seconds: Math.round(median * 10) / 10, tests: counts.get(key)! };
  }
  return { source: { generated, runs: runs.map((r) => r.id) }, units };
}
