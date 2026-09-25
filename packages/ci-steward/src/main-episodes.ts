/**
 * Red spells on the default branch, read the same way by the `main-green` SLO
 * and by trigger rule 7, so the page and the number cannot disagree.
 *
 * A spell starts when a push workflow goes red on `main` and ends only when
 * THAT workflow goes green on `main` again. Ending it at the next commit whose
 * push checks were all green, as this used to, closed spells early: the push
 * workflows are path-filtered differently (desktop-smoke runs on a fraction of
 * commits, cli-smoke-test on all of them), so a commit that simply did not run
 * the failing workflow read as the fix. Over 2026-08-28..09-24 that turned 9
 * real spells into 14 short ones and put the restore p90 at 66 minutes when
 * the failing workflows took 356 to come back.
 *
 * Several workflows can be red at once; the spell is the whole stretch during
 * which at least one of them is, so overlapping failures are one spell, never
 * two.
 */
import type { MainCommit } from './data.ts';

/** The key a commit collected before per-workflow results existed is read under. */
const LEGACY = '*';

/**
 * A workflow red on `main` that has not reported at all for this long is
 * dropped from the spell. Without it, a red workflow whose push trigger was
 * then removed (docs-openapi-check lost its push leg in #1655) would hold
 * `main` "red" forever; typecheck and lint have lost theirs too. Seven days is
 * far past any real gap between two runs of a live push workflow: the longest
 * over 2026-08-28..09-24 was 41 hours (scripts-test), across 678 commits.
 */
const SENSOR_GONE_MS = 7 * 86_400_000;

/** One red spell on the default branch. */
export interface MainEpisode {
  /** The commit whose push checks opened it, short. */
  sha: string;
  /** When the opening commit's checks finished. */
  opened: string;
  /** When the commit that closed it finished, or null while `main` is still red. */
  closed: string | null;
  /** Every workflow that was red at some point in the spell, sorted. */
  workflows: string[];
}

/**
 * Every red spell in a run of commits, oldest first.
 *
 * A commit collected before `workflows` was recorded is read the old way: red
 * opens a spell under an unnamed workflow, and green closes everything. That
 * keeps an unrefreshed day reading exactly what it always read, so the only
 * days whose numbers move are the ones with the data to move them.
 *
 * @param commits - Commits on the default branch, in any order.
 */
export function mainEpisodes(commits: readonly MainCommit[]): MainEpisode[] {
  const sorted = [...commits].sort((a, b) => a.at.localeCompare(b.at));
  const out: MainEpisode[] = [];
  /** Red workflow → when it last reported red. */
  const red = new Map<string, string>();
  let open: { sha: string; opened: string; workflows: Set<string> } | null = null;
  for (const c of sorted) {
    const now = Date.parse(c.at);
    for (const [w, seen] of red) if (now - Date.parse(seen) > SENSOR_GONE_MS) red.delete(w);
    if (c.workflows) {
      for (const [w, isRed] of Object.entries(c.workflows)) {
        if (isRed) red.set(w, c.done);
        else red.delete(w);
      }
      // A spell opened by an old-format commit names no workflow, so nothing
      // but an all-green commit can close it, exactly as before.
      if (!c.red) red.delete(LEGACY);
    } else if (c.red) {
      red.set(LEGACY, c.done);
    } else {
      red.clear();
    }
    if (red.size > 0) {
      open ??= { sha: c.sha, opened: c.done, workflows: new Set() };
      for (const w of red.keys()) open.workflows.add(w);
    } else if (open) {
      out.push({ ...open, workflows: [...open.workflows].sort(), closed: c.done });
      open = null;
    }
  }
  if (open) out.push({ ...open, workflows: [...open.workflows].sort(), closed: null });
  return out;
}
