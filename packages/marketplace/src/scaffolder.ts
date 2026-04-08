/**
 * @dorkos/marketplace — Package scaffolder.
 *
 * Node.js-only helper that creates a new marketplace package directory on
 * disk, populated with a starter `.dork/manifest.json`, an optional Claude
 * Code plugin manifest, a README, and type-specific starter directories.
 *
 * This module performs filesystem I/O via `node:fs` and is **not** safe to
 * import from browser bundles. It is exposed via the
 * `@dorkos/marketplace/scaffolder` subpath and is intentionally not
 * re-exported from the package barrel.
 *
 * @module @dorkos/marketplace/scaffolder
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { CLAUDE_PLUGIN_MANIFEST_PATH, PACKAGE_MANIFEST_PATH } from './constants.js';
import { requiresClaudePlugin, type PackageType } from './package-types.js';

/**
 * Options accepted by {@link createPackage}.
 */
export interface CreatePackageOptions {
  /** Where to create the package directory. */
  parentDir: string;
  /** Package name (kebab-case). Becomes the directory name and `manifest.name`. */
  name: string;
  /** Package type — determines starter file layout. */
  type: PackageType;
  /** Optional description for the manifest. */
  description?: string;
  /** Optional author for the manifest. */
  author?: string;
  /**
   * Adapter implementation identifier (e.g. `'discord'`, `'slack'`). Only
   * meaningful when `type === 'adapter'`. When omitted for an adapter package
   * the package `name` is used as a placeholder so the scaffolded manifest
   * still passes schema validation — the author is expected to edit it.
   * Ignored for non-adapter package types.
   */
  adapterType?: string;
}

/**
 * Result returned by {@link createPackage}.
 */
export interface CreatePackageResult {
  /** Absolute path to the created package directory. */
  packagePath: string;
  /** Files written, relative to the package root. */
  filesWritten: string[];
}

/**
 * Scaffold a new marketplace package on disk.
 *
 * Creates a directory at `<parentDir>/<name>/` and writes:
 *
 * - `.dork/manifest.json` (always)
 * - `.claude-plugin/plugin.json` (for `plugin`, `skill-pack`, and `adapter` types)
 * - `README.md` (always)
 * - Type-specific starter directories (e.g. empty `skills/`, `tasks/` folders)
 *
 * Refuses to overwrite an existing directory: if `<parentDir>/<name>/` already
 * exists the function throws `Error('Directory already exists: ...')`. Any
 * non-`ENOENT` error from the existence check is re-thrown.
 *
 * @param opts - Options describing the package to create.
 * @returns The absolute package path and the list of files written, relative
 *          to the package root.
 */
export async function createPackage(opts: CreatePackageOptions): Promise<CreatePackageResult> {
  const packagePath = path.join(opts.parentDir, opts.name);

  // Refuse to overwrite existing directories. `fs.access` throws ENOENT when
  // the path is missing — that is the expected "safe to create" path. Any
  // other error (permissions, I/O failure) must propagate to the caller.
  try {
    await fs.access(packagePath);
    throw new Error(`Directory already exists: ${packagePath}`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  await fs.mkdir(packagePath, { recursive: true });
  await fs.mkdir(path.join(packagePath, '.dork'), { recursive: true });

  const filesWritten: string[] = [];

  const baseManifest = {
    schemaVersion: 1,
    name: opts.name,
    version: '0.0.1',
    type: opts.type,
    description: opts.description ?? `${opts.name} — a DorkOS ${opts.type}`,
    author: opts.author,
    license: 'MIT',
    tags: [],
    layers: defaultLayersForType(opts.type),
  };
  // Adapter packages require an `adapterType` field per the discriminated
  // union schema. Default to the package name when not provided so the
  // scaffolded manifest is always valid; the author is expected to edit it.
  const manifest =
    opts.type === 'adapter'
      ? { ...baseManifest, adapterType: opts.adapterType ?? opts.name }
      : baseManifest;
  await fs.writeFile(
    path.join(packagePath, PACKAGE_MANIFEST_PATH),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8'
  );
  filesWritten.push(PACKAGE_MANIFEST_PATH);

  if (requiresClaudePlugin(opts.type)) {
    await fs.mkdir(path.join(packagePath, '.claude-plugin'), { recursive: true });
    const pluginManifest = {
      name: opts.name,
      version: '0.0.1',
      description: manifest.description,
    };
    await fs.writeFile(
      path.join(packagePath, CLAUDE_PLUGIN_MANIFEST_PATH),
      JSON.stringify(pluginManifest, null, 2) + '\n',
      'utf-8'
    );
    filesWritten.push(CLAUDE_PLUGIN_MANIFEST_PATH);
  }

  const readme = `# ${opts.name}\n\n${manifest.description}\n\nCreated with \`dorkos package init\`.\n`;
  await fs.writeFile(path.join(packagePath, 'README.md'), readme, 'utf-8');
  filesWritten.push('README.md');

  for (const dir of starterDirsForType(opts.type)) {
    await fs.mkdir(path.join(packagePath, dir), { recursive: true });
  }

  return { packagePath, filesWritten };
}

/**
 * Default `layers` array written into a freshly scaffolded manifest. Mirrors
 * the conventional layout for each package type. Exhaustive over
 * {@link PackageType}.
 */
function defaultLayersForType(type: PackageType): string[] {
  switch (type) {
    case 'plugin':
      return ['skills', 'extensions'];
    case 'skill-pack':
      return ['skills'];
    case 'adapter':
      return ['adapters'];
    case 'agent':
      return ['skills', 'tasks', 'agents'];
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

/**
 * Type-specific starter directories created (empty) inside the package root.
 * These give authors a familiar layout to drop their content into. Exhaustive
 * over {@link PackageType}.
 */
function starterDirsForType(type: PackageType): string[] {
  switch (type) {
    case 'plugin':
      return ['skills', 'hooks', 'commands'];
    case 'skill-pack':
      return ['skills'];
    case 'adapter':
      return ['.dork/adapters'];
    case 'agent':
      return ['.claude/skills', '.dork/tasks'];
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}
