/**
 * Build the one {@link InstallEvent} an install reports when it finishes.
 *
 * Kept apart from the dispatcher so what may leave this computer is decided in
 * one small place. The rule that matters: before the package is resolved, the
 * only name available is what the person typed, which can be a folder path
 * with their username in it, a private repository, or a URL carrying a token.
 * None of that is ever sent; an unresolved install reports a fixed placeholder
 * instead (DOR-4988). The same goes for a folder install, whose name is the
 * folder's name, and for the marketplace field, which is only ever a
 * configured marketplace's name.
 *
 * @module services/marketplace/telemetry/install-event
 */
import type { PackageType } from '@dorkos/marketplace';
import type { InstallTelemetrySourceType } from '@dorkos/shared/marketplace-install-telemetry';
import type { ResolvedPackageSource } from '../package-resolver.js';
import type { InstallEvent } from './telemetry-hook.js';

/** Marketplace label for a package installed straight from a git URL or a folder. */
export const DIRECT_SOURCE_LABEL = '<direct>';

/** Package name reported when an install failed before its package was resolved. */
export const UNRESOLVED_PACKAGE_LABEL = '<unresolved>';

/** Package name reported for a package installed from a folder on this computer. */
export const LOCAL_PACKAGE_LABEL = '<local>';

/** Error code reported when the real one does not look like an error class name. */
export const UNKNOWN_ERROR_CODE = 'UnknownError';

/** An error class name: a letter, then up to 63 letters, digits or underscores. */
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** What {@link buildInstallEvent} needs to know about a finished install. */
export interface InstallEventInput {
  /** The resolved package source, or `null` when resolving it failed. */
  resolved: ResolvedPackageSource | null;
  /** The staged manifest's type, or `null` when staging never got that far. */
  packageType: PackageType | null;
  /**
   * The marketplace the request named, ONLY once checked to be one this
   * install has configured. Free text a person typed must never be passed here.
   */
  configuredMarketplace?: string;
  /** The terminal outcome. */
  outcome: InstallEvent['outcome'];
  /** Wall-clock duration of the install in milliseconds. */
  durationMs: number;
  /** The error's class name when the install failed; anything else becomes `UnknownError`. */
  errorCode?: string;
}

/**
 * Build the install event from a finished install. Takes no request name on
 * purpose, so the typed input can never reach the event.
 *
 * @param input - What the install knew when it finished.
 */
export function buildInstallEvent(input: InstallEventInput): InstallEvent {
  const { resolved } = input;
  return {
    packageName: installPackageName(resolved),
    marketplace: resolved
      ? (resolved.marketplaceName ?? DIRECT_SOURCE_LABEL)
      : (input.configuredMarketplace ?? DIRECT_SOURCE_LABEL),
    type: input.packageType ?? 'plugin',
    outcome: input.outcome,
    durationMs: input.durationMs,
    errorCode:
      input.errorCode === undefined
        ? undefined
        : ERROR_CODE_PATTERN.test(input.errorCode)
          ? input.errorCode
          : UNKNOWN_ERROR_CODE,
    sourceType: installSourceType(resolved),
  };
}

/** The package name to report: a placeholder when unresolved or from a folder. */
function installPackageName(resolved: ResolvedPackageSource | null): string {
  if (!resolved) return UNRESOLVED_PACKAGE_LABEL;
  if (resolved.kind === 'local') return LOCAL_PACKAGE_LABEL;
  return resolved.packageName;
}

/**
 * The kind of source a package came from, for telemetry.
 *
 * - Unresolved: `unknown`, since nothing says where it would have come from.
 * - A folder on this computer: `local`.
 * - A direct git input (`github:user/repo` or `name@<url>`): `github` when the
 *   URL is on github.com, `url` otherwise. The shorthand expands to a plain
 *   URL source, so the host is the honest test.
 * - A marketplace entry: the form the entry declares, as the marketplace
 *   wrote it (a bare string is a `relative-path`).
 *
 * @param resolved - The resolved package source, or `null`.
 */
export function installSourceType(
  resolved: ResolvedPackageSource | null
): InstallTelemetrySourceType {
  if (!resolved) return 'unknown';
  if (resolved.kind === 'local') return 'local';
  const source = resolved.pluginSource;
  if (!source) return 'unknown';
  if (typeof source === 'string') return 'relative-path';
  if (resolved.kind === 'git' && source.source === 'url' && isGithubUrl(source.url)) {
    return 'github';
  }
  return source.source;
}

/** True when `url` is a github.com address. */
function isGithubUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'github.com' || host === 'www.github.com';
  } catch {
    return false;
  }
}
