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
  UpdateOptions,
  UpdateResult,
  InstalledPackage,
  MarketplaceSource,
  AddSourceInput,
} from '@dorkos/shared/marketplace-schemas';
import { fetchJSON, buildQueryString } from './http-client';

/** Create all Marketplace methods bound to a base URL. */
export function createMarketplaceMethods(baseUrl: string) {
  return {
    // --- Browse / discovery ---

    listMarketplacePackages(filter?: PackageFilter): Promise<AggregatedPackage[]> {
      const qs = buildQueryString({
        type: filter?.type,
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

    // --- Update ---

    updateMarketplacePackage(name: string, opts?: UpdateOptions): Promise<UpdateResult> {
      return fetchJSON<UpdateResult>(
        baseUrl,
        `/marketplace/packages/${encodeURIComponent(name)}/update`,
        {
          method: 'POST',
          body: JSON.stringify(opts ?? {}),
        }
      );
    },

    // --- Installed packages ---

    listInstalledPackages(): Promise<InstalledPackage[]> {
      return fetchJSON<{ packages: InstalledPackage[] }>(baseUrl, '/marketplace/installed').then(
        (r) => r.packages
      );
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

    removeMarketplaceSource(name: string): Promise<void> {
      return fetchJSON<void>(baseUrl, `/marketplace/sources/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
    },
  };
}
