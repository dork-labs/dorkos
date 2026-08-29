/**
 * What a room-repo fixture has to do to git so that deleting its own scratch
 * directory is not a race (DOR-1603).
 *
 * Every one of these suites builds a REAL repo in a temporary directory,
 * commits into it, and deletes the whole tree in `afterEach`. Twice on
 * 2026-08-28, on two unrelated PRs, that delete failed in CI with
 * `ENOTEMPTY: directory not empty, rmdir '<scratch>/.dork/rooms/<id>/repo/.git/objects/pack'`
 * — a directory `rm` had just emptied had something in it again a moment later.
 *
 * The writer is git itself, and it is not the process the test awaited.
 * Measured with `GIT_TRACE=1`, every `git commit` ends by spawning
 * `git maintenance run --auto --quiet --detach`: a DETACHED grandchild that
 * outlives the commit the test waited for. When its `gc` task decides there is
 * work to do it repacks — writing into `.git/objects/pack` — with no
 * relationship at all to where the test has got to. Reproduced deliberately
 * (force the gc, then delete the tree straight away) it fails exactly the way
 * CI did, and it stops failing when either belt below is applied.
 *
 * Two belts, because they close different halves:
 *
 * 1. {@link silenceGitAutoMaintenance} stops the detached process ever being
 *    spawned. It is the cause, so it is the one to fix.
 * 2. {@link removeFixtureTree} deletes anyway. `rm -rf` racing ANY concurrent
 *    writer has this failure shape, and belt 1 only covers the writer that has
 *    been identified.
 *
 * **Honest about what is proven:** the detached process is real and measured,
 * and it produces this exact error when it repacks. What is NOT established is
 * that git's default auto threshold (`gc.auto`, 6700 loose objects) was crossed
 * on the CI runner — the 500-file fixture makes ~504 loose objects, which is
 * well under it. So belt 1 removes the only detached writer anyone has found,
 * and belt 2 is what actually guarantees the teardown against whatever else may
 * be holding that directory open.
 *
 * @module server/services/rooms/repo/__tests__/fixture-git
 */
import { rm } from 'node:fs/promises';
import { vi } from 'vitest';

/**
 * Run every git command this test spawns with automatic background maintenance
 * turned off.
 *
 * Call it from `beforeEach`, before anything creates a repo.
 *
 * **Why the environment rather than `git config` in the repo.** A fixture can
 * only configure the repos it makes itself, and these suites do not make all of
 * theirs: `initRepo` and `RoomRepoService.enable` create repos from inside the
 * production code under test, so there is no moment at which the fixture could
 * reach them. `GIT_CONFIG_COUNT` and its `KEY`/`VALUE` pairs are read by every
 * git process in the tree — the detached maintenance child included — and
 * `room-repo-git.ts` builds its child environment from `process.env`, keeping
 * them. A belt that covered only the repos the fixture happened to build itself
 * would be a belt with a hole in it.
 *
 * `maintenance.auto=false` is the one that matters: measured, it stops
 * `git commit` spawning the background process at all. `gc.auto=0` is the
 * second line, for any path that reaches `git gc --auto` another way.
 *
 * The values are stubbed rather than assigned, so vitest unwinds them even if a
 * test throws; a suite that also calls `vi.unstubAllEnvs()` mid-test gets them
 * back from its own next `beforeEach`.
 */
export function silenceGitAutoMaintenance(): void {
  vi.stubEnv('GIT_CONFIG_COUNT', '2');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'maintenance.auto');
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'false');
  vi.stubEnv('GIT_CONFIG_KEY_1', 'gc.auto');
  vi.stubEnv('GIT_CONFIG_VALUE_1', '0');
}

/**
 * Delete a fixture's scratch tree, tolerating a directory something else is
 * still writing into.
 *
 * `maxRetries` re-reads the directory and retries the `rmdir` rather than
 * failing the test on the first `ENOTEMPTY` — which is what a plain
 * `rm(dir, { recursive: true, force: true })` does. Three attempts 200ms apart
 * is far longer than the sub-second window a detached git process occupies, and
 * it costs nothing at all when there is no race, which is every ordinary run.
 *
 * @param dir - The scratch directory to remove.
 */
export async function removeFixtureTree(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
