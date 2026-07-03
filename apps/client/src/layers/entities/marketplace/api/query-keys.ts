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
  // The preview reflects the CURRENT installed state at the target scope, so the
  // install options (esp. `projectPath`) are part of the identity — otherwise a
  // scope toggle in the install dialog would return the prior scope's cached
  // conflicts (global vs agent-local differ). Omit the object when empty so the
  // common global preview keeps a stable, noise-free key.
  permissionPreview: (
    name: string,
    opts?: { marketplace?: string; source?: string; projectPath?: string }
  ) =>
    opts && Object.keys(opts).length > 0
      ? ([...marketplaceKeys.preview(), name, opts] as const)
      : ([...marketplaceKeys.preview(), name] as const),

  // `projectPath` scopes the result to a project's local agent directory.
  // Omitting it returns the global `{dorkHome}/plugins` + `/agents` set.
  // Including it adds the path dimension so global and per-project caches
  // remain independent and stale data cannot leak between projects.
  installed: (projectPath?: string) =>
    projectPath
      ? ([...marketplaceKeys.all, 'installed', { projectPath }] as const)
      : ([...marketplaceKeys.all, 'installed'] as const),

  // Every installation of a single package across scopes, enriched with
  // `provides`. Scoped by name only — the cross-scope detail endpoint takes
  // no projectPath — so it caches independently of the installed list.
  installedDetail: (name: string) => [...marketplaceKeys.all, 'installed', 'detail', name] as const,

  sources: () => [...marketplaceKeys.all, 'sources'] as const,
};
