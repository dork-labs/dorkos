import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { MARKETPLACE_SECTIONS } from '../playground-registry';
import { MarketplaceShowcases } from '../showcases/MarketplaceShowcases';

/** Marketplace component showcase page for the dev playground. */
export function MarketplacePage() {
  return (
    <PlaygroundPageLayout
      title="Marketplace Components"
      description="Marketplace browse grid, package cards, install flows, and source management."
      sections={MARKETPLACE_SECTIONS}
    >
      <MarketplaceShowcases />
    </PlaygroundPageLayout>
  );
}
