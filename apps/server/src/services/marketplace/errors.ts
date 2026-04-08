/**
 * Shared error classes for the marketplace install service.
 *
 * Re-exports the typed errors that originate in {@link
 * services/marketplace/package-resolver} so resolvers, fetchers, and
 * orchestrators can import them from a single barrel without creating
 * circular dependencies.
 *
 * @module services/marketplace/errors
 */
export {
  AmbiguousPackageError,
  MarketplaceNotFoundError,
  PackageNotFoundError,
} from './package-resolver.js';
