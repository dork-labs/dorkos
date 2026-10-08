import { createFileRoute } from '@tanstack/react-router';
import { MarketplacePage } from '@/layers/widgets/marketplace';
import { MarketplaceBar } from '../app/route-headers';
import { zodValidator } from '@tanstack/zod-adapter';
import { marketplaceRouteSearchSchema } from '../app/route-search';

export const Route = createFileRoute('/_shell/marketplace')({
  staticData: { header: MarketplaceBar },
  validateSearch: zodValidator(marketplaceRouteSearchSchema),
  component: MarketplacePage,
});
