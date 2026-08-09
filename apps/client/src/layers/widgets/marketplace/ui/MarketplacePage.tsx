import { Marketplace } from '@/layers/features/marketplace';
import { PageContainer } from '@/layers/shared/ui';

/**
 * Marketplace page widget — renders the marketplace browse experience at /marketplace.
 *
 * This is a thin shell: all layout (sidebar, header) is provided by `AppShell`
 * via its route-aware slot hooks. The page component only supplies the page's
 * width and scroll container, so browse and installed share one geometry.
 */
export function MarketplacePage() {
  return (
    <PageContainer width="wide">
      <Marketplace />
    </PageContainer>
  );
}
