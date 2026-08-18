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
 *   - `apps/server/src/services/shapes/apply-shape.ts` — ApplyShapeResult, AppliedShape,
 *     OfferedAgent, ShapeLayout (DOR-355 §5/§9)
 *   - `apps/server/src/services/shapes/shape-services.ts` — InstalledShapeSummary
 *   - `apps/server/src/services/shapes/fork.ts` — ForkShapeResult (DOR-402)
 *   - `packages/marketplace` — MarketplaceJsonEntry, MarketplacePackageManifest, PackageType
 *
 * @module shared/marketplace-schemas
 */
import type { PermissionMode } from './schemas.js';

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
export type MarketplacePackageType = 'agent' | 'plugin' | 'skill-pack' | 'adapter' | 'shape';

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
  /** Package name (primary identifier — kebab-case slug). */
  name: string;
  /**
   * Human-readable display name from the DorkOS sidecar (`dorkos.json`), when
   * the author supplies one. Absent for packages that ship only a slug — the
   * UI humanizes `name` in that case, so template cards never show raw slugs.
   */
  displayName?: string;
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
  /**
   * DorkOS extension: adapter type identifier from the sidecar, mirroring the
   * package manifest's `adapterType` (e.g. `'slack'`, or the well-known
   * `'connector'` marking a connector-gateway package — `CONNECTOR_ADAPTER_TYPE`
   * in `@dorkos/marketplace`). Present only for adapter packages whose sidecar
   * declares it; absent for every other package type.
   */
  adapterType?: string;
  /** DorkOS extension: browsing category (primary — equals `categories[0]` when present). */
  category?: string;
  /** DorkOS extension: controlled multi-membership categories (ADR-0236 sidecar). */
  categories?: string[];
  /** DorkOS extension: searchable tags. */
  tags?: string[];
  /** DorkOS extension: icon emoji or identifier. */
  icon?: string;
  /** DorkOS extension: whether to highlight in the browse UI. */
  featured?: boolean;
  /**
   * Total successful community installs, enriched server-side from the public
   * dorkos.ai telemetry endpoint (`0` when the package has no recorded
   * installs). Absent when counts are unavailable — a cold server cache or an
   * unreachable dorkos.ai — so the client hides the Popular sort whenever no
   * package carries a count and the marketplace works fully offline.
   */
  installCount?: number;
  /**
   * Registry-derived recency: the ISO 8601 timestamp of the last commit that
   * touched this package's directory in the `dork-labs/marketplace` registry,
   * enriched server-side from the public dorkos.ai endpoint
   * (`GET /api/telemetry/updated-at`). Present only for community packages that
   * live inside the registry repo — a package sourced from an external repo has
   * no registry directory, so it honestly carries no timestamp. Absent whenever
   * dates are unavailable (a cold server cache, an unreachable dorkos.ai, or a
   * telemetry kill switch), so the client hides the Recent sort and the
   * marketplace works fully offline.
   */
  updatedAt?: string;
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
  /**
   * Raw markdown of the package's root `README.md`, read from the staged clone
   * (case-insensitive, capped at 200 KB). Omitted when the package ships no
   * README so the UI renders nothing rather than an empty section.
   */
  readme?: string;
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
  /**
   * DorkOS extension: adapter type identifier, mirroring the manifest's
   * `adapterType` (e.g. `'slack'`, or the well-known `'connector'` value —
   * `CONNECTOR_ADAPTER_TYPE` in `@dorkos/marketplace`). The install route
   * returns the full adapter manifest, so this rides through on adapter
   * installs and lets a post-install surface route to the matching Connections
   * region. Absent for every other package type.
   */
  adapterType?: string;
}

// ---------------------------------------------------------------------------
// Permission preview
// ---------------------------------------------------------------------------

/**
 * How much a scheduled job may do on its own once it fires.
 *
 * Aliased to this package's own {@link PermissionMode} rather than redeclared:
 * `PermissionModeSchema` lives one file over in `schemas.ts`, and
 * `@dorkos/marketplace` already pins its `SHAPE_SCHEDULE_PERMISSION_MODES`
 * against it with a drift test. A fourth hand-written copy of the same six
 * strings could only ever go stale. The import is type-only, so it erases at
 * compile time and this file stays browser-safe.
 */
export type SchedulePermissionMode = PermissionMode;

/**
 * Plain-language summary of what a scheduled job may do on its own, keyed by
 * permission mode.
 *
 * Read by every install preview surface (the cockpit dialog and `dorkos
 * install`) so nobody has to decode a raw id like `bypassPermissions` while
 * deciding whether to trust a stranger's package. Each entry completes the
 * sentence "This job ...". Use {@link describeSchedulePermissionMode} rather
 * than indexing this map directly, so a mode the server learns before the
 * client does still renders something true.
 *
 * ## Why these sentences say less than they used to
 *
 * A mode id means different things on different runtimes. `acceptEdits` on
 * Claude Code edits files and stops before a command; on Codex the same id runs
 * commands too and cannot pause to ask at all. This map used to assert Claude
 * Code's behavior for everyone, which shipped a false promise to anyone running
 * a package's schedule on another runtime.
 *
 * A package manifest names no runtime, and an install preview has no session, so
 * there is nothing here to resolve a runtime profile from — the honest fix is to
 * claim only what is true of the mode on every runtime that declares it. Where a
 * runtime IS known, say more, not less: read
 * `PermissionModeDescriptor.promise` from its capability profile, which is what
 * the Trust Dial renders (spec `trust-dial`, decision 2A).
 */
export const SCHEDULE_PERMISSION_MODE_SUMMARY: Record<SchedulePermissionMode, string> = {
  default: 'runs at the most careful setting its agent offers',
  plan: 'can only read and plan, and cannot change anything',
  acceptEdits: 'can change files on its own, and on some agents run commands too',
  dontAsk: 'runs its tools without asking you',
  bypassPermissions: 'can run any command without asking you',
  auto: 'decides for itself which actions are safe to take',
};

/**
 * Describe what a scheduled job may do on its own, in plain words.
 *
 * @param mode - The permission mode the job runs under, as sent by the server.
 * @returns A phrase completing "This job ...". An unrecognised mode falls back
 *   to naming it and admitting we do not know, which is honest; claiming the
 *   job is safe would not be.
 */
export function describeSchedulePermissionMode(mode: string): string {
  return (
    SCHEDULE_PERMISSION_MODE_SUMMARY[mode as SchedulePermissionMode] ??
    `runs in "${mode}" mode, which this version of DorkOS does not recognise`
  );
}

/**
 * Plain-language phrasing for the harness hook events, keyed by Claude's event
 * name.
 *
 * Each entry completes the sentence "Runs ...". `PreToolUse` tells a
 * non-developer nothing; "before the agent uses a tool" tells them when the
 * command fires. Use {@link describeHookEvent}, never this map directly — the
 * event is an open string and a package may declare one that is not listed
 * here.
 */
export const HOOK_EVENT_SUMMARY: Record<string, string> = {
  SessionStart: 'when a session starts',
  SessionEnd: 'when a session ends',
  UserPromptSubmit: 'when you send a message',
  PreToolUse: 'before the agent uses a tool',
  PostToolUse: 'after the agent uses a tool',
  PermissionRequest: 'when the agent asks for permission',
  Notification: 'when the agent sends a notification',
  SubagentStart: 'when a subagent starts',
  SubagentStop: 'when a subagent finishes',
  Stop: 'when the agent finishes',
  PreCompact: 'before the conversation is shortened',
  PostCompact: 'after the conversation is shortened',
};

/**
 * Describe when a hook fires, in plain words.
 *
 * @param event - The harness event name the package declared.
 * @param matcher - Optional tool/event matcher the hook narrows to.
 * @returns A phrase completing "Runs ...". An event with no known phrasing
 *   falls back to naming it verbatim, which is still true.
 */
export function describeHookEvent(event: string, matcher?: string): string {
  const when = HOOK_EVENT_SUMMARY[event] ?? `on ${event}`;
  return matcher ? `${when} (${matcher})` : when;
}

/**
 * A shell hook a package registers with the harness.
 *
 * Mirrors `PreviewHook` in `apps/server/src/services/marketplace/types.ts`.
 */
export interface PreviewHook {
  /** Harness event the hook fires on (e.g. `PreToolUse`, `Stop`). */
  event: string;
  /** Optional tool/event matcher the hook narrows to. */
  matcher?: string;
  /** The literal shell command the hook runs, verbatim. */
  command: string;
}

/**
 * A hook declaration the package ships that could not be read.
 *
 * Mirrors `UnreadablePreviewHook` in `apps/server/src/services/marketplace/types.ts`.
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
 * Mirrors `PreviewSchedule` in `apps/server/src/services/marketplace/types.ts`.
 */
export interface PreviewSchedule {
  /** Job name as declared by the package. */
  name: string;
  /** Cron expression, or `null` when the job only runs when asked. */
  cron: string | null;
  /** How much the job may do without a human in the loop. */
  permissionMode: SchedulePermissionMode;
  /** Whether the job is created switched on. */
  startsEnabled: boolean;
}

/**
 * One npm library a package will fetch from the registry when it installs.
 *
 * Mirrors `NpmDependency` in
 * `apps/server/src/services/marketplace/lib/npm-dependencies.ts`.
 */
export interface PreviewNpmDependency {
  /** Package name on the npm registry (e.g. `zod`). */
  name: string;
  /** Version range exactly as the package declared it (e.g. `^4.3.6`). */
  range: string;
}

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
  /** Shell hooks the package registers with the harness, commands verbatim. */
  hooks: PreviewHook[];
  /** Hook declarations the package ships that could not be read. */
  unreadableHooks: UnreadablePreviewHook[];
  /** Scheduled jobs that will be created, and what each may do unattended. */
  schedules: PreviewSchedule[];
  /** Secrets the package will request from the user. */
  secrets: { key: string; required: boolean; description?: string }[];
  /**
   * npm libraries the install will download from the registry, read from the
   * `dependencies` map of the package's own `package.json`. Disclosed so the
   * install dialog can name the network fetch before a person approves it.
   */
  npmDependencies: PreviewNpmDependency[];
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
  type:
    | 'package-name'
    | 'slot'
    | 'skill-name'
    | 'task-name'
    | 'cron-collision'
    | 'adapter-id'
    | 'extension-scope';
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

/** Scope origin of an installed package. */
export type PackageScope = 'global' | 'agent-local' | 'override';

/**
 * Capability summary of an installed package — how many commands and skills it
 * ships and whether it contributes lifecycle hooks. Surfaced by the
 * single-package endpoint (`GET /api/marketplace/installed/:name`) only; the
 * list endpoint omits it to keep the scan cheap.
 */
export interface PackageProvides {
  /** Number of slash-command definitions the package ships. */
  commands: number;
  /** Number of skills the package ships. */
  skills: number;
  /** Whether the package ships lifecycle hooks. */
  hooks: boolean;
}

/**
 * One installation of a marketplace package as surfaced by
 * `GET /api/marketplace/installed`. The cross-scope listing returns one entry
 * PER INSTALLATION — a package installed globally and on two agents yields
 * three entries — so consumers can show and manage each scope independently.
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
  /** Scope origin — undefined means global (backward compat). */
  scope?: PackageScope;
  /** Agent project path — set for agent-local and override packages. */
  agentPath?: string;
  /** Registered agent id owning `agentPath` — set by the cross-scope scan. */
  agentId?: string;
  /** Registered agent display name — set by the cross-scope scan. */
  agentName?: string;
  /** Capability counts — populated by the single-package endpoint only. */
  provides?: PackageProvides;
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

// ---------------------------------------------------------------------------
// Install backups
// ---------------------------------------------------------------------------

/**
 * Basename fragment marking a crash-left marketplace install backup
 * directory — `<target>.dorkos-bak-<timestamp>-<uuid>`. Written by
 * `apps/server/src/services/marketplace/transaction.ts` when it moves an
 * existing install target aside before activation (see ADR-0304); a hard
 * crash between the move-aside and the transaction's own cleanup/rollback
 * leaves one of these on disk. Consumed by
 * `apps/server/src/services/marketplace/backup-janitor.ts` (sweeps stale
 * ones at server startup) and by `packages/mesh/src/discovery/unified-scanner.ts`
 * (excludes them from discovery unconditionally, regardless of location).
 *
 * Shared here — rather than the mesh package importing server code, which
 * the hexagonal layering forbids — because both `apps/server` and
 * `packages/mesh` already depend on `@dorkos/shared`.
 */
export const MARKETPLACE_BACKUP_DIR_MARKER = '.dorkos-bak-';

// ---------------------------------------------------------------------------
// Shapes (DOR-355) — the fifth package type's list/apply API response shapes.
//
// These mirror the server contract frozen in spec §5/§9 (`applyShape` returns
// `{ ok, applied, warnings[], offeredAgents[] }`, and `applied` carries the
// resolved chrome the client restores WITHOUT a second fetch). The server keeps
// its own structurally-identical types + local Zod OpenAPI mirrors; these are
// the browser-safe view the client transport + switcher UI consume.
// ---------------------------------------------------------------------------

/**
 * The workspace chrome a Shape restores on apply (`ShapeLayoutSchema`). The
 * literal unions mirror `UiSidebarTab` / `UiPanelId` (`./types`) — redeclared
 * here to keep this module import-free and browser-safe.
 */
export interface ShapeLayout {
  /** Sidebar open on arrival. */
  sidebarOpen: boolean;
  /**
   * Sidebar tab to select on arrival, when the Shape pins one. Any registered
   * tab id — a built-in (`overview` | `sessions` | `schedules` | `connections`)
   * or an extension-contributed tab (e.g. `linear-issues:linear-loop-sidebar`),
   * mirroring `UiSidebarTab` (`./types`).
   */
  sidebarTab?: string;
  /** Panels to open on arrival. */
  openPanels: ('settings' | 'tasks' | 'relay' | 'picker')[];
  /** Extension dashboard-section ids to order first (ordering hint only). */
  focusDashboardSections: string[];
}

/** Scaffold seed for an offered agent (mirrors the manifest `template`). */
export interface ShapeAgentTemplate {
  displayName?: string;
  persona?: string;
  runtime?: 'claude-code' | 'codex' | 'opencode';
  capabilities?: string[];
  skills?: string[];
}

/**
 * An agent a Shape surfaces on arrival — offered, never forced (affinity, not
 * ownership). A satisfied `default` is the highlighted arrival offer; an
 * unsatisfied entry carries the `template` to scaffold on accept.
 */
export interface ShapeOfferedAgent {
  /** Shape-local agent slug (`agents[].ref`). */
  ref: string;
  /** Soft affinity — `default` is the arrival offer, `suggested` is listed only. */
  affinity: 'suggested' | 'default';
  /** True when an existing agent already satisfies this entry (`matchName` hit). */
  satisfied: boolean;
  /** The single highlighted arrival offer (satisfied-or-offered `default`). */
  arrival: boolean;
  /** The server asks the client to switch into this agent (satisfied default + opt-in). */
  autoFollow: boolean;
  /** Resolved agent id, when satisfied. */
  agentId?: string;
  /** Resolved agent project path, when satisfied (the `switch_agent` target). */
  projectPath?: string;
  /** Display name for the offer card. */
  displayName: string;
  /** Scaffold seed for an unsatisfied offer. */
  template?: ShapeAgentTemplate;
  /**
   * Human cadence line ("Every weekday at 9:00 AM") derived server-side from
   * the Shape's schedule bound to this agent. Absent when the Shape declares
   * no describable schedule for it — consumers show no schedule line then.
   */
  scheduleSummary?: string;
}

/**
 * The resolved outcome the client acts on without a second fetch — the
 * `applied` field of the apply response.
 */
export interface AppliedShape {
  /** The chrome to restore (sidebar, panels, dashboard focus). */
  layout: ShapeLayout;
  /** Extension ids actually enabled this apply (post-degradation). */
  activatedExtensions: string[];
  /**
   * Extension ids turned OFF this apply because they belonged to the outgoing
   * Shape and this Shape does not declare them — the swap that stops Shapes from
   * piling their extensions on. Empty/absent when nothing was swapped out.
   */
  deactivatedExtensions?: string[];
  /** Schedule names created this apply (idempotent skips excluded). */
  schedulesCreated: string[];
  /**
   * Schedule names re-bound this apply: created global/disabled by an earlier
   * apply (their agent was missing), now re-targeted to the agent and enabled
   * because the agent exists.
   */
  schedulesRebound: string[];
  /**
   * Schedule names deleted this apply because an earlier version of this Shape
   * created them but the current manifest no longer declares them (a rename or
   * drop). Provenance-gated to this Shape. Empty/absent when nothing was dropped.
   */
  schedulesRemoved?: string[];
}

/** Response body for `POST /api/shapes/:name/apply`. */
export interface ApplyShapeResult {
  /** Always true — the apply only throws for an uninstalled Shape (404). */
  ok: boolean;
  /** The resolved chrome + outcomes the client applies from the response. */
  applied: AppliedShape;
  /** Per-piece degradation notes (spec §7) — surfaced to the user, not the console. */
  warnings: string[];
  /** Agents the Shape offers on arrival (never auto-created). */
  offeredAgents: ShapeOfferedAgent[];
}

/** Fork lineage on a Shape summary — present only on forked Shapes. */
export interface ShapeLineageInfo {
  /** `<name>@<source>` the Shape was forked from. */
  forkedFrom: string;
  forkedFromVersion?: string;
  /** ISO-8601. */
  forkedAt: string;
}

/** One installed Shape as returned by `GET /api/shapes`. */
export interface InstalledShapeSummary {
  /** Shape name (install directory + manifest name). */
  name: string;
  /** Human-facing display name, when the manifest declares one. */
  displayName?: string;
  /** Whether this Shape is the currently-applied one (`ui.shapes.active`). */
  active: boolean;
  /** Fork lineage, present only on forked Shapes. */
  lineage?: ShapeLineageInfo;
}

/**
 * Response body for `POST /api/shapes/:name/fork` — the browser-safe view of the
 * server's `ForkShapeResult`. The forked `manifest` rides along opaquely: no
 * client surface reads it, and typing it here would drag the Zod-3
 * `@dorkos/marketplace` manifest union into the browser bundle.
 */
export interface ForkShapeResult {
  /** Always true — the fork throws (404/409/400) rather than reporting failure. */
  ok: true;
  /** The new Shape's name. */
  name: string;
  /** The `<name>@<source>` lineage stamp on the fork. */
  forkedFrom: string;
  /** Absolute path the new Shape landed at. */
  installPath: string;
  /** The forked manifest, as written to disk. */
  manifest: Record<string, unknown>;
}
