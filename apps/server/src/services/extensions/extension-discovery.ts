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
 * when an extension ID appears in both — except for an id that ships with
 * DorkOS or that a person approved to run code, which a project directory can
 * never take over. When the two scopes name the same directory on disk it is
 * scanned once, as global. See {@link ExtensionDiscovery.discover}.
 */
export class ExtensionDiscovery {
  private dorkHome: string;

  constructor(dorkHome: string) {
    this.dorkHome = dorkHome;
  }

  /**
   * Scan for extensions in both global and local directories, then resolve each
   * record's `origin` (from the staging directory it was read from) and
   * tier-aware `status`.
   *
   * @param cwd - Optional current working directory for local extension scanning.
   * @param config - The user's `{ enabled, disabled }` deviation lists plus
   *   `approvedToRun`, read here so a project directory cannot take over the id
   *   of an extension the person already approved.
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
      if (await this.isSameDirectory(localDir, globalDir)) {
        // The working directory holds the DorkOS home — `$HOME` for a
        // Finder-launched Mac app, or `dorkos` started from `~`. Scanning it a
        // second time re-found every installed extension as a "project copy" of
        // itself and warned about each one on every discovery pass (DOR-1336).
        // One directory, one scan: nothing here is a project copy of anything.
        logger.debug(
          `[Extensions] Skipping the project scan: ${localDir} is the installed extensions ` +
            `directory, not a project copy of it`
        );
      } else {
        localRecords = await this.scanDirectory(localDir, 'local');
      }
    }

    // Merge: local overrides global by extension ID
    const merged = new Map<string, Omit<ExtensionRecord, 'origin'>>();
    for (const rec of globalRecords) {
      merged.set(rec.id, rec);
    }
    for (const rec of localRecords) {
      // ...except for an id whose standing is already spoken for: one DorkOS ships
      // (`core`), or one a person approved to run code in this process. Both are
      // decisions about the extension INSTALLED under `{dorkHome}/extensions`, and
      // an id is all a project directory needs to inherit them — a file an agent
      // writes with no prompt and no shell (the DOR-511 adversary the approval
      // record itself is placed to avoid). A project copy may still override any
      // ordinary global extension, which is what the local scope is for.
      if (core.has(rec.id) || config.approvedToRun.includes(rec.id)) {
        logger.warn(
          `[Extensions] Ignoring the project copy of '${rec.id}' at ${rec.path}: that id ` +
            `belongs to the extension installed under ${globalDir}. Rename it, or remove the ` +
            `installed one first.`
        );
        continue;
      }
      merged.set(rec.id, rec);
    }

    // Resolve origin (from the staging directory on disk) and tier-aware status.
    const stagingDir = path.resolve(globalDir);
    const results: ExtensionRecord[] = [];
    for (const rec of merged.values()) {
      // `origin: 'core'` means "this is the copy `ensureCoreExtensions` staged",
      // so it is answered by WHERE the record was read from, never by its id and
      // never by a manifest claim — VS Code's `isBuiltin` semantic, which is a
      // property of the install location. Deriving it from the core map alone let
      // any directory that reused a bundled id run as core: `{cwd}/.dork/extensions/
      // marketplace/server.ts` was `origin: 'core'`, and core short-circuits the
      // load approval, so the planted code was never asked about.
      const origin: 'core' | 'user' =
        core.has(rec.id) &&
        path.resolve(rec.path) === path.join(stagingDir, rec.id) &&
        (await this.isRealDirectory(rec.path))
          ? 'core'
          : 'user';

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
   * Whether two paths name the same directory on disk.
   *
   * Answered by `fs.realpath` when a path exists, so a project `.dork` that is a
   * SYMLINK to the DorkOS home counts as the same directory — the lexical
   * comparison alone would call the two different and scan the same extensions
   * twice. Neither path is required to exist: a path that cannot be resolved
   * falls back to its lexically-normalized form, which is exactly right for the
   * ordinary case of a project with no `.dork/extensions` directory at all (it
   * compares unequal, and the scan of it finds nothing anyway).
   *
   * @param a - First path.
   * @param b - Second path.
   */
  private async isSameDirectory(a: string, b: string): Promise<boolean> {
    const [ra, rb] = await Promise.all([this.canonicalize(a), this.canonicalize(b)]);
    return ra === rb;
  }

  /**
   * Resolve a path to its canonical form, degrading to lexical normalization when
   * the path does not exist (or cannot be read).
   *
   * @param target - Path to canonicalize.
   */
  private async canonicalize(target: string): Promise<string> {
    try {
      return await fs.realpath(target);
    } catch {
      return path.resolve(target);
    }
  }

  /**
   * Whether `target` is a real directory, rather than a symlink standing where one
   * belongs.
   *
   * The third condition on `origin: 'core'`, and it has to be checked HERE rather
   * than trusted from staging. The path comparison above is lexical —
   * `path.resolve` normalizes `..` and separators but does not follow links — and
   * {@link ExtensionDiscovery.scanDirectory} admits symlink entries on purpose, so
   * a symlink at `{dorkHome}/extensions/<core-id>` matches the staged path exactly
   * while its contents live wherever the link points.
   *
   * `ensureCoreExtensions` deletes such a symlink before staging, but that runs
   * once, at boot (`index.ts`). {@link ExtensionManager.reload} re-runs discovery
   * with no re-staging, and it is reachable from `POST /api/extensions/reload` and
   * the `reload_extensions` tool — so the repair sat on the wrong side of the check
   * it was protecting, and a symlink planted after boot re-derived as `core` until
   * the next restart. Both defenses are kept: this one refuses, that one heals.
   *
   * `fs.realpath` on both sides would NOT have worked. When the staged path itself
   * is the link, both sides resolve to the same target and compare equal. The
   * question is not "where does this path lead" but "is this path the directory
   * DorkOS wrote", and only `lstat` answers that.
   *
   * Scoped honestly: creating a symlink needs a shell, so this is not the no-shell
   * `acceptEdits` adversary that made the id-membership derivation critical.
   *
   * @param target - Absolute path to the extension directory.
   */
  private async isRealDirectory(target: string): Promise<boolean> {
    try {
      const stats = await fs.lstat(target);
      return stats.isDirectory();
    } catch {
      return false;
    }
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
