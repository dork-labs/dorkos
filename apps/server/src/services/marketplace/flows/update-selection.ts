/**
 * Which installations an update request means: by name, by install path, or the
 * one a name means in one scope's view. Split from `update.ts`; every update
 * door narrows its scan through here before anything is checked.
 *
 * @module services/marketplace/flows/update-selection
 */
import { updateNameOf } from '../lib/install-roots.js';
import type { InstallationRecord } from '../installed-scanner.js';

/**
 * A requested package or installation is not installed anywhere the caller can
 * see: a name in no scope at all for the per-package route (which can see every
 * scope, while `UpdateFlow.run` answers "not installed in this scope"), or
 * a name or install path not among the installations in view for
 * {@link selectInstallations}. Both routes answer it as a 404 carrying the
 * unmatched names and paths as fields.
 */
export class PackageNotInstalledForUpdateError extends Error {
  /** Every package name that could not be found, in the order the caller gave them. */
  public readonly packageNames: string[];
  /** Every install path that could not be found, in the order the caller gave them. */
  public readonly installPaths: string[];

  /**
   * Build a `PackageNotInstalledForUpdateError`.
   *
   * @param names - The package name, or names, that could not be located.
   * @param installPaths - Install paths that matched no installation in view.
   */
  constructor(names: string | string[], installPaths: string[] = []) {
    const packageNames = typeof names === 'string' ? [names] : names;
    const parts = [
      packageNames.length > 0 &&
        `${packageNames.length === 1 ? 'Package' : 'Packages'} not installed: ${packageNames.join(', ')}`,
      installPaths.length > 0 && `No installation at: ${installPaths.join(', ')}`,
    ].filter(Boolean);
    super(parts.join('. '));
    this.name = 'PackageNotInstalledForUpdateError';
    this.packageNames = packageNames;
    this.installPaths = installPaths;
  }
}

/**
 * The name an installation is checked and applied under ({@link updateNameOf}):
 * its manifest name when that is a valid package name, else its directory name.
 *
 * @param record - A scanned installation.
 * @returns The installation's update name.
 */
export function installationUpdateName(record: InstallationRecord): string {
  return updateNameOf(record.package.name, record.package.installPath);
}

/** Which scanned installations to keep; an absent or empty list keeps them all. */
export interface InstallationSelector {
  /** Package names: every installation in view that goes by one of them. */
  names?: readonly string[];
  /**
   * Exact installations, by the `installPath` a check reported — what a
   * confirm step showed, so an apply touches exactly that.
   */
  installPaths?: readonly string[];
}

/**
 * Narrow scanned installations. A name matches every installation in view that
 * goes by it ({@link installationUpdateName}), so the same package in two scopes
 * is two installations; an install path matches exactly one. Given both, an
 * installation must match both.
 *
 * @param records - The installations one scan found.
 * @param selector - The names and install paths to keep.
 * @returns The matching installations, in scan order.
 * @throws {PackageNotInstalledForUpdateError} Naming every name and path that
 *   matched nothing in view, before anything is checked.
 */
export function selectInstallations(
  records: InstallationRecord[],
  selector: InstallationSelector = {}
): InstallationRecord[] {
  const names = selector.names?.length ? new Set(selector.names) : undefined;
  const paths = selector.installPaths?.length ? new Set(selector.installPaths) : undefined;
  const missingNames = names
    ? [...names].filter((n) => !records.some((r) => installationUpdateName(r) === n))
    : [];
  const missingPaths = paths
    ? [...paths].filter((p) => !records.some((r) => r.package.installPath === p))
    : [];
  if (missingNames.length > 0 || missingPaths.length > 0) {
    throw new PackageNotInstalledForUpdateError(missingNames, missingPaths);
  }
  return records.filter(
    (r) =>
      (!names || names.has(installationUpdateName(r))) &&
      (!paths || paths.has(r.package.installPath))
  );
}

/**
 * The installation a name means within one scope's view: the project's own
 * installation when there is one (it shadows the global package for that
 * project, even in another install root), else the first in scan order.
 *
 * @param records - One scope's view (`scanInstallationRecords`).
 * @param name - The package name, as the update check names it.
 * @returns The installation, or `undefined` when the name is not in view.
 */
export function pickInstallation(
  records: InstallationRecord[],
  name: string
): InstallationRecord | undefined {
  const named = records.filter((record) => installationUpdateName(record) === name);
  return named.find((record) => record.package.agentPath !== undefined) ?? named[0];
}
