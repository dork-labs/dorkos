/**
 * Shared types for the marketplace install service. Consumed by the source
 * manager, cache, resolver, permission preview builder, conflict detector,
 * transaction engine, and every install/uninstall/update flow.
 *
 * @module services/marketplace/types
 */
import type { MarketplacePackageManifest, PackageType } from '@dorkos/marketplace';

/**
 * A configured marketplace source — a remote location (Git URL or
 * marketplace.json URL) that the user has registered as a place to discover
 * and install packages from.
 */
export interface MarketplaceSource {
  /** User-chosen identifier (e.g., "dorkos-community") */
  name: string;
  /** Git URL or marketplace JSON URL */
  source: string;
  /** Whether this source is enabled */
  enabled: boolean;
  /** When this source was added */
  addedAt: string;
}

/**
 * A request to install a marketplace package, captured before resolution
 * and permission preview. Mirrors the CLI/HTTP install surface.
 */
export interface InstallRequest {
  /** Package name to install */
  name: string;
  /** Optional marketplace identifier (e.g., "dorkos-community") */
  marketplace?: string;
  /** Optional explicit source (overrides marketplace lookup) */
  source?: string;
  /** Force reinstall even if same version is present */
  force?: boolean;
  /** Skip permission preview confirmation (for non-interactive use) */
  yes?: boolean;
  /** Project path for project-local installs (defaults to global) */
  projectPath?: string;
}

/**
 * A preview of every effect a package install will have — file changes,
 * extension registrations, scheduled tasks, secrets requested, external
 * hosts contacted, dependencies, and conflicts. Surfaced to the user
 * before any disk mutation.
 */
export interface PermissionPreview {
  /** What will be created on disk */
  fileChanges: { path: string; action: 'create' | 'modify' | 'delete' }[];
  /** Extensions that will be registered */
  extensions: { id: string; slots: string[] }[];
  /** Tasks that will be created */
  tasks: { name: string; cron: string | null }[];
  /** Secrets the package will request */
  secrets: { key: string; required: boolean; description?: string }[];
  /** External hosts the package will contact */
  externalHosts: string[];
  /** Other packages this depends on */
  requires: { type: string; name: string; version?: string; satisfied: boolean }[];
  /** Conflicts with already-installed packages */
  conflicts: ConflictReport[];
}

/**
 * A single conflict detected between an incoming package and the
 * currently-installed set. Errors block install; warnings are surfaced
 * but allow the user to proceed.
 */
export interface ConflictReport {
  level: 'error' | 'warning';
  type: 'package-name' | 'slot' | 'skill-name' | 'task-name' | 'cron-collision' | 'adapter-id';
  description: string;
  conflictingPackage?: string;
}

/**
 * The outcome of a successful install transaction — the resolved package
 * identity, where it landed on disk, the parsed manifest, and any
 * non-fatal warnings raised along the way.
 */
export interface InstallResult {
  ok: boolean;
  packageName: string;
  version: string;
  type: PackageType;
  installPath: string;
  manifest: MarketplacePackageManifest;
  rollbackBranch?: string;
  warnings: string[];
}
