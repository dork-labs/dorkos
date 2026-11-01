/**
 * The upgrade's half of the repo pin (DOR-3298): on the first start with the
 * repo settings check, pin every repo DorkOS already knew to the commit its
 * default branch points at, so a person's own projects don't all stop at once.
 * After that, a repo with no pinned commit waits for a person
 * (`repo-baseline.ts`).
 *
 * It runs once (`harness.repoBaselinesPinned`, operator-only, carried across
 * a config wipe), so an agent can't make DorkOS pin a repo it made later by
 * registering it, or by wiping the config. **Residual:** anything planted in
 * those repos before the upgrade was pinned with them.
 *
 * @module services/runtimes/claude-code/repo-settings/pin-repo-baselines
 */
import { logger } from '../../../../lib/logger.js';
import { firstBootSeedsMayRun } from '../accounts/first-boot-seed-guard.js';
import { pinRepoBaseline } from './repo-baseline.js';
import { markRepoBaselinesPinned, repoBaselinesPinned } from './repo-config-consent.js';
import { GitMissingError } from './repo-git.js';

/** The most folders pinned in one start; repos past it wait for a person. */
const MAX_FOLDERS = 500;

/**
 * Pin the repos of `folders`, once ever. Never throws: a folder that is gone
 * or isn't a repo is skipped. A list that can't be read, or git missing, pins
 * nothing and still counts as the one time, so a later start never pins the
 * repos registered in between: they wait for a person like any new repo.
 *
 * @param folders - The folders DorkOS knows: agent homes, projects, workspaces.
 * @returns How many repos it pinned.
 */
export async function pinKnownRepoBaselinesOnce(
  folders: () => Promise<Iterable<string>>
): Promise<number> {
  if (!firstBootSeedsMayRun() || repoBaselinesPinned()) return 0;
  let list: string[];
  try {
    list = [...new Set(await folders())].slice(0, MAX_FOLDERS);
  } catch (err) {
    logger.warn('[RepoConfig] Could not list the repos to pin; each will wait for a person', {
      error: err instanceof Error ? err.message : String(err),
    });
    markRepoBaselinesPinned();
    return 0;
  }
  let pinned = 0;
  for (const folder of list) {
    try {
      if (await pinRepoBaseline(folder)) pinned += 1;
    } catch (err) {
      if (err instanceof GitMissingError) break;
      // Gone, or not a repo: its repo waits for a person like any new one.
    }
  }
  markRepoBaselinesPinned();
  logger.info('[RepoConfig] Pinned the repos DorkOS already knew', { pinned });
  return pinned;
}
