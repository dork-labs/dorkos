/**
 * Marketplace feature — browse experience, package detail drawer, and install flows.
 *
 * Exports the root `Marketplace` component (compose into a page widget), the
 * `useMarketplaceParams` hook + `marketplaceSearchSchema` that persist browse
 * state in the URL, and the `useMarketplaceStore` Zustand hook for transient
 * install-flow state.
 *
 * @module features/marketplace
 */
export { Marketplace } from './ui/Marketplace';
export { PackageCard } from './ui/PackageCard';
export { InstalledPackagesView } from './ui/InstalledPackagesView';
export { MarketplaceSourcesView } from './ui/MarketplaceSourcesView';
export { TelemetryConsentBanner } from './ui/TelemetryConsentBanner';
export { useMarketplaceStore } from './model/marketplace-store';
export { useMarketplaceParams } from './model/use-marketplace-params';
export { marketplaceSearchSchema } from './model/marketplace-search';
export type { MarketplaceTypeFilter, MarketplaceSort } from './model/marketplace-search';
