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
import { realpathSync } from 'node:fs';
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
 * `target` as the filesystem spells it. A path that does not exist yet keeps
 * its missing tail on the resolved nearest existing ancestor, so a file about
 * to be written compares the same way as one already there. `/tmp/x` on macOS
 * comes back as `/private/tmp/x`.
 *
 * @param target - An absolute path.
 */
export function realPathOf(target: string): string {
  let existing = target;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(existing), ...tail.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      tail.push(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Throw unless `grants` is a set a runtime may hand its backend for a turn
 * standing in `cwd`:
 *
 * - every path absolute, normalized and `realpath`-resolved — a backend
 *   compares the paths its tools touch against the resolved spelling, so a
 *   grant spelled through a symlink (`/tmp` for `/private/tmp`) would silently
 *   fail to match, and for a `read` grant that is a write let through;
 * - no path twice;
 * - none equal to, inside, or CONTAINING `cwd` — the turn already reaches its
 *   own folder, and a `read` grant above it would refuse edits in it;
 * - none that is, or contains, the user's home folder or a filesystem root — a
 *   grant that wide is not a grant of a folder, it is a grant of everything;
 * - no `read` grant inside a `write` one. Claude Code and OpenCode could refuse
 *   writes to it, but Codex's `--add-dir` makes the whole `write` folder
 *   writable, so the runtimes would disagree about the same set. (A `write`
 *   grant inside a `read` one is fine: the read folder wins for file tools
 *   everywhere, and Codex's shell can still write the nested folder, which is
 *   what a room's `repo/.git` needs.)
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
  const home = path.resolve(homeDir);
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
    if (realPathOf(grant.path) !== grant.path) {
      throw new DirectoryGrantError(
        `${where} is not realpath-resolved (the filesystem spells it "${realPathOf(grant.path)}").`
      );
    }
    if (isSameOrInside(home, grant.path)) {
      throw new DirectoryGrantError(`${where} is the user's home folder or contains it.`);
    }
    if (isSameOrInside(grant.path, turnDir)) {
      throw new DirectoryGrantError(
        `${where} is the turn's own directory or inside it, which the turn can already reach.`
      );
    }
    if (isSameOrInside(turnDir, grant.path)) {
      throw new DirectoryGrantError(`${where} contains the turn's own directory.`);
    }
    if (seen.has(grant.path)) {
      throw new DirectoryGrantError(`${where} appears more than once.`);
    }
    seen.add(grant.path);
  }
  for (const grant of grants) {
    if (grant.access !== 'read') continue;
    const outer = grants.find(
      (other) =>
        other.access === 'write' &&
        other.path !== grant.path &&
        isSameOrInside(grant.path, other.path)
    );
    if (outer) {
      throw new DirectoryGrantError(
        `Folder grant "${grant.path}" is read-only inside the write grant "${outer.path}", which not every runtime can enforce.`
      );
    }
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
