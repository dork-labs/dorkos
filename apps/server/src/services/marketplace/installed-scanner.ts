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
import { readInstallMetadata } from './installed-metadata.js';

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
}

/** Subdirectories of `dorkHome` that hold installed packages. */
const INSTALL_ROOTS = ['plugins', 'agents'] as const;

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
export async function scanInstalledPackages(dorkHome: string): Promise<InstalledPackage[]> {
  const results: InstalledPackage[] = [];

  for (const rootName of INSTALL_ROOTS) {
    const root = join(dorkHome, rootName);
    const entries = await safeReaddir(root);
    for (const entry of entries) {
      const packagePath = join(root, entry);
      const installed = await readInstalledPackage(packagePath);
      if (installed) {
        results.push(installed);
      }
    }
  }

  return results;
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
