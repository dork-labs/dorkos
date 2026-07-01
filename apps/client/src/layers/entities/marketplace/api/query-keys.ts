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

  // `projectPath` scopes the result to a project's local agent directory.
  // Omitting it returns the global `{dorkHome}/plugins` + `/agents` set.
  // Including it adds the path dimension so global and per-project caches
  // remain independent and stale data cannot leak between projects.
  installed: (projectPath?: string) =>
    projectPath
      ? ([...marketplaceKeys.all, 'installed', { projectPath }] as const)
      : ([...marketplaceKeys.all, 'installed'] as const),

  // Single installed package, enriched with `provides`. Scoped by name (and
  // projectPath when set) so it caches independently of the installed list.
  installedDetail: (name: string, projectPath?: string) =>
    projectPath
      ? ([...marketplaceKeys.all, 'installed', 'detail', name, { projectPath }] as const)
      : ([...marketplaceKeys.all, 'installed', 'detail', name] as const),

  sources: () => [...marketplaceKeys.all, 'sources'] as const,
};
