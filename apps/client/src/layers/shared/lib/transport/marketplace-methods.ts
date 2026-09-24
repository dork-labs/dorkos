/**
 * Marketplace Transport methods factory.
 *
 * Wraps the `/api/marketplace/*` HTTP API (spec 02) with typed fetch calls.
 * All package name segments are `encodeURIComponent`'d because marketplace
 * package names follow the npm convention and may contain `/` (e.g. `@org/name`).
 *
 * @module shared/lib/transport/marketplace-methods
 */
import type {
  AggregatedPackage,
  PackageFilter,
  MarketplacePackageDetail,
  InstallOptions,
  InstallResult,
  UninstallOptions,
  UninstallResult,
  ApplyUpdatesOptions,
  InstallationUpdatesResult,
  InstalledPackage,
  MarketplaceSource,
  AddSourceInput,
} from '@dorkos/shared/marketplace-schemas';
import { fetchJSON, fetchNoContent, buildQueryString } from './http-client';

/** Create all Marketplace methods bound to a base URL. */
export function createMarketplaceMethods(baseUrl: string) {
  return {
    // --- Browse / discovery ---

    listMarketplacePackages(filter?: PackageFilter): Promise<AggregatedPackage[]> {
      const qs = buildQueryString({
        marketplace: filter?.marketplace,
        q: filter?.q,
      });
      return fetchJSON<{ packages: AggregatedPackage[] }>(
        baseUrl,
        `/marketplace/packages${qs}`
      ).then((r) => r.packages);
    },

    getMarketplacePackage(name: string, marketplace?: string): Promise<MarketplacePackageDetail> {
      const qs = buildQueryString({ marketplace });
      return fetchJSON<MarketplacePackageDetail>(
        baseUrl,
        `/marketplace/packages/${encodeURIComponent(name)}${qs}`
      );
    },

    // --- Preview ---

    previewMarketplacePackage(
      name: string,
      opts?: InstallOptions
    ): Promise<MarketplacePackageDetail> {
      return fetchJSON<MarketplacePackageDetail>(
        baseUrl,
        `/marketplace/packages/${encodeURIComponent(name)}/preview`,
        {
          method: 'POST',
          body: JSON.stringify(opts ?? {}),
        }
      );
    },

    // --- Install ---

    installMarketplacePackage(name: string, opts?: InstallOptions): Promise<InstallResult> {
      return fetchJSON<InstallResult>(
        baseUrl,
        `/marketplace/packages/${encodeURIComponent(name)}/install`,
        {
          method: 'POST',
          body: JSON.stringify(opts ?? {}),
        }
      );
    },

    // --- Uninstall ---

    uninstallMarketplacePackage(name: string, opts?: UninstallOptions): Promise<UninstallResult> {
      return fetchJSON<UninstallResult>(
        baseUrl,
        `/marketplace/packages/${encodeURIComponent(name)}/uninstall`,
        {
          method: 'POST',
          body: JSON.stringify(opts ?? {}),
        }
      );
    },

    // --- Updates ---

    checkMarketplaceUpdates(projectPath?: string): Promise<InstallationUpdatesResult> {
      const qs = buildQueryString({ projectPath });
      return fetchJSON<InstallationUpdatesResult>(baseUrl, `/marketplace/updates${qs}`);
    },

    applyMarketplaceUpdates(opts: ApplyUpdatesOptions): Promise<InstallationUpdatesResult> {
      // `apply: true` is the route's literal switch: a POST without it is
      // refused, so an empty or mistyped body can never reinstall anything.
      return fetchJSON<InstallationUpdatesResult>(baseUrl, '/marketplace/updates', {
        method: 'POST',
        body: JSON.stringify({ apply: true, ...opts }),
      });
    },

    // --- Installed packages ---

    listInstalledPackages(projectPath?: string): Promise<InstalledPackage[]> {
      const params = projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : '';
      return fetchJSON<{ packages: InstalledPackage[] }>(
        baseUrl,
        `/marketplace/installed${params}`
      ).then((r) => r.packages);
    },

    listPackageInstallations(name: string): Promise<InstalledPackage[]> {
      return fetchJSON<{ installations: InstalledPackage[] }>(
        baseUrl,
        `/marketplace/installed/${encodeURIComponent(name)}`
      ).then((r) => r.installations);
    },

    // --- Sources ---

    listMarketplaceSources(): Promise<MarketplaceSource[]> {
      return fetchJSON<{ sources: MarketplaceSource[] }>(baseUrl, '/marketplace/sources').then(
        (r) => r.sources
      );
    },

    addMarketplaceSource(input: AddSourceInput): Promise<MarketplaceSource> {
      return fetchJSON<MarketplaceSource>(baseUrl, '/marketplace/sources', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    /**
     * The route answers 204, so there is no body to read back — `fetchJSON`
     * would reject a request that in fact succeeded with a JSON parse error.
     */
    removeMarketplaceSource(name: string): Promise<void> {
      return fetchNoContent(baseUrl, `/marketplace/sources/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
    },
  };
}
