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
 * Used by both the HTTP route (`GET /api/marketplace/installed`) and the
 * `marketplace_list_installed` MCP tool so the scan logic lives in one place.
 *
 * @module services/marketplace/installed-scanner
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PackageType } from '@dorkos/marketplace';
import { PACKAGE_MANIFEST_PATH } from '@dorkos/marketplace/constants';
import { validatePackage } from '@dorkos/marketplace/package-validator';
import type { PackageProvides } from '@dorkos/shared/marketplace-schemas';
import { MARKETPLACE_BACKUP_DIR_MARKER } from '@dorkos/shared/marketplace-schemas';
import type { InstallRootDir } from './lib/install-roots.js';
import { installKey, installRootsUnder, projectScopeRoot } from './lib/install-roots.js';
import { readInstallMetadata } from './installed-metadata.js';
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
  /** Package version from `.dork/manifest.json`. */
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
 * This is the data source for `plugin-activation.ts` — the returned list
 * of package names is passed to `buildClaudeAgentSdkPluginsArray` which
 * translates each name into a `{ type: 'local', path }` entry for the
 * SDK's `options.plugins` array.
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

/**
 * Walk every install root under a single scope root ({@link installRootsUnder}:
 * `plugins/`, `agents/`, `shapes/`), read each `.dork/manifest.json`, merge in
 * any `.dork/install-metadata.json` sidecar, and return each find tagged with
 * the root it came from. Directories without a readable manifest are skipped
 * silently — partial installs and unrelated sibling files never poison the
 * result — as are roots the scope does not have at all.
 *
 * The `kind` tag is what the callers below shadow and dedupe on
 * ({@link installKey}); it is deliberately the scope-relative root name rather
 * than the manifest's `type`, so a manifest that disagrees with the directory
 * it sits in cannot move an install into another root's namespace.
 *
 * @param scopeRoot - `dorkHome`, or a project's {@link projectScopeRoot}.
 */
async function scanScopeRoot(
  scopeRoot: string
): Promise<{ kind: InstallRootDir; pkg: InstalledPackage }[]> {
  const found: { kind: InstallRootDir; pkg: InstalledPackage }[] = [];
  for (const { kind, dir } of installRootsUnder(scopeRoot)) {
    for (const entry of await listPackageDirEntries(dir)) {
      const installed = await readInstalledPackage(join(dir, entry));
      if (installed) found.push({ kind, pkg: installed });
    }
  }
  return found;
}

/**
 * Scan the global install roots under `dorkHome` and, when `projectPath` is
 * supplied, merge that project's own installs over them — one entry per
 * package, which is what the install dialog needs for scope-accurate reinstall
 * detection.
 *
 * A project install shadows a global one of the same name only when both sit in
 * the SAME install root ({@link installKey}); it is then tagged `override`,
 * otherwise `agent-local`. A project's `agents/flow` and a global
 * `plugins/flow` are different packages the {@link ConflictDetector} allows to
 * coexist, so both survive as their own entries.
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
  const globalResults = await scanScopeRoot(dorkHome);

  if (!projectPath) {
    // Global-only listing: tag every result so the UI can show "Installed
    // globally" without a projectPath round-trip. (The merged path below tags
    // its own results as global/agent-local/override.)
    return globalResults.map(({ pkg }) => ({ ...pkg, scope: 'global' as PackageScope }));
  }

  const merged = new Map<string, InstalledPackage>();

  for (const { kind, pkg } of globalResults) {
    merged.set(installKey(kind, pkg.name), { ...pkg, scope: 'global' as PackageScope });
  }

  for (const { kind, pkg } of await scanScopeRoot(projectScopeRoot(projectPath))) {
    const key = installKey(kind, pkg.name);
    const scope: PackageScope = merged.has(key) ? 'override' : 'agent-local';
    merged.set(key, { ...pkg, scope, agentPath: projectPath });
  }

  return Array.from(merged.values());
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
  const globalScoped = await scanScopeRoot(dorkHome);
  const globalKeys = new Set(globalScoped.map(({ kind, pkg }) => installKey(kind, pkg.name)));
  const globalEntries = globalScoped.map(({ pkg }) => ({
    ...pkg,
    scope: 'global' as PackageScope,
  }));

  const seenPaths = new Set<string>();
  const agentEntries: InstalledPackage[] = [];

  for (const agent of agents) {
    if (seenPaths.has(agent.projectPath)) continue;
    seenPaths.add(agent.projectPath);

    for (const { kind, pkg } of await scanScopeRoot(projectScopeRoot(agent.projectPath))) {
      agentEntries.push({
        ...pkg,
        scope: globalKeys.has(installKey(kind, pkg.name)) ? 'override' : 'agent-local',
        agentPath: agent.projectPath,
        ...(agent.id !== undefined && { agentId: agent.id }),
        ...(agent.name !== undefined && { agentName: agent.name }),
      });
    }
  }

  agentEntries.sort((a, b) =>
    (a.agentName ?? a.agentPath ?? '').localeCompare(b.agentName ?? b.agentPath ?? '')
  );
  return [...globalEntries, ...agentEntries];
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
  return found.map(({ pkg }) => ({
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
 * Read a single installed package's `.dork/manifest.json` and translate it
 * into an {@link InstalledPackage} summary. Returns `null` when the manifest
 * is missing, unreadable, or fails validation so the walker can skip silently.
 *
 * Provenance fields (`installedFrom`, `installedAt`) come from the
 * `.dork/install-metadata.json` sidecar via {@link readInstallMetadata}; they
 * are omitted entirely when the sidecar is absent rather than coerced to a
 * placeholder string.
 */
async function readInstalledPackage(packagePath: string): Promise<InstalledPackage | null> {
  const base = await readManifestSummary(packagePath);
  if (!base) return null;

  const metadata = await readInstallMetadata(packagePath);
  return {
    ...base,
    ...(metadata?.installedFrom !== undefined && { installedFrom: metadata.installedFrom }),
    ...(metadata?.installedAt !== undefined && { installedAt: metadata.installedAt }),
    ...(metadata?.dependencyWarnings !== undefined &&
      metadata.dependencyWarnings.length > 0 && {
        dependencyWarnings: metadata.dependencyWarnings,
      }),
  };
}

/**
 * Read and parse `.dork/manifest.json` for a single package directory.
 * Returns the minimum {@link InstalledPackage} fields (name/version/type/
 * installPath) on success, or `null` when the manifest is missing,
 * unparseable, or invalid. Falls back to {@link validatePackage} for a second
 * opinion when shallow parsing rejects the file.
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
 * CC-native packages. Returns `null` when validation fails or produces no
 * manifest, so walkers skip the entry silently.
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
    validated = await validatePackage(packagePath);
  } catch (err) {
    logger.debug(`[InstalledScanner] Could not validate ${packagePath}`, err);
    return null;
  }
  if (!validated.ok || !validated.manifest) {
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
  return (await safeReaddir(dir)).filter((name) => !name.includes(MARKETPLACE_BACKUP_DIR_MARKER));
}
