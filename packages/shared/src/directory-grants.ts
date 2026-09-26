/**
 * The one validator for a turn's folder grants (spec `agent-home-desk` §4.1).
 *
 * The dispatcher is the only producer of {@link DirectoryGrant}s, so a set that
 * fails here is a programming error, never something a person typed. Every
 * runtime calls {@link assertValidDirectoryGrants} before it launches its
 * backend, so a bad set stops the turn instead of reaching a harness that would
 * read it some other way than DorkOS meant.
 *
 * @module shared/directory-grants
 */
import os from 'node:os';
import path from 'node:path';
import type { DirectoryGrant } from './agent-runtime.js';

/** A grant set that no runtime may hand its backend. */
export class DirectoryGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectoryGrantError';
  }
}

/**
 * Whether `child` is `parent` or sits somewhere under it, by path segments (so
 * `/a/bc` is not inside `/a/b`). Both paths are compared as given; callers pass
 * normalized absolute paths.
 *
 * @param child - The path being placed.
 * @param parent - The folder it may sit in.
 */
export function isSameOrInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === '') return true;
  const escapes = relative === '..' || relative.startsWith(`..${path.sep}`);
  return !escapes && !path.isAbsolute(relative);
}

/**
 * Throw unless `grants` is a set a runtime may hand its backend for a turn
 * standing in `cwd`: every path absolute and normalized, no path twice, none
 * equal to or inside `cwd` (the turn already stands there), and none that is a
 * filesystem root or the user's home folder itself (a grant that wide is not a
 * grant of a folder, it is a grant of everything).
 *
 * @param grants - The turn's grants, as the dispatcher computed them.
 * @param cwd - The directory the turn runs in.
 * @param homeDir - The user's home folder; defaults to the OS answer.
 * @throws DirectoryGrantError naming the first grant that breaks a rule.
 */
export function assertValidDirectoryGrants(
  grants: readonly DirectoryGrant[],
  cwd: string,
  homeDir: string = os.homedir()
): void {
  const seen = new Set<string>();
  const turnDir = path.resolve(cwd);
  for (const grant of grants) {
    const where = `Folder grant "${grant.path}"`;
    if (grant.access !== 'read' && grant.access !== 'write') {
      throw new DirectoryGrantError(`${where} has no valid access ("read" or "write").`);
    }
    if (!path.isAbsolute(grant.path)) {
      throw new DirectoryGrantError(`${where} is not an absolute path.`);
    }
    if (path.parse(grant.path).root === grant.path) {
      throw new DirectoryGrantError(`${where} is a filesystem root.`);
    }
    if (path.normalize(grant.path) !== grant.path || /[\\/]$/.test(grant.path)) {
      throw new DirectoryGrantError(`${where} is not a normalized path.`);
    }
    if (grant.path === path.resolve(homeDir)) {
      throw new DirectoryGrantError(`${where} is the user's home folder itself.`);
    }
    if (isSameOrInside(grant.path, turnDir)) {
      throw new DirectoryGrantError(
        `${where} is the turn's own directory or inside it, which the turn can already reach.`
      );
    }
    if (seen.has(grant.path)) {
      throw new DirectoryGrantError(`${where} appears more than once.`);
    }
    seen.add(grant.path);
  }
}

/**
 * The order-free identity of a grant set: `path:access` pairs, sorted. Two
 * sets that hand the same folders the same way have the same fingerprint
 * whatever order the dispatcher listed them in.
 *
 * @param grants - The grants to identify; absent means none.
 */
export function directoryGrantsFingerprint(grants: readonly DirectoryGrant[] | undefined): string {
  return (grants ?? [])
    .map((grant) => `${grant.path}:${grant.access}`)
    .sort()
    .join('\n');
}
