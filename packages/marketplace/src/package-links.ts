/**
 * Find the symbolic links ("shortcuts") inside a package, so a person sees
 * what will not be installed (DOR-2319).
 *
 * Staging copies a package without any of its links (see
 * `apps/server/src/services/marketplace/lib/stage-package.ts`), and nothing
 * reads through a link before then. So a link in a package is simply not
 * installed: a skill folder that is a shortcut to a folder elsewhere (some
 * official plugins ship these) arrives missing. Saying so up front is kinder
 * than a skill that silently is not there.
 *
 * The walk never follows a link. It resolves each link's target only to say
 * where it leads, and never reads it. `.git` and `node_modules` are skipped:
 * links there are tooling, not content a person would miss. The walk stops
 * after {@link MAX_ENTRIES_WALKED} entries.
 *
 * Node-only (`node:fs`).
 *
 * @module marketplace/package-links
 */
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Directories the walk does not enter: tooling, not package content. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

/** The most directory entries one walk looks at. */
export const MAX_ENTRIES_WALKED = 50_000;

/** One symbolic link found in a package. */
export interface PackageLink {
  /** The link's path, relative to the package root, with `/` separators. */
  path: string;
  /** Where it leads: outside the package, inside it, or nowhere (a broken link). */
  leadsTo: 'outside' | 'inside' | 'nowhere';
  /** What it leads to, when it leads anywhere. */
  kind: 'folder' | 'file' | 'other' | null;
}

/**
 * Every symbolic link in a package tree, in a stable (sorted) order.
 *
 * @param packagePath - The package root. It may itself be reached through a link.
 * @returns The links found; `[]` when the root cannot be read.
 */
export async function findPackageLinks(packagePath: string): Promise<PackageLink[]> {
  let realRoot: string;
  try {
    realRoot = await realpath(packagePath);
  } catch {
    return [];
  }
  const links: PackageLink[] = [];
  const queue: string[] = [''];
  let walked = 0;
  while (queue.length > 0 && walked < MAX_ENTRIES_WALKED) {
    const rel = queue.shift()!;
    let entries;
    try {
      entries = await readdir(path.join(packagePath, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      walked += 1;
      if (walked > MAX_ENTRIES_WALKED) break;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        links.push(await describeTarget(path.join(packagePath, childRel), childRel, realRoot));
      } else if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) {
        queue.push(childRel);
      }
    }
  }
  return links.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Where one link leads, without reading what it leads to.
 *
 * @param fullPath - The link's absolute path.
 * @param relPath - The link's package-relative path.
 * @param realRoot - The package root, resolved.
 */
async function describeTarget(
  fullPath: string,
  relPath: string,
  realRoot: string
): Promise<PackageLink> {
  let target: string;
  let kind: PackageLink['kind'];
  try {
    target = await realpath(fullPath);
    const stats = await stat(fullPath);
    kind = stats.isDirectory() ? 'folder' : stats.isFile() ? 'file' : 'other';
  } catch {
    return { path: relPath, leadsTo: 'nowhere', kind: null };
  }
  const fromRoot = path.relative(realRoot, target);
  const outside =
    path.isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`);
  return { path: relPath, leadsTo: outside ? 'outside' : 'inside', kind };
}

/**
 * One link as a sentence a person can act on.
 *
 * @param link - The link.
 * @returns For example "skills/neon-postgres is a shortcut to a folder outside
 *   the package, so it won't be installed."
 */
export function describePackageLink(link: PackageLink): string {
  if (link.leadsTo === 'nowhere') {
    return `${link.path} is a shortcut that leads nowhere, so it won't be installed.`;
  }
  const what = link.kind === 'folder' ? 'a folder' : link.kind === 'file' ? 'a file' : 'something';
  const where = link.leadsTo === 'outside' ? 'outside the package' : 'elsewhere in the package';
  return `${link.path} is a shortcut to ${what} ${where}, so it won't be installed.`;
}
