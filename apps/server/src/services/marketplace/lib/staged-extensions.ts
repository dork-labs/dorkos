/**
 * Shared helpers for discovering and compiling the inline extensions bundled
 * inside a staged marketplace package.
 *
 * Both the plugin flow ({@link ../flows/install-plugin.PluginInstallFlow}) and
 * the shape flow ({@link ../flows/install-shape.ShapeInstallFlow}) copy a
 * package into a staging directory and must compile every extension it bundles
 * under `.dork/extensions/<id>/` before the atomic activation move. The two
 * flows differ only in what they do *after* the move (a plugin enables its
 * extensions immediately; a Shape leaves them disabled until it is applied), so
 * the discover + compile machinery lives here and is shared verbatim.
 *
 * @module services/marketplace/lib/staged-extensions
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionManifest, ExtensionRecord } from '@dorkos/extension-api';
import { ExtensionManifestSchema } from '@dorkos/extension-api';
import type { Logger } from '@dorkos/shared/logger';

/**
 * Structural interface for the extension compiler dependency. Mirrors the
 * shape of {@link ../../extensions/extension-compiler.ExtensionCompiler}'s
 * `compile` method but is declared locally so install flows can be exercised
 * with lightweight test doubles.
 */
export interface StagedExtensionCompiler {
  compile(
    record: ExtensionRecord
  ): Promise<
    | { code: string; sourceHash: string }
    | { error: { code: string; message: string }; sourceHash: string }
  >;
}

/** A single extension discovered within a staged package. */
export interface StagedExtension {
  id: string;
  path: string;
  manifest: ExtensionManifest;
}

/**
 * Walk `<root>/.dork/extensions/<id>/extension.json` and return every extension
 * found, with parsed manifests. Invalid manifests are skipped — the package
 * validator is responsible for surfacing schema errors before this point.
 *
 * @param root - Absolute path to a staged (or installed) package root.
 * @returns The discovered extensions, in directory order.
 */
export async function discoverStagedExtensions(root: string): Promise<StagedExtension[]> {
  const extRoot = path.join(root, '.dork', 'extensions');
  if (!(await pathExists(extRoot))) return [];

  const entries = await readdir(extRoot, { withFileTypes: true });
  const found: StagedExtension[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const extDir = path.join(extRoot, entry.name);
    const manifestPath = path.join(extDir, 'extension.json');
    if (!(await pathExists(manifestPath))) continue;
    const parsed = await readExtensionManifest(manifestPath);
    if (parsed) {
      found.push({ id: entry.name, path: extDir, manifest: parsed });
    }
  }
  return found;
}

/**
 * Compile every extension bundled in a staged package. Throws on the first
 * compile error so the caller's transaction wrapper tears the staging directory
 * down before activation ever runs — a malformed inline extension never lands
 * on disk.
 *
 * @param stagingDir - Absolute path to the staged package directory.
 * @param compiler - The extension compiler (or a structural test double).
 * @param logger - Structured logger for per-extension progress.
 * @param logPrefix - Log prefix identifying the calling flow (e.g. `[install-shape]`).
 * @throws When any bundled extension fails to compile.
 */
export async function compileStagedExtensions(
  stagingDir: string,
  compiler: StagedExtensionCompiler,
  logger: Logger,
  logPrefix: string
): Promise<void> {
  const extensions = await discoverStagedExtensions(stagingDir);
  for (const ext of extensions) {
    const record = buildCompilerRecord(ext);
    const result = await compiler.compile(record);
    if ('error' in result) {
      throw new Error(
        `${logPrefix} Extension '${ext.id}' failed to compile: ${result.error.message}`
      );
    }
    logger.info(`${logPrefix} Compiled extension ${ext.id}`);
  }
}

/**
 * List the bundled extension IDs under `<root>/.dork/extensions/` by directory
 * name, without parsing each `extension.json`. Unlike
 * {@link discoverStagedExtensions}, this does not skip extensions whose manifest
 * fails to parse — a dangling extension must still be enumerable even if its
 * manifest is malformed. Returns an empty array when `root` or its extensions
 * directory does not exist.
 *
 * @param root - Absolute path to a staged (or installed) package root.
 * @returns The bundled extension directory names.
 */
export async function discoverExtensionIds(root: string): Promise<string[]> {
  const extRoot = path.join(root, '.dork', 'extensions');
  if (!(await pathExists(extRoot))) return [];
  const entries = await readdir(extRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * Build the minimal {@link ExtensionRecord} the compiler needs. The record is
 * transient — it lives only for the duration of the compile call and is never
 * persisted.
 *
 * @param ext - The staged extension to build a record for.
 * @returns A transient compiler record.
 */
export function buildCompilerRecord(ext: StagedExtension): ExtensionRecord {
  return {
    id: ext.id,
    manifest: ext.manifest,
    status: 'discovered',
    scope: 'global',
    origin: 'user',
    path: ext.path,
    bundleReady: false,
    hasServerEntry: false,
    hasDataProxy: ext.manifest.dataProxy !== undefined,
  };
}

/**
 * Parse a single `extension.json` file. Returns `null` on any read or
 * validation failure so the caller can skip the extension instead of failing
 * the entire install on a malformed manifest.
 *
 * @param manifestPath - Absolute path to an `extension.json` file.
 * @returns The parsed manifest, or `null` when it cannot be read or validated.
 */
export async function readExtensionManifest(
  manifestPath: string
): Promise<ExtensionManifest | null> {
  try {
    const raw = await readFile(manifestPath, 'utf-8');
    const parsed = ExtensionManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Returns true if the supplied path exists on disk (file or directory).
 *
 * @param target - Absolute path to test.
 * @returns Whether the path exists.
 */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
