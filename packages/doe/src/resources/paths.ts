import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { PathPolicy } from '../contracts.js';
/** Resolve every existing symlink before collapsing parent segments, including new destinations. */
export async function canonicalPath(
  input: string,
  workingDirectory: string,
  hops = 0
): Promise<string> {
  if (!path.isAbsolute(workingDirectory)) throw new Error('Working directory must be absolute');
  if (!input || input.includes('\0')) throw new Error('Invalid path');
  if (hops > 40) throw new Error('Access denied: symlink cycle');
  const absolute = path.isAbsolute(input) ? input : `${workingDirectory}${path.sep}${input}`;
  const root = path.parse(absolute).root;
  let current = root;
  const segments = absolute.slice(root.length).split(path.sep);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      current = path.dirname(current);
      continue;
    }
    const candidate = path.join(current, segment);
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) {
        const target = await readlink(candidate);
        const rawTarget = path.isAbsolute(target) ? target : `${current}${path.sep}${target}`;
        return canonicalPath(
          `${rawTarget}${path.sep}${segments.slice(index + 1).join(path.sep)}`,
          workingDirectory,
          hops + 1
        );
      }
      if (!stat.isDirectory() && segments.slice(index + 1).some(Boolean))
        throw new Error('Invalid path: parent is not a directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    current = candidate;
  }
  return current;
}
/** Canonical containment uses directory boundaries, never a raw prefix match. */
export function contained(target: string, root: string): boolean {
  return (
    target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
  );
}
/** Explicit host grants; neither instruction nor skill discovery adds a root. */
export class CanonicalPaths {
  constructor(
    private readonly policy: PathPolicy,
    private readonly workingDirectory: string
  ) {}
  /** Resolve an existing or new target and refuse targets outside the selected host grants. */
  async resolve(input: string, mode: 'read' | 'write'): Promise<string> {
    const target = await canonicalPath(input, this.workingDirectory);
    const roots = mode === 'read' ? this.policy.readRoots : this.policy.writeRoots;
    for (const root of roots) {
      const canonicalRoot = await realpath(await canonicalPath(root, this.workingDirectory));
      if (contained(target, canonicalRoot)) return target;
    }
    throw new Error(`Access denied: path outside ${mode} grants`);
  }
}
