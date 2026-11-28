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
import { fetchAllPages, fetchJSON, fetchNoContent, buildQueryString } from './http-client';

// The five marketplace lists come in pages (DOR-4982); the app shows each
// whole, so these read every page, in the list's own order.

/** Create all Marketplace methods bound to a base URL. */
export function createMarketplaceMethods(baseUrl: string) {
  return {
    // --- Browse / discovery ---

    async listMarketplacePackages(filter?: PackageFilter): Promise<AggregatedPackage[]> {
      type Page = { packages: AggregatedPackage[]; nextCursor: string | null };
      const params = { marketplace: filter?.marketplace, q: filter?.q };
      const path = '/marketplace/packages';
      const { rows } = await fetchAllPages(baseUrl, path, params, (p: Page) => p.packages);
      return rows;
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

    async listDevLinks(): Promise<DevLinkListing> {
      type Page = DevLinkListing & { nextCursor: string | null };
      const path = '/marketplace/dev-links';
      const { first, rows } = await fetchAllPages(baseUrl, path, {}, (p: Page) => p.links);
      const { nextCursor: _next, ...listing } = first;
      return { ...listing, links: rows };
    },

    previewDevLink(input: DevLinkPreviewInput): Promise<DevLinkPreviewResponse> {
      return fetchJSON<DevLinkPreviewResponse>(baseUrl, '/marketplace/dev-links/previews', {
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
      const qs = buildQueryString({ scope: input.scope, projectPath: input.projectPath });
      return fetchJSON<DevUnlinkResult>(
        baseUrl,
        `/marketplace/dev-links/${encodeURIComponent(name)}${qs}`,
        { method: 'DELETE' }
      );
    },

    // --- Installed packages ---

    async listInstalledPackages(
      projectPath?: string,
      opts?: ListInstalledOptions
    ): Promise<InstalledPackage[]> {
      type Page = { packages: InstalledPackage[]; nextCursor: string | null };
      const params = { projectPath, verify: opts?.verify ? 'true' : undefined };
      const path = '/marketplace/installed';
      const { rows } = await fetchAllPages(baseUrl, path, params, (p: Page) => p.packages);
      return rows;
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

    async listHeldBackPackages(): Promise<HeldBackPackage[]> {
      type Page = { packages: HeldBackPackage[]; nextCursor: string | null };
      const path = '/marketplace/held-back';
      const { rows } = await fetchAllPages(baseUrl, path, {}, (p: Page) => p.packages);
      return rows;
    },

    listPackageInstallations(name: string): Promise<InstalledPackage[]> {
      return fetchJSON<{ installations: InstalledPackage[] }>(
        baseUrl,
        `/marketplace/installed/${encodeURIComponent(name)}`
      ).then((r) => r.installations);
    },

    // --- Sources ---

    async listMarketplaceSources(): Promise<ListedMarketplaceSource[]> {
      type Page = { sources: ListedMarketplaceSource[]; nextCursor: string | null };
      const path = '/marketplace/sources';
      const { rows } = await fetchAllPages(baseUrl, path, {}, (p: Page) => p.sources);
      return rows;
    },

    addMarketplaceSource(input: AddSourceInput): Promise<AddedMarketplaceSource> {
      return fetchJSON<AddedMarketplaceSource>(baseUrl, '/marketplace/sources', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    /**
     * The name goes in the body, never the path: a name saved by an older
     * DorkOS may hold a `/`, and Remote Access refuses an encoded `/` in a URL
     * path (DOR-4212). {@link removeMarketplaceSource} sends it in the query.
     */
    refreshMarketplaceSource(name: string): Promise<RefreshedMarketplaceSource> {
      return fetchJSON<RefreshedMarketplaceSource>(baseUrl, '/marketplace/sources/refreshes', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
    },

    /**
     * The route answers 204, so there is no body to read back — `fetchJSON`
     * would reject a request that in fact succeeded with a JSON parse error.
     */
    removeMarketplaceSource(name: string): Promise<void> {
      return fetchNoContent(baseUrl, `/marketplace/sources?name=${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
    },
  };
}
