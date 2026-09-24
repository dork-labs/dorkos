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
 *   - `apps/server/src/services/marketplace/flows/update.ts` — UpdateResult, UpdateCheckResult,
 *     InstallationUpdateCheck, InstallationUpdatesResult
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
   * The part of {@link preview} an install approval binds to: everything the
   * package runs on its own, in canonical form. Send it back as
   * `InstallOptions.approvedDisclosure` to install only this (DOR-2306).
   */
  disclosed: DisclosedEffects;
  /**
   * A hash of the package's files as they were staged for this preview. Send
   * it back as `InstallOptions.approvedContentHash`: a globally installed
   * package that runs anything loads into sessions only when its installed
   * copy hashes the same (DOR-2306).
   */
  contentHash: string;
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
 * `@dorkos/marketplace` already pins its `SCHEDULE_PERMISSION_MODES`
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
  dontAsk: 'runs its tools without a permission prompt',
  bypassPermissions: 'can run any command without a permission prompt',
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
 * Describe what happens to a packaged scheduled job before it could first run.
 *
 * ## Why this is not "starts switched on"
 *
 * Because that is false, on every path a preview can describe. `startsEnabled`
 * is the author's `enabled` flag read verbatim, but every schedule a package
 * brings reaches its row through `TaskStore.upsertFromFile` with `source:
 * 'discovery'` — the SKILL.md files the package ships, the ones
 * `materialize-schedules.ts` writes for a plugin manifest, and the ones
 * `shape-schedule-service.ts` writes for a Shape manifest alike — and
 * `resolveFileArmStatus` parks EVERY first sighting at `pending_approval`
 * whatever `enabled` says (ADR `260823-200726`). Intent is not permission.
 *
 * ## Why it lives in shared rather than beside one caller
 *
 * Three surfaces disclose this same fact to the same person — the install
 * confirmation dialog, the agent arrival card (DOR-644), and `dorkos install` in
 * the terminal. The false claim reached all three because each wrote the phrase
 * itself. One function is what stops the next correction landing on two of them.
 *
 * @param startsEnabled - Whether the package ASKED for the job to be on.
 * @returns A phrase completing "…, {phrase}."
 */
export function describeScheduleArrival(startsEnabled: boolean): string {
  return startsEnabled
    ? 'waits for your approval before its first run'
    : 'arrives switched off, and would wait for your approval too';
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
  /** The skill or command file whose frontmatter declares it, when it is one; it runs while that is in use. */
  source?: string;
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
 * An MCP server a package starts, as Claude Code would launch it.
 *
 * Mirrors `PreviewMcpServer` in `apps/server/src/services/marketplace/types.ts`.
 */
export interface PreviewMcpServer {
  /** The server's name, the key it is declared under. */
  name: string;
  /** `stdio` for a local command, else the declared remote transport. */
  transport: string;
  /** The program a `stdio` server runs, verbatim. */
  command?: string;
  /** Its arguments, verbatim and in order. */
  args?: string[];
  /** The address a remote server is reached at. */
  url?: string;
}

/**
 * A language (LSP) server a package starts.
 *
 * Mirrors `PreviewLspServer` in `apps/server/src/services/marketplace/types.ts`.
 */
export interface PreviewLspServer {
  /** The server's name, the key it is declared under. */
  name: string;
  /** The program it runs, verbatim. */
  command: string;
  /** Its arguments, verbatim and in order. */
  args: string[];
}

/**
 * The tools a skill or command lets the agent use without asking.
 *
 * Mirrors `PreviewSkillTools` in `apps/server/src/services/marketplace/types.ts`.
 */
export interface PreviewSkillTools {
  /** Package-relative path of the skill or command file. */
  source: string;
  /** The skill's name. */
  skill: string;
  /** Each allowed-tools entry, verbatim. */
  tools: string[];
}

/**
 * A background monitor a package runs.
 *
 * Mirrors `PreviewMonitor` in `apps/server/src/services/marketplace/types.ts`.
 */
export interface PreviewMonitor {
  /** The monitor's declared name. */
  name: string;
  /** The command it runs, verbatim. */
  command: string;
  /** When it starts (`always`, or `on-skill-invoke:<skill>`), when declared. */
  when?: string;
}

/**
 * A program declaration the package ships that could not be read, or points
 * outside the package.
 *
 * Mirrors `UnreadableDeclaration` in `apps/server/src/services/marketplace/types.ts`.
 */
export interface UnreadableDeclaration {
  /** Package-relative path of the declaration. */
  path: string;
  /** Which kind of program it declares. */
  kind: 'mcp-server' | 'lsp-server' | 'monitor';
  /** Set when one entry is malformed; absent when the whole declaration is. */
  entry?: string;
}

/**
 * When a plugin's own programs (MCP servers, language servers, monitors, the
 * files in its `bin/`) actually run, in one sentence every consent surface shares.
 * A globally installed plugin is loaded into every Claude Code session DorkOS
 * starts (`plugin-activation.ts`); a project install is projected as files, and
 * none of these are among them.
 */
export const PLUGIN_PROGRAMS_SCOPE_NOTE =
  'A plugin installed for everyone is loaded into every session, and these start with it. ' +
  'A plugin installed in one project does not start them.';

/**
 * A program and its arguments, each quoted exactly as it will be passed and with
 * hidden characters shown, so a person reads the argument boundaries a plain
 * space-joined line would blur.
 *
 * @param command - The program, verbatim.
 * @param args - Its arguments, verbatim and in order.
 * @returns One line, every part JSON-quoted.
 */
export function describeProgramLine(command: string, args: readonly string[] = []): string {
  return [command, ...args].map((part) => revealHiddenCharacters(JSON.stringify(part))).join(' ');
}

/**
 * Characters that change how text around them is displayed without being seen:
 * bidirectional controls (which can make `rm -rf ~` read as something else) and
 * zero-width characters.
 */
const HIDDEN_CHARACTERS =
  /[\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Show every invisible or direction-changing character in a string a person is
 * about to approve, as a visible `<U+202E>` marker, so a command reads exactly
 * as it will run. Used wherever a package's command, argument or address is
 * displayed for consent: the install preview, `dorkos install`, and the update
 * approval card.
 *
 * @param text - Text taken verbatim from a package.
 * @returns The same text with each hidden character replaced by its code point.
 */
export function revealHiddenCharacters(text: string): string {
  return text.replace(
    HIDDEN_CHARACTERS,
    (ch) => `<U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`
  );
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
  /**
   * Whether the package asked for the job to be switched on. Its declared
   * intent, not an outcome: `resolveFileArmStatus` parks every packaged
   * schedule at `pending_approval` on first sighting whatever this says.
   */
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
  /**
   * True for an `optionalDependencies` entry. npm installs these by default, so
   * they are disclosed like any other; the flag only says this one is allowed
   * to fail without failing the install.
   */
  optional?: boolean;
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
  /** MCP servers the package starts, with what each runs. */
  mcpServers: PreviewMcpServer[];
  /** Language (LSP) servers the package starts. */
  lspServers: PreviewLspServer[];
  /** Background monitors the package runs. */
  monitors: PreviewMonitor[];
  /** Programs the package puts on the agent's PATH (the files in its `bin/`). */
  executables: string[];
  /** Tools each skill or command lets the agent use without asking. */
  skillTools: PreviewSkillTools[];
  /** Program declarations that could not be read or point outside the package. */
  unreadableDeclarations: UnreadableDeclaration[];
  /** Scheduled jobs that will be created, and what each may do unattended. */
  schedules: PreviewSchedule[];
  /** Secrets the package will request from the user. */
  secrets: { key: string; required: boolean; description?: string }[];
  /**
   * npm libraries the install will download, read from the `dependencies` and
   * `optionalDependencies` maps of the package's own `package.json`. Disclosed
   * so the install dialog can name the network fetch before a person approves
   * it. These are the DECLARED libraries — each brings its own dependencies,
   * so the number actually downloaded is this many or more, and the UI copy
   * says so rather than implying an exact count.
   */
  npmDependencies: PreviewNpmDependency[];
  /** External hosts the package will contact. */
  externalHosts: string[];
  /** Other packages this package depends on. */
  requires: { type: string; name: string; version?: string; satisfied: boolean }[];
  /** Conflicts with already-installed packages. */
  conflicts: ConflictReport[];
}

// ---------------------------------------------------------------------------
// Disclosed effects — what an approval attests to
// ---------------------------------------------------------------------------

/** One shell command a package declares, as the approval showed it. */
export interface DisclosedHook {
  /** Harness event the command fires on (e.g. `PreToolUse`, `Stop`). */
  event: string;
  /** Tool/event matcher the hook narrows to; `null` when it matches everything. */
  matcher: string | null;
  /** The literal shell command, verbatim — never paraphrased or normalized. */
  command: string;
  /** The skill or command file it belongs to (it runs while that is in use); `null` for a plugin hook. */
  source: string | null;
}

/** A skill or command's `allowed-tools`: tools it may use without asking. */
export interface DisclosedSkillTools {
  /** Package-relative path of the skill or command. */
  source: string;
  /** The skill's name. */
  skill: string;
  /** Each allowed-tools entry, verbatim. */
  tools: string[];
}

/** One scheduled job the install would create, and what it may do unattended. */
export interface DisclosedSchedule {
  /** Job name as the package declares it. */
  name: string;
  /** Cron expression, or `null` when the job only runs when asked. */
  cron: string | null;
  /** How much the job may do without a person in the loop, after the clamp. */
  permissionMode: string;
  /**
   * Whether the package asked for the job to be switched on. Its declared
   * intent, not an outcome: every packaged schedule is parked at
   * `pending_approval` on first sighting whatever this says.
   */
  startsEnabled: boolean;
}

/** One MCP server a package starts, as the approval showed it. */
export interface DisclosedMcpServer {
  /** The server's declared name. */
  name: string;
  /** `stdio` for a local program, else the remote transport. */
  transport: string;
  /** The program a local server runs, verbatim; `null` for a remote one. */
  command: string | null;
  /** Its arguments, verbatim and in order; empty for a remote server. */
  args: string[];
  /** The address a remote server connects to; `null` for a local one. */
  url: string | null;
}

/** One language server or monitor: a named program and how it is started. */
export interface DisclosedProgram {
  /** Its declared name. */
  name: string;
  /** The program it runs, verbatim. */
  command: string;
  /** Its arguments, verbatim and in order. */
  args: string[];
  /** When it starts, for a monitor that says; `null` otherwise. */
  when: string | null;
}

/**
 * Everything executable a package declares, in the canonical shape an approval
 * binds to (DOR-647, DOR-2195): the subset of a {@link PermissionPreview} that
 * runs on its own. Hooks keep declaration order (they run in it); everything
 * else is sorted, so the value does not move when a directory listing does.
 *
 * Built only by the server (`disclosedEffectsOf` in
 * `apps/server/src/services/marketplace/disclosed-effects.ts`). A client shows
 * it and sends it back untouched as what the person was shown (DOR-2306); the
 * server compares it with the version it resolves now and refuses any other.
 */
export interface DisclosedEffects {
  /** Every hook command the package declares, in declaration order. */
  hooks: DisclosedHook[];
  /** Every scheduled job the install would create, sorted. */
  schedules: DisclosedSchedule[];
  /** Every MCP server the package starts, sorted by name. */
  mcpServers: DisclosedMcpServer[];
  /** Every language server the package starts, sorted by name. */
  lspServers: DisclosedProgram[];
  /** Every background monitor the package runs, sorted by name. */
  monitors: DisclosedProgram[];
  /** The names of the commands the package puts on the agent's PATH, sorted. */
  executables: string[];
  /** Every skill or command's allowed tools, sorted by file. */
  skillTools: DisclosedSkillTools[];
}

/**
 * Whether a disclosure names anything that runs on its own: a hook, a program,
 * a scheduled job, or a skill allowed to use tools without asking. `null`
 * (nothing was previewed) runs nothing.
 *
 * @param effects - A disclosure, or `null`.
 * @returns True when a person has something to read before approving.
 */
export function disclosesAnything(effects: DisclosedEffects | null | undefined): boolean {
  if (!effects) return false;
  return (
    effects.hooks.length +
      effects.schedules.length +
      effects.mcpServers.length +
      effects.lspServers.length +
      effects.monitors.length +
      effects.executables.length +
      effects.skillTools.length >
    0
  );
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
  /**
   * What the person was shown this package runs: the preview's `disclosed`,
   * sent back untouched. The install refuses a package that now runs anything
   * else, before writing anything, and a person's install of a global plugin
   * is then recorded as their approval to load it (DOR-2306).
   */
  approvedDisclosure?: DisclosedEffects;
  /** The preview's `contentHash`, sent back with {@link approvedDisclosure}. */
  approvedContentHash?: string;
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
  /**
   * The subset of `warnings` describing npm dependency problems (DOR-1341).
   * Persisted to the package's install-metadata sidecar, so the installed-package
   * view keeps reporting an incomplete package after the toast is gone.
   */
  dependencyWarnings?: string[];
  /**
   * What the install did with files the person may have changed (DOR-2245).
   * Each notice is also one plain sentence on {@link InstallResult.warnings}.
   */
  fileNotices?: PackageFileNotice[];
}

/**
 * What an install did with a file the person may have changed (DOR-2245).
 * Paths are POSIX, relative to the install root.
 */
export interface PackageFileNotice {
  /** The file the notice is about. */
  path: string;
  /**
   * - `replaced-edit`: the package's copy is in place; the person's is at `savedAs`.
   * - `kept-edit`: the person's copy is in place; the package's new default is at `savedAs`.
   * - `kept-no-longer-shipped`: the person's copy is in place; the package no longer ships this file.
   * - `late-write`: it changed while the update ran; the newest copy is in place
   *   (the person's at `savedAs` when it collided with a package file).
   * - `skipped-special`: a socket, pipe or device file, which was not copied.
   */
  outcome:
    'replaced-edit' | 'kept-edit' | 'kept-no-longer-shipped' | 'late-write' | 'skipped-special';
  /** Where the other copy was saved, when one was written. */
  savedAs?: string;
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

/**
 * Options for `POST /api/marketplace/packages/:name/uninstall`.
 */
export interface UninstallOptions {
  /** Also remove the files you and your agents added or changed. */
  purge?: boolean;
  /** Project path for project-local uninstalls. */
  projectPath?: string;
}

/** Options for {@link Transport.prepareMarketplacePackage} (DOR-2320). */
export interface PrepareOptions {
  /** Project path, for an installation scoped to a project or an agent. */
  projectPath?: string;
  /** The one installation to prepare, as the installed list names it (`installPath`). */
  installRoot?: string;
}

/**
 * What preparing a package an older DorkOS installed did (DOR-2320): only
 * `rebuilt` wrote anything, and `message` says the outcome in one sentence.
 */
export interface PrepareResult {
  outcome: 'rebuilt' | 'not-needed' | 'no-source' | 'fetch-failed' | 'mismatch';
  message: string;
}

/** Options for listing installed packages. */
export interface ListInstalledOptions {
  /** Add each installation's {@link InstallIntegrity}; reads every shipped file (DOR-2197). */
  verify?: boolean;
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
  /**
   * Absolute paths kept on disk because `purge` was false: the files you and
   * your agents added or changed, collapsed to the highest directory whose
   * whole contents were kept.
   */
  preservedData: string[];
  /**
   * Set when uninstalling an agent package removed the agent from the team
   * (DOR-2245). A reinstall restores none of {@link AgentRemovedSummary.removed}.
   */
  agentRemoved?: AgentRemovedSummary;
  /** Non-fatal notes, such as a cleanup the recovery sweep will finish later. */
  warnings?: string[];
}

/** Something removing an agent from the team takes away with it. */
export type AgentRemovalEffect =
  | 'relay-endpoint'
  | 'rooms'
  | 'schedules-paused'
  | 'task-roots'
  | 'mcp-sign-ins'
  | 'identity-tokens'
  | 'community-enrollments'
  | 'connection-access';

/** What uninstalling an agent package did to the agent itself. */
export interface AgentRemovedSummary {
  /** The removed agent's id. */
  id: string;
  /** True when git tracks its `agent.json`, so the file stayed and the folder was denied instead. */
  directoryDenied: boolean;
  /** Everything removal took away. */
  removed: AgentRemovalEffect[];
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Where a package's version came from, in Claude Code's order: the version
 * the package declares, its marketplace entry's, or the commit it was fetched
 * at. Declared here as a literal union because this package does not depend
 * on `@dorkos/marketplace`, whose `VersionSource` is its twin.
 */
export type UpdateVersionSource = 'package' | 'index' | 'commit';

/**
 * A single comparison result for one installed package.
 *
 * Mirrors `UpdateCheckResult` in `apps/server/src/services/marketplace/flows/update.ts`.
 */
export interface UpdateCheckResult {
  packageName: string;
  /** The installed version, or the full commit SHA when its source is `'commit'`. */
  installedVersion: string;
  /** What installing now would give; `''` when `status === 'unknown'`. */
  latestVersion: string;
  /** Always `status === 'update-available'`. */
  hasUpdate: boolean;
  /** The marketplace the package was checked against; `''` for direct installs and unknowns. */
  marketplace: string;
  /** `unknown` means the check could not answer; `note` says why. Never read as current. */
  status: 'current' | 'update-available' | 'unknown';
  /** Which step of Claude Code's chain the installed version came from. */
  installedVersionSource?: UpdateVersionSource;
  /** Which step of Claude Code's chain the latest version came from. */
  latestVersionSource?: UpdateVersionSource;
  /** Why a check is `unknown`, or a caveat on a known answer (a rollback, a default branch). */
  note?: string;
}

/**
 * The result of a one-package update check (`POST /api/marketplace/packages/:name/update`).
 * Advisory: updates are applied only through `POST /api/marketplace/updates`.
 *
 * Mirrors `UpdateResult` in `apps/server/src/services/marketplace/flows/update-types.ts`.
 */
export interface UpdateResult {
  checks: UpdateCheckResult[];
}

/**
 * One installation's update check, returned by `GET /api/marketplace/updates`
 * and `POST /api/marketplace/updates`: the check, the installation's identity in
 * the installed list's own field names (`installPath` joins the two), and after
 * an apply, what happened to it.
 *
 * Mirrors `InstallationUpdateCheck` in `apps/server/src/services/marketplace/flows/update.ts`.
 */
export interface InstallationUpdateCheck extends UpdateCheckResult {
  /** Absolute path to the installation; unique per installation, unlike the name. */
  installPath: string;
  /** The installed package's type. */
  type: MarketplacePackageType;
  /** `global`, or `agent-local` / `override` for a project or agent install. */
  scope: PackageScope;
  /** The project directory holding a non-global installation. */
  agentPath?: string;
  /** Registered agent id owning `agentPath`, when known. */
  agentId?: string;
  /** Registered agent display name owning `agentPath`, when known. */
  agentName?: string;
  /**
   * The installation is a symbolic link to a developer's working copy. Present,
   * and `true`, only then: its check is always `unknown` and it is never
   * reinstalled, so this tells "not checked, by design" from "the check failed".
   */
  linked?: true;
  /** Set when an apply reinstalled this installation: what is installed now. */
  applied?: InstallResult;
  /** Set when an apply tried to reinstall this installation and failed: why. */
  applyError?: string;
  /**
   * What the new version would run, read from the version a reinstall would
   * install. Present on every `update-available` check; `null` when nothing
   * was previewed. An update is applied only with this sent back untouched
   * ({@link ApplyUpdateTarget}), so it is what a confirm step must show.
   */
  disclosed?: DisclosedEffects | null;
  /**
   * A hash of the new version's files, as staged for this check. Sent back
   * with {@link disclosed}: the apply refuses a new version whose files moved.
   */
  contentHash?: string;
  /**
   * What the version installed NOW runs, read from its install root, so a
   * confirm step can say what the new version adds or changes.
   */
  installedDisclosed?: DisclosedEffects | null;
}

/**
 * One installation an apply is asked to update, exactly as a check reported
 * it and a person was shown it: which installation, which version, and what
 * that version runs. The server recomputes the last two and refuses the whole
 * apply when either moved (DOR-2306).
 */
export interface ApplyUpdateTarget {
  /** The installation, exactly as a check reported it. */
  installPath: string;
  /** The version the check offered. */
  latestVersion: string;
  /** What that version runs, as the check reported it (`check.disclosed`). */
  disclosed: DisclosedEffects | null;
  /** The check's `contentHash` for that version. */
  contentHash: string;
}

/**
 * Options for `POST /api/marketplace/updates`, which always applies: the
 * transport sends `apply: true` itself.
 *
 * `targets` is required and non-empty, so a client can only ever apply the
 * installations a check reported and a person confirmed, never an unnamed
 * "update everything". The route's `names` filter is left out on purpose: no
 * client surface selects by name.
 */
export interface ApplyUpdatesOptions {
  /** The installations to update. */
  targets: [ApplyUpdateTarget, ...ApplyUpdateTarget[]];
  /** The project whose view the targets came from; omit for the every-scope view. */
  projectPath?: string;
}

/**
 * The all-packages update result: one check per installation in view, in scan
 * order (global installations first, then each agent's).
 *
 * Mirrors `InstallationUpdatesResult` in `apps/server/src/services/marketplace/flows/update.ts`.
 */
export interface InstallationUpdatesResult {
  checks: InstallationUpdateCheck[];
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
  /**
   * DorkOS extension: adapter type identifier from the installed manifest,
   * mirroring `AggregatedPackage.adapterType` (e.g. `'slack'`, or the
   * well-known `'connector'` value — `CONNECTOR_ADAPTER_TYPE` in
   * `@dorkos/marketplace`). Present only for adapter packages whose manifest
   * declares it; absent for every other package type, so the installed view
   * can show the same CONNECTOR badge Browse already shows for it (DOR-710).
   */
  adapterType?: string;
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
  /**
   * Problems installing this package's npm libraries (DOR-1341). Present only
   * when something went wrong, so the installed-package view can say the
   * package is on disk but incomplete, and name the command that fixes it.
   */
  dependencyWarnings?: string[];
  /**
   * The install folder is a symbolic link to a developer's working copy.
   * Present, and `true`, only then. Such an install is never updated in place:
   * its update check is `unknown` and says to update the source instead.
   */
  linked?: true;
  /**
   * Set on a global installation that runs things on its own and is held
   * back from every session because nobody approved it as it is now
   * (DOR-2306). Absent when it loads.
   */
  heldBack?: HeldBackState;
  /**
   * Whether the installed files still match what was installed (DOR-2197).
   * Present only when the caller asked for verification (`?verify=true`).
   */
  integrity?: InstallIntegrity;
}

/** Why a global package is held back from sessions. */
export type HeldBackReason =
  'unasked' | 'refused' | 'unrecorded' | 'unreadable' | 'unreadable-config';

/** A global package held back from every session, and what a person can do about it. */
export interface HeldBackState {
  /**
   * Why it is held back. `unrecorded`: it was installed before DorkOS recorded
   * what an approval binds, so a person reviews it as it is now.
   */
  reason: HeldBackReason;
  /** One plain sentence saying why, and what to do. */
  note: string;
  /**
   * Set for a LINKED install (the install folder is a link to a developer's
   * working copy): the folder it runs from. Its approval covers whatever is in
   * that folder, so the listing and the card say so.
   */
  linkedPath?: string;
  /**
   * Whether an approval card can be raised for it. False when it cannot be
   * shown in full: something in it could not be read, the settings file could
   * not be read, or its list is too long for a card (the terminal can still
   * show it: `dorkos marketplace held-back --allow <name>`).
   */
  reviewable: boolean;
}

/**
 * One held-back global package as `GET /api/marketplace/held-back` lists it:
 * everything a person needs to decide, and what a decision binds.
 */
export interface HeldBackPackage extends HeldBackState {
  /** The package's directory name. */
  name: string;
  /** Its installed version, when recorded. */
  version?: string;
  /** Where it was installed from, when recorded. */
  source?: string;
  /** Whether an earlier approval exists for another install: it changed since then. */
  changedSinceApproval: boolean;
  /** What it runs, when it could be read. Sent back with a decision. */
  effects?: DisclosedEffects;
  /**
   * What an allow or refuse is bound to, when it can be decided: the content
   * hash its install recorded (`sha256:…`), or `linked:<path>` for a linked
   * install. Opaque: send it back with {@link effects} exactly as listed.
   */
  bindsTo?: string;
}

/** Why an install's files cannot be checked against what was installed. */
export type InstallIntegrityUnknownReason = 'no-record' | 'unreadable-record' | 'linked';

/**
 * Whether an install's files still match what was installed (DOR-2197), read
 * from its installed-files record (DOR-2245). Paths are relative to the
 * install folder, sorted, and each list holds at most 50 (`truncated` when
 * there were more).
 *
 * - `clean`: every shipped file is as installed. `customized` names shipped
 *   files the package marks as yours to edit that you changed; those never
 *   count as a modification.
 * - `modified`: `changed` shipped files differ, `missing` ones are gone, and
 *   `added` files sit where a package keeps what it runs (a new skill, a
 *   hook), so they change what runs.
 * - `unknown`: the record cannot speak for the install. `no-record` is an
 *   install made before DorkOS recorded a package's files (it can be prepared);
 *   `unreadable-record` is a damaged record; `linked` is a developer's working
 *   copy.
 */
export type InstallIntegrity =
  | { status: 'clean'; customized: string[]; truncated?: true }
  | {
      status: 'modified';
      changed: string[];
      missing: string[];
      added: string[];
      customized: string[];
      truncated?: true;
    }
  | { status: 'unknown'; reason: InstallIntegrityUnknownReason };

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
 * Basename fragment of the records a marketplace install transaction keeps
 * beside its target — `<target>.dorkos-bak-<timestamp>-<uuid>`, optionally
 * with a `.absent` or `.committed` state suffix. Written by
 * `apps/server/src/services/marketplace/transaction.ts` (the grammar and what
 * each state means live in `.../marketplace/install-recovery.ts`); a crash
 * mid-install leaves one on disk until recovery settles it.
 *
 * Shared here — rather than the mesh package importing server code, which
 * the hexagonal layering forbids — because `apps/server`, `packages/mesh` and
 * `packages/harness` all depend on `@dorkos/shared`.
 */
export const MARKETPLACE_BACKUP_DIR_MARKER = '.dorkos-bak-';

/**
 * Basename fragment of the directory an install stages its new tree in, beside
 * its target — `<target>.dorkos-stage-<createdAt>-<owner>-<uuid>` — so the
 * activation is a same-filesystem rename and the person's carried files never
 * pass through `os.tmpdir()` (DOR-2245). Recovery discards a crash-left one:
 * it only ever holds copies and new package files.
 */
export const MARKETPLACE_STAGE_DIR_MARKER = '.dorkos-stage-';

/**
 * Basename fragment of the directory an in-place uninstall moves a package's
 * own files into, beside its root — `<root>.dorkos-uninstall-<createdAt>-<owner>-<uuid>`
 * (DOR-2245). It carries a journal, and recovery rolls the uninstall back or
 * finishes it by that journal.
 */
export const MARKETPLACE_UNINSTALL_DIR_MARKER = '.dorkos-uninstall-';

/**
 * Every basename marker the install engine writes beside an install target.
 * Anything carrying one of these is the engine's own bookkeeping — never an
 * installed package, agent, plugin or skill — whatever it contains (a backup
 * holds the previous install's valid manifest). A new kind of sibling is added
 * here and in the recovery policy table in
 * `apps/server/src/services/marketplace/install-recovery.ts`.
 */
export const MARKETPLACE_INSTALL_SIBLING_MARKERS: readonly string[] = [
  MARKETPLACE_BACKUP_DIR_MARKER,
  MARKETPLACE_STAGE_DIR_MARKER,
  MARKETPLACE_UNINSTALL_DIR_MARKER,
];

/**
 * Whether a directory entry is one of the install engine's own siblings (see
 * {@link MARKETPLACE_INSTALL_SIBLING_MARKERS}) and must be skipped by anything
 * that lists installed packages, agents, plugins or skills.
 *
 * Deliberately looser than the recovery grammar: a name that carries a marker
 * but not the full `<timestamp>-<uuid>` stamp is still hidden from readers,
 * while recovery leaves it alone. Hiding costs nothing; touching would not.
 *
 * @param name - A basename (not a path).
 */
export function isInstallSiblingName(name: string): boolean {
  return MARKETPLACE_INSTALL_SIBLING_MARKERS.some((marker) => name.includes(marker));
}

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
 * client surface reads it, and typing it here would drag the
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
