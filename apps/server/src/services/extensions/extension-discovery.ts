import fs from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';
import { ExtensionManifestSchema } from '@dorkos/extension-api';
import { isInstallSiblingName } from '@dorkos/shared/marketplace-schemas';
import type { ExtensionRecord, ExtensionManifest } from '@dorkos/extension-api';
import {
  isEnabled,
  type ExtensionsConfig,
  type CoreExtensionInfo,
} from './extension-enable-resolution.js';
import { isApprovedCopy, isFromTrustedSource } from './extension-load-policy.js';
import { mergePluginRecords, type DiscoveredRecord } from './extension-precedence.js';
import {
  inspectCopy,
  installRootOf,
  proveOrigin,
  readTrustedInstalls,
  type CopyOnDisk,
} from './extension-trusted-origin.js';
import { logger } from '../../lib/logger.js';
import {
  satisfiesMinHostVersion,
  RUNNING_HOST_VERSION,
  type HostVersion,
} from './extension-host-version.js';

/**
 * Scans filesystem paths for extension directories containing valid
 * `extension.json` manifests, in four kinds of place:
 *
 * - `{dorkHome}/extensions/<id>` — installed directly (scope `global`);
 * - `<project>/.dork/extensions/<id>` — a project's own (scope `local`);
 * - `{dorkHome}/plugins/<plugin>/.dork/extensions/<id>` — carried inside an
 *   installed marketplace plugin (scope `global`, DOR-2383);
 * - `<project>/.dork/plugins/<plugin>/.dork/extensions/<id>` — carried inside a
 *   plugin installed into the project (scope `local`).
 *
 * `<project>` is the working directory and every known project core has seen
 * (spec `flow-multiproject` §9.2), so which copy runs no longer depends on the
 * folder the server started in. The plugin roots are where the marketplace
 * installer puts a plugin (`marketplace/flows/install-plugin.ts`). When one id
 * turns up in more than one place, precedence is: a core extension, then an
 * extension installed directly (the working directory's project copy before any
 * other project's), then the plugin-carried copies, resolved by
 * `extension-precedence.ts` — where copies installed from one trusted source
 * collapse to the newest. A project copy never takes over an id that ships with
 * DorkOS, that a person approved for another copy, or that a trusted source
 * already holds. When a project scope names the same directory on disk as the
 * global one it is scanned once, as global. See {@link ExtensionDiscovery.discover}.
 */
export class ExtensionDiscovery {
  private dorkHome: string;
  private host: HostVersion;

  /**
   * Create a scanner rooted at one DorkOS data directory.
   *
   * @param dorkHome - The DorkOS data directory.
   * @param host - The build `minHostVersion` is checked against; defaults to
   *   the running server. Tests pass a fixed one.
   */
  constructor(dorkHome: string, host: HostVersion = RUNNING_HOST_VERSION) {
    this.dorkHome = dorkHome;
    this.host = host;
  }

  /**
   * Scan every extension root, then resolve each record's `origin` (from the
   * staging directory it was read from) and tier-aware `status`.
   *
   * The roots are DorkOS's own, the working directory's project, and every
   * project in `projects` (spec `flow-multiproject` §9.2): each root's
   * `.dork/extensions` and `.dork/plugins/<p>/.dork/extensions`, and nothing
   * deeper, so the scan stays bounded. A root is scanned once however many
   * ways it is named, a root that is the DorkOS home is not scanned as a
   * project, and a root whose folder is gone finds nothing.
   *
   * @param cwd - Optional current working directory for local extension scanning.
   * @param config - The user's `{ enabled, disabled }` deviation lists plus
   *   `approvedToRun`, `approvedSources` and `trustedSources`, read here so a
   *   project directory or a second plugin cannot take over the id of an
   *   extension the person approved.
   * @param core - Tier metadata for bundled core extensions, keyed by id.
   * @param projects - Known project roots to scan as well. The caller passes
   *   only roots core has seen itself, never ones only an extension reported
   *   (§6.1), so an extension cannot widen where core looks for code.
   * @returns Every copy that runs, one per id, followed by the copies a newer
   *   copy of the same trusted origin shadows (each with `shadowedBy` set).
   */
  async discover(
    cwd: string | null,
    config: ExtensionsConfig,
    core: Map<string, CoreExtensionInfo>,
    projects: readonly string[] = []
  ): Promise<ExtensionRecord[]> {
    const globalDir = path.join(this.dorkHome, 'extensions');
    const globalRecords = await this.scanDirectory(globalDir, 'global');
    const globalPluginsDir = path.join(this.dorkHome, 'plugins');
    const pluginRecords = await this.scanPlugins(globalPluginsDir, 'global');

    // The working directory first (its copy keeps today's standing), then every
    // other known project in sorted order, each canonical root once.
    const roots = await this.projectRoots(cwd, projects, globalDir);
    const cwdRecords: DiscoveredRecord[] = [];
    const otherProjectRecords: DiscoveredRecord[] = [];
    for (const { root, isCwd } of roots) {
      const localDir = path.join(root, '.dork', 'extensions');
      if (await this.isSameDirectory(localDir, globalDir)) {
        // The folder holds the DorkOS home — `$HOME` for a Finder-launched Mac
        // app, or `dorkos` started from `~`. Scanning it a second time re-found
        // every installed extension as a "project copy" of itself and warned
        // about each one on every discovery pass (DOR-1336). One directory, one
        // scan: nothing here is a project copy of anything.
        logger.debug(
          `[Extensions] Skipping the project scan: ${localDir} is the installed extensions ` +
            `directory, not a project copy of it`
        );
      } else {
        (isCwd ? cwdRecords : otherProjectRecords).push(
          ...(await this.scanDirectory(localDir, 'local'))
        );
      }
      // The same rule for plugins installed into the project.
      const localPluginsDir = path.join(root, '.dork', 'plugins');
      if (!(await this.isSameDirectory(localPluginsDir, globalPluginsDir))) {
        pluginRecords.push(...(await this.scanPlugins(localPluginsDir, 'local')));
      }
    }

    // Where each plugin-carried copy provably came from (§9.1): only from this
    // machine's own install records, never from a file inside the project.
    const installs = await readTrustedInstalls(this.dorkHome);
    // One walk per plugin folder per scan, however many extensions it carries.
    const inspected = new Map<string, Promise<CopyOnDisk>>();
    for (const rec of pluginRecords) {
      const key = `${rec.scope}:${installRootOf(rec.path)}`;
      let pending = inspected.get(key);
      if (!pending) {
        pending = inspectCopy(rec);
        inspected.set(key, pending);
      }
      const onDisk = await pending;
      const proof = proveOrigin(rec, installs, onDisk);
      if (proof.origin) {
        rec.trustedOrigin = proof.origin;
        if (proof.pinnedDigest) rec.pinnedDigest = proof.pinnedDigest;
      }
      if (proof.problem) rec.originProblem = proof.problem;
      if (onDisk.folder.kind === 'digest') {
        // What a digest-pinned approval of this copy is compared with.
        rec.currentDigest = onDisk.folder.digest;
        // A person's yes named these exact files (a changed copy's fresh yes,
        // or "Stop trusting" keeping a running copy): the compile, and the
        // snapshot it runs from, hold it to them.
        const approved = config.approvedSources?.[rec.id];
        if (approved?.digest && approved.digest === rec.currentDigest) {
          rec.pinnedDigest = rec.currentDigest;
        }
      }
    }

    // Ids a plugin copy from a trusted source already speaks for: a project's
    // own folder must not take their place any more than an approved one's.
    const trustedIds = new Set(
      pluginRecords.filter((rec) => isFromTrustedSource(rec, config)).map((rec) => rec.id)
    );
    // An id already approved for some OTHER copy, or held by a copy from a
    // trusted source. Only a person's decision put either there, so a project
    // file must not take its place.
    const approvedElsewhere = (rec: DiscoveredRecord): boolean => {
      const copy = { ...rec, origin: 'user' as const };
      if (isApprovedCopy(copy, config) || isFromTrustedSource(copy, config)) return false;
      // The approval names THIS folder, but its files changed since: not
      // another copy's, so it stays listed and asks for a fresh yes rather
      // than vanishing (security review of DOR-2527).
      const named = config.approvedSources?.[rec.id];
      if (
        named &&
        path.resolve(named.path) === path.resolve(rec.path) &&
        (named.plugin ?? null) === (rec.sourcePlugin ?? null)
      ) {
        return false;
      }
      return config.approvedToRun.includes(rec.id) || trustedIds.has(rec.id);
    };

    // Merge: local overrides global by extension ID
    const merged = new Map<string, DiscoveredRecord>();
    for (const rec of globalRecords) {
      merged.set(rec.id, rec);
    }
    for (const rec of cwdRecords) {
      // ...except for an id whose standing is already spoken for: one DorkOS ships
      // (`core`), or one a person approved to run code for another copy. Both are
      // decisions about a copy that is not this one, and an id is all a project
      // directory needs to inherit them — a file an agent writes with no prompt
      // and no shell (the DOR-511 adversary the approval record itself is placed
      // to avoid). A project copy may still override any ordinary global
      // extension, which is what the local scope is for.
      if (core.has(rec.id) || approvedElsewhere(rec)) {
        this.warnIgnoredProjectCopy(rec, globalDir);
        continue;
      }
      merged.set(rec.id, rec);
    }
    // A direct copy in any other known project counts as a project copy with the
    // same rule, and fills only an id nothing above holds: opening one project
    // must not let another project's folder replace what runs.
    const otherById = new Map<string, DiscoveredRecord[]>();
    for (const rec of otherProjectRecords) {
      if (core.has(rec.id) || approvedElsewhere(rec)) {
        this.warnIgnoredProjectCopy(rec, globalDir);
        continue;
      }
      if (merged.has(rec.id)) continue;
      const group = otherById.get(rec.id);
      if (group) group.push(rec);
      else otherById.set(rec.id, [rec]);
    }
    for (const [id, copies] of otherById) {
      const chosen =
        copies.find((c) => isApprovedCopy({ ...c, origin: 'user' }, config)) ?? copies[0];
      if (!chosen) continue;
      if (copies.length > 1) {
        logger.warn(
          `[Extensions] More than one project holds '${id}' (${copies.map((c) => c.path).join(', ')}); ` +
            `using ${chosen.path}.`
        );
      }
      merged.set(id, chosen);
    }

    const shadowed = mergePluginRecords(merged, pluginRecords, config, core, approvedElsewhere);

    // Resolve origin (from the staging directory on disk) and tier-aware status.
    const stagingDir = path.resolve(globalDir);
    const results: ExtensionRecord[] = [];
    for (const rec of merged.values()) {
      results.push(await this.resolveRecord(rec, config, core, stagingDir));
    }
    const shadowedResults: ExtensionRecord[] = [];
    for (const { record, shadowedBy } of shadowed) {
      shadowedResults.push({
        ...(await this.resolveRecord(record, config, core, stagingDir)),
        shadowedBy,
      });
    }

    logger.info(
      `[Extensions] Discovered ${results.length} extension(s): ${
        results
          .map((r) => {
            const flags: string[] = [r.origin, r.status];
            if (r.sourcePlugin) flags.push(`plugin ${r.sourcePlugin}`);
            if (r.trustedOrigin) flags.push(`from ${r.trustedOrigin.source}`);
            if (r.hasServerEntry) flags.push('server');
            if (r.hasDataProxy) flags.push('proxy');
            return `${r.id} (${flags.join(', ')})`;
          })
          .join(', ') || 'none'
      }${shadowedResults.length > 0 ? `; ${shadowedResults.length} older copy(ies) not used` : ''}`
    );
    return [...results, ...shadowedResults];
  }

  /**
   * Resolve one record's `origin` and status.
   *
   * `origin: 'core'` means "this is the copy `ensureCoreExtensions` staged", so
   * it is answered by WHERE the record was read from, never by its id and never
   * by a manifest claim — VS Code's `isBuiltin` semantic, which is a property of
   * the install location. Deriving it from the core map alone let any directory
   * that reused a bundled id run as core: `{cwd}/.dork/extensions/marketplace/
   * server.ts` was `origin: 'core'`, and core short-circuits the load approval,
   * so the planted code was never asked about.
   */
  private async resolveRecord(
    rec: DiscoveredRecord,
    config: ExtensionsConfig,
    core: Map<string, CoreExtensionInfo>,
    stagingDir: string
  ): Promise<ExtensionRecord> {
    const origin: 'core' | 'user' =
      core.has(rec.id) &&
      path.resolve(rec.path) === path.join(stagingDir, rec.id) &&
      (await this.isRealDirectory(rec.path))
        ? 'core'
        : 'user';
    if (rec.status === 'invalid') return { ...rec, origin };
    if (!this.checkCompatibility(rec.manifest)) return { ...rec, status: 'incompatible', origin };
    return { ...rec, status: isEnabled(rec.id, config, core) ? 'enabled' : 'disabled', origin };
  }

  /** Say, once per copy, why a project's own copy of an id is not used. */
  private warnIgnoredProjectCopy(rec: DiscoveredRecord, globalDir: string): void {
    logger.warn(
      `[Extensions] Ignoring the project copy of '${rec.id}' at ${rec.path}: that id ` +
        `belongs to the extension installed under ${globalDir}. Rename it, or remove the ` +
        `installed one first.`
    );
  }

  /**
   * The project roots to scan: the working directory first, then every other
   * root in sorted order, each canonical folder once. A folder that no longer
   * exists is skipped (the registry keeps it; a drive may be unplugged).
   *
   * @param cwd - The working directory, or null.
   * @param projects - Known project roots.
   * @param globalDir - DorkOS's own extensions directory.
   */
  private async projectRoots(
    cwd: string | null,
    projects: readonly string[],
    globalDir: string
  ): Promise<Array<{ root: string; isCwd: boolean }>> {
    const seen = new Set<string>();
    const roots: Array<{ root: string; isCwd: boolean }> = [];
    const dorkHome = await this.canonicalize(path.dirname(globalDir));
    if (cwd) {
      seen.add(await this.canonicalize(cwd));
      roots.push({ root: cwd, isCwd: true });
    }
    for (const project of [...projects].sort()) {
      const canonical = await this.canonicalize(project);
      if (seen.has(canonical) || canonical === dorkHome) continue;
      seen.add(canonical);
      if (!(await this.isDirectory(project))) continue;
      roots.push({ root: project, isCwd: false });
    }
    return roots;
  }

  /**
   * Whether `target` exists and is a directory, following links.
   *
   * @param target - Path to check.
   */
  private async isDirectory(target: string): Promise<boolean> {
    try {
      return (await fs.stat(target)).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Scan every installed plugin under `pluginsDir` for the extensions it carries
   * in its own `.dork/extensions/`, tagging each record with its plugin.
   *
   * @param pluginsDir - A `plugins` install root: `{dorkHome}/plugins` or
   *   `{cwd}/.dork/plugins`.
   * @param scope - `global` for the DorkOS home, `local` for a project.
   * @returns The carried records, sorted by plugin name so a duplicate id always
   *   resolves the same way.
   */
  private async scanPlugins(
    pluginsDir: string,
    scope: 'global' | 'local'
  ): Promise<DiscoveredRecord[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(pluginsDir, { withFileTypes: true });
    } catch {
      // No plugins installed in this scope.
      return [];
    }
    // An install engine sibling (a backup, a staging copy, an uninstall in
    // flight) holds a plugin's files but is not an installed plugin: reading it
    // would find every carried extension twice.
    const names = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => !isInstallSiblingName(name))
      .sort();
    const records: DiscoveredRecord[] = [];
    for (const plugin of names) {
      const carried = await this.scanDirectory(
        path.join(pluginsDir, plugin, '.dork', 'extensions'),
        scope
      );
      for (const rec of carried) records.push({ ...rec, sourcePlugin: plugin });
    }
    return records;
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
    return satisfiesMinHostVersion(manifest.minHostVersion, this.host);
  }
}
