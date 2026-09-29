import { gte, valid } from 'semver';
import { SERVER_VERSION, IS_DEV_BUILD } from '../../lib/version.js';
import { logger } from '../../lib/logger.js';

/** The DorkOS build an extension's `minHostVersion` is checked against. */
export interface HostVersion {
  /** The running server's version, e.g. `0.88.0`. */
  version: string;
  /**
   * Whether this is a development build (`0.0.0-*`, run from source). A dev
   * build is built from the newest source, so it satisfies any minimum.
   */
  isDevBuild: boolean;
}

/** The running server's own version, from {@link SERVER_VERSION}. */
export const RUNNING_HOST_VERSION: HostVersion = {
  version: SERVER_VERSION,
  isDevBuild: IS_DEV_BUILD,
};

/**
 * Whether a host satisfies an extension's `minHostVersion`.
 *
 * - No minimum: always compatible.
 * - A development build: always compatible, since it runs the newest source.
 * - A host version that is not semver (a mistyped `DORKOS_VERSION_OVERRIDE`,
 *   say): incompatible, with one warning naming the bad version. Loading
 *   every extension whatever it needs would hide the mistake; refusing only
 *   extensions that ask for a minimum makes it visible on their cards.
 * - A minimum that is not semver: incompatible, since it cannot be satisfied.
 *
 * @param minHostVersion - The manifest's `minHostVersion`, if any.
 * @param host - The host to check; defaults to the running server.
 * @returns `true` when the extension may load on this host.
 */
export function satisfiesMinHostVersion(
  minHostVersion: string | undefined,
  host: HostVersion = RUNNING_HOST_VERSION
): boolean {
  if (!minHostVersion) return true;
  if (host.isDevBuild) return true;
  if (!valid(host.version)) {
    warnUnreadableHostVersion(host.version);
    return false;
  }
  if (!valid(minHostVersion)) return false;
  return gte(host.version, minHostVersion);
}

let warnedHostVersion: string | null = null;

/** Log once per bad host version, so a mistyped override is visible without flooding the log. */
function warnUnreadableHostVersion(version: string): void {
  if (warnedHostVersion === version) return;
  warnedHostVersion = version;
  logger.warn(
    `[Extensions] DorkOS version "${version}" is not a version number, so extensions that need a minimum DorkOS version will not load. Check DORKOS_VERSION_OVERRIDE.`
  );
}
