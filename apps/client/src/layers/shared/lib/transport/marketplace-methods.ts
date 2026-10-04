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
  ListInstalledOptions,
  CheckFilesOptions,
  CheckFilesResult,
  KeepFilesOptions,
  KeepFilesResult,
  HeldBackPackage,
  DevLinkCreateInput,
  DevLinkListing,
  DevLinkPreviewInput,
  DevLinkPreviewResponse,
  DevLinkScopeInput,
  DevLinkStatus,
  DevUnlinkResult,
  UninstallResult,
  ApplyUpdatesOptions,
  InstallationUpdatesResult,
  InstalledPackage,
  AddSourceInput,
  AddedMarketplaceSource,
  ListedMarketplaceSource,
  RefreshedMarketplaceSource,
} from '@dorkos/shared/marketplace-schemas';
import type { CapabilityApprovalRequired, DevLinkCreateResult } from '@dorkos/shared/transport';
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

    async applyMarketplaceUpdates({
      targets,
      projectPath,
    }: ApplyUpdatesOptions): Promise<InstallationUpdatesResult> {
      // `apply: true` is the route's literal switch: a POST without it is
      // refused, so an empty or mistyped body can never reinstall anything.
      // Each target carries what the person was shown, sent back untouched.
      const result = await fetchJSON<InstallationUpdatesResult | { status: string }>(
        baseUrl,
        '/marketplace/updates',
        {
          method: 'POST',
          body: JSON.stringify({
            apply: true,
            targets,
            ...(projectPath !== undefined && { projectPath }),
          }),
        }
      );
      // A 202 is the answer for an agent, whose update waits on an approval
      // card. The app is the person, so it should never get one; if it does,
      // say so rather than hand back a result with nothing in it.
      if (!('checks' in result)) {
        throw new Error('These updates wait for approval. Nothing changed.');
      }
      return result;
    },

    async reviewHeldBackPackage(name: string): Promise<void> {
      await fetchJSON<{ status: string }>(
        baseUrl,
        `/marketplace/held-back/${encodeURIComponent(name)}/review`,
        { method: 'POST' }
      );
    },

    // --- Dev links (DOR-2696) ---

    listDevLinks(): Promise<DevLinkListing> {
      return fetchJSON<DevLinkListing>(baseUrl, '/marketplace/dev-links');
    },

    previewDevLink(input: DevLinkPreviewInput): Promise<DevLinkPreviewResponse> {
      return fetchJSON<DevLinkPreviewResponse>(baseUrl, '/marketplace/dev-links/preview', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    async linkDevLink(input: DevLinkCreateInput): Promise<DevLinkCreateResult> {
      // `fetchJSON` treats `201` and `202` alike (`res.ok`), so the two
      // outcomes are told apart by the body: the tier gate's `202` carries
      // `status: 'approval_required'`, a made link never has a `status`.
      const body = await fetchJSON<DevLinkStatus | CapabilityApprovalRequired>(
        baseUrl,
        '/marketplace/dev-links',
        { method: 'POST', body: JSON.stringify(input) }
      );
      return 'status' in body && body.status === 'approval_required'
        ? { status: 'approval_required', approval: body }
        : { status: 'linked', link: body as DevLinkStatus };
    },

    unlinkDevLink(name: string, input: DevLinkScopeInput): Promise<DevUnlinkResult> {
      return fetchJSON<DevUnlinkResult>(
        baseUrl,
        `/marketplace/dev-links/${encodeURIComponent(name)}/unlink`,
        { method: 'POST', body: JSON.stringify(input) }
      );
    },

    // --- Installed packages ---

    listInstalledPackages(
      projectPath?: string,
      opts?: ListInstalledOptions
    ): Promise<InstalledPackage[]> {
      const qs = buildQueryString({ projectPath, verify: opts?.verify ? 'true' : undefined });
      return fetchJSON<{ packages: InstalledPackage[] }>(
        baseUrl,
        `/marketplace/installed${qs}`
      ).then((r) => r.packages);
    },

    checkPackageFiles(name: string, opts?: CheckFilesOptions): Promise<CheckFilesResult> {
      return fetchJSON<CheckFilesResult>(
        baseUrl,
        `/marketplace/packages/${encodeURIComponent(name)}/check-files`,
        { method: 'POST', body: JSON.stringify(opts ?? {}) }
      );
    },

    keepPackageFiles(name: string, opts: KeepFilesOptions): Promise<KeepFilesResult> {
      return fetchJSON<KeepFilesResult>(
        baseUrl,
        `/marketplace/packages/${encodeURIComponent(name)}/keep-files`,
        { method: 'POST', body: JSON.stringify(opts) }
      );
    },

    listHeldBackPackages(): Promise<HeldBackPackage[]> {
      return fetchJSON<{ packages: HeldBackPackage[] }>(baseUrl, '/marketplace/held-back').then(
        (r) => r.packages
      );
    },

    listPackageInstallations(name: string): Promise<InstalledPackage[]> {
      return fetchJSON<{ installations: InstalledPackage[] }>(
        baseUrl,
        `/marketplace/installed/${encodeURIComponent(name)}`
      ).then((r) => r.installations);
    },

    // --- Sources ---

    listMarketplaceSources(): Promise<ListedMarketplaceSource[]> {
      return fetchJSON<{ sources: ListedMarketplaceSource[] }>(
        baseUrl,
        '/marketplace/sources'
      ).then((r) => r.sources);
    },

    addMarketplaceSource(input: AddSourceInput): Promise<AddedMarketplaceSource> {
      return fetchJSON<AddedMarketplaceSource>(baseUrl, '/marketplace/sources', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    refreshMarketplaceSource(name: string): Promise<RefreshedMarketplaceSource> {
      return fetchJSON<RefreshedMarketplaceSource>(
        baseUrl,
        `/marketplace/sources/${encodeURIComponent(name)}/refresh`,
        { method: 'POST' }
      );
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
