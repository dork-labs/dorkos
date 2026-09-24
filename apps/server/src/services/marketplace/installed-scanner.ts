/**
 * Installed-package scanner — walks every install root ({@link
 * installRootsUnder}: `plugins/`, `agents/`, `shapes/`) under every scope in
 * view, reads each package's `.dork/manifest.json`, and merges in the
 * `.dork/install-metadata.json` provenance sidecar where available.
 *
 * A scope is `dorkHome` (the global one) or a project's own `.dork/`. Both hold
 * the same set of roots: `AgentInstallFlow` writes a project-scoped agent to
 * `<projectPath>/.dork/agents/<name>` exactly as the global flow writes
 * `<dorkHome>/agents/<name>`. Every project walk below used to hardcode
 * `plugins/`, which made every project-scoped agent invisible here (DOR-994).
 *
 * Used by the HTTP routes (`GET /api/marketplace/installed`, the update
 * doors), the `marketplace_list_installed` MCP tool and the update flow, so the
 * scan logic lives in one place. One walk yields {@link InstallationRecord}s —
 * the listing's view of each installation plus the declared version and the
 * install sidecar the update check compares — and every list here is a view
 * over those records, so a list and an update check never walk twice.
 *
 * @module services/marketplace/installed-scanner
 */
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PackageType } from '@dorkos/marketplace';
import { PACKAGE_MANIFEST_PATH } from '@dorkos/marketplace/constants';
import { readDeclaredVersion, validatePackage } from '@dorkos/marketplace/package-validator';
import type { PackageProvides } from '@dorkos/shared/marketplace-schemas';
import { isInstallSiblingName } from '@dorkos/shared/marketplace-schemas';
import type { InstallRootDir } from './lib/install-roots.js';
import { installKey, installRootsUnder, projectScopeRoot } from './lib/install-roots.js';
import { readInstallMetadata, type InstallMetadata } from './installed-metadata.js';
import { logger } from '../../lib/logger.js';

/**
 * Scope origin of an installed package.
 */
export type PackageScope = 'global' | 'agent-local' | 'override';

/**
 * Summary of an installed marketplace package — the merged view of the
 * package's `.dork/manifest.json` plus its `.dork/install-metadata.json`
 * provenance sidecar.
 */
export interface InstalledPackage {
  /** Package name from `.dork/manifest.json`. */
  name: string;
  /**
   * The version the package declares (`readDeclaredVersion`: plugin.json's,
   * else the manifest's), falling back to the manifest's — the same version
   * the update check compares and Claude Code runs.
   */
  version: string;
  /** Package type (plugin, agent, skill-pack, adapter). */
  type: PackageType;
  /**
   * Adapter type identifier from the manifest (e.g. `'slack'`, or the
   * well-known `'connector'` value marking a connector-gateway package —
   * `CONNECTOR_ADAPTER_TYPE` in `@dorkos/marketplace`). Present only for
   * adapter packages, mirroring the gate `AggregatedPackage.adapterType`
   * already applies for Browse (DOR-710) — never leaked for non-adapter
   * entries.
   */
  adapterType?: string;
  /** Absolute path to the package root directory. */
  installPath: string;
  /** Marketplace source the package was installed from, if known. */
  installedFrom?: string;
  /** ISO timestamp when the package was installed, if known. */
  installedAt?: string;
  /** Scope origin — undefined means global (backward compat). */
  scope?: PackageScope;
  /** Agent project path — set for agent-local and override packages. */
  agentPath?: string;
  /** Registered agent id owning `agentPath` — set by the cross-scope scan. */
  agentId?: string;
  /** Registered agent display name — set by the cross-scope scan. */
  agentName?: string;
  /** Capability counts — populated on demand by {@link computeProvides}. */
  provides?: PackageProvides;
  /**
   * Problems installing this package's npm libraries, from the
   * `install-metadata.json` sidecar (DOR-1341). Present only when something
   * went wrong, so the installed-package view can say the package is on disk
   * but incomplete, and name the command that finishes the job.
   */
  dependencyWarnings?: string[];
  /**
   * The install folder is a symbolic link to a developer's working copy
   * ({@link InstallationRecord.linked}). Present, and `true`, only then, so a
   * listing can say why such an install is never updated in place.
   */
  linked?: true;
}

/** A registered agent whose project directory the cross-scope scan should walk. */
export interface AgentScopeRef {
  /** Absolute path to the agent's project directory. */
  projectPath: string;
  /** Registered agent id, echoed onto matching installations. */
  id?: string;
  /** Agent display name, echoed onto matching installations. */
  name?: string;
}

/**
 * Scan all installed packages and return only those whose `type` makes
 * them candidates for Claude Agent SDK runtime activation (`plugin`,
 * `skill-pack`, and `adapter`). Agents are excluded because they run as
 * DorkOS-managed subprocesses, not as CC plugins.
 *
 * These are the CANDIDATES for activation. `global-plugin-consent.ts`
 * partitions them, and only the ones that run nothing on their own, or that a
 * person approved exactly, reach `buildClaudeAgentSdkPluginsArray`, which
 * translates each name into a `{ type: 'local', path }` entry for the SDK's
 * `options.plugins` array (DOR-2306).
 *
 * DorkOS does not currently model plugin enable/disable state; every
 * installed plugin is treated as enabled. If that changes, add the
 * filter here so the runtime wiring stays a single call site.
 *
 * @param dorkHome - Resolved DorkOS data directory.
 * @returns Plugin package names to activate on session start.
 */
export async function listEnabledPluginNames(dorkHome: string): Promise<string[]> {
  const installed = await scanInstalledPackages(dorkHome);
  return installed
    .filter((pkg) => pkg.type === 'plugin' || pkg.type === 'skill-pack' || pkg.type === 'adapter')
    .map((pkg) => pkg.name);
}

/** One installation as one scan found it: the listing's view plus what the update check needs. */
export interface InstallationRecord {
  /** Exactly what `GET /api/marketplace/installed` returns for this installation. */
  package: InstalledPackage;
  /**
   * The install root it was found in. The scope-relative root name, never the
   * manifest's `type`, so a manifest that disagrees with the directory it sits
   * in cannot move an install into another root's namespace ({@link installKey}).
   */
  kind: InstallRootDir;
  /** From `readDeclaredVersion`: plugin.json's version, else the manifest's; undefined when neither states one. */
  declaredVersion?: string;
  /** The `.dork/install-metadata.json` sidecar, or `null` when there is none. */
  metadata: InstallMetadata | null;
  /**
   * The install folder is a symbolic link — a developer's working copy linked
   * into place, not a checkout DorkOS fetched. It is listed and checked like any
   * other, but never reinstalled: a reinstall would replace the link, and the
   * working copy behind it, with a fresh fetch.
   */
  linked: boolean;
}

/**
 * Which installations a scan covers.
 *
 * - `{ agents }` — every scope: the global roots, then each listed agent's
 *   project, one record per installation. `{ agents: [] }` is global-only.
 * - `{ projectPath }` — one project's merged view: the global roots with that
 *   project's installs merged over them, one record per install root and name.
 */
export type InstallationView = { projectPath: string } | { agents: AgentScopeRef[] };

/**
 * Walk every install root under a single scope root ({@link installRootsUnder}:
 * `plugins/`, `agents/`, `shapes/`) and read each installation once. Directories
 * without a readable identity are skipped silently — partial installs and
 * unrelated sibling files never poison the result — as are roots the scope does
 * not have at all. The records come back untagged; the callers below set
 * `scope` and any agent identity.
 *
 * @param scopeRoot - `dorkHome`, or a project's {@link projectScopeRoot}.
 */
async function scanScopeRoot(scopeRoot: string): Promise<InstallationRecord[]> {
  const found: InstallationRecord[] = [];
  for (const { kind, dir } of installRootsUnder(scopeRoot)) {
    for (const entry of await listPackageDirEntries(dir)) {
      const record = await readInstallationRecord(
        join(dir, entry),
        kind,
        await isSymlink(join(dir, entry))
      );
      if (record) found.push(record);
    }
  }
  return found;
}

/**
 * Scan the installations in a view once, keeping everything both the installed
 * list and the update check need. See {@link InstallationView} for the two views;
 * the list helpers below are `.map((r) => r.package)` over this.
 *
 * @param dorkHome - Resolved DorkOS data directory
 *   (see `.claude/rules/dork-home.md`).
 * @param view - One project's merged view, or every scope.
 * @returns One record per installation in view, tagged with its scope.
 */
export async function scanInstallationRecords(
  dorkHome: string,
  view: InstallationView
): Promise<InstallationRecord[]> {
  return 'projectPath' in view
    ? scanProjectView(dorkHome, view.projectPath)
    : scanEveryScope(dorkHome, view.agents);
}

/** Tag a record with scope fields, leaving the rest as the walk read it. */
function withScope(
  record: InstallationRecord,
  fields: Partial<InstalledPackage>
): InstallationRecord {
  return { ...record, package: { ...record.package, ...fields } };
}

/**
 * One project's merged view. A project install shadows a global one of the same
 * name only when both sit in the SAME install root ({@link installKey}); it is
 * then tagged `override`, otherwise `agent-local`. A project's `agents/flow` and
 * a global `plugins/flow` are different packages the {@link ConflictDetector}
 * allows to coexist, so both survive as their own entries. Order: global scan
 * order, with an override taking the place of the global entry it shadows, then
 * project-only installs.
 */
async function scanProjectView(
  dorkHome: string,
  projectPath: string
): Promise<InstallationRecord[]> {
  const merged = new Map<string, InstallationRecord>();
  for (const record of await scanScopeRoot(dorkHome)) {
    merged.set(
      installKey(record.kind, record.package.name),
      withScope(record, { scope: 'global' })
    );
  }
  for (const record of await scanScopeRoot(projectScopeRoot(projectPath))) {
    const key = installKey(record.kind, record.package.name);
    const scope: PackageScope = merged.has(key) ? 'override' : 'agent-local';
    merged.set(key, withScope(record, { scope, agentPath: projectPath }));
  }
  return [...merged.values()];
}

/**
 * Every scope, one record PER INSTALLATION. Agent entries are tagged
 * `agent-local`, or `override` when the same package name is installed globally
 * in the same install root. Global entries come first (scan order), then agent
 * entries sorted by agent name. Agents sharing a project path are deduped;
 * unreadable agent directories are skipped silently.
 */
async function scanEveryScope(
  dorkHome: string,
  agents: AgentScopeRef[]
): Promise<InstallationRecord[]> {
  const globalRecords = (await scanScopeRoot(dorkHome)).map((record) =>
    withScope(record, { scope: 'global' })
  );
  const globalKeys = new Set(globalRecords.map((r) => installKey(r.kind, r.package.name)));

  const seenPaths = new Set<string>();
  const agentRecords: InstallationRecord[] = [];
  for (const agent of agents) {
    if (seenPaths.has(agent.projectPath)) continue;
    seenPaths.add(agent.projectPath);

    for (const record of await scanScopeRoot(projectScopeRoot(agent.projectPath))) {
      agentRecords.push(
        withScope(record, {
          scope: globalKeys.has(installKey(record.kind, record.package.name))
            ? 'override'
            : 'agent-local',
          agentPath: agent.projectPath,
          ...(agent.id !== undefined && { agentId: agent.id }),
          ...(agent.name !== undefined && { agentName: agent.name }),
        })
      );
    }
  }

  agentRecords.sort((a, b) =>
    (a.package.agentName ?? a.package.agentPath ?? '').localeCompare(
      b.package.agentName ?? b.package.agentPath ?? ''
    )
  );
  return [...globalRecords, ...agentRecords];
}

/**
 * Scan the global install roots under `dorkHome` and, when `projectPath` is
 * supplied, merge that project's own installs over them — one entry per
 * package, which is what the install dialog needs for scope-accurate reinstall
 * detection. Without a project every result is tagged `global`, so the UI can
 * show "Installed globally" without a projectPath round-trip. The shadowing
 * rule is {@link scanInstallationRecords}' `{ projectPath }` view.
 *
 * @param dorkHome - Resolved DorkOS data directory
 *   (see `.claude/rules/dork-home.md`)
 * @param projectPath - Project whose own `.dork/` installs merge over the
 *   global ones; omit for the global-only listing.
 * @returns Every installed package in view, tagged with its scope
 */
export async function scanInstalledPackages(
  dorkHome: string,
  projectPath?: string
): Promise<InstalledPackage[]> {
  const records = await scanInstallationRecords(
    dorkHome,
    projectPath ? { projectPath } : { agents: [] }
  );
  return records.map((r) => r.package);
}

/**
 * Scan every installation across all scopes: the global roots plus every
 * install root under each registered agent's `<projectPath>/.dork/`. Unlike
 * {@link scanInstalledPackages}'s merged single-project view, this returns one
 * entry PER INSTALLATION — a package installed globally and on two agents
 * yields three entries — so the UI can show exactly where a package lives and
 * manage each installation independently.
 *
 * Agent entries are tagged `agent-local`, or `override` when the same package
 * name is installed globally in the same install root (the agent's copy shadows
 * the global one for that agent's sessions — the same semantics, and the same
 * {@link installKey}, as the merged view). Each agent entry carries `agentPath`
 * plus the registry's `agentId`/`agentName` so consumers never re-derive
 * display names from paths.
 *
 * Ordering is deterministic: global entries first (scan order), then agent
 * entries sorted by agent name. Agents sharing a project path are deduped;
 * unreadable agent directories are skipped silently, mirroring the global walk.
 *
 * @param dorkHome - Resolved DorkOS data directory.
 * @param agents - Registered agents whose project dirs to scan
 *   (typically `meshCore.listWithPaths()`).
 * @returns Every installation found, tagged with scope and agent identity.
 */
export async function scanInstallationsAcrossScopes(
  dorkHome: string,
  agents: AgentScopeRef[]
): Promise<InstalledPackage[]> {
  const records = await scanInstallationRecords(dorkHome, { agents });
  return records.map((r) => r.package);
}

/**
 * Scan a single project's agent-local installs under every install root in
 * `<projectPath>/.dork/` — no global roots. Used to surface what a
 * just-unregistered agent leaves behind on disk (unregistration removes the
 * registry entry but not the installed files, so they become orphaned), which
 * is why it walks `agents/` too: an agent package installed into that project
 * is exactly the kind of leftover this report exists to name. Each entry is
 * tagged `agent-local`; unreadable directories are skipped silently, mirroring
 * the global walk.
 *
 * @param projectPath - The agent's project directory.
 * @returns The project's local installations (possibly empty).
 */
export async function scanAgentLocalInstalls(projectPath: string): Promise<InstalledPackage[]> {
  const found = await scanScopeRoot(projectScopeRoot(projectPath));
  return found.map(({ package: pkg }) => ({
    ...pkg,
    scope: 'agent-local' as PackageScope,
    agentPath: projectPath,
  }));
}

/**
 * Count how many commands and skills a package ships and whether it contributes
 * hooks, by walking its on-disk layout (`commands/`, `skills/`, `hooks/`). Used
 * to render the "Provides" line in the installed-package drawer. Best-effort:
 * missing directories count as zero rather than throwing, so a partial package
 * still yields a summary.
 *
 * @param installPath - Absolute path to the installed package root.
 * @returns Capability counts (commands, skills, hooks presence).
 */
export async function computeProvides(installPath: string): Promise<PackageProvides> {
  const [commands, skills, hooks] = await Promise.all([
    countCommandFiles(join(installPath, 'commands')),
    countSubdirectories(join(installPath, 'skills')),
    hasEntries(join(installPath, 'hooks')),
  ]);
  return { commands, skills, hooks };
}

/**
 * Count command definition files under a plugin's `commands/` directory —
 * top-level `*.md` plus `*.md` one namespace level deep, mirroring how
 * `command-registry.ts` scans `.claude/commands/`.
 */
async function countCommandFiles(commandsDir: string): Promise<number> {
  const entries = await readdir(commandsDir, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const nested = await safeReaddir(join(commandsDir, entry.name));
      count += nested.filter((f) => f.endsWith('.md')).length;
    } else if (entry.name.endsWith('.md')) {
      count += 1;
    }
  }
  return count;
}

/** Count immediate subdirectories of `dir` (each skill is one directory). */
async function countSubdirectories(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

/** Whether `dir` exists and holds at least one entry. */
async function hasEntries(dir: string): Promise<boolean> {
  return (await safeReaddir(dir)).length > 0;
}

/**
 * Read a single installation's identity and sidecar, once, into an
 * {@link InstallationRecord}. Returns `null` when no identity can be read so the
 * walker can skip silently.
 *
 * Provenance fields on the listing (`installedFrom`, `installedAt`,
 * `dependencyWarnings`) come from the `.dork/install-metadata.json` sidecar via
 * {@link readInstallMetadata}; they are omitted entirely when the sidecar is
 * absent rather than coerced to a placeholder string. The whole sidecar rides
 * along on the record for the update check.
 */
async function readInstallationRecord(
  packagePath: string,
  kind: InstallRootDir,
  linked: boolean
): Promise<InstallationRecord | null> {
  const identity = await readInstalledIdentity(packagePath);
  if (!identity) return null;
  const { declaredVersion, ...base } = identity;

  const metadata = await readInstallMetadata(packagePath);
  return {
    kind,
    declaredVersion,
    metadata,
    linked,
    package: {
      ...base,
      ...(metadata?.installedFrom !== undefined && { installedFrom: metadata.installedFrom }),
      ...(metadata?.installedAt !== undefined && { installedAt: metadata.installedAt }),
      ...(metadata?.dependencyWarnings !== undefined &&
        metadata.dependencyWarnings.length > 0 && {
          dependencyWarnings: metadata.dependencyWarnings,
        }),
      ...(linked && { linked: true as const }),
    },
  };
}

/** A package's identity as read off disk, never gated on validity. */
export type InstalledIdentity = Omit<InstalledPackage, 'installedFrom' | 'installedAt'> & {
  /** From `readDeclaredVersion`: plugin.json's version, else the manifest's; undefined when neither declares one. */
  declaredVersion?: string;
};

/**
 * The one reader of an installed package's identity, shared by the installed
 * list and the update check so both show and compare the same version.
 *
 * `version` is the version the package declares (plugin.json's, else the
 * manifest's) and only falls back to the manifest's — so a flow with manifest
 * 0.6.0 beside plugin.json 0.7.2 lists as 0.7.2, what Claude Code runs.
 * `declaredVersion` is `undefined` when neither file states one, which keeps a
 * Claude-Code-only package's synthesized `'0.0.0'` from reading as real.
 *
 * NEVER gated on validity: an install that fails today's rules (a
 * `VERSION_MISMATCH` included) stays listed, updatable and uninstallable.
 * Total: any throw returns `null`, because it sits on the path of
 * `GET /api/marketplace/installed` and the update check, where one unreadable
 * package must cost only its own entry.
 *
 * @param installRoot - Absolute path to the package's install root.
 * @returns The identity, or `null` when none can be read.
 */
export async function readInstalledIdentity(
  installRoot: string
): Promise<InstalledIdentity | null> {
  try {
    const base = await readManifestSummary(installRoot);
    if (!base) return null;
    const declaredVersion = await readDeclaredVersion(installRoot);
    return { ...base, version: declaredVersion ?? base.version, declaredVersion };
  } catch (err) {
    logger.debug(`[InstalledScanner] Could not read ${installRoot}`, err);
    return null;
  }
}

/**
 * Read and parse `.dork/manifest.json` for a single package directory.
 * Returns the minimum {@link InstalledPackage} fields (name/version/type/
 * installPath) on success, or `null` when no manifest can be read at all.
 * Falls back to {@link validatePackage}'s manifest when shallow parsing
 * rejects the file or there is none (a Claude-Code-only package).
 */
async function readManifestSummary(
  packagePath: string
): Promise<Omit<InstalledPackage, 'installedFrom' | 'installedAt'> | null> {
  const manifestPath = join(packagePath, PACKAGE_MANIFEST_PATH);
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf-8');
  } catch {
    // No .dork/manifest.json — a CC-native package installed verbatim. The
    // canonical validator synthesizes identity from .claude-plugin/plugin.json,
    // so such installs stay visible to list/uninstall/update (DOR-264).
    return validatedSummary(packagePath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const shallow = parsed as Partial<{
    name: unknown;
    version: unknown;
    type: unknown;
    adapterType: unknown;
  }>;

  if (
    typeof shallow.name === 'string' &&
    typeof shallow.version === 'string' &&
    typeof shallow.type === 'string'
  ) {
    return {
      name: shallow.name,
      version: shallow.version,
      type: shallow.type as PackageType,
      // Gated on type, mirroring the Browse-side gate in
      // `flattenMergedEntry` (marketplace.ts): a manifest that sets
      // adapterType on a non-adapter entry does not leak it downstream.
      ...(shallow.type === 'adapter' &&
        typeof shallow.adapterType === 'string' && { adapterType: shallow.adapterType }),
      installPath: packagePath,
    };
  }

  // Shallow parse rejected the file — give the canonical validator a chance
  // before discarding the entry. This keeps the scanner forgiving of older
  // installs that may have a slightly different field shape on disk.
  return validatedSummary(packagePath);
}

/**
 * Resolve a package's identity via the canonical {@link validatePackage},
 * which also synthesizes a manifest from `.claude-plugin/plugin.json` for
 * CC-native packages. Uses the parsed manifest whenever there is one, `ok` or
 * not — the validator returns it alongside errors — and returns `null` only
 * when there is no manifest at all, so walkers skip the entry silently.
 *
 * Deliberately not gated on `ok`: this is the installed side, and a package
 * already on disk that fails today's rules must stay visible to list,
 * uninstall and update rather than vanish (ADR 260923-122616).
 *
 * Total by construction: an unreadable file or directory inside ONE package
 * must cost that package its listing entry, never the whole installed list.
 * This function is on the path from `GET /api/marketplace/installed`, where a
 * propagating throw is a 500 for every package the user has.
 */
async function validatedSummary(
  packagePath: string
): Promise<Omit<InstalledPackage, 'installedFrom' | 'installedAt'> | null> {
  let validated;
  try {
    // An installed root holds the installer's records and the person's data by
    // design, so the reserved-path check (and its whole-tree walk) is skipped.
    validated = await validatePackage(packagePath, { tree: 'installed' });
  } catch (err) {
    logger.debug(`[InstalledScanner] Could not validate ${packagePath}`, err);
    return null;
  }
  if (!validated.manifest) {
    return null;
  }
  return {
    name: validated.manifest.name,
    version: validated.manifest.version,
    type: validated.manifest.type,
    // Same gate as the shallow-parse branch above and Browse's
    // `flattenMergedEntry`: only an adapter manifest carries this field.
    ...(validated.manifest.type === 'adapter' && {
      adapterType: validated.manifest.adapterType,
    }),
    installPath: packagePath,
  };
}

/** Whether `target` is itself a symbolic link (false when it cannot be read). */
async function isSymlink(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `fs.readdir` that swallows ENOENT so callers can walk optional trees. */
async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Enumerate a package-root directory, skipping crash-left install backups
 * (`<target>.dorkos-bak-<timestamp>-<uuid>`, written by the transaction
 * engine's move-aside and orphaned by a hard crash mid-install — DOR-175,
 * ADR-0304). A backup is a byte-for-byte copy of a previous installation, so
 * it carries a valid manifest under the same package name; without this skip
 * a walker would list it as a phantom duplicate package (and the merged-by-name
 * views could non-deterministically resolve `installPath` to the backup).
 *
 * Only for package-root walks (`plugins/`, `agents/`, `shapes/`, under either
 * scope root) — backups are always siblings of an install target, never
 * package-internal, so the `computeProvides` helpers keep plain
 * {@link safeReaddir}.
 */
async function listPackageDirEntries(dir: string): Promise<string[]> {
  return (await safeReaddir(dir)).filter((name) => !isInstallSiblingName(name));
}
