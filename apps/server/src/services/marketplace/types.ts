/**
 * Shared types for the marketplace install service. Consumed by the source
 * manager, cache, resolver, permission preview builder, conflict detector,
 * transaction engine, and every install/uninstall/update flow.
 *
 * @module services/marketplace/types
 */
import type { CreateAgentOptions } from '@dorkos/shared/mesh-schemas';
import type {
  MarketplacePackageManifest,
  PackageType,
  ShapePackageManifest,
  SourceKey,
} from '@dorkos/marketplace';
import type { NpmDependency } from './lib/npm-dependencies.js';
import type { DisclosedEffects } from './disclosed-effects.js';
import type { PackageFileNotice } from '@dorkos/shared/marketplace-schemas';
import type { InstalledFiles, RecordSource } from './lib/installed-files.js';

/**
 * Describes a package install, uninstall or applied update that just succeeded,
 * passed to {@link NotifyPluginsChanged}.
 */
export interface PluginsChangedContext {
  /** The project root the change targeted, or `undefined` for a global change. */
  projectPath?: string;
  /** The RESOLVED manifest name of the package, never the raw install identifier. */
  packageName: string;
  /** Whether the change was an install (applied updates count) or an uninstall. */
  action: 'install' | 'uninstall';
}

/**
 * The post-change notification every surface that mutates installed packages
 * must fire after a successful mutation: it refreshes the Claude runtime's plugin
 * list for the project and runs Harness Sync auto-projection (GAP-4). Built once
 * in `index.ts` and required by both the HTTP router and the marketplace MCP
 * tools, so no surface can install a plugin without setting it up.
 *
 * Fire-and-forget: the implementation never throws and never makes the caller wait.
 */
export type NotifyPluginsChanged = (ctx: PluginsChangedContext) => void;

/**
 * How much a scheduled job may do on its own once it fires.
 *
 * Derived from the Shape manifest's own schedule schema
 * (`SCHEDULE_PERMISSION_MODES` in `@dorkos/marketplace`) so a mode added
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
  /**
   * The skill or command file whose frontmatter declares this hook, when it is
   * one: Claude Code registers such a hook while that skill is in use.
   * Absent for a plugin-wide hook.
   */
  source?: string;
}

/**
 * The tools a skill or command lets the agent use without asking
 * (`allowed-tools` in its frontmatter). A skill is invoked by the model on the
 * strength of its description, so this is permission the package grants itself.
 */
export interface PreviewSkillTools {
  /** Package-relative path of the skill or command file. */
  source: string;
  /** The skill's name, from its frontmatter or its location. */
  skill: string;
  /** Each allowed-tools entry, verbatim. */
  tools: string[];
}

/**
 * A shell command a skill's, command's, agent's or output style's TEXT runs
 * when it is used (DOR-2327):
 * `` !`cmd` `` or a fenced block whose info string is `!`. Claude Code runs it
 * while it renders the skill, before the model sees it; OpenCode runs the
 * inline form in the command wrappers Harness Sync writes for it.
 */
export interface PreviewSkillCommand {
  /** Package-relative path of the skill or command file. */
  source: string;
  /** The skill's name, from its frontmatter or its location. */
  skill: string;
  /** `inline` for `` !`cmd` ``, `block` for a ```` ```! ```` block. */
  form: 'inline' | 'block';
  /** The command exactly as written. */
  command: string;
  /**
   * Whether it names a placeholder (`$ARGUMENTS`, `$1`, a named `$name`) that
   * Claude Code and OpenCode fill with the text typed after the command BEFORE
   * running it, so what it runs depends on that text.
   */
  usesArguments: boolean;
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
   * Whether the package ASKED for the job to be switched on — its declared
   * intent, never a promise about what happens.
   *
   * `true` here does not mean the job starts running: every packaged schedule
   * reaches its row through `upsertFromFile` with `source: 'discovery'`, and
   * `resolveFileArmStatus` parks every first sighting at `pending_approval`
   * whatever this says (ADR `260823-200726`). Shapes additionally create a
   * schedule disabled when its agent is missing at apply time, which the preview
   * cannot know in advance — so this is always the more permissive of the
   * possible outcomes, and user-facing copy must describe it as a request
   * (`describeScheduleArrival` in `@dorkos/shared/marketplace-schemas`).
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
  /**
   * The executable content a person's approval was bound to, for callers that
   * hold one (DOR-647).
   *
   * `install()` resolves the package a SECOND time, so this is what it checks its
   * own resolve against before writing anything: an approval covering `echo hi`
   * must not install a package that now declares `curl … | sh`. Absent for the CLI
   * and the cockpit route, which resolve once and install what they resolved —
   * there is no earlier disclosure for them to be inconsistent with.
   *
   * Deliberately NOT part of `InstallRequestBodySchema`: it is a server-internal
   * hand-off from the approval gate to the installer, and a value an HTTP caller
   * could set would be a value an HTTP caller could set to `null`.
   */
  approvedDisclosure?: DisclosedEffects | null;
  /**
   * `update()` only: the exact install root to replace — the installation an
   * update check resolved. Without it, `update()` finds its target by name,
   * first root wins, so a plugin and an agent of one name would resolve to the
   * plugin whichever the check was about. Server-internal, like
   * `approvedDisclosure`: no HTTP body schema carries it.
   */
  installRoot?: string;
  /**
   * The installer's hand-off to the flows so an install keeps the person's
   * files (DOR-2245): where the package came from, for the installed-files
   * record, and how to rebuild the record of an install made before records
   * existed. Server-internal: set by `MarketplaceInstaller.install()` only.
   */
  ownership?: InstallOwnershipContext;
  /**
   * The content hash a person was shown for the staged package
   * (`lib/content-hash.ts`, DOR-2306). For an agent package, `install()`
   * refuses a staged copy that hashes differently before writing anything
   * (DOR-2325): the app creates a marketplace agent through this installer, and
   * a source that moved after the preview is not the agent the person chose.
   * Server-internal: the agents route sets it from what the app sent back, and
   * an agent's install (`POST /packages/:name/install`, `marketplace_install`)
   * from the hash its approval card bound.
   */
  approvedContentHash?: string;
  /**
   * Agent packages only (DOR-2325): the identity a person chose for the agent
   * in the app's creation flow, applied as the agent is created in the
   * package's install folder. Server-internal, set by the agents route.
   */
  agentIdentity?: AgentInstallIdentity;
}

/** See {@link InstallRequest.agentIdentity}. */
export type AgentInstallIdentity = Pick<
  CreateAgentOptions,
  'displayName' | 'icon' | 'color' | 'persona' | 'runtime' | 'capabilities' | 'model' | 'effort'
>;

/** See {@link InstallRequest.ownership}. */
export interface InstallOwnershipContext {
  /** Where the package came from. */
  source?: RecordSource;
  /** Rebuild a legacy install's record; `null` when none can be rebuilt. */
  rebuildLegacy?: (liveRoot: string, stagedTree: string) => Promise<InstalledFiles | null>;
  /**
   * Finish the staged tree before its installed-files record is computed, so
   * the record holds every file as installed (DOR-2318: `skillRef` schedules).
   */
  prepareStaged?: (stagingDir: string) => Promise<void>;
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
  /** MCP servers the package starts, with what each runs */
  mcpServers: PreviewMcpServer[];
  /** Language (LSP) servers the package starts, with what each runs */
  lspServers: PreviewLspServer[];
  /** Background monitors the package runs */
  monitors: PreviewMonitor[];
  /** Programs the package puts on the agent's PATH (the files in its `bin/`) */
  executables: string[];
  /** Tools each skill or command lets the agent use without asking */
  skillTools: PreviewSkillTools[];
  /** Shell commands each skill's or command's text runs when it is used */
  skillCommands: PreviewSkillCommand[];
  /** Program declarations (MCP, LSP, monitors) that could not be read */
  unreadableDeclarations: UnreadableDeclaration[];
  /**
   * Shortcuts (symbolic links) in the package, each with a sentence saying it
   * will not be installed: staging drops every link (DOR-2319).
   */
  skippedLinks: { path: string; message: string }[];
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
 * An MCP server a package starts, as Claude Code would launch it. A plugin's
 * servers load into every session the plugin loads in, so a person approving
 * the install has to see what each one runs: the command and its arguments
 * verbatim for a local (`stdio`) server, the address for a remote one.
 */
export interface PreviewMcpServer {
  /** The server's name, the key it is declared under. */
  name: string;
  /** `stdio` for a local command, else the declared remote transport (`http`, `sse`, …). */
  transport: string;
  /** The program a `stdio` server runs, verbatim. */
  command?: string;
  /** Its arguments, verbatim and in order. */
  args?: string[];
  /** The address a remote server is reached at. */
  url?: string;
}

/** A language (LSP) server a package starts, as Claude Code would launch it. */
export interface PreviewLspServer {
  /** The server's name, the key it is declared under. */
  name: string;
  /** The program it runs, verbatim. */
  command: string;
  /** Its arguments, verbatim and in order. */
  args: string[];
}

/** A background monitor a package runs: a command Claude Code keeps running. */
export interface PreviewMonitor {
  /** The monitor's declared name. */
  name: string;
  /** The command it runs, verbatim. */
  command: string;
  /** When it starts (`always`, or `on-skill-invoke:<skill>`), when declared. */
  when?: string;
}

/** Which kind of program a declaration we could not read was for. */
export type UnreadableDeclarationKind = 'mcp-server' | 'lsp-server' | 'monitor';

/**
 * A program declaration the package ships that could not be read, or that
 * points outside the package. Reported for the reason {@link UnreadablePreviewHook}
 * is: "declares something we could not read" must never render as "declares none".
 */
export interface UnreadableDeclaration {
  /** Package-relative path of the declaration (a default file, or where plugin.json points). */
  path: string;
  /** Which kind of program it declares. */
  kind: UnreadableDeclarationKind;
  /** Set when one entry is malformed; absent when the whole declaration is. */
  entry?: string;
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
  /**
   * The subset of {@link InstallResult.warnings} describing npm dependency
   * problems (DOR-1341). Carried separately because these are the warnings
   * that outlive the install: the installer persists them to the package's
   * `install-metadata.json` sidecar, and the installed-package view keeps
   * showing them until a reinstall clears them. A toast the person dismissed
   * is not a record of a package that is still missing its libraries.
   */
  dependencyWarnings?: string[];
  /**
   * What the install did with files the person may have changed (DOR-2245).
   * Each notice is also one plain sentence on {@link InstallResult.warnings}.
   */
  fileNotices?: PackageFileNotice[];
}

/**
 * Looks up the commit a ref points at. Throws on a refused address; may return
 * a placeholder (test it with `isRealCommitSha`). The update flow passes a
 * memoized one, so packages from one repository share a lookup.
 */
export type CommitLookup = (cloneUrl: string, ref: string) => Promise<string>;

/**
 * What installing a package right now would give, as far as
 * `MarketplaceInstaller.resolveLatest` could tell.
 *
 * - `unchanged`: the source, the entry version and the commit all equal what
 *   the install recorded, so nothing was staged.
 * - `resolved`: the package was staged and validated; these are the facts
 *   Claude Code's chain reads a version from (`resolvePackageVersion`).
 * - `unresolved`: the check could not answer, and `reason` says why in words
 *   a person can read.
 */
export type LatestResolution =
  | { kind: 'unchanged' }
  | {
      kind: 'resolved';
      /** The version the staged tree declares (`readDeclaredVersion`). */
      declaredVersion?: string;
      /** The marketplace entry's own `version`. */
      entryVersion?: string;
      /** The commit staging fetched, when it resolved a real one. */
      commitSha?: string;
      /** Where it was fetched from; absent for `file://` sources. */
      sourceKey?: SourceKey;
    }
  | { kind: 'unresolved'; reason: string };

/** Options for `MarketplaceInstaller.resolveLatest`. */
export interface ResolveLatestOptions {
  /** What the install's sidecar recorded; every field may be absent on older sidecars. */
  installed: { commitSha?: string; entryVersion?: string; sourceKey?: SourceKey };
  /** How to look up a ref's current commit (memoized by the caller). */
  commitLookup: CommitLookup;
}
