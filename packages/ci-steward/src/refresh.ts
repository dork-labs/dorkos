/**
 * Bringing days already on the data branch up to what the current engine
 * derives, without collecting them again (a complete day never is).
 */
import type { CollectOptions, Run } from './collect.ts';
import { priorQueueBuilds, repeatEjections } from './ejection-facts.ts';
import { readData, snapshotDays, snapshotPath, SnapshotSchema, writeData } from './data.ts';
import { BudgetExhausted, type Gh } from './gh.ts';
import { fetchMergedPrs } from './prs.ts';
import type { Config } from './schemas.ts';
import { mainCommits, trimRun } from './series.ts';
import { addDays, dayOf } from './time.ts';

/**
 * Push runs on the default branch created on one day. One or two requests: the
 * branch and event filters leave about a hundred runs a day.
 *
 * @param gh - The client.
 * @param config - The parsed config.
 * @param day - The UTC day.
 * @returns The runs, or null when the listing came back short of its own count.
 */
function fetchMainPushRuns(gh: Gh, config: Config, day: string): Run[] | null {
  const base = `repos/${config.github_repo}/actions/runs?branch=${config.default_branch}&event=push&created=${day}T00:00:00Z..${day}T23:59:59Z&per_page=100`;
  const out = new Map<number, Run>();
  let total = 0;
  for (let page = 1; page <= 10; page += 1) {
    const res = gh.rest(`${base}&page=${page}`) as {
      total_count: number;
      workflow_runs: Record<string, unknown>[];
    };
    total = res.total_count;
    for (const r of res.workflow_runs) out.set(Number(r.id), trimRun(r));
    if (res.workflow_runs.length < 100 || out.size >= total) break;
  }
  return out.size < total ? null : [...out.values()];
}

/**
 * Bring an already-collected day up to what this engine derives, without
 * collecting it again: its `main` commits get their per-workflow results
 * (`mainEpisodes`) and its counts get `repeat_ejections`. A complete day is
 * never re-collected, so without this every day before the change would keep
 * reading under the old ruler for as long as it stays in a 28-day window.
 *
 * About four requests a day (two run listings, one or two PR searches) against
 * the 150 to 400 a full collection costs, and only for days Actions still keeps.
 * A day whose listing or search comes back short is left exactly as it was.
 *
 * @param opts - The run's inputs.
 * @param day - A day already on disk.
 * @returns Whether the day was rewritten.
 */
function refreshDay(opts: CollectOptions, day: string): boolean {
  const { gh, files, dataDir } = opts;
  const snap = readData(dataDir, snapshotPath(day), SnapshotSchema);
  if (!snap || !snap.complete || snap.partial_day || snap.counts.repeat_ejections !== undefined)
    return false;
  const runs = fetchMainPushRuns(gh, files.config, day);
  if (!runs) return false;
  const failures: string[] = [];
  const prs = fetchMergedPrs(gh, files.config.github_repo, day, undefined, failures);
  if (failures.length) return false;
  snap.main = mainCommits(runs, files.config.default_branch);
  snap.counts.repeat_ejections = repeatEjections(
    prs,
    priorQueueBuilds(dataDir, day, snap.queue_builds)
  );
  writeData(dataDir, snapshotPath(day), snap);
  return true;
}

/**
 * Refresh every older day that needs it (`refreshDay`), newest first — the
 * days every window reads — inside the 90 days Actions keeps and before today,
 * until the budget is down to its last ten requests.
 *
 * @param opts - The run's inputs.
 * @returns The days rewritten, oldest first.
 */
export function refreshOlderDays(opts: CollectOptions): string[] {
  const { dataDir, now, gh } = opts;
  const oldest = addDays(dayOf(now), -89);
  const days = snapshotDays(dataDir)
    .filter((d) => d >= oldest && d < dayOf(now))
    .reverse();
  const refreshed: string[] = [];
  for (const day of days) {
    if (gh.budget - gh.calls < 10) break;
    try {
      if (refreshDay(opts, day)) refreshed.push(day);
    } catch (e) {
      if (e instanceof BudgetExhausted) break;
      throw e;
    }
  }
  return refreshed.sort();
}
