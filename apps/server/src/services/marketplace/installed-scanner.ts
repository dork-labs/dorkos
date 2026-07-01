/**
 * Installed-package scanner — walks `${dorkHome}/plugins/` and
 * `${dorkHome}/agents/`, reads each package's `.dork/manifest.json`, and
 * merges in the `.dork/install-metadata.json` provenance sidecar where
 * available.
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
import { readInstallMetadata } from './installed-metadata.js';

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
  /** Capability counts — populated on demand by {@link computeProvides}. */
  provides?: PackageProvides;
}

/** Subdirectories of `dorkHome` that hold installed packages. */
const INSTALL_ROOTS = ['plugins', 'agents'] as const;

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
 * Walk `${dorkHome}/plugins/*` and `${dorkHome}/agents/*`, read each
 * `.dork/manifest.json`, merge in any `.dork/install-metadata.json` sidecar,
 * and return the resulting {@link InstalledPackage} list. Directories without
 * a readable manifest are skipped silently — partial installs and unrelated
 * sibling files never poison the result.
 *
 * @param dorkHome - Resolved DorkOS data directory
 *   (see `.claude/rules/dork-home.md`)
 * @returns A flat list of every installed package found under `dorkHome`
 */
export async function scanInstalledPackages(
  dorkHome: string,
  projectPath?: string
): Promise<InstalledPackage[]> {
  const globalResults: InstalledPackage[] = [];

  for (const rootName of INSTALL_ROOTS) {
    const root = join(dorkHome, rootName);
    const entries = await safeReaddir(root);
    for (const entry of entries) {
      const packagePath = join(root, entry);
      const installed = await readInstalledPackage(packagePath);
      if (installed) {
        globalResults.push(installed);
      }
    }
  }

  if (!projectPath) {
    // Global-only listing: tag every result so the UI can show "Installed
    // globally" without a projectPath round-trip. (The merged path below tags
    // its own results as global/agent-local/override.)
    return globalResults.map((pkg) => ({ ...pkg, scope: 'global' as PackageScope }));
  }

  const merged = new Map<string, InstalledPackage>();

  for (const pkg of globalResults) {
    merged.set(pkg.name, { ...pkg, scope: 'global' as PackageScope });
  }

  const localRoot = join(projectPath, '.dork', 'plugins');
  const localEntries = await safeReaddir(localRoot);

  for (const entry of localEntries) {
    const packagePath = join(localRoot, entry);
    const installed = await readInstalledPackage(packagePath);
    if (installed) {
      const scope: PackageScope = merged.has(installed.name) ? 'override' : 'agent-local';
      merged.set(installed.name, { ...installed, scope, agentPath: projectPath });
    }
  }

  return Array.from(merged.values());
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
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(commandsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
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
    return null;
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
      installPath: packagePath,
    };
  }

  // Shallow parse rejected the file — give the canonical validator a chance
  // before discarding the entry. This keeps the scanner forgiving of older
  // installs that may have a slightly different field shape on disk.
  const validated = await validatePackage(packagePath);
  if (!validated.ok || !validated.manifest) {
    return null;
  }
  return {
    name: validated.manifest.name,
    version: validated.manifest.version,
    type: validated.manifest.type,
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
