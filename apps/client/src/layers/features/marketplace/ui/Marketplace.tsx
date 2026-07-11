import { Tabs, TabsList, TabsTrigger } from '@/layers/shared/ui';
import { MarketplaceHeader } from './MarketplaceHeader';
import { FeaturedAgentsRail } from './FeaturedAgentsRail';
import { PackageGrid } from './PackageGrid';
import { PackageDetailSheet } from './PackageDetailSheet';
import { InstallConfirmationDialog } from './InstallConfirmationDialog';
import { InstalledPackagesView } from './InstalledPackagesView';
import { useMarketplaceParams } from '../model/use-marketplace-params';
import type { MarketplaceView } from '../model/marketplace-search';

/**
 * Root Marketplace experience with two URL-driven views.
 *
 * `browse` (default) composes `MarketplaceHeader` (search + type filters),
 * `FeaturedAgentsRail`, and `PackageGrid`. `installed` renders
 * `InstalledPackagesView` — every installation across scopes with per-scope
 * management. The active view lives in the URL (`?view=` via
 * `useMarketplaceParams`), so it survives refresh and is shareable, matching
 * PR #71's URL-driven browse state.
 *
 * `PackageDetailSheet` and `InstallConfirmationDialog` are rendered at the root
 * in both views so a deep link like `?view=installed&pkg=flow` opens the drawer
 * over either surface. The detail sheet reads its open state from the URL
 * (`?pkg=`); the install dialog reads transient state from `useMarketplaceStore`.
 */
export function Marketplace() {
  const { view, setView } = useMarketplaceParams();

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Marketplace</h1>
          <p className="text-muted-foreground text-sm">
            {view === 'installed'
              ? 'Manage every package installed across your global and per-agent scopes.'
              : 'Browse and install agents, plugins, skill packs, and adapters from the DorkOS marketplace.'}
          </p>
        </div>
        <Tabs value={view} onValueChange={(next) => setView(next as MarketplaceView)}>
          <TabsList aria-label="Marketplace view">
            <TabsTrigger value="browse">Browse</TabsTrigger>
            <TabsTrigger value="installed">Installed</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {view === 'installed' ? (
        <section aria-label="Installed packages">
          <InstalledPackagesView />
        </section>
      ) : (
        <>
          <MarketplaceHeader />
          <FeaturedAgentsRail />
          <section aria-label="All packages">
            <PackageGrid />
          </section>
        </>
      )}

      {/* Rendered at root so they float over all content, in both views */}
      <PackageDetailSheet />
      <InstallConfirmationDialog />
    </div>
  );
}
