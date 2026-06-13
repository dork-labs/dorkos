import fs from 'fs/promises';
import path from 'path';
import { ExtensionManifestSchema } from '@dorkos/extension-api';
import type { ExtensionRecord, ExtensionManifest } from '@dorkos/extension-api';
import { gte } from 'semver';
import {
  isEnabled,
  type ExtensionsConfig,
  type CoreExtensionInfo,
} from './extension-enable-resolution.js';
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
   * Scan for extensions in both global and local directories, then resolve each
   * record's `origin` (from the core staging set) and tier-aware `status`.
   *
   * @param cwd - Optional current working directory for local extension scanning.
   * @param config - The user's `{ enabled, disabled }` deviation lists.
   * @param core - Tier metadata for bundled core extensions, keyed by id.
   * @returns All discovered extension records, with local overriding global by ID.
   */
  async discover(
    cwd: string | null,
    config: ExtensionsConfig,
    core: Map<string, CoreExtensionInfo>
  ): Promise<ExtensionRecord[]> {
    const globalDir = path.join(this.dorkHome, 'extensions');
    const globalRecords = await this.scanDirectory(globalDir, 'global');

    let localRecords: Array<Omit<ExtensionRecord, 'origin'>> = [];
    if (cwd) {
      const localDir = path.join(cwd, '.dork', 'extensions');
      localRecords = await this.scanDirectory(localDir, 'local');
    }

    // Merge: local overrides global by extension ID
    const merged = new Map<string, Omit<ExtensionRecord, 'origin'>>();
    for (const rec of globalRecords) {
      merged.set(rec.id, rec);
    }
    for (const rec of localRecords) {
      merged.set(rec.id, rec);
    }

    // Resolve origin (from the staging set) and tier-aware status per record.
    const results: ExtensionRecord[] = [];
    for (const rec of merged.values()) {
      // `origin` keys off core-map membership — VS Code's isBuiltin pattern,
      // unspoofable by a manifest claim. A local override of a core id stays
      // 'core' by id membership while running whichever code won the merge.
      const origin: 'core' | 'user' = core.has(rec.id) ? 'core' : 'user';

      if (rec.status === 'invalid') {
        results.push({ ...rec, origin });
        continue;
      }

      if (!this.checkCompatibility(rec.manifest)) {
        rec.status = 'incompatible';
        results.push({ ...rec, origin });
        continue;
      }

      rec.status = isEnabled(rec.id, config, core) ? 'enabled' : 'disabled';
      results.push({ ...rec, origin });
    }

    logger.info(
      `[Extensions] Discovered ${results.length} extension(s): ${
        results
          .map((r) => {
            const flags: string[] = [r.origin, r.status];
            if (r.hasServerEntry) flags.push('server');
            if (r.hasDataProxy) flags.push('proxy');
            return `${r.id} (${flags.join(', ')})`;
          })
          .join(', ') || 'none'
      }`
    );
    return results;
  }

  /**
   * Scan a single directory for extension subdirectories.
   *
   * @param dir - Absolute path to the directory to scan
   * @param scope - Whether this is a global or local extensions directory
   */
  private async scanDirectory(
    dir: string,
    scope: 'global' | 'local'
  ): Promise<Array<Omit<ExtensionRecord, 'origin'>>> {
    try {
      await fs.access(dir);
    } catch {
      // Directory doesn't exist — not an error, just no extensions
      return [];
    }

    const entries = await fs.readdir(dir, { withFileTypes: true });
    const records: Array<Omit<ExtensionRecord, 'origin'>> = [];

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

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
  ): Promise<Omit<ExtensionRecord, 'origin'>> {
    const manifestPath = path.join(extDir, 'extension.json');

    try {
      const raw = await fs.readFile(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      const result = ExtensionManifestSchema.safeParse(parsed);

      if (!result.success) {
        return {
          id: dirName,
          manifest: { id: dirName, name: dirName, version: '0.0.0' },
          status: 'invalid',
          scope,
          path: extDir,
          error: {
            code: 'invalid_manifest',
            message: 'Manifest validation failed',
            details: result.error.message,
          },
          bundleReady: false,
          hasServerEntry: false,
          hasDataProxy: false,
        };
      }

      const manifest = result.data;
      const { hasServerEntry, resolvedPath } = await this.detectServerEntry(extDir, manifest);
      const hasDataProxy = !!manifest.dataProxy;

      return {
        id: manifest.id,
        manifest,
        status: 'discovered',
        scope,
        path: extDir,
        bundleReady: false,
        hasServerEntry,
        hasDataProxy,
        serverEntryPath: hasServerEntry ? resolvedPath : undefined,
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
        hasServerEntry: false,
        hasDataProxy: false,
      };
    }
  }

  /**
   * Detect whether a server entry point exists in the extension directory.
   *
   * Resolves the entry path from `serverCapabilities.serverEntry` (defaulting
   * to `./server.ts`), then checks for `.ts` and `.js` variants on disk.
   *
   * @param extDir - Absolute path to the extension directory
   * @param manifest - Parsed extension manifest
   * @returns Whether a server entry was found and its resolved absolute path
   */
  private async detectServerEntry(
    extDir: string,
    manifest: ExtensionManifest
  ): Promise<{ hasServerEntry: boolean; resolvedPath: string }> {
    const serverEntryRel = manifest.serverCapabilities?.serverEntry ?? './server.ts';
    const resolvedPath = path.join(extDir, serverEntryRel);

    // Check the declared path first (typically .ts)
    try {
      await fs.access(resolvedPath);
      return { hasServerEntry: true, resolvedPath };
    } catch {
      // Not found — try .js variant if the declared path ends in .ts
    }

    // Fall back to .js variant for pre-compiled extensions
    if (resolvedPath.endsWith('.ts')) {
      const jsPath = resolvedPath.replace(/\.ts$/, '.js');
      try {
        await fs.access(jsPath);
        return { hasServerEntry: true, resolvedPath: jsPath };
      } catch {
        // No server entry point
      }
    }

    return { hasServerEntry: false, resolvedPath };
  }

  /**
   * Check if the host version satisfies the extension's minimum requirement.
   */
  private checkCompatibility(manifest: ExtensionManifest): boolean {
    if (!manifest.minHostVersion) return true;
    return gte(HOST_VERSION, manifest.minHostVersion);
  }
}
