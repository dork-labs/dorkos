/**
 * Test reports from queue builds' artifacts, for flaky-test-runs: Playwright's
 * JSON stats count a test that failed and then passed on its retry as flaky;
 * the vitest shard reports carry executions and the flake reporter's list.
 *
 * Downloads cost one request per artifact, so the collector samples a fixed
 * number of queue builds a day (`collect.artifact_builds_per_day`) rather than
 * all of them, and records how many it sampled.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Run } from './collect.ts';
import type { Snapshot } from './data.ts';
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
 * Executions and flaky executions in a directory of downloaded reports.
 *
 * @param dir - Where the artifacts were extracted.
 * @param format - The report format.
 */
function countReports(
  dir: string,
  format: 'playwright' | 'vitest'
): { executions: number; flaky: number } {
  let executions = 0;
  let flaky = 0;
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
    } else if (format === 'vitest' && path.basename(f) === 'vitest-shard-report.json') {
      executions +=
        Number(doc.numTotalTests ?? 0) -
        Number(doc.numPendingTests ?? 0) -
        Number(doc.numTodoTests ?? 0);
    } else if (format === 'vitest' && path.basename(f) === 'vitest-flake-report.json') {
      flaky += Array.isArray(doc.flaky) ? doc.flaky.length : 0;
    }
  }
  return { executions, flaky };
}

/**
 * Download the reports of up to `artifact_builds_per_day` finished queue
 * builds, spread evenly over the day, and add their counts to the snapshot.
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
        sampled = sampled || c.executions > 0;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    if (sampled) snap.counts.flaky_builds_sampled += 1;
  }
}
