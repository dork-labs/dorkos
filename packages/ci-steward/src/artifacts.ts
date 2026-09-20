/**
 * Test reports from queue builds' artifacts, for flaky-test-runs and for the
 * quarantine classifier: Playwright's JSON stats count a test that failed and
 * then passed on its retry as flaky; the vitest shard reports carry executions
 * and the flake reporter's list.
 *
 * It records both halves. The COUNTS answer "how much flake is there" (the
 * `flaky-test-runs` SLO) and are taken from each runner's own tally, unchanged.
 * The NAMES answer "where", which is the only thing `ci-steward flaky` can
 * classify from — a share of 0.5% says nothing about whether the flake is
 * spread over four hundred tests or concentrated in two, and the second is the
 * one a quarantine lane can fix.
 *
 * Downloads cost one request per artifact, so the collector samples a fixed
 * number of queue builds a day (`collect.artifact_builds_per_day`) rather than
 * all of them, and records how many it sampled.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Run } from './collect.ts';
import { readPlaywrightReport, readVitestFlakeReport } from './flaky.ts';
import type { FlakyTest, Snapshot } from './data.ts';
import type { Gh } from './gh.ts';
import type { HandFiles } from './load.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/**
 * Executions, flaky executions and the flaky tests' NAMES in a directory of
 * downloaded reports.
 *
 * The two counts come from each runner's own tally, exactly as they did before
 * names were recorded, so the `flaky-test-runs` denominator never moves because
 * the classifier was added. The names are read from the same files beside them.
 *
 * @param dir - Where the artifacts were extracted.
 * @param format - The report format.
 */
function countReports(
  dir: string,
  format: 'playwright' | 'vitest'
): { executions: number; flaky: number; named: Omit<FlakyTest, 'sha'>[] } {
  let executions = 0;
  let flaky = 0;
  const named: Omit<FlakyTest, 'sha'>[] = [];
  for (const f of walk(dir)) {
    if (!f.endsWith('.json')) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    if (!isObj(doc)) continue;
    if (format === 'playwright' && isObj(doc.stats)) {
      const s = doc.stats;
      executions += Number(s.expected ?? 0) + Number(s.unexpected ?? 0) + Number(s.flaky ?? 0);
      flaky += Number(s.flaky ?? 0);
      for (const t of readPlaywrightReport(doc)) {
        if (t.outcome === 'flaky') named.push({ runner: t.runner, file: t.file, title: t.title });
      }
    } else if (format === 'vitest' && path.basename(f) === 'vitest-shard-report.json') {
      executions +=
        Number(doc.numTotalTests ?? 0) -
        Number(doc.numPendingTests ?? 0) -
        Number(doc.numTodoTests ?? 0);
    } else if (format === 'vitest' && path.basename(f) === 'vitest-flake-report.json') {
      flaky += Array.isArray(doc.flaky) ? doc.flaky.length : 0;
      for (const t of readVitestFlakeReport(doc)) {
        named.push({ runner: t.runner, file: t.file, title: t.title });
      }
    }
  }
  return { executions, flaky, named };
}

/**
 * Download the reports of up to `artifact_builds_per_day` finished queue
 * builds, spread evenly over the day, and add their counts and named flakes to
 * the snapshot.
 *
 * @param opts - The client, hand files and scratch directory.
 * @param snap - The day being collected; its queue builds must be filled.
 * @param runs - The day's runs, to find each build's run ids.
 */
export function sampleFlaky(
  opts: { gh: Gh; files: HandFiles; tmpDir: string },
  snap: Snapshot,
  runs: readonly Run[]
): void {
  const { gh, files } = opts;
  const cfg = files.config.collect;
  const wanted = cfg.artifact_builds_per_day - snap.counts.flaky_builds_sampled;
  if (wanted <= 0 || cfg.artifacts.length === 0) return;
  const done = snap.queue_builds.filter((b) => b.outcome === 'green' || b.outcome === 'red');
  if (done.length === 0) return;
  const step = Math.max(1, Math.floor(done.length / wanted));
  const picks = done.filter((_, i) => i % step === 0).slice(0, wanted);
  // Keyed per (test, build): three shards of one build are ONE occurrence, and
  // a resumed day never records the same one twice.
  const seen = new Set(
    snap.flaky_tests.map((f) => `${f.runner}\u0000${f.file}\u0000${f.title}\u0000${f.sha}`)
  );
  const builds = new Set(snap.flaky_builds.map((b) => `${b.runner}\u0000${b.sha}`));
  for (const b of picks) {
    let sampled = false;
    for (const a of cfg.artifacts) {
      const run = runs.find(
        (r) =>
          r.event === 'merge_group' &&
          r.head_sha.startsWith(b.sha) &&
          r.path.endsWith(`/${a.workflow}`)
      );
      if (!run) continue;
      const dir = mkdtempSync(path.join(opts.tmpDir, 'artifacts-'));
      try {
        if (gh.downloadArtifacts(run.id, a.pattern, dir) === 0) continue;
        const c = countReports(dir, a.format);
        snap.counts.test_executions += c.executions;
        snap.counts.test_flaky += c.flaky;
        for (const n of c.named) {
          const key = `${n.runner}\u0000${n.file}\u0000${n.title}\u0000${b.sha}`;
          if (seen.has(key)) continue;
          seen.add(key);
          snap.flaky_tests.push({ ...n, sha: b.sha });
        }
        if (c.executions > 0) {
          sampled = true;
          const key = `${a.format}\u0000${b.sha}`;
          if (!builds.has(key)) {
            builds.add(key);
            snap.flaky_builds.push({ sha: b.sha, runner: a.format });
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    if (sampled) snap.counts.flaky_builds_sampled += 1;
  }
}
