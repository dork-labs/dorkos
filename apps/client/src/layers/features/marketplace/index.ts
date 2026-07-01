/**
 * Marketplace feature — Marketplace browse experience, package detail sheet, and install flows.
 *
 * Exports the root `Marketplace` component (compose into a page widget) and the
 * `useMarketplaceStore` Zustand hook plus its filter/sort types for any widget that
 * needs to read or drive Marketplace UI state.
 *
 * @module features/marketplace
 */
export { Marketplace } from './ui/Marketplace';
export { PackageCard } from './ui/PackageCard';
export { InstalledPackagesView } from './ui/InstalledPackagesView';
export { MarketplaceSourcesView } from './ui/MarketplaceSourcesView';
export { TelemetryConsentBanner } from './ui/TelemetryConsentBanner';
export { useMarketplaceStore } from './model/marketplace-store';
export type { MarketplaceTypeFilter, MarketplaceSort } from './model/marketplace-store';
