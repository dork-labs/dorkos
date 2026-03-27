import fs from 'fs/promises';
import path from 'path';
import { ExtensionManifestSchema } from '@dorkos/extension-api';
import type { ExtensionRecord, ExtensionManifest } from '@dorkos/extension-api';
import { gte } from 'semver';
import { logger } from '../../lib/logger.js';

/** Host version for compatibility checking. */
const HOST_VERSION = '0.1.0';

/**
 * Scans filesystem paths for extension directories containing valid
 * `extension.json` manifests. Handles both global (`{dorkHome}/extensions/`)
 * and local (`{cwd}/.dork/extensions/`) scopes, with local overriding global
 * when an extension ID appears in both.
 */
export class ExtensionDiscovery {
  private dorkHome: string;

  constructor(dorkHome: string) {
    this.dorkHome = dorkHome;
  }

  /**
   * Scan for extensions in both global and local directories.
   *
   * @param cwd - Optional current working directory for local extension scanning
   * @param enabledIds - Extension IDs that the user has enabled (from config)
   * @returns All discovered extension records, with local overriding global by ID
   */
  async discover(cwd: string | null, enabledIds: string[]): Promise<ExtensionRecord[]> {
    const globalDir = path.join(this.dorkHome, 'extensions');
    const globalRecords = await this.scanDirectory(globalDir, 'global');

    let localRecords: ExtensionRecord[] = [];
    if (cwd) {
      const localDir = path.join(cwd, '.dork', 'extensions');
      localRecords = await this.scanDirectory(localDir, 'local');
    }

    // Merge: local overrides global by extension ID
    const merged = new Map<string, ExtensionRecord>();
    for (const rec of globalRecords) {
      merged.set(rec.id, rec);
    }
    for (const rec of localRecords) {
      merged.set(rec.id, rec);
    }

    // Apply status based on version compatibility and enabled state
    const results: ExtensionRecord[] = [];
    for (const rec of merged.values()) {
      if (rec.status === 'invalid') {
        results.push(rec);
        continue;
      }

      if (!this.checkCompatibility(rec.manifest)) {
        rec.status = 'incompatible';
        results.push(rec);
        continue;
      }

      if (enabledIds.includes(rec.id)) {
        rec.status = 'enabled';
      } else {
        rec.status = 'disabled';
      }
      results.push(rec);
    }

    logger.info(
      `[Extensions] Discovered ${results.length} extension(s): ${results.map((r) => `${r.id} (${r.status})`).join(', ') || 'none'}`
    );
    return results;
  }

  /**
   * Scan a single directory for extension subdirectories.
   *
   * @param dir - Absolute path to the directory to scan
   * @param scope - Whether this is a global or local extensions directory
   */
  private async scanDirectory(dir: string, scope: 'global' | 'local'): Promise<ExtensionRecord[]> {
    try {
      await fs.access(dir);
    } catch {
      // Directory doesn't exist — not an error, just no extensions
      return [];
    }

    const entries = await fs.readdir(dir, { withFileTypes: true });
    const records: ExtensionRecord[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const extDir = path.join(dir, entry.name);
      const record = await this.readExtension(extDir, entry.name, scope);
      records.push(record);
    }

    return records;
  }

  /**
   * Read and parse a single extension directory.
   *
   * @param extDir - Absolute path to the extension directory
   * @param dirName - Name of the directory (used as fallback ID)
   * @param scope - Whether this is a global or local extension
   */
  private async readExtension(
    extDir: string,
    dirName: string,
    scope: 'global' | 'local'
  ): Promise<ExtensionRecord> {
    const manifestPath = path.join(extDir, 'extension.json');

    try {
      const raw = await fs.readFile(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      const result = ExtensionManifestSchema.safeParse(parsed);

      if (!result.success) {
        return {
          id: dirName,
          manifest: parsed as ExtensionManifest,
          status: 'invalid',
          scope,
          path: extDir,
          error: {
            code: 'invalid_manifest',
            message: 'Manifest validation failed',
            details: result.error.message,
          },
          bundleReady: false,
        };
      }

      return {
        id: result.data.id,
        manifest: result.data,
        status: 'discovered',
        scope,
        path: extDir,
        bundleReady: false,
      };
    } catch (err) {
      return {
        id: dirName,
        manifest: { id: dirName, name: dirName, version: '0.0.0' },
        status: 'invalid',
        scope,
        path: extDir,
        error: {
          code: 'manifest_read_error',
          message: err instanceof Error ? err.message : 'Failed to read extension.json',
        },
        bundleReady: false,
      };
    }
  }

  /**
   * Check if the host version satisfies the extension's minimum requirement.
   */
  private checkCompatibility(manifest: ExtensionManifest): boolean {
    if (!manifest.minHostVersion) return true;
    return gte(HOST_VERSION, manifest.minHostVersion);
  }
}
