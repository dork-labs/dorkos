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
 * {@link isProtectedPath} for the many paths one shell command names, its rules compiled once
 * (DOR-4522). Use it for one check only, so a changed link is read again next time. Throws, like
 * it, on a path it can't check.
 *
 * @param roots - The turn's roots.
 * @param operation - Which entries refuse: `read` or `write`.
 */
export function protectedPathTest(
  roots: ProtectedPathRoots,
  operation: ProtectedPath['deny']
): (input: string) => boolean {
  return checker(roots, operation);
}

/** The most entries a folder walk looks at before it counts as protected. */
const MAX_WALK_ENTRIES = 50_000;

/**
 * Walk the tree at `input`, bounded and cycle-aware, until `found` says yes. A tree too big to
 * finish, or one that can't be read, counts as yes. With `follow`, the walk goes into linked
 * folders, each entry where it really is, as a search does. Without it a link is an entry like
 * any other, as a removal or a move takes it, and an entry that isn't there holds nothing.
 */
function walkFinds(
  input: string,
  found: (entry: string) => boolean,
  follow?: (entry: string) => string
): boolean {
  const pending = [input];
  const seen = new Set<string>();
  let entries = 0;
  try {
    while (pending.length > 0) {
      const supplied = pending.pop()!;
      if (found(supplied)) return true;
      const current = follow ? follow(supplied) : supplied;
      if (seen.has(current)) continue;
      seen.add(current);
      if (++entries > MAX_WALK_ENTRIES) return true;
      let folder: boolean;
      try {
        folder = (follow ? statSync(current) : lstatSync(current)).isDirectory();
      } catch (error) {
        if (follow || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        continue;
      }
      if (folder) for (const entry of readdirSync(current)) pending.push(path.join(current, entry));
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Refuse a native folder search only when its tree contains a protected read,
 * or cannot be checked completely. No file contents are opened. A bounded,
 * cycle-aware walk prevents a symlink loop or a huge tree from blocking a turn.
 */
export function searchTouchesProtectedPath(input: string, roots: ProtectedPathRoots): boolean {
  let protectedRead: (input: string) => boolean;
  try {
    protectedRead = checker(roots, 'read');
  } catch {
    return true;
  }
  return walkFinds(input, protectedRead, (entry) => canonical(entry, roots.cwd));
}

/**
 * Whether removing or moving the whole of `input` takes with it a protected write that can sit at
 * any depth, such as a project's `.dork/plugins` (DOR-5249): `input` is the folder such an entry
 * starts with (`.dork`), or the same bounded walk as a search finds one below it. A tree too big
 * to finish, or one that can't be read, counts as yes. Links below `input` are not followed: a
 * removal or a move takes the link, not what it names.
 *
 * The entries measured from a fixed folder are the caller's: where they sit is known without a
 * walk. An `agent-folder` entry counts wherever it sits, which only ever refuses more.
 *
 * @param input - The absolute path a command removes or moves as a whole.
 * @param full - Whether the command runs at Full.
 */
export function wholeTakesProtectedWrite(input: string, full: boolean): boolean {
  const entries = protectedPathsAt(full).filter(
    (entry) =>
      entry.deny === 'write' && (entry.root === 'anywhere' || entry.root === 'agent-folder')
  );
  const named = entries.map((entry) => expression(entry, true));
  const leading = entries.flatMap((entry) => {
    const parts = entry.path.split('/');
    return parts
      .slice(1)
      .map((_, i) =>
        expression({ ...entry, path: parts.slice(0, i + 1).join('/'), kind: 'file' }, true)
      );
  });
  const fromRoot = (entry: string): string =>
    path.relative(path.parse(entry).root, entry).split(path.sep).join('/');
  if (leading.some((test) => test.test(fromRoot(input)))) return true;
  return walkFinds(input, (entry) => named.some((test) => test.test(fromRoot(entry))));
}
