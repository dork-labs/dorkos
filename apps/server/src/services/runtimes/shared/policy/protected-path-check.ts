/** Runtime-neutral refusal checks for native file tools, before mode or grants. */
import path from 'node:path';
import { lstatSync, readlinkSync, readdirSync, statSync } from 'node:fs';
import { protectedPathsAt, type ProtectedPath } from './protected-paths.js';

/** Roots captured for one turn; discovery never widens file access. */
export interface ProtectedPathRoots {
  cwd: string;
  data: string;
  home: string;
  accounts: readonly string[];
  agentFolders: readonly string[];
  agentHomes: readonly string[];
  /**
   * Whether the call runs at Full, which leaves out the paths refused below Full only
   * (`ProtectedPath.belowFull`, DOR-4136). Absent counts as below Full.
   */
  full?: boolean;
}

/** Match a shared path glob: a star spans one name, never a separator. */
function expression(entry: ProtectedPath, nested: boolean): RegExp {
  const escaped = entry.path
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(
    `^${nested ? '(?:[^/]+/)*' : ''}${escaped}${entry.kind === 'folder' ? '(?:/.*)?' : ''}$`,
    'i'
  );
}

/** Resolve links before parent segments, including destinations not created yet. */
function canonical(input: string, cwd: string, hops = 0): string {
  if (!input || input.includes('\0') || hops > 40)
    throw new Error('This file path cannot be checked. Choose another path.');
  const absolute = path.isAbsolute(input) ? input : `${cwd}${path.sep}${input}`;
  const root = path.parse(absolute).root;
  const segments = absolute.slice(root.length).split(path.sep);
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, segment);
    try {
      if (lstatSync(next).isSymbolicLink()) {
        const link = readlinkSync(next);
        const destination = path.isAbsolute(link) ? link : `${current}${path.sep}${link}`;
        return canonical(
          `${destination}${path.sep}${segments.slice(index + 1).join(path.sep)}`,
          cwd,
          hops + 1
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    current = next;
  }
  return current;
}

/** Given and resolved spellings both refuse, including aliases of protected roots. */
function spellings(file: string, cwd: string): string[] {
  return [...new Set([path.resolve(cwd, file), canonical(file, cwd)])];
}

/** Compile root spellings once per check or tree scan, never across turns. */
function checker(
  roots: ProtectedPathRoots,
  operation: ProtectedPath['deny']
): (input: string) => boolean {
  const cache = new Map<string, string[]>();
  const expanded = (base: string): string[] => {
    let found = cache.get(base);
    if (!found) {
      found = spellings(base, roots.cwd);
      cache.set(base, found);
    }
    return found;
  };
  const entries = protectedPathsAt(roots.full === true);
  const rules = entries
    .filter((entry) => entry.deny === operation)
    .flatMap((entry) => {
      const bases =
        entry.root === 'data'
          ? [roots.data]
          : entry.root === 'home'
            ? [roots.home]
            : entry.root === 'account'
              ? roots.accounts
              : entry.root === 'agent-folder'
                ? roots.agentFolders
                : entry.root === 'agent-home'
                  ? roots.agentHomes
                  : [path.parse(roots.cwd).root];
      const regex = expression(entry, entry.root === 'anywhere' || entry.root === 'agent-folder');
      const rules = bases.flatMap((base) => expanded(base).map((base) => ({ base, regex })));
      if (entry.root === 'agent-home') {
        // New homes are protected before the registry notices them.
        const future = expression({ ...entry, path: `*/${entry.path}` }, false);
        rules.push(
          ...expanded(path.join(roots.data, 'agents')).map((base) => ({ base, regex: future }))
        );
      }
      return rules;
    });
  return (input) => {
    const targets = spellings(input, roots.cwd);
    return rules.some(({ base, regex }) =>
      targets.some((target) => {
        const relative = path.relative(base, target);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          return false;
        return regex.test(relative.split(path.sep).join('/'));
      })
    );
  };
}

/**
 * Whether a native file tool must refuse this target, before mode or grants.
 * Both the path given and its canonical target count as protected. Root
 * spellings are refreshed on every call so a changed link cannot reuse a check.
 */
export function isProtectedPath(
  input: string,
  operation: ProtectedPath['deny'],
  roots: ProtectedPathRoots
): boolean {
  return checker(roots, operation)(input);
}

/**
 * Refuse a native write to a protected name, or to any file with more than one hard link: a
 * hard link may give a protected file an ordinary name, and a write through it changes the
 * protected file too. Reads keep the name check alone (Security, DOR-4138): pnpm hard-links
 * every installed file on Linux, so refusing reads on link count would block package source.
 * This is a check at approve time, not a descriptor lock: the native runtime still owns the open.
 *
 * @param input - The path the native tool will write.
 * @param roots - The roots and level the protected paths are measured from.
 */
export function isProtectedNativeWrite(input: string, roots: ProtectedPathRoots): boolean {
  try {
    if (isProtectedPath(input, 'write', roots)) return true;
    const stat = statSync(canonical(input, roots.cwd));
    return stat.isFile() && stat.nlink > 1;
  } catch (error) {
    // A missing file is a new one, linked to nothing. Other metadata failures must not permit it.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * Refuse a native folder search only when its tree contains a protected read,
 * or cannot be checked completely. No file contents are opened. A bounded,
 * cycle-aware walk prevents a symlink loop or a huge tree from blocking a turn.
 */
export function searchTouchesProtectedPath(input: string, roots: ProtectedPathRoots): boolean {
  const pending = [input];
  const seen = new Set<string>();
  let entries = 0;
  try {
    const protectedRead = checker(roots, 'read');
    while (pending.length > 0) {
      const supplied = pending.pop()!;
      if (protectedRead(supplied)) return true;
      const current = canonical(supplied, roots.cwd);
      if (seen.has(current)) continue;
      seen.add(current);
      if (++entries > 50_000) return true;
      if (statSync(current).isDirectory()) {
        for (const entry of readdirSync(current)) pending.push(path.join(current, entry));
      }
    }
    return false;
  } catch {
    return true;
  }
}
