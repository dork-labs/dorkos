import { MarketplaceSourcesView } from '@/layers/features/marketplace/ui/MarketplaceSourcesView';

/**
 * Marketplace sources page widget — renders the source management view at /marketplace/sources.
 *
 * This is a thin shell: all layout (sidebar, header) is provided by `AppShell`
 * via its route-aware slot hooks. The page component only renders the feature content.
 */
export function MarketplaceSourcesPage() {
  return (
    <div className="flex h-full flex-col">
      <MarketplaceSourcesView />
    </div>
  );
}
