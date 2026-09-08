/**
 * Marketplace entity — domain hooks for package install, uninstall, update,
 * source management, and browse/discovery queries.
 *
 * @module entities/marketplace
 */

// --- Query key factory ---
export { marketplaceKeys } from './api/query-keys';

// --- Lib ---
// The one sentence that describes a package's scheduled job, shared by every
// surface that has to disclose one before a person says yes.
export { describePreviewSchedule, runsUnattended } from './lib/describe-schedule';

// --- Query hooks ---
export { useMarketplacePackages } from './model/use-marketplace-packages';
export { useMarketplacePackage } from './model/use-marketplace-package';
export { usePermissionPreview } from './model/use-permission-preview';
export { useInstalledPackages } from './model/use-installed-packages';
export { usePackageInstallations } from './model/use-package-installations';
export { useMarketplaceSources } from './model/use-marketplace-sources';

// --- Mutation hooks ---
export { useInstallPackage } from './model/use-install-package';
export type { InstallPackageArgs } from './model/use-install-package';

export { useUninstallPackage } from './model/use-uninstall-package';
export type { UninstallPackageArgs } from './model/use-uninstall-package';

export { useUpdatePackage } from './model/use-update-package';
export type { UpdatePackageArgs } from './model/use-update-package';

export { useAddMarketplaceSource } from './model/use-add-marketplace-source';

export { useRemoveMarketplaceSource } from './model/use-remove-marketplace-source';

// No UI. `SkillPacksList` drew the profile's Skills page until the harness
// status arrived: it listed installed skill-packs and told a person with
// thirty-one skills they had none, because a skill-pack is one of the ways a
// skill gets into a folder and not the only one. `entities/harness` answers the
// same question from what is actually on disk, so the list and the `ScopeBadge`
// that was its only cell are deleted rather than left compiling beside it.
