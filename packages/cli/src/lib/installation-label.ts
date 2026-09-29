/**
 * How the package commands name one installation and its versions, so
 * `dorkos marketplace update`, `outdated` and `installed` print the same
 * package in the same place the same way.
 *
 * A package can be installed globally and on several agents at once, and each
 * is its own installation. A global one is printed bare; any other carries its
 * place (the agent's name, else the project path), so two installations of one
 * package never read as the same line.
 *
 * @module lib/installation-label
 */
import type {
  InstallationUpdateCheck,
  UpdateCheckResult,
  UpdateVersionSource,
} from '@dorkos/shared/marketplace-schemas';

/** Where an installation lives, as the server reports it on a listing row or a check. */
export interface InstallationPlace {
  /** The project directory holding a non-global installation. */
  agentPath?: string;
  /** Registered agent display name owning `agentPath`, when known. */
  agentName?: string;
}

/** A check as the package commands print it: any check, with its place when it has one. */
export type PrintableCheck = UpdateCheckResult & Partial<InstallationUpdateCheck>;

/**
 * An installation's place as a person reads it.
 *
 * @param place - The installation's place fields.
 * @returns The agent's name, else its project path, else `undefined` for a
 *   global installation.
 */
export function placeOf(place: InstallationPlace): string | undefined {
  return place.agentName ?? place.agentPath;
}

/**
 * A package's name as a line starts with: bare for a global installation, and
 * followed by its place in brackets for any other (`flow [Alpha]`).
 *
 * @param check - The check to label.
 * @returns The label.
 */
export function labelOf(check: PrintableCheck): string {
  const place = placeOf(check);
  return place ? `${check.packageName} [${place}]` : check.packageName;
}

/**
 * A version as a person reads it: a commit prints as `commit <short sha>`.
 *
 * @param version - The version string, or a full commit SHA.
 * @param source - Where the version came from.
 * @returns The printable version.
 */
export function formatVersion(version: string, source: UpdateVersionSource | undefined): string {
  return source === 'commit' ? `commit ${version.slice(0, 7)}` : version;
}

/**
 * The line for an `update-available` check:
 * `flow [Alpha]  0.7.2 → 0.7.3  (dorkos-community)`.
 *
 * @param check - A check whose status is `update-available`.
 * @returns The line, without a trailing newline.
 */
export function formatUpdateLine(check: PrintableCheck): string {
  const installed = formatVersion(check.installedVersion, check.installedVersionSource);
  const latest = formatVersion(check.latestVersion, check.latestVersionSource);
  const from = check.marketplace ? `  (${check.marketplace})` : '';
  return `${labelOf(check)}  ${installed} → ${latest}${from}`;
}
