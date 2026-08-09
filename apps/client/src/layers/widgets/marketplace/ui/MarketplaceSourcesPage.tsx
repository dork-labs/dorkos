import { MarketplaceSourcesView } from '@/layers/features/marketplace';
import { PageContainer } from '@/layers/shared/ui';

/**
 * Marketplace sources page widget — renders the source management view at /marketplace/sources.
 *
 * This is a thin shell: all layout (sidebar, header) is provided by `AppShell`
 * via its route-aware slot hooks. The page component only supplies the page's
 * width and scroll container.
 */
export function MarketplaceSourcesPage() {
  return (
    <PageContainer width="reading">
      <MarketplaceSourcesView />
    </PageContainer>
  );
}
