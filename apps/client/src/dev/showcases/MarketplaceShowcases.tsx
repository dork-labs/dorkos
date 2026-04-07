/**
 * Marketplace component showcases for the dev playground.
 *
 * Each `PlaygroundSection` renders one component or a set of closely related
 * variants. Sections that depend on TanStack Query hooks receive their own
 * isolated `QueryClientProvider` with pre-seeded cache data so they render
 * with realistic state without hitting the server.
 *
 * Components that use `useDorkHubStore` (Zustand) share the global store
 * instance — the store is ephemeral and resets on page refresh.
 *
 * @module dev/showcases/MarketplaceShowcases
 */
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

// Marketplace UI components — direct imports are fine inside dev/
import { PackageCard } from '@/layers/features/marketplace/ui/PackageCard';
import { PackageTypeBadge } from '@/layers/features/marketplace/ui/PackageTypeBadge';
import { PackageGrid } from '@/layers/features/marketplace/ui/PackageGrid';
import { PackageLoadingSkeleton } from '@/layers/features/marketplace/ui/PackageLoadingSkeleton';
import { PackageEmptyState } from '@/layers/features/marketplace/ui/PackageEmptyState';
import { PackageErrorState } from '@/layers/features/marketplace/ui/PackageErrorState';
import { FeaturedAgentsRail } from '@/layers/features/marketplace/ui/FeaturedAgentsRail';
import { PackageDetailSheet } from '@/layers/features/marketplace/ui/PackageDetailSheet';
import { InstallConfirmationDialog } from '@/layers/features/marketplace/ui/InstallConfirmationDialog';
import { PermissionPreviewSection } from '@/layers/features/marketplace/ui/PermissionPreviewSection';
import { InstalledPackagesView } from '@/layers/features/marketplace/ui/InstalledPackagesView';
import { MarketplaceSourcesView } from '@/layers/features/marketplace/ui/MarketplaceSourcesView';
import { DorkHubHeader } from '@/layers/features/marketplace/ui/DorkHubHeader';
import { useDorkHubStore } from '@/layers/features/marketplace/model/dork-hub-store';

import { marketplaceKeys } from '@/layers/entities/marketplace/api/query-keys';

import {
  MOCK_PACKAGES,
  MOCK_PKG_FEATURED_AGENT,
  MOCK_PKG_FEATURED_DEPLOY,
  MOCK_PKG_FEATURED_DOCS,
  MOCK_PKG_PLUGIN,
  MOCK_PKG_SKILL_PACK_NO_DESC,
  MOCK_PKG_ADAPTER_LONG_DESC,
  MOCK_PERMISSION_PREVIEW_MINIMAL,
  MOCK_PERMISSION_PREVIEW_FULL,
  MOCK_PERMISSION_PREVIEW_BLOCKING,
  MOCK_INSTALLED_PACKAGES,
  MOCK_SOURCES,
} from './marketplace-mocks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an isolated QueryClient with marketplace package data pre-seeded.
 *
 * Each invocation returns a new client to ensure showcase sections are fully
 * independent. The `staleTime: Infinity` prevents background refetches that
 * would hit the server (which is not running in the playground context).
 */
function makeSeededQueryClient(seed: (qc: QueryClient) => void): QueryClient {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
    },
  });
  seed(qc);
  return qc;
}

/** Wrapper providing an isolated QueryClient with pre-seeded data. */
function IsolatedQueryProvider({
  seed,
  children,
}: {
  seed: (qc: QueryClient) => void;
  children: React.ReactNode;
}) {
  // useMemo ensures the client is created once per component mount.
  const qc = useMemo(() => makeSeededQueryClient(seed), []); // eslint-disable-line react-hooks/exhaustive-deps
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// ---------------------------------------------------------------------------
// PackageCard showcase
// ---------------------------------------------------------------------------

/** PackageCard in four states: default, featured, installed, long description. */
function PackageCardShowcase() {
  return (
    <PlaygroundSection
      title="PackageCard"
      description="Grid card for a single marketplace package. Variants: default, featured, installed, long description."
    >
      <ShowcaseLabel>Default (plugin, no icon)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-xs">
          <PackageCard pkg={MOCK_PKG_PLUGIN} onClick={() => {}} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Featured (agent, starred)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-xs">
          <PackageCard pkg={MOCK_PKG_FEATURED_AGENT} onClick={() => {}} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Installed state</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-xs">
          <PackageCard pkg={MOCK_PKG_FEATURED_AGENT} installed onClick={() => {}} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Long description (line-clamp)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-xs">
          <PackageCard pkg={MOCK_PKG_ADAPTER_LONG_DESC} onClick={() => {}} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>No description (skill-pack)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-xs">
          <PackageCard pkg={MOCK_PKG_SKILL_PACK_NO_DESC} onClick={() => {}} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// PackageTypeBadge showcase
// ---------------------------------------------------------------------------

/** All four package type badge variants. */
function PackageTypeBadgeShowcase() {
  const types = ['agent', 'plugin', 'skill-pack', 'adapter'] as const;

  return (
    <PlaygroundSection
      title="PackageTypeBadge"
      description="Coloured pill badge for each marketplace package type."
    >
      <ShowcaseDemo>
        <div className="flex flex-wrap gap-3">
          {types.map((t) => (
            <PackageTypeBadge key={t} type={t} />
          ))}
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// PackageGrid showcase
// ---------------------------------------------------------------------------

/** PackageGrid in loading, loaded, error, and empty states. */
function PackageGridShowcase() {
  return (
    <PlaygroundSection
      title="PackageGrid"
      description="Browse grid — renders loading skeletons, cards, error state, or empty state depending on query result."
    >
      <ShowcaseLabel>Loading state (8 skeleton cards)</ShowcaseLabel>
      <ShowcaseDemo>
        <PackageLoadingSkeleton count={8} />
      </ShowcaseDemo>

      <ShowcaseLabel>Loaded state (8 packages)</ShowcaseLabel>
      <ShowcaseDemo>
        <IsolatedQueryProvider
          seed={(qc) => {
            qc.setQueryData(marketplaceKeys.packageList(), MOCK_PACKAGES);
            qc.setQueryData(marketplaceKeys.installed(), []);
          }}
        >
          <PackageGrid />
        </IsolatedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Error state</ShowcaseLabel>
      <ShowcaseDemo>
        <PackageErrorState
          error={new Error('Failed to fetch packages — connection refused')}
          onRetry={() => {}}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Empty state (with reset action)</ShowcaseLabel>
      <ShowcaseDemo>
        <PackageEmptyState onResetFilters={() => {}} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// FeaturedAgentsRail showcase
// ---------------------------------------------------------------------------

/** FeaturedAgentsRail with 3 featured mocks and with zero featured (renders nothing). */
function FeaturedAgentsRailShowcase() {
  const featuredPackages = [
    MOCK_PKG_FEATURED_AGENT,
    MOCK_PKG_FEATURED_DEPLOY,
    MOCK_PKG_FEATURED_DOCS,
  ];
  // Non-featured packages — FeaturedAgentsRail filters to featured: true, so
  // seeding only non-featured items should cause it to return null.
  const nonFeaturedPackages = [MOCK_PKG_PLUGIN, MOCK_PKG_SKILL_PACK_NO_DESC];

  return (
    <PlaygroundSection
      title="FeaturedAgentsRail"
      description="Hero rail shown when featured agent packages are available. Returns null when none are featured."
    >
      <ShowcaseLabel>With 3 featured agents</ShowcaseLabel>
      <ShowcaseDemo>
        <IsolatedQueryProvider
          seed={(qc) => {
            qc.setQueryData(marketplaceKeys.packageList({ type: 'agent' }), featuredPackages);
          }}
        >
          <FeaturedAgentsRail />
        </IsolatedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Zero featured agents (renders nothing — empty div below is ShowcaseDemo)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <IsolatedQueryProvider
          seed={(qc) => {
            qc.setQueryData(marketplaceKeys.packageList({ type: 'agent' }), nonFeaturedPackages);
          }}
        >
          <FeaturedAgentsRail />
        </IsolatedQueryProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// PackageDetailSheet showcase
// ---------------------------------------------------------------------------

/** PackageDetailSheet shown open with a mock package, preview, and loading state. */
function PackageDetailSheetShowcase() {
  const openDetail = useDorkHubStore((s) => s.openDetail);
  const closeDetail = useDorkHubStore((s) => s.closeDetail);

  const permPreviewDetail = {
    manifest: {
      name: MOCK_PKG_FEATURED_AGENT.name,
      version: '1.4.2',
      type: 'agent' as const,
      description: MOCK_PKG_FEATURED_AGENT.description,
      author: 'DorkOS Team',
      license: 'MIT',
    },
    packagePath: '/tmp/code-reviewer',
    preview: MOCK_PERMISSION_PREVIEW_FULL,
  };

  return (
    <PlaygroundSection
      title="PackageDetailSheet"
      description="Slide-over detail sheet. Click the button to open it with mock package data and a full permission preview."
    >
      <ShowcaseDemo>
        <IsolatedQueryProvider
          seed={(qc) => {
            qc.setQueryData(
              marketplaceKeys.packageDetail(MOCK_PKG_FEATURED_AGENT.name),
              permPreviewDetail
            );
            qc.setQueryData(
              marketplaceKeys.permissionPreview(MOCK_PKG_FEATURED_AGENT.name),
              permPreviewDetail
            );
            qc.setQueryData(marketplaceKeys.installed(), []);
          }}
        >
          <div className="flex gap-3">
            <button
              type="button"
              className="bg-card hover:bg-accent rounded-md border px-4 py-2 text-sm font-medium"
              onClick={() => openDetail(MOCK_PKG_FEATURED_AGENT)}
            >
              Open detail sheet →
            </button>
            <button
              type="button"
              className="bg-card hover:bg-accent rounded-md border px-4 py-2 text-sm font-medium"
              onClick={closeDetail}
            >
              Close
            </button>
          </div>
          <PackageDetailSheet />
        </IsolatedQueryProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// InstallConfirmationDialog showcase
// ---------------------------------------------------------------------------

/** InstallConfirmationDialog shown open with a preview that has conflicts. */
function InstallConfirmationDialogShowcase() {
  const openInstallConfirm = useDorkHubStore((s) => s.openInstallConfirm);
  const closeInstallConfirm = useDorkHubStore((s) => s.closeInstallConfirm);

  const conflictPreviewDetail = {
    manifest: {
      name: MOCK_PKG_ADAPTER_LONG_DESC.name,
      version: '2.1.0',
      type: 'adapter' as const,
    },
    packagePath: '/tmp/slack-adapter',
    preview: MOCK_PERMISSION_PREVIEW_BLOCKING,
  };

  return (
    <PlaygroundSection
      title="InstallConfirmationDialog"
      description="Blocking confirmation modal with full permission preview. Open variant below shows blocking conflicts that disable the Install button."
    >
      <ShowcaseDemo>
        <IsolatedQueryProvider
          seed={(qc) => {
            qc.setQueryData(
              marketplaceKeys.permissionPreview(MOCK_PKG_ADAPTER_LONG_DESC.name),
              conflictPreviewDetail
            );
          }}
        >
          <div className="flex gap-3">
            <button
              type="button"
              className="bg-card hover:bg-accent rounded-md border px-4 py-2 text-sm font-medium"
              onClick={() => openInstallConfirm(MOCK_PKG_ADAPTER_LONG_DESC)}
            >
              Open with blocking conflict →
            </button>
            <button
              type="button"
              className="bg-card hover:bg-accent rounded-md border px-4 py-2 text-sm font-medium"
              onClick={closeInstallConfirm}
            >
              Close
            </button>
          </div>
          <InstallConfirmationDialog />
        </IsolatedQueryProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// PermissionPreviewSection showcase
// ---------------------------------------------------------------------------

/** PermissionPreviewSection in three states: minimal, full, blocking conflicts. */
function PermissionPreviewSectionShowcase() {
  return (
    <PlaygroundSection
      title="PermissionPreviewSection"
      description="Human-readable breakdown of everything a package will do on install. Three variants: minimal, fully populated, and with blocking conflicts."
    >
      <ShowcaseLabel>Minimal (no secrets, no hosts, no conflicts)</ShowcaseLabel>
      <ShowcaseDemo>
        <PermissionPreviewSection preview={MOCK_PERMISSION_PREVIEW_MINIMAL} />
      </ShowcaseDemo>

      <ShowcaseLabel>Full (all sections populated)</ShowcaseLabel>
      <ShowcaseDemo>
        <PermissionPreviewSection preview={MOCK_PERMISSION_PREVIEW_FULL} />
      </ShowcaseDemo>

      <ShowcaseLabel>Blocking conflict (error-level)</ShowcaseLabel>
      <ShowcaseDemo>
        <PermissionPreviewSection preview={MOCK_PERMISSION_PREVIEW_BLOCKING} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// InstalledPackagesView showcase
// ---------------------------------------------------------------------------

/** InstalledPackagesView in empty, populated states. */
function InstalledPackagesViewShowcase() {
  return (
    <PlaygroundSection
      title="InstalledPackagesView"
      description="Manage installed packages — list with per-row update and two-click uninstall actions."
    >
      <ShowcaseLabel>Empty state</ShowcaseLabel>
      <ShowcaseDemo>
        <IsolatedQueryProvider
          seed={(qc) => {
            qc.setQueryData(marketplaceKeys.installed(), []);
          }}
        >
          <InstalledPackagesView />
        </IsolatedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Populated (3 packages)</ShowcaseLabel>
      <ShowcaseDemo>
        <IsolatedQueryProvider
          seed={(qc) => {
            qc.setQueryData(marketplaceKeys.installed(), MOCK_INSTALLED_PACKAGES);
          }}
        >
          <InstalledPackagesView />
        </IsolatedQueryProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// MarketplaceSourcesView showcase
// ---------------------------------------------------------------------------

/** MarketplaceSourcesView in empty and populated states. */
function MarketplaceSourcesViewShowcase() {
  return (
    <PlaygroundSection
      title="MarketplaceSourcesView"
      description="Git registry management — add and remove marketplace sources."
    >
      <ShowcaseLabel>Empty state</ShowcaseLabel>
      <ShowcaseDemo>
        <IsolatedQueryProvider
          seed={(qc) => {
            qc.setQueryData(marketplaceKeys.sources(), []);
          }}
        >
          <MarketplaceSourcesView />
        </IsolatedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Populated (2 sources, one disabled)</ShowcaseLabel>
      <ShowcaseDemo>
        <IsolatedQueryProvider
          seed={(qc) => {
            qc.setQueryData(marketplaceKeys.sources(), MOCK_SOURCES);
          }}
        >
          <MarketplaceSourcesView />
        </IsolatedQueryProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// DorkHubHeader showcase
// ---------------------------------------------------------------------------

/** DorkHubHeader — search input and type filter tabs. */
function DorkHubHeaderShowcase() {
  return (
    <PlaygroundSection
      title="DorkHubHeader"
      description="Top-of-hub search input (debounced) and type-filter tab row. Writes to the global useDorkHubStore."
    >
      <ShowcaseDemo>
        <div className="max-w-2xl">
          <DorkHubHeader />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// Primitives showcase (loading / empty / error)
// ---------------------------------------------------------------------------

/** PackageLoadingSkeleton, PackageEmptyState, PackageErrorState in isolation. */
function PackagePrimitivesShowcase() {
  return (
    <PlaygroundSection
      title="Package Primitives"
      description="Standalone loading, empty, and error state components used across the marketplace browse grid."
    >
      <ShowcaseLabel>PackageLoadingSkeleton (4 cards)</ShowcaseLabel>
      <ShowcaseDemo>
        <PackageLoadingSkeleton count={4} />
      </ShowcaseDemo>

      <ShowcaseLabel>PackageEmptyState — filter-induced (with reset)</ShowcaseLabel>
      <ShowcaseDemo>
        <PackageEmptyState onResetFilters={() => {}} />
      </ShowcaseDemo>

      <ShowcaseLabel>PackageEmptyState — true empty (no reset button)</ShowcaseLabel>
      <ShowcaseDemo>
        <PackageEmptyState
          title="No packages available"
          description="Add a marketplace source to start browsing."
        />
      </ShowcaseDemo>

      <ShowcaseLabel>PackageErrorState — generic error</ShowcaseLabel>
      <ShowcaseDemo>
        <PackageErrorState error={new Error('Internal Server Error (500)')} onRetry={() => {}} />
      </ShowcaseDemo>

      <ShowcaseLabel>PackageErrorState — network / offline</ShowcaseLabel>
      <ShowcaseDemo>
        <PackageErrorState
          error={new Error('network request failed — you appear to be offline')}
          onRetry={() => {}}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

/** Marketplace feature component showcases for the dev playground. */
export function MarketplaceShowcases() {
  return (
    <>
      <PackageCardShowcase />
      <PackageTypeBadgeShowcase />
      <PackageGridShowcase />
      <FeaturedAgentsRailShowcase />
      <PackageDetailSheetShowcase />
      <InstallConfirmationDialogShowcase />
      <PermissionPreviewSectionShowcase />
      <InstalledPackagesViewShowcase />
      <MarketplaceSourcesViewShowcase />
      <DorkHubHeaderShowcase />
      <PackagePrimitivesShowcase />
    </>
  );
}
