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
import { mergesOf, releaseContents, type PublishedRelease } from './release-lead.ts';
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
 * (`mainEpisodes`), its counts get `repeat_ejections`, and it gets the
 * `merges` and `release_contents` that `tracked.merged-to-released` joins. A
 * complete day is never re-collected, so without this every day before the
 * change would keep reading under the old ruler for as long as it stays in a
 * 28-day window.
 *
 * About three requests a day (one push-run listing, one merged-PR search, a
 * timeline page for any PR with more than 100 events, and one compare per
 * release published that day), each part only when the day lacks what it
 * gives, against the 150 to 400 a full collection costs, and only for days
 * Actions still keeps. A day whose listing, search or compare comes back short
 * is left exactly as it was.
 *
 * @param opts - The run's inputs.
 * @param day - A day already on disk.
 * @param releases - Every published release the run read, so a day's release finds its predecessor.
 * @returns Whether the day was rewritten.
 */
function refreshDay(
  opts: CollectOptions,
  day: string,
  releases: readonly PublishedRelease[]
): boolean {
  const { gh, files, dataDir } = opts;
  const snap = readData(dataDir, snapshotPath(day), SnapshotSchema);
  if (!snap || !snap.complete || snap.partial_day) return false;
  const needsRepeats = snap.counts.repeat_ejections === undefined;
  const needsShipped = snap.merges === undefined || snap.release_contents === undefined;
  if (!needsRepeats && !needsShipped) return false;
  const runs = needsRepeats ? fetchMainPushRuns(gh, files.config, day) : [];
  if (!runs) return false;
  const failures: string[] = [];
  const prs = fetchMergedPrs(gh, files.config.github_repo, day, undefined, failures);
  if (failures.length) return false;
  const shipped = needsShipped
    ? releaseContents(gh, files.config.github_repo, snap.releases, releases)
    : null;
  if (shipped?.short.length) return false;
  if (needsRepeats) {
    snap.main = mainCommits(runs, files.config.default_branch);
    snap.counts.repeat_ejections = repeatEjections(
      prs,
      priorQueueBuilds(dataDir, day, snap.queue_builds)
    );
  }
  if (shipped) {
    snap.merges = mergesOf(prs);
    snap.release_contents = shipped.contents;
  }
  writeData(dataDir, snapshotPath(day), snap);
  return true;
}

/**
 * Refresh every older day that needs it (`refreshDay`), newest first — the
 * days every window reads — inside the 90 days Actions keeps and before today,
 * until the budget is down to its last ten requests.
 *
 * @param opts - The run's inputs.
 * @param releases - Every published release the run read.
 * @returns The days rewritten, oldest first.
 */
export function refreshOlderDays(
  opts: CollectOptions,
  releases: readonly PublishedRelease[] = []
): string[] {
  const { dataDir, now, gh } = opts;
  const oldest = addDays(dayOf(now), -89);
  const days = snapshotDays(dataDir)
    .filter((d) => d >= oldest && d < dayOf(now))
    .reverse();
  const refreshed: string[] = [];
  for (const day of days) {
    if (gh.budget - gh.calls < 10) break;
    try {
      if (refreshDay(opts, day, releases)) refreshed.push(day);
    } catch (e) {
      if (e instanceof BudgetExhausted) break;
      throw e;
    }
  }
  return refreshed.sort();
}
