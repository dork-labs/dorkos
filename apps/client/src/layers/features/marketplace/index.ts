/**
 * Marketplace feature — Dork Hub browse experience, package detail sheet, and install flows.
 *
 * Exports the root `DorkHub` component (compose into a page widget) and the
 * `useDorkHubStore` Zustand hook plus its filter/sort types for any widget that
 * needs to read or drive Dork Hub UI state.
 *
 * @module features/marketplace
 */
export { DorkHub } from './ui/DorkHub';
export { PackageCard } from './ui/PackageCard';
export { InstalledPackagesView } from './ui/InstalledPackagesView';
export { MarketplaceSourcesView } from './ui/MarketplaceSourcesView';
export { TelemetryConsentBanner } from './ui/TelemetryConsentBanner';
export { useDorkHubStore } from './model/dork-hub-store';
export type { DorkHubTypeFilter, DorkHubSort } from './model/dork-hub-store';
