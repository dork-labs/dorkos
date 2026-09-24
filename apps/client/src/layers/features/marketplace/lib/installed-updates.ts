/**
 * Joins the Installed view's rows to the update check, by installation.
 *
 * The installed list and the check both carry one entry per installation,
 * keyed by `installPath`: a package installed globally and on two agents is
 * three rows and three checks, each with its own answer. Everything here is
 * pure, so the view, the tab count and the confirm step agree by construction.
 *
 * @module features/marketplace/lib/installed-updates
 */
import type {
  InstallationUpdateCheck,
  InstalledPackage,
  PackageScope,
  UpdateVersionSource,
} from '@dorkos/shared/marketplace-schemas';

/** Where one row stands with respect to updates. */
export type RowUpdateState =
  /** A check request is in flight: pending, never a failure. */
  | { kind: 'checking' }
  /** This installation is being reinstalled right now. */
  | { kind: 'applying'; check?: InstallationUpdateCheck }
  | { kind: 'update-available'; check: InstallationUpdateCheck }
  | { kind: 'current'; check: InstallationUpdateCheck }
  /** The check could not answer; `check.note` says why. */
  | { kind: 'unknown'; check: InstallationUpdateCheck }
  /** No answer for this row: the check failed, or the row is newer than it. */
  | { kind: 'unchecked' };

/** What is in flight right now, for {@link rowUpdateState}. */
export interface RowUpdateFlags {
  /** A check request is running. */
  isChecking: boolean;
  /** Every installation an apply is updating right now. */
  applying: ReadonlySet<string>;
}

/**
 * One installation with something to install: the row as listed (its name is
 * the one every label uses) and the check that found the newer version.
 */
export interface StaleInstallation {
  installation: InstalledPackage;
  check: InstallationUpdateCheck;
}

/** The update picture across the rows in view. */
export interface UpdatesSummary {
  /** Stale installations still in the list, in list order: what "Update all" offers. */
  available: StaleInstallation[];
  /** Installations the check found up to date. */
  current: number;
  /** Installations the check could not answer for. */
  unknown: number;
}

/**
 * Index checks by the installation they answer for.
 *
 * @param checks - The check's answer, or `undefined` before there is one.
 */
export function indexChecks(
  checks?: readonly InstallationUpdateCheck[]
): Map<string, InstallationUpdateCheck> {
  return new Map((checks ?? []).map((check) => [check.installPath, check]));
}

/** A version as written, without a leading `v`, for comparing two spellings. */
function bareVersion(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version;
}

/**
 * The row's check, if it still describes what the row lists.
 *
 * A check answers for the version installed when it ran. If the package was
 * updated since (from the CLI, an agent, another window), the listed version
 * moved on and the old answer would offer an update that already happened, so
 * it no longer counts. Only a declared version (`installedVersionSource:
 * 'package'`) is the listing's own version; a marketplace entry's version or a
 * commit is not what the list shows, so those checks cannot be compared and
 * stand until the next check.
 *
 * @param pkg - The row.
 * @param checks - The check's answer, indexed by {@link indexChecks}.
 */
export function currentCheckFor(
  pkg: InstalledPackage,
  checks: ReadonlyMap<string, InstallationUpdateCheck>
): InstallationUpdateCheck | undefined {
  const check = checks.get(pkg.installPath);
  if (!check) return undefined;
  if (check.installedVersionSource !== 'package') return check;
  return bareVersion(check.installedVersion) === bareVersion(pkg.version) ? check : undefined;
}

/**
 * Where one row stands. An installation being reinstalled says so first; any
 * other row reads as pending while a check is running (an earlier answer may
 * be out of date, and a check can wait behind another scan); otherwise the
 * row's own check decides ({@link currentCheckFor}), and a row with no check
 * that still describes it is `unchecked`, never current.
 *
 * @param pkg - The row.
 * @param checks - The check's answer, indexed by {@link indexChecks}.
 * @param flags - What is in flight.
 */
export function rowUpdateState(
  pkg: InstalledPackage,
  checks: ReadonlyMap<string, InstallationUpdateCheck>,
  flags: RowUpdateFlags
): RowUpdateState {
  const check = currentCheckFor(pkg, checks);
  if (flags.applying.has(pkg.installPath)) return { kind: 'applying', check };
  if (flags.isChecking) return { kind: 'checking' };
  if (!check) return { kind: 'unchecked' };
  return { kind: check.status, check };
}

/**
 * Count where the listed installations stand. Only rows still in the list,
 * with a check that still describes them ({@link currentCheckFor}), count, so
 * an uninstalled or since-updated package drops out as soon as the list
 * refreshes, with no new check.
 *
 * @param installed - The rows, in the order they are shown.
 * @param checks - The check's answer, indexed by {@link indexChecks}.
 */
export function summarizeUpdates(
  installed: readonly InstalledPackage[],
  checks: ReadonlyMap<string, InstallationUpdateCheck>
): UpdatesSummary {
  const summary: UpdatesSummary = { available: [], current: 0, unknown: 0 };
  for (const pkg of installed) {
    const check = currentCheckFor(pkg, checks);
    if (check?.status === 'update-available') summary.available.push({ installation: pkg, check });
    else if (check?.status === 'current') summary.current += 1;
    else if (check?.status === 'unknown') summary.unknown += 1;
  }
  return summary;
}

/** How many characters of a commit identify it to a person. */
const SHORT_COMMIT_LENGTH = 7;

/**
 * A check's version as a person reads it: `v1.2.0`, or a seven-character
 * commit for a package whose version is the commit it was fetched at.
 *
 * @param version - The version or full commit SHA.
 * @param source - Where the version came from; `commit` means a SHA.
 */
export function formatCheckVersion(version: string, source?: UpdateVersionSource): string {
  if (source === 'commit') return version.slice(0, SHORT_COMMIT_LENGTH);
  return version.startsWith('v') ? version : `v${version}`;
}

/**
 * The place a non-global installation lives, for labels: the agent's name,
 * else its project folder's name. A global installation has no place of its
 * own (`null`); callers say "All agents" or nothing.
 *
 * @param installation - Any installation-shaped value (a row or a check).
 */
export function installationPlace(installation: {
  scope?: PackageScope;
  agentName?: string;
  agentPath?: string;
}): string | null {
  if (installation.scope !== 'agent-local' && installation.scope !== 'override') return null;
  return (
    installation.agentName ?? installation.agentPath?.split('/').filter(Boolean).pop() ?? 'agent'
  );
}
