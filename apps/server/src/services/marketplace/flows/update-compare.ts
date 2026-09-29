/**
 * How one installed package compares with what installing it now would give,
 * by Claude Code's version chain, and the shapes a check result takes. Pure
 * functions, split from `update.ts` so the flow module holds only the
 * orchestrator.
 *
 * @module services/marketplace/flows/update-compare
 */
import { gt as semverGt, valid as semverValid } from 'semver';
import {
  isRealCommitSha,
  resolvePackageVersion,
  type ResolvedPackageVersion,
} from '@dorkos/marketplace';
import type { LatestResolution } from '../types.js';
import type { InstallationRecord } from '../installed-scanner.js';
import type { InstallationUpdateCheck, UpdateCheckResult } from './update-types.js';

/** The note on a check whose installed side names no version at all. */
const INSTALLED_UNKNOWN_NOTE = 'reinstall this package to enable update checks';

/**
 * Compare an installed package with what installing it now would give, by
 * Claude Code's chain, in order:
 *
 * 1. `unresolved` → unknown, with the reason.
 * 2. The installed side names no version, entry version or real commit →
 *    unknown (file:// marketplaces, pre-DOR-147 sidecars, placeholder SHAs).
 * 3. `unchanged` → current.
 * 4. The latest side names nothing → unknown.
 * 5. Both are versions (`package` or `index`) and both valid semver → an
 *    update only when the latest is strictly newer; a lower one is current
 *    with a rollback note, never offered as an "update".
 * 6. Both are versions but one is not semver → an update when they differ.
 * 7. Either is a commit → an update when they differ, as Claude Code does for
 *    a package that declares no version.
 *
 * @internal
 */
export function compareVersions(
  packageName: string,
  marketplace: string,
  installed: ResolvedPackageVersion | undefined,
  latest: LatestResolution
): UpdateCheckResult {
  if (latest.kind === 'unresolved') return unknownCheck(packageName, installed, latest.reason);
  // `unchanged` needs a real recorded commit, so its installed side is always
  // known; checking this first only keeps the types honest.
  if (!installed) return unknownCheck(packageName, installed, INSTALLED_UNKNOWN_NOTE);
  if (latest.kind === 'unchanged') {
    return knownCheck(packageName, marketplace, installed, installed, 'current');
  }

  const latestVersion = resolvePackageVersion(latest);
  if (!latestVersion) {
    return unknownCheck(packageName, installed, "couldn't tell which version the marketplace has");
  }

  const bothVersions = installed.source !== 'commit' && latestVersion.source !== 'commit';
  if (bothVersions && semverValid(installed.version) && semverValid(latestVersion.version)) {
    if (semverGt(latestVersion.version, installed.version)) {
      return knownCheck(packageName, marketplace, installed, latestVersion, 'update-available');
    }
    const check = knownCheck(packageName, marketplace, installed, latestVersion, 'current');
    if (semverGt(installed.version, latestVersion.version)) {
      check.note =
        `rollback: the marketplace has ${latestVersion.version}, older than the installed ` +
        `${installed.version}; a downgrade is never offered as an update`;
    }
    return check;
  }

  const status = latestVersion.version !== installed.version ? 'update-available' : 'current';
  return knownCheck(packageName, marketplace, installed, latestVersion, status);
}

/** The install's recorded commit, when it is a real one. @internal */
export function realCommitOf(record: InstallationRecord): string | undefined {
  const sha = record.metadata?.commitSha;
  return isRealCommitSha(sha) ? sha : undefined;
}

/** The installed side of Claude Code's version chain, from one scanned record. @internal */
export function installedVersionOf(record: InstallationRecord): ResolvedPackageVersion | undefined {
  return resolvePackageVersion({
    declaredVersion: record.declaredVersion,
    entryVersion: record.metadata?.entryVersion,
    commitSha: realCommitOf(record),
  });
}

/** A check whose both sides are known. @internal */
function knownCheck(
  packageName: string,
  marketplace: string,
  installed: ResolvedPackageVersion,
  latest: ResolvedPackageVersion,
  status: 'current' | 'update-available'
): UpdateCheckResult {
  return {
    packageName,
    installedVersion: installed.version,
    latestVersion: latest.version,
    hasUpdate: status === 'update-available',
    marketplace,
    status,
    installedVersionSource: installed.source,
    latestVersionSource: latest.source,
  };
}

/** A check that could not be answered, and why. @internal */
export function unknownCheck(
  packageName: string,
  installed: ResolvedPackageVersion | undefined,
  note: string
): UpdateCheckResult {
  return {
    packageName,
    installedVersion: installed?.version ?? '',
    latestVersion: '',
    hasUpdate: false,
    marketplace: '',
    status: 'unknown',
    ...(installed && { installedVersionSource: installed.source }),
    note,
  };
}

/** The one result for a named package missing from the requested scope. @internal */
export function notInScope(packageName: string): UpdateCheckResult {
  return unknownCheck(packageName, undefined, 'not installed in this scope');
}

/** Join two optional notes into one sentence list. @internal */
export function joinNotes(first: string, second: string | undefined): string {
  return second ? `${first}; ${second}` : first;
}

/**
 * A check plus the installation it belongs to, in the installed list's own
 * field names so `installPath` joins the two. @internal
 */
export function withIdentity(
  check: UpdateCheckResult,
  installed: InstallationRecord['package']
): InstallationUpdateCheck {
  return {
    ...check,
    installPath: installed.installPath,
    type: installed.type,
    scope: installed.scope ?? 'global',
    ...(installed.agentPath !== undefined && { agentPath: installed.agentPath }),
    ...(installed.agentId !== undefined && { agentId: installed.agentId }),
    ...(installed.agentName !== undefined && { agentName: installed.agentName }),
    ...(installed.linked && { linked: true as const }),
  };
}
