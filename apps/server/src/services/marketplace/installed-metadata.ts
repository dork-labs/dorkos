/**
 * Installed-package metadata sidecar.
 *
 * Each successfully installed package gets a `.dork/install-metadata.json`
 * file written by the {@link import('./marketplace-installer.js').MarketplaceInstaller}
 * after the install flow completes. The sidecar is intentionally separate
 * from `.dork/manifest.json` (which is the immutable source manifest copied
 * from the package archive) so install-time provenance — which marketplace
 * we installed from, when, at which version — is preserved without mutating
 * the canonical manifest.
 *
 * Used by the update flow to scope marketplace lookups, and by the routes
 * layer to surface install provenance to API clients.
 *
 * @module services/marketplace/installed-metadata
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { PackageType } from '@dorkos/marketplace';

/** Path to the install-metadata sidecar relative to an install root. */
export const INSTALL_METADATA_PATH = path.join('.dork', 'install-metadata.json');

/**
 * Sidecar metadata describing how and when a package was installed. Stored
 * separately from the immutable source manifest so provenance survives
 * marketplace upgrades and source repository churn.
 */
export interface InstallMetadata {
  /** Package name from the source manifest, captured at install time. */
  name: string;
  /** Package version from the source manifest, captured at install time. */
  version: string;
  /** Package type from the source manifest, captured at install time. */
  type: PackageType;
  /**
   * Marketplace source name the package was installed from. `undefined`
   * for direct git URL or local-path installs.
   */
  installedFrom?: string;
  /** ISO 8601 timestamp of the successful install. */
  installedAt: string;
}

/**
 * Read the install-metadata sidecar from an install root. Returns `null`
 * when the file is missing (e.g. older installs that pre-date the sidecar
 * format) or unparseable. Callers should treat `null` as "no provenance
 * available" and fall back to whatever they do for ambiguous installs.
 *
 * @param installRoot - Absolute path to the package install root.
 */
export async function readInstallMetadata(installRoot: string): Promise<InstallMetadata | null> {
  const metadataPath = path.join(installRoot, INSTALL_METADATA_PATH);
  try {
    const raw = await readFile(metadataPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.name !== 'string' || typeof obj.version !== 'string') return null;
    if (typeof obj.type !== 'string' || typeof obj.installedAt !== 'string') return null;
    return {
      name: obj.name,
      version: obj.version,
      type: obj.type as PackageType,
      installedFrom: typeof obj.installedFrom === 'string' ? obj.installedFrom : undefined,
      installedAt: obj.installedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Write the install-metadata sidecar to an install root. Creates the
 * `.dork/` directory if it does not already exist (defensive — install
 * flows always create it, but write-after-rename ordering means we
 * cannot rely on it being present in every code path).
 *
 * @param installRoot - Absolute path to the package install root.
 * @param metadata - The provenance metadata to persist.
 */
export async function writeInstallMetadata(
  installRoot: string,
  metadata: InstallMetadata
): Promise<void> {
  const metadataPath = path.join(installRoot, INSTALL_METADATA_PATH);
  await mkdir(path.dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', 'utf-8');
}
