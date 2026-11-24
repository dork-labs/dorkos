/**
 * The two snapshot facts `tracked.merged-to-released` joins (release-lead.ts):
 * the day's merge commits and what each of the day's releases shipped. Kept
 * out of data.ts, which holds every other snapshot schema, by its line limit.
 */
import { z } from 'zod';

/**
 * One merged PR's merge commit on the default branch, so a release that ships
 * the commit can be timed back to the merge (`tracked.merged-to-released`).
 */
export const MergeSchema = z
  .object({
    pr: z.number(),
    /** The merge commit, short (12). */
    sha: z.string(),
    /** The PR's `mergedAt`, not the commit's date: a queue build's commit is made 20 to 60 minutes before the merge. */
    at: z.string(),
  })
  .strict();
/** One merged PR's merge commit. */
export type Merge = z.infer<typeof MergeSchema>;

/**
 * One published release and the default-branch commits in its range: the
 * commits reachable from its tag and not from the release published before it,
 * plus the source of each `git cherry-pick -x` among them
 * (`tracked.merged-to-released`, `releaseContents` in release-lead.ts). The
 * release commit itself is left out: it is the release, not a change waiting
 * for one.
 */
export const ReleaseContentsSchema = z
  .object({
    tag: z.string(),
    published_at: z.string(),
    /** The release the range starts from; null when none was published before it, and then `shas` is empty. */
    base: z.string().nullable(),
    /** Short (12) SHAs. */
    shas: z.array(z.string()),
  })
  .strict();
/** One published release and the commits it shipped. */
export type ReleaseContents = z.infer<typeof ReleaseContentsSchema>;
