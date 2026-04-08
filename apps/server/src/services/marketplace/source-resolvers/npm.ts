/**
 * npm source resolver — STUB.
 *
 * Full implementation is tracked in spec marketplace-06-npm-sources. The
 * `@dorkos/marketplace` schema recognizes npm sources so a Direction B test
 * marketplace can be parsed, but install attempts surface a structured
 * deferred error that the orchestrator catches and reports to the user
 * without entering the transaction lifecycle.
 *
 * @module services/marketplace/source-resolvers/npm
 */
import type { ResolvedSourceDescriptor } from '@dorkos/marketplace';
import type { FetchedPackage, FetchPackageOptions } from '../package-fetcher.js';

/**
 * Structured error thrown by {@link npmResolver} so the install orchestrator
 * can surface a clean "this source type is not yet supported" message rather
 * than a generic resolver failure.
 */
export class NpmSourceNotSupportedError extends Error {
  /** The npm package name from the source descriptor. */
  readonly package: string;
  /** Optional version specifier from the source descriptor. */
  readonly version?: string;
  /** URL of the public docs page describing the deferred status. */
  readonly docs: string;

  constructor(opts: { package: string; version?: string; message: string; docs: string }) {
    super(opts.message);
    this.name = 'NpmSourceNotSupportedError';
    this.package = opts.package;
    this.version = opts.version;
    this.docs = opts.docs;
  }
}

/**
 * Throw a structured deferred error indicating that npm sources are not
 * yet supported in this DorkOS release. Does not touch the filesystem or
 * network — pure error construction.
 *
 * @param resolved - Resolved npm source descriptor.
 * @param _opts - Original {@link FetchPackageOptions} (unused).
 * @throws {NpmSourceNotSupportedError} always.
 */
export async function npmResolver(
  resolved: Extract<ResolvedSourceDescriptor, { type: 'npm' }>,
  _opts: FetchPackageOptions
): Promise<FetchedPackage> {
  throw new NpmSourceNotSupportedError({
    package: resolved.package,
    version: resolved.version,
    message:
      `npm sources (${resolved.package}) are not yet supported in this DorkOS version. ` +
      `Full npm install pipeline is tracked in spec marketplace-06-npm-sources. ` +
      `See https://docs.dorkos.ai/marketplace/source-types#npm for the roadmap.`,
    docs: 'https://docs.dorkos.ai/marketplace/source-types#npm',
  });
}
