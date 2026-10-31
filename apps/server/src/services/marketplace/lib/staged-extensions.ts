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
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { PACKAGE_TEXT_MAX_BYTES, readTextFileWithin } from '@dorkos/shared/bounded-read';
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
    { code: string; sourceHash: string } | { error: StagedCompileError; sourceHash: string }
  >;
}

/** What a failed compile reports: a summary, and the bundler's own reasons. */
export interface StagedCompileError {
  code: string;
  message: string;
  errors?: Array<{
    text: string;
    location?: { file: string; line: number; column: number } | null;
  }>;
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
 * @param plugin - The plugin the package installs as (its install folder's
 *   name), when it is a plugin. Its extensions are then held to the plugin's
 *   folder, as they are once installed (DOR-3537); without it, each extension
 *   is held to its own folder.
 * @throws When any bundled extension fails to compile, with the bundler's reason.
 */
export async function compileStagedExtensions(
  stagingDir: string,
  compiler: StagedExtensionCompiler,
  logger: Logger,
  logPrefix: string,
  plugin?: string
): Promise<void> {
  const extensions = await discoverStagedExtensions(stagingDir);
  for (const ext of extensions) {
    const record = buildCompilerRecord(ext, plugin);
    const result = await compiler.compile(record);
    if ('error' in result) {
      // The message reaches the install card, the HTTP body and
      // `marketplace_install` as it is, so it carries the bundler's reason and
      // leaves the flow's log prefix to the log.
      const message = `Extension '${ext.id}' failed to compile: ${describeCompileError(result.error)}`;
      logger.warn(`${logPrefix} ${message}`);
      throw new Error(message);
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
 * Why a compile failed: the bundler's first reason and where it was raised,
 * so the install error says which import failed and which folder it had to
 * stay inside, not only that the build failed. The summary stands in when the
 * bundler gave no reason.
 *
 * @param error - The compiler's error.
 */
export function describeCompileError(error: StagedCompileError): string {
  const reasons = error.errors ?? [];
  const first = reasons[0];
  if (!first) return error.message;
  const where = first.location
    ? ` (${first.location.file}:${first.location.line}:${first.location.column})`
    : '';
  const more = reasons.length > 1 ? ` (and ${reasons.length - 1} more)` : '';
  return `${first.text}${where}${more}`;
}

/**
 * Build the minimal {@link ExtensionRecord} the compiler needs. The record is
 * transient — it lives only for the duration of the compile call and is never
 * persisted.
 *
 * A plugin's extension carries `sourcePlugin`, exactly as discovery tags it
 * once installed, so the compiler applies the same boundary at install as it
 * does afterwards: the staged plugin folder (`<stage>/.dork/extensions/<id>`
 * three levels up), and nothing wider (DOR-3537).
 *
 * @param ext - The staged extension to build a record for.
 * @param plugin - The plugin carrying it, or nothing for a non-plugin package.
 * @returns A transient compiler record.
 */
export function buildCompilerRecord(ext: StagedExtension, plugin?: string): ExtensionRecord {
  return {
    ...(plugin ? { sourcePlugin: plugin } : {}),
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
    const raw = await readTextFileWithin(
      manifestPath,
      PACKAGE_TEXT_MAX_BYTES,
      'The extension.json'
    );
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
