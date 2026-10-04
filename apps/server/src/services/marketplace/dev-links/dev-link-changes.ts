/**
 * What a change inside a dev-linked folder asks DorkOS to do (DOR-2696, spec
 * `marketplace-dev-link` §6): which paths are never watched, how a burst of
 * changes is classified, and the cheap listing the sweep compares. Pure apart
 * from {@link shapeOf}, which reads the folder.
 *
 * @module services/marketplace/dev-links/dev-link-changes
 */
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isRuntimeStatePath } from '../lib/content-hash.js';

/** Directory names never watched anywhere inside a linked folder. */
const IGNORED_DIR_NAMES = new Set(['.git', 'node_modules']);

/** Where a package carries its extensions, relative to its folder. */
const EXTENSIONS_REL = '.dork/extensions';

/** Folders whose changes the harness projects (besides a root `SKILL.md`). */
const PROJECTED_PREFIXES = ['skills', 'commands', 'hooks', '.dork/tasks'] as const;

/** Of those, the ones that also hold declarations a package runs on its own. */
const DECLARING_PREFIXES = ['skills', 'commands', 'hooks'] as const;

/**
 * The directories the sweep lists, relative to the folder. Each extension's own
 * folder is added per pass. Deeper edits are left to the watch, which in a
 * steady state misses nothing (`skills-watcher.ts`).
 */
const SWEPT_DIRS = [
  '',
  '.claude-plugin',
  '.dork',
  EXTENSIONS_REL,
  '.dork/tasks',
  'skills',
  'commands',
  'hooks',
  'bin',
  'monitors',
] as const;

/** A filesystem event, as chokidar names it. */
export type DevLinkChangeKind = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';

/** One change inside a linked folder. */
export interface DevLinkChange {
  /** POSIX path relative to the folder; `''` is the folder itself. */
  rel: string;
  /** What happened to it. */
  kind: DevLinkChangeKind;
}

/** What a burst of changes asks for. */
export interface DevLinkReloadPlan {
  /** Extension folder names (under `.dork/extensions`) to rebuild, sorted. */
  reload: string[];
  /** Re-scan every extension before rebuilding any. */
  refreshExtensions: boolean;
  /** Run a project dev link's harness projection again. */
  projection: boolean;
  /** Refresh the runtime's plugin list and check what the package runs again. */
  plugins: boolean;
}

/**
 * Whether a path inside a linked folder is never watched or acted on: anything
 * under a `.git` or `node_modules` directory, and DorkOS's own runtime state
 * (`isRuntimeStatePath`: saved data, secrets, install records).
 *
 * @param rel - POSIX path relative to the folder.
 */
export function isIgnoredDevLinkPath(rel: string): boolean {
  if (rel === '') return false;
  if (rel.split('/').some((segment) => IGNORED_DIR_NAMES.has(segment))) return true;
  return isRuntimeStatePath(rel);
}

/** Whether `rel` is `prefix` or lies under it. */
function under(rel: string, prefix: string): boolean {
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

/**
 * Decide what a burst of changes asks for. Pure.
 *
 * | Changed path                                         | Asks for                     |
 * | ---------------------------------------------------- | ---------------------------- |
 * | `.dork/extensions/<dir>/**`, `<dir>` known           | rebuild `<dir>`              |
 * | `.dork/extensions/<dir>/extension.json`, known       | re-scan, then rebuild        |
 * | a new or removed `.dork/extensions/<dir>`, or an unknown one | re-scan               |
 * | `skills/**`, `commands/**`, `hooks/**`, root `SKILL.md` | projection and plugins    |
 * | `.dork/tasks/**`                                     | projection                   |
 * | anything else (manifests, `bin/`, servers, monitors) | plugins                      |
 *
 * Skills, commands and hooks ask for both because their frontmatter and files
 * declare hooks the package runs on its own, which global consent re-checks.
 * "Anything else" errs toward checking again: a plugin may name its hooks or
 * servers file anywhere, and a refresh that finds nothing new costs little.
 *
 * @param changes - The burst, in any order.
 * @param knownExtensionDirs - Extension folder names DorkOS already has a
 *   record for, from this linked folder.
 */
export function classifyDevLinkChanges(
  changes: readonly DevLinkChange[],
  knownExtensionDirs: ReadonlySet<string>
): DevLinkReloadPlan {
  const reload = new Set<string>();
  let refreshExtensions = false;
  let projection = false;
  let plugins = false;
  for (const { rel, kind } of changes) {
    if (isIgnoredDevLinkPath(rel)) continue;
    if (under(rel, EXTENSIONS_REL)) {
      const parts = rel.split('/');
      const dir = parts[2];
      if (dir === undefined) {
        refreshExtensions = true;
        continue;
      }
      const known = knownExtensionDirs.has(dir);
      if (parts.length === 3) {
        // The extension's own folder: appearing or going away is a re-scan; a
        // sweep's "something in it changed" is a rebuild when it is known.
        if (kind === 'change' && known) reload.add(dir);
        else refreshExtensions = true;
        continue;
      }
      if (!known) {
        refreshExtensions = true;
        continue;
      }
      if (parts.length === 4 && parts[3] === 'extension.json') refreshExtensions = true;
      reload.add(dir);
      continue;
    }
    if (rel === 'SKILL.md' || PROJECTED_PREFIXES.some((prefix) => under(rel, prefix))) {
      projection = true;
      if (rel === 'SKILL.md' || DECLARING_PREFIXES.some((prefix) => under(rel, prefix))) {
        plugins = true;
      }
      continue;
    }
    plugins = true;
  }
  return { reload: [...reload].sort(), refreshExtensions, projection, plugins };
}

/**
 * POSIX path of `abs` relative to `folder`, or `null` when it is outside.
 *
 * @param folder - The linked folder.
 * @param abs - An absolute path.
 */
export function relativeTo(folder: string, abs: string): string | null {
  const rel = path.relative(folder, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * A cheap listing of a folder's meaningful directories: each one's entries
 * with their modification time and size, ignored paths left out. Changes
 * whenever an entry appears, goes or is rewritten at those levels.
 *
 * @param folder - The linked folder.
 * @returns Listing by swept directory; `-` for one that cannot be read.
 */
export async function shapeOf(folder: string): Promise<Map<string, string>> {
  const shape = new Map<string, string>();
  const extensionDirs = await readdir(path.join(folder, EXTENSIONS_REL), {
    withFileTypes: true,
  }).catch(() => []);
  const dirs = [
    ...SWEPT_DIRS,
    ...extensionDirs
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${EXTENSIONS_REL}/${entry.name}`),
  ];
  for (const rel of dirs) {
    const abs = path.join(folder, rel);
    const entries = await readdir(abs).catch(() => null);
    if (entries === null) {
      shape.set(rel, '-');
      continue;
    }
    const parts: string[] = [];
    for (const name of entries.sort()) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (isIgnoredDevLinkPath(childRel)) continue;
      const stats = await lstat(path.join(abs, name)).catch(() => null);
      parts.push(stats ? `${name}:${stats.mtimeMs}:${stats.size}` : `${name}:?`);
    }
    shape.set(rel, parts.join('|'));
  }
  return shape;
}

/**
 * The swept directories whose listing differs, as changes to act on.
 *
 * @param before - The listing last acted on.
 * @param after - The listing now.
 */
export function shapeChanges(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>
): DevLinkChange[] {
  const changes: DevLinkChange[] = [];
  for (const rel of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(rel);
    const is = after.get(rel);
    if (was === is) continue;
    // An extension folder that appeared or went away is a re-scan; any other
    // difference is "something in it changed".
    const appeared = was === undefined || was === '-';
    const vanished = is === undefined || is === '-';
    changes.push({ rel, kind: appeared ? 'addDir' : vanished ? 'unlinkDir' : 'change' });
  }
  return changes;
}
