/**
 * Shared types for the marketplace install service. Consumed by the source
 * manager, cache, resolver, permission preview builder, conflict detector,
 * transaction engine, and every install/uninstall/update flow.
 *
 * @module services/marketplace/types
 */
import type {
  MarketplacePackageManifest,
  PackageType,
  ShapePackageManifest,
} from '@dorkos/marketplace';
import type { NpmDependency } from './lib/npm-dependencies.js';

/**
 * How much a scheduled job may do on its own once it fires.
 *
 * Derived from the Shape manifest's own schedule schema
 * (`SHAPE_SCHEDULE_PERMISSION_MODES` in `@dorkos/marketplace`) so a mode added
 * there is picked up here without a second list to keep in sync. Task
 * SKILL.md files (`.dork/tasks/<name>/SKILL.md`) declare a narrower set
 * (`acceptEdits` | `bypassPermissions`) that is a subset of these.
 */
export type SchedulePermissionMode = ShapePackageManifest['schedules'][number]['permissionMode'];

/**
 * A shell hook a package registers with the harness. `command` is the literal
 * string that will run, verbatim as the package authored it — the preview must
 * never paraphrase it.
 */
export interface PreviewHook {
  /** Harness event the hook fires on (e.g. `PreToolUse`, `Stop`). */
  event: string;
  /** Optional tool/event matcher the hook narrows to. */
  matcher?: string;
  /** The literal shell command the hook runs. */
  command: string;
}

/**
 * A hook declaration the package ships that could not be read.
 *
 * Surfaced as its own preview field rather than folded into `hooks`: a package
 * that declares hooks we cannot parse is a worse signal than a package with no
 * hooks, and silently returning an empty list would render the two identical.
 */
export interface UnreadablePreviewHook {
  /** Package-relative path of the unreadable declaration (e.g. `hooks/hooks.json`). */
  path: string;
  /** Set when a single event entry is malformed; absent when the whole file is. */
  event?: string;
}

/**
 * A scheduled job the package will create, and how much it may do unattended.
 *
 * Both declaration sites land here: a package's `.dork/tasks/<name>/SKILL.md`
 * files and a Shape manifest's `schedules[]`. The person reading the preview
 * cares that a job will run on a timer, not which file declared it.
 */
export interface PreviewSchedule {
  /** Job name as declared by the package. */
  name: string;
  /** Cron expression, or `null` when the job only runs when asked. */
  cron: string | null;
  /** How much the job may do without a human in the loop. */
  permissionMode: SchedulePermissionMode;
  /**
   * Whether the job is created switched on. Shapes additionally create a
   * schedule disabled when its agent is missing at apply time, which the
   * preview cannot know in advance — so this reports the package's declared
   * intent, which is always the more permissive of the two.
   */
  startsEnabled: boolean;
}

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
 * extension registrations, shell hooks, scheduled jobs, secrets requested,
 * external hosts contacted, dependencies, and conflicts. Surfaced to the user
 * before any disk mutation.
 */
export interface PermissionPreview {
  /** What will be created on disk */
  fileChanges: { path: string; action: 'create' | 'modify' | 'delete' }[];
  /** Extensions that will be registered */
  extensions: { id: string; slots: string[] }[];
  /** Shell hooks the package registers with the harness, commands verbatim */
  hooks: PreviewHook[];
  /** Hook declarations the package ships that could not be read */
  unreadableHooks: UnreadablePreviewHook[];
  /** Scheduled jobs that will be created, and what each may do unattended */
  schedules: PreviewSchedule[];
  /** Secrets the package will request */
  secrets: { key: string; required: boolean; description?: string }[];
  /**
   * npm libraries the install will download from the registry, read from the
   * `dependencies` map of the package's own `package.json`. Disclosed because
   * the install fetches them over the network before the package ever runs, and
   * a person approving an install deserves to know that in advance (DOR-1341).
   */
  npmDependencies: NpmDependency[];
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
  type:
    | 'package-name'
    | 'slot'
    | 'skill-name'
    | 'task-name'
    | 'cron-collision'
    | 'adapter-id'
    | 'extension-scope';
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
  warnings: string[];
}
