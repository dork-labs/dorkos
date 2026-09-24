/**
 * The sweep that gives legacy installs a record after boot (DOR-2197; spec
 * `marketplace-install-verification` §6).
 *
 * An install made before DOR-2245 has no installed-files record until its next
 * update or uninstall rebuilds one, and that rebuild guesses when it cannot
 * fetch the installed commit. This runs the strict rebuild
 * ({@link rebuildRecordStrict}) on every legacy install after boot instead,
 * one at a time, so most legacy installs have an exact record long before
 * anything needs one. An install it cannot rebuild (offline, installed from a
 * local folder, or edited) is left exactly as it was, and is retried at the
 * next boot or by the "Prepare" action.
 *
 * @module services/marketplace/lib/integrity/legacy-record-sweep
 */
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { INSTALLED_FILES_PATH } from '@dorkos/marketplace';
import { isInstallSiblingName } from '@dorkos/shared/marketplace-schemas';
import { installRootsUnder, projectScopeRoot } from '../install-roots.js';
import { hasPackageIdentity } from '../locate-install.js';
import { rebuildRecordStrict, type StrictRecordDeps } from './strict-record.js';

/** The install folders a sweep rebuilt, or could not, by reason. */
export interface LegacySweepSummary {
  /** Given a record. */
  rebuilt: string[];
  /** Their files differ from the installed commit, so nothing was written. */
  mismatch: string[];
  /** Nothing exact to fetch (installed from a local folder, or no commit recorded). */
  noSource: string[];
  /** The fetch failed, or the rebuild threw; retried next time. */
  fetchFailed: string[];
}

/**
 * The install roots a legacy sweep reads: `plugins/`, `agents/` and `shapes/`
 * under `dorkHome` and under each project's `.dork/`. Skills roots never hold
 * packages, so they are not listed.
 *
 * @param dorkHome - The resolved data directory.
 * @param projectPaths - Registered projects (and agent workspaces).
 */
export function legacySweepDirs(dorkHome: string, projectPaths: readonly string[]): string[] {
  const dirs = [
    ...installRootsUnder(dorkHome).map(({ dir }) => dir),
    ...projectPaths.flatMap((p) => installRootsUnder(projectScopeRoot(p)).map(({ dir }) => dir)),
  ];
  return [...new Set(dirs)];
}

/** Whether `p` exists, without following a final link. */
async function exists(p: string): Promise<boolean> {
  return (await lstat(p).catch(() => undefined)) !== undefined;
}

/** The legacy installs directly inside `dir`: real folders with a package identity and no record. */
async function legacyInstallsIn(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names.sort()) {
    if (isInstallSiblingName(name)) continue;
    const root = path.join(dir, name);
    const stats = await lstat(root).catch(() => undefined);
    if (!stats?.isDirectory()) continue;
    if (await exists(path.join(root, ...INSTALLED_FILES_PATH.split('/')))) continue;
    if (!(await hasPackageIdentity(root))) continue;
    found.push(root);
  }
  return found;
}

/**
 * Rebuild the record of every legacy install directly inside `dirs`, one at a
 * time. Never throws: a failure is logged and counted, and the sweep goes on.
 *
 * @param dirs - Install roots to read ({@link legacySweepDirs}); each is read once, not walked.
 * @param deps - The fetcher and a logger.
 * @returns Which installs were rebuilt, and which were not and why.
 */
export async function rebuildLegacyRecords(
  dirs: readonly string[],
  deps: StrictRecordDeps
): Promise<LegacySweepSummary> {
  const summary: LegacySweepSummary = { rebuilt: [], mismatch: [], noSource: [], fetchFailed: [] };
  for (const dir of dirs) {
    for (const root of await legacyInstallsIn(dir)) {
      try {
        const result = await rebuildRecordStrict(root, deps);
        switch (result.outcome) {
          case 'rebuilt':
            summary.rebuilt.push(root);
            break;
          case 'mismatch':
            summary.mismatch.push(root);
            deps.logger.info(
              `[marketplace/legacy-sweep] left ${root} without a record: ${result.differing.length} of its files differ from the version it was installed from`
            );
            break;
          case 'no-source':
            summary.noSource.push(root);
            break;
          case 'fetch-failed':
            summary.fetchFailed.push(root);
            deps.logger.info(
              `[marketplace/legacy-sweep] could not fetch the version ${root} was installed from: ${result.message}`
            );
            break;
          case 'not-needed':
            break;
        }
      } catch (err) {
        summary.fetchFailed.push(root);
        deps.logger.warn(
          `[marketplace/legacy-sweep] rebuilding the record of ${root} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
  return summary;
}
