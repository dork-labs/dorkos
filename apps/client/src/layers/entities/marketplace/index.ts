/**
 * Marketplace entity — domain hooks for package install, uninstall, update,
 * source management, and browse/discovery queries.
 *
 * @module entities/marketplace
 */

// --- Query key factory ---
export { marketplaceKeys } from './api/query-keys';

// --- Query hooks ---
export { useMarketplacePackages } from './model/use-marketplace-packages';
export { useMarketplacePackage } from './model/use-marketplace-package';
export { usePermissionPreview } from './model/use-permission-preview';
export { useInstalledPackages } from './model/use-installed-packages';
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
