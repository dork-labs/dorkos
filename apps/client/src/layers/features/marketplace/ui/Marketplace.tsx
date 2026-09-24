import { PageHeading, Tabs, TabsList, TabsTrigger } from '@/layers/shared/ui';
import { MarketplaceToolbar } from './MarketplaceToolbar';
import { FeaturedRail } from './FeaturedRail';
import { PackageGrid } from './PackageGrid';
import { PackageDetailSheet } from './PackageDetailSheet';
import { InstallConfirmationDialog } from './InstallConfirmationDialog';
import { InstalledPackagesView } from './InstalledPackagesView';
import { useMarketplaceParams } from '../model/use-marketplace-params';
import { useInstalledUpdatesView } from '../model/use-installed-updates-view';
import type { MarketplaceView } from '../model/marketplace-search';

/**
 * Root Marketplace experience with two URL-driven views.
 *
 * `browse` (default) composes `MarketplaceToolbar` (search + sort), `FeaturedRail`,
 * and `PackageGrid`. The type and category filter facets live in the sidebar
 * takeover panel (`MarketplaceSidebar`), not here. `installed` renders
 * `InstalledPackagesView` — every installation across scopes with per-scope
 * management. The active view lives in the URL (`?view=` via
 * `useMarketplaceParams`), so it survives refresh and is shareable, matching
 * PR #71's URL-driven browse state.
 *
 * The Installed tab carries a count of installations with a newer version, so
 * staleness is visible from Browse. It reads the same one update check the
 * Installed view reads (`useInstalledUpdatesView`), so opening the Marketplace
 * asks once, whichever tab is showing.
 *
 * `PackageDetailSheet` and `InstallConfirmationDialog` are rendered at the root
 * in both views so a deep link like `?view=installed&pkg=flow` opens the drawer
 * over either surface. The detail sheet reads its open state from the URL
 * (`?pkg=`); the install dialog reads transient state from `useMarketplaceStore`.
 */
export function Marketplace() {
  const { view, setView } = useMarketplaceParams();
  const updateCount = useInstalledUpdatesView().summary.available.length;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          {/* Not drawn (design decision E1): the bar overhead already says
              "Marketplace". Kept for the outline — the bar's title is a `nav`
              landmark, not a heading, and a page with no `h1` leaves its
              sections hanging under nothing. */}
          <PageHeading>Marketplace</PageHeading>
          <p className="text-muted-foreground text-sm">
            {view === 'installed'
              ? 'Manage every package installed across your global and per-agent scopes.'
              : 'Browse and install packages for your agents and for DorkOS itself.'}
          </p>
        </div>
        <Tabs value={view} onValueChange={(next) => setView(next as MarketplaceView)}>
          <TabsList aria-label="Marketplace view">
            <TabsTrigger value="browse">Browse</TabsTrigger>
            <TabsTrigger value="installed">
              Installed
              {updateCount > 0 && (
                <>
                  <span
                    aria-hidden
                    className="bg-status-info-bg text-status-info-fg text-2xs ml-1.5 rounded-full px-1.5 font-medium tabular-nums"
                  >
                    {updateCount}
                  </span>
                  <span className="sr-only">
                    , {updateCount} {updateCount === 1 ? 'update' : 'updates'} available
                  </span>
                </>
              )}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {view === 'installed' ? (
        <section aria-label="Installed packages">
          <InstalledPackagesView />
        </section>
      ) : (
        <>
          <MarketplaceToolbar />
          <FeaturedRail />
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
