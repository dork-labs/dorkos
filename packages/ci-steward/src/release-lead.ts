/**
 * `tracked.merged-to-released`: per merged PR, the hours from its merge to the
 * first published release that contains it. The headline number of a pipeline
 * that releases once a day and fixes forward (DOR-5127).
 *
 * Two facts are recorded per day, and the join happens when the metric is
 * read, never at collection:
 *
 * - `merges`: each PR merged that day and its merge commit, from the merged-PR
 *   search the collector already makes (`mergeCommit { oid }`, no extra
 *   request).
 * - `release_contents`: each release published that day and the commits it
 *   shipped, one `compare/<previous tag>...<tag>` request per release (a page
 *   holds 100 commits; a day's release is one page).
 *
 * Joining at read time is what lets a release on Tuesday find a PR merged on
 * Monday, whatever order the two days were collected in.
 *
 * CONTAINMENT IS COMMIT ANCESTRY. A compare range is every commit reachable
 * from the tag and not from the previous release's tag, which is exactly the
 * set a release adds when it is cut from `main`. A release cut from a
 * `release/v*` branch holds cherry-picks with new SHAs; each carries a
 * `(cherry picked from commit <sha>)` line (`git cherry-pick -x`, which the
 * release-branch rule requires), and that source SHA is recorded too, so the
 * PR counts as shipped by the patch release, not by the next one cut from
 * `main` that holds it by ancestry. Earliest published release wins.
 */
import type { Snapshot } from './data.ts';
import type { Merge, ReleaseContents } from './release-facts.ts';
import type { Gh } from './gh.ts';
import { h, type Html } from './html.ts';
import type { PrFacts } from './prs.ts';
import { addDays, count, daysBetween, quantile, round } from './time.ts';

/** A published release, as the collector reads it once per run. */
export interface PublishedRelease {
  tag: string;
  published_at: string;
}

/** How far before a release the reader looks for the merge it ships. */
export const MERGE_LOOKBACK_DAYS = 28;

/** Pages of one compare range read at most; 1,000 commits is weeks of merges. */
const COMPARE_PAGES = 10;

const CHERRY_PICK = /\(cherry picked from commit ([0-9a-f]{12,40})\)/g;
const RELEASE_COMMIT = /^chore\(release\):/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const short = (sha: string) => sha.slice(0, 12);

/**
 * The day's merges, from the merged-PR facts. A PR GitHub reported no merge
 * commit for is left out: it cannot be found in any release.
 *
 * @param prs - The PRs merged that day.
 */
export function mergesOf(prs: readonly PrFacts[]): Merge[] {
  return prs.flatMap((p) =>
    p.mergeSha ? [{ pr: p.number, sha: short(p.mergeSha), at: p.mergedAt }] : []
  );
}

/**
 * The release published most recently before `r`, from the run's release list.
 *
 * @param r - The release.
 * @param all - Every published release the run read.
 */
function previousRelease(
  r: PublishedRelease,
  all: readonly PublishedRelease[]
): PublishedRelease | null {
  let best: PublishedRelease | null = null;
  for (const x of all) {
    if (x.tag === r.tag || x.published_at >= r.published_at) continue;
    if (!best || x.published_at > best.published_at) best = x;
  }
  return best;
}

/**
 * What each release shipped: one compare range per release, from the release
 * published before it. A release with nothing published before it in `all`
 * gets `base: null` and no SHAs, since its range cannot be told.
 *
 * A range that comes back shorter than its own `total_commits` is kept with
 * what was read and named in `short`, so the caller can say so (the collector
 * warns; a refresh leaves the day as it was).
 *
 * @param gh - The client (a spent budget throws BudgetExhausted).
 * @param repo - `owner/name`.
 * @param releases - The releases published on the day.
 * @param all - Every published release the run read, to find each one's predecessor.
 */
export function releaseContents(
  gh: Gh,
  repo: string,
  releases: readonly PublishedRelease[],
  all: readonly PublishedRelease[]
): { contents: ReleaseContents[]; short: string[] } {
  const contents: ReleaseContents[] = [];
  const shortRanges: string[] = [];
  const known = [...all, ...releases];
  for (const r of releases) {
    const prev = previousRelease(r, known);
    if (!prev) {
      contents.push({ tag: r.tag, published_at: r.published_at, base: null, shas: [] });
      continue;
    }
    const shas = new Set<string>();
    let read = 0;
    let total = 0;
    for (let page = 1; page <= COMPARE_PAGES; page += 1) {
      const res = gh.rest(
        `repos/${repo}/compare/${encodeURIComponent(prev.tag)}...${encodeURIComponent(r.tag)}?per_page=100&page=${page}`
      ) as { total_commits?: number; commits?: unknown[] };
      total = Number(res.total_commits ?? 0);
      const batch = (res.commits ?? []).filter(isObj);
      read += batch.length;
      for (const c of batch) {
        const message = String((isObj(c.commit) ? c.commit.message : '') ?? '');
        if (RELEASE_COMMIT.test(message)) continue;
        shas.add(short(String(c.sha)));
        for (const m of message.matchAll(CHERRY_PICK)) shas.add(short(m[1]!));
      }
      if (batch.length < 100 || read >= total) break;
    }
    if (read < total) shortRanges.push(r.tag);
    contents.push({
      tag: r.tag,
      published_at: r.published_at,
      base: prev.tag,
      shas: [...shas].sort(),
    });
  }
  return { contents, short: shortRanges };
}

/** The metric over one window. */
export interface ReleaseLead {
  /** Merged PRs whose first release was published inside the window. */
  n: number;
  /** Hours, merge to release. */
  p50: number | null;
  p90: number | null;
  /** Releases in the window whose contents were recorded; 0 means not measured, not "nothing shipped". */
  releases: number;
}

/**
 * `tracked.merged-to-released` over `[from, to)`.
 *
 * A sample sits at its release's publication, so the window holds the PRs that
 * SHIPPED in it, however long ago they merged: a PR that waited is counted the
 * day it finally goes out, not dropped because the window closed first. Each
 * PR counts once, in its earliest release.
 *
 * The snapshots must reach `MERGE_LOOKBACK_DAYS` before `from`, so the merges
 * and any earlier release of the same commit are in view. A commit with no
 * recorded merge (a direct push, or a PR merged before merges were recorded)
 * adds no sample.
 *
 * @param snaps - The snapshots, from `MERGE_LOOKBACK_DAYS` before the window to its end.
 * @param from - Window start, ms.
 * @param to - Window end, ms (exclusive).
 */
export function mergedToReleased(
  snaps: readonly Snapshot[],
  from: number,
  to: number
): ReleaseLead {
  const merged = new Map<string, string>();
  for (const s of snaps) for (const m of s.merges ?? []) merged.set(m.sha, m.at);
  const releases = snaps
    .flatMap((s) => s.release_contents ?? [])
    .sort((a, b) => a.published_at.localeCompare(b.published_at));
  const first = new Map<string, string>();
  for (const r of releases)
    for (const sha of r.shas) if (!first.has(sha)) first.set(sha, r.published_at);
  const hours: number[] = [];
  for (const [sha, published] of first) {
    const t = Date.parse(published);
    const at = merged.get(sha);
    if (t < from || t >= to || at === undefined) continue;
    const h = (t - Date.parse(at)) / 3_600_000;
    if (h >= 0) hours.push(h);
  }
  const inWindow = releases.filter((r) => {
    const t = Date.parse(r.published_at);
    return t >= from && t < to;
  }).length;
  const q = (p: number) => {
    const v = quantile(hours, p);
    return v === null ? null : round(v, 1);
  };
  return { n: hours.length, p50: q(0.5), p90: q(0.9), releases: inWindow };
}

/**
 * The metric over the seven days to `day`, for the daily report.
 *
 * @param load - Reads the snapshots of the given days that exist.
 * @param day - The last day of the window.
 */
export function releaseLeadWeek(
  load: (days: readonly string[]) => Snapshot[],
  day: string
): ReleaseLead {
  const start = addDays(day, -6);
  return mergedToReleased(
    load(daysBetween(addDays(start, -MERGE_LOOKBACK_DAYS), day)),
    Date.parse(`${start}T00:00:00Z`),
    Date.parse(`${addDays(day, 1)}T00:00:00Z`)
  );
}

/**
 * The daily report's "Merge to release" panel, the headline number since
 * releases went daily (DOR-5127): how long a merged PR waits to ship, over the
 * seven days to the report's day. Reported, never scored. A week with no
 * release contents recorded says so rather than reading as zero.
 *
 * @param load - Reads the snapshots of the given days that exist.
 * @param day - The report's day.
 */
export function releaseLeadPanel(load: (days: readonly string[]) => Snapshot[], day: string): Html {
  const r = releaseLeadWeek(load, day);
  if (r.releases === 0)
    return h`<div class="panel"><p>No release recorded in the 7 days to ${day}.</p></div>`;
  if (r.p50 === null || r.p90 === null)
    return h`<div class="panel"><p>${count(r.releases, 'release')} in the 7 days to ${day}, with no recorded merge in ${r.releases === 1 ? 'it' : 'them'}.</p></div>`;
  return h`<div class="panel">
        <p><strong>p50 ${r.p50} h</strong> · p90 ${r.p90} h from merge to release.</p>
        <p class="note">${count(r.n, 'merged PR')} shipped in ${count(r.releases, 'release')}, 7 days to ${day}. A PR counts once, in the first release that holds it.</p>
      </div>`;
}
