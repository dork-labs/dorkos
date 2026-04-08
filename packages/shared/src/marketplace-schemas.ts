/**
 * Shared marketplace API response types — consumed by the client transport
 * layer and the React query hooks that wrap it.
 *
 * Types are plain TypeScript interfaces (no Zod schemas) because they model
 * HTTP response shapes, not validated domain inputs. They must remain
 * browser-safe (no Node.js imports).
 *
 * Server-side source of truth:
 *   - `apps/server/src/routes/marketplace.ts` — AggregatedPackage, InstalledPackage, AddSourceInput
 *   - `apps/server/src/services/marketplace/types.ts` — PermissionPreview, InstallResult,
 *     InstallRequest, MarketplaceSource, ConflictReport
 *   - `apps/server/src/services/marketplace/flows/uninstall.ts` — UninstallResult
 *   - `apps/server/src/services/marketplace/flows/update.ts` — UpdateResult, UpdateCheckResult
 *   - `packages/marketplace` — MarketplaceJsonEntry, MarketplacePackageManifest, PackageType
 *
 * @module shared/marketplace-schemas
 */

// ---------------------------------------------------------------------------
// Package type
// ---------------------------------------------------------------------------

/**
 * Closed enumeration of package types supported by the DorkOS marketplace.
 *
 * Mirrors `PackageType` from `@dorkos/marketplace` — redeclared here so the
 * client transport layer does not need to import from that package directly
 * (which is fine but adds a dependency that may not be desired in all
 * client contexts).
 */
export type MarketplacePackageType = 'agent' | 'plugin' | 'skill-pack' | 'adapter';

// ---------------------------------------------------------------------------
// Browse / discovery
// ---------------------------------------------------------------------------

/**
 * A single marketplace.json plugin entry as exposed by `GET /api/marketplace/packages`.
 *
 * Combines the standard Claude Code marketplace entry fields with optional
 * DorkOS extension fields, plus the origin marketplace source name.
 */
export interface AggregatedPackage {
  /** Package name (primary identifier). */
  name: string;
  /** Git URL or other source identifier for the package. */
  source: string;
  /** Human-readable description. */
  description?: string;
  /** Package version string. */
  version?: string;
  /** Package author. */
  author?: string;
  /** Homepage URL. */
  homepage?: string;
  /** Repository URL. */
  repository?: string;
  /** License identifier. */
  license?: string;
  /** Searchable keywords. */
  keywords?: string[];
  /** DorkOS extension: package type (defaults to `plugin` when absent). */
  type?: MarketplacePackageType;
  /** DorkOS extension: browsing category. */
  category?: string;
  /** DorkOS extension: searchable tags. */
  tags?: string[];
  /** DorkOS extension: icon emoji or identifier. */
  icon?: string;
  /** DorkOS extension: whether to highlight in the browse UI. */
  featured?: boolean;
  /** Marketplace source the entry was discovered in. */
  marketplace: string;
}

/**
 * Filter options for `GET /api/marketplace/packages`.
 *
 * All fields are optional — omitting a field returns all packages regardless
 * of that dimension.
 */
export interface PackageFilter {
  /** Filter by package type. */
  type?: MarketplacePackageType;
  /** Filter by marketplace source name. */
  marketplace?: string;
  /** Free-text search across name, description, and tags. */
  q?: string;
}

// ---------------------------------------------------------------------------
// Package detail (GET /packages/:name)
// ---------------------------------------------------------------------------

/**
 * A simplified manifest shape as surfaced by the `GET /api/marketplace/packages/:name`
 * and `POST /api/marketplace/packages/:name/preview` endpoints.
 *
 * The full `MarketplacePackageManifest` lives in `@dorkos/marketplace` and
 * has stricter Zod validation. This interface represents what the server
 * serialises over the wire.
 */
export interface MarketplacePackageDetail {
  /** Full package manifest as parsed by the server-side validator. */
  manifest: MarketplaceManifestSummary;
  /** Absolute path on the server where the package was staged. */
  packagePath: string;
  /** Permission preview computed for this package. */
  preview: PermissionPreview;
}

/** Minimal manifest summary included in detail and preview responses. */
export interface MarketplaceManifestSummary {
  name: string;
  version: string;
  type: MarketplacePackageType;
  description?: string;
  author?: string;
  homepage?: string;
  license?: string;
  requires?: string[];
}

// ---------------------------------------------------------------------------
// Permission preview
// ---------------------------------------------------------------------------

/**
 * A preview of every effect a package install will have — surfaced to the user
 * before any disk mutation occurs.
 *
 * Mirrors `PermissionPreview` in `apps/server/src/services/marketplace/types.ts`.
 */
export interface PermissionPreview {
  /** Files that will be created, modified, or deleted. */
  fileChanges: { path: string; action: 'create' | 'modify' | 'delete' }[];
  /** Extensions that will be registered. */
  extensions: { id: string; slots: string[] }[];
  /** Scheduled tasks that will be created. */
  tasks: { name: string; cron: string | null }[];
  /** Secrets the package will request from the user. */
  secrets: { key: string; required: boolean; description?: string }[];
  /** External hosts the package will contact. */
  externalHosts: string[];
  /** Other packages this package depends on. */
  requires: { type: string; name: string; version?: string; satisfied: boolean }[];
  /** Conflicts with already-installed packages. */
  conflicts: ConflictReport[];
}

/**
 * A single conflict detected between an incoming package and the installed set.
 *
 * Mirrors `ConflictReport` in `apps/server/src/services/marketplace/types.ts`.
 */
export interface ConflictReport {
  /** `error` blocks install; `warning` is surfaced but allows the user to proceed. */
  level: 'error' | 'warning';
  /** Conflict category for structured display. */
  type: 'package-name' | 'slot' | 'skill-name' | 'task-name' | 'cron-collision' | 'adapter-id';
  /** Human-readable description of the conflict. */
  description: string;
  /** Name of the already-installed package causing the conflict, if known. */
  conflictingPackage?: string;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Options for `POST /api/marketplace/packages/:name/install`.
 *
 * Mirrors the body of `InstallRequestBodySchema` in
 * `apps/server/src/routes/marketplace.ts`.
 */
export interface InstallOptions {
  /** Restrict lookup to a specific marketplace source. */
  marketplace?: string;
  /** Override with an explicit git URL or local path. */
  source?: string;
  /** Force reinstall even if the same version is already present. */
  force?: boolean;
  /** Skip interactive confirmation (non-interactive use). */
  yes?: boolean;
  /** Project path for project-local installs. */
  projectPath?: string;
}

/**
 * The outcome of a successful install transaction.
 *
 * Mirrors `InstallResult` in `apps/server/src/services/marketplace/types.ts`.
 */
export interface InstallResult {
  ok: boolean;
  packageName: string;
  version: string;
  type: MarketplacePackageType;
  installPath: string;
  manifest: MarketplaceManifestSummary;
  rollbackBranch?: string;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

/**
 * Options for `POST /api/marketplace/packages/:name/uninstall`.
 */
export interface UninstallOptions {
  /** Remove `.dork/data/` and `.dork/secrets.json` in addition to package files. */
  purge?: boolean;
  /** Project path for project-local uninstalls. */
  projectPath?: string;
}

/**
 * The outcome of a successful uninstall.
 *
 * Mirrors `UninstallResult` in `apps/server/src/services/marketplace/flows/uninstall.ts`.
 */
export interface UninstallResult {
  ok: boolean;
  packageName: string;
  /** Number of top-level entries removed from the install root. */
  removedFiles: number;
  /** Absolute paths preserved on disk because `purge` was false. */
  preservedData: string[];
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Options for `POST /api/marketplace/packages/:name/update`.
 */
export interface UpdateOptions {
  /** Apply the update (default: advisory check only). */
  apply?: boolean;
  /** Project path for project-local updates. */
  projectPath?: string;
}

/**
 * A single comparison result for one installed package.
 *
 * Mirrors `UpdateCheckResult` in `apps/server/src/services/marketplace/flows/update.ts`.
 */
export interface UpdateCheckResult {
  packageName: string;
  installedVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  marketplace: string;
}

/**
 * The composite result of an update check, with optional applied reinstalls.
 *
 * Mirrors `UpdateResult` in `apps/server/src/services/marketplace/flows/update.ts`.
 */
export interface UpdateResult {
  checks: UpdateCheckResult[];
  /** Populated only when `apply: true`; one entry per successful reinstall. */
  applied: InstallResult[];
}

// ---------------------------------------------------------------------------
// Installed packages
// ---------------------------------------------------------------------------

/**
 * Summary of an installed marketplace package as surfaced by
 * `GET /api/marketplace/installed`.
 *
 * Mirrors `InstalledPackage` in `apps/server/src/routes/marketplace.ts`.
 */
export interface InstalledPackage {
  name: string;
  version: string;
  type: MarketplacePackageType;
  installPath: string;
  installedFrom?: string;
  installedAt?: string;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * A configured marketplace source.
 *
 * Mirrors `MarketplaceSource` in `apps/server/src/services/marketplace/types.ts`.
 */
export interface MarketplaceSource {
  name: string;
  source: string;
  enabled: boolean;
  addedAt: string;
}

/**
 * Request body for `POST /api/marketplace/sources`.
 *
 * Mirrors `AddSourceBodySchema` in `apps/server/src/routes/marketplace.ts`.
 */
export interface AddSourceInput {
  name: string;
  source: string;
  enabled?: boolean;
}
