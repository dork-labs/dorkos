import { DorkHubHeader } from './DorkHubHeader';
import { FeaturedAgentsRail } from './FeaturedAgentsRail';
import { PackageGrid } from './PackageGrid';
import { PackageDetailSheet } from './PackageDetailSheet';
import { InstallConfirmationDialog } from './InstallConfirmationDialog';

/**
 * Root Dork Hub browse experience.
 *
 * Composes `DorkHubHeader` (search + type filters), `FeaturedAgentsRail`
 * (curated featured packages), and `PackageGrid` (full filterable catalog).
 * `PackageDetailSheet` and `InstallConfirmationDialog` are rendered here at
 * the root so they float above all content; both read their open state from
 * `useDorkHubStore`.
 */
export function DorkHub() {
  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Dork Hub</h1>
        <p className="text-muted-foreground text-sm">
          Browse and install agents, plugins, skill packs, and adapters from the DorkOS marketplace.
        </p>
      </div>
      <DorkHubHeader />
      <FeaturedAgentsRail />
      <section aria-label="All packages" className="space-y-4">
        <h2 className="text-base font-semibold">All Packages</h2>
        <PackageGrid />
      </section>
      {/* Rendered at root so they float over all content */}
      <PackageDetailSheet />
      <InstallConfirmationDialog />
    </div>
  );
}
