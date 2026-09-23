/**
 * Rebuilds `shard-timings.json` from real merge-queue runs.
 *
 *   pnpm --filter @dorkos/e2e shard-timings            # the 7 latest green queue runs
 *   pnpm --filter @dorkos/e2e shard-timings <run-id>…  # these runs
 *
 * Downloads each run's `browser-results-shard-*` artifacts (the JSON reports
 * the browser-test workflow uploads on success) with `gh`, and writes the
 * per-unit medians `buildTimings` computes. Only green runs are used: a failed
 * shard uploads no report, so a red run would be missing a third of its units.
 *
 * Run it when the per-shard estimates the balanced-shard reporter prints in CI
 * drift away from the shards' real suite-step times. New specs do not need it
 * — they are weighed by their project's per-test rate — so this is upkeep,
 * not a step anyone has to remember per change.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTimings, type ReportLike } from './balanced-shard';
import { SHARD_TIMINGS_PATH } from './balanced-shard-reporter';

const REPO = 'dork-labs/dorkos';

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
}

function latestGreenRuns(count: number): string[] {
  const out = gh([
    'run',
    'list',
    '-R',
    REPO,
    '--workflow',
    'browser-test.yml',
    '--event',
    'merge_group',
    '--status',
    'success',
    '--limit',
    String(count),
    '--json',
    'databaseId',
  ]);
  return (JSON.parse(out) as Array<{ databaseId: number }>).map((r) => String(r.databaseId));
}

const ids = process.argv.slice(2);
const runIds = ids.length ? ids : latestGreenRuns(7);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-timings-'));
try {
  const runs = runIds.map((id) => {
    const dir = path.join(scratch, id);
    gh(['run', 'download', id, '-R', REPO, '-p', 'browser-results-shard-*', '-D', dir]);
    const reports = fs
      .readdirSync(dir)
      .map((shard) => path.join(dir, shard, 'results.json'))
      .filter((f) => fs.existsSync(f))
      .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as ReportLike);
    if (reports.length === 0) throw new Error(`run ${id} has no browser-results-shard-* reports`);
    return { id, reports };
  });
  const timings = buildTimings(runs, new Date().toISOString().slice(0, 10));
  fs.writeFileSync(SHARD_TIMINGS_PATH, `${JSON.stringify(timings, null, 2)}\n`);
  console.log(
    `wrote ${Object.keys(timings.units).length} units from ${runs.length} runs to ${SHARD_TIMINGS_PATH}`
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
