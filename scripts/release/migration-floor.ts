/**
 * The release version must reach the newest config migration key.
 *
 * `conf` runs a `CONFIG_MIGRATIONS` key only when the app's version is at or
 * above it. A PR that adds `'0.143.0'` and a release that ships as `0.142.1`
 * means that migration silently runs for nobody; one release had to jump from
 * 0.66.0 to 0.73.0 to reach its keys. So the planned version is the higher of
 * the fragments' bump and the newest key above the last release.
 *
 * The newest key must be the next patch or the next minor after the last
 * release, the only keys the table's own rule opens (the key right above the
 * newest tag). Anything else is refused, not followed: it is almost surely a
 * typo, and following it would skip versions. An explicit `--version` is a
 * person's choice, so it may name any version at or above the newest key, and
 * is refused below it.
 *
 * Reads the release point's table as text (`migration-table.ts`) and
 * runs nothing from it.
 *
 * @module scripts/release/migration-floor
 */
import {
  MIGRATIONS_FILE,
  compareSemver,
  pendingKeys,
  readMigrationTable,
} from './migration-table.ts';
import { ReleaseCommitError } from './errors.ts';
import { parseVersion, type BumpDecision } from './fragments.ts';

/** The newest key still to run for someone on `previous`, or undefined when none is. */
export function newestPendingKey(migrationsText: string, previous: string): string | undefined {
  let entries;
  try {
    entries = readMigrationTable(migrationsText);
  } catch (error) {
    throw new ReleaseCommitError(
      `${MIGRATIONS_FILE} ${error instanceof Error ? error.message : String(error)}; the release cannot tell which migrations it must reach.`
    );
  }
  return pendingKeys(entries, previous).sort(compareSemver).at(-1);
}

/**
 * Raise `decision` to the newest pending key, or refuse. Returns the decision
 * unchanged when no key is pending or the bump already reaches it.
 */
export function applyMigrationFloor(
  decision: BumpDecision,
  previous: string,
  newest: string | undefined
): BumpDecision {
  if (newest === undefined) return decision;
  const withKey = { ...decision, migrationKey: newest };
  if (decision.bump === 'override') {
    if (compareSemver(decision.version, newest) >= 0) return withKey;
    throw new ReleaseCommitError(
      `--version ${decision.version} is below the newest config migration key, '${newest}', so that migration would never run.`
    );
  }
  const [major, minor, patch] = parseVersion(previous, '--previous');
  const nextPatch = `${major}.${minor}.${patch + 1}`;
  const nextMinor = `${major}.${minor + 1}.0`;
  if (newest !== nextPatch && newest !== nextMinor)
    throw new ReleaseCommitError(
      `${MIGRATIONS_FILE} has the key '${newest}', which is neither the next patch (${nextPatch}) nor the next minor (${nextMinor}) after ${previous}. It is almost surely a typo; fix it in a PR, or name the version with --version.`
    );
  if (compareSemver(decision.version, newest) >= 0) return withKey;
  // The fragments always reach the next patch, so a raise is to the next minor.
  return {
    ...withKey,
    bump: 'minor',
    reason: `the config migration key '${newest}' runs only from ${newest}, above the ${decision.version} the fragments call for (${decision.reason})`,
    version: newest,
    raisedFrom: decision.version,
  };
}
