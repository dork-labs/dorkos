import { createFileRoute } from '@tanstack/react-router';
import { MarketplaceSourcesPage } from '@/layers/widgets/marketplace';
import { MarketplaceSourcesBar } from '../app/route-headers';

export const Route = createFileRoute('/_shell/marketplace_/sources')({
  staticData: { header: MarketplaceSourcesBar },
  component: MarketplaceSourcesPage,
});
