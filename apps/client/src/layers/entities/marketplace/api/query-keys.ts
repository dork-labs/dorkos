/**
 * TanStack Query key factory for marketplace entity queries.
 *
 * @module entities/marketplace/api
 */
import type { PackageFilter } from '@dorkos/shared/marketplace-schemas';

export const marketplaceKeys = {
  all: ['marketplace'] as const,

  packages: () => [...marketplaceKeys.all, 'packages'] as const,
  packageList: (filter?: PackageFilter) => [...marketplaceKeys.packages(), { filter }] as const,
  packageDetail: (name: string) => [...marketplaceKeys.packages(), 'detail', name] as const,

  preview: () => [...marketplaceKeys.all, 'preview'] as const,
  permissionPreview: (name: string) => [...marketplaceKeys.preview(), name] as const,

  installed: () => [...marketplaceKeys.all, 'installed'] as const,

  sources: () => [...marketplaceKeys.all, 'sources'] as const,
};
