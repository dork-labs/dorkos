/**
 * Marketplace feature module — apps/site marketplace browse and detail experience.
 *
 * Provides server-side fetch helpers, ranking, telemetry queries, and UI components
 * for the public `/marketplace` browse page and `/marketplace/[slug]` detail pages.
 *
 * @module features/marketplace
 */

export { fetchMarketplaceJson, fetchPackageReadme } from './lib/fetch';
export { rankPackages } from './lib/ranking';
export type { RankFilters, RankedPackage } from './lib/ranking';
export { fetchInstallCount, fetchInstallCounts } from './lib/telemetry';
export { formatPermissions } from './lib/format-permissions';
export type { PermissionClaim } from './lib/format-permissions';
export { PermissionPreviewServer } from './ui/PermissionPreviewServer';
export { PackageCard } from './ui/PackageCard';
export { MarketplaceGrid } from './ui/MarketplaceGrid';
export { FeaturedAgentsRail } from './ui/FeaturedAgentsRail';
export { MarketplaceHeader } from './ui/MarketplaceHeader';
export { PackageHeader } from './ui/PackageHeader';
export { PackageReadme } from './ui/PackageReadme';
export { InstallInstructions } from './ui/InstallInstructions';
export { RelatedPackages } from './ui/RelatedPackages';
