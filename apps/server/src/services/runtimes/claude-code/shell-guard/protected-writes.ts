/**
 * The protected-files list, as a shell command's writes meet it (DOR-4522).
 *
 * Claude Code's own deny rules keep its shell off most of the list, and Codex's sandbox keeps its
 * shell off all of it. OpenCode and Doe have neither: their file tools check the list, and their
 * shells ran with no check at all. So for those two the guard checks every path a command writes
 * against the same list the file tools refuse (`PROTECTED_PATHS`, through `isProtectedPath`):
 * installed packages, the Terminal command, the config and the rest, at every level the list says.
 *
 * Removing or moving a whole folder counts for what is below it: a fixed entry by where it sits,
 * and an entry at any depth (a project's `.dork/plugins`) by the folder it starts with or a
 * bounded walk below (`wholeTakesProtectedWrite`, DOR-5249).
 *
 * It runs in the guard's own process, like the rest of the check, and only when the launch asks
 * for it (`ShellGuardRoots.protectedWrites`).
 *
 * @module services/runtimes/claude-code/shell-guard/protected-writes
 */
import path from 'node:path';
import { protectedPathsAt } from '../../../core/protected-paths/protected-paths.js';
import {
  protectedPathTest,
  wholeTakesProtectedWrite,
} from '../../../core/protected-paths/protected-path-check.js';
import type { ShellGuardRoots } from './shell-check.js';

/** What a command's writes may not reach. */
interface ProtectedWrites {
  /**
   * Whether writing `target` changes a protected path, or, for a whole-folder removal or move,
   * takes one with it.
   */
  reaches(target: string, whole: boolean): boolean;
  /**
   * Whether a word written from `cwd` could name a protected path: the cut a padded script's words
   * are kept to, so the cut never drops one that does.
   */
  mayName(word: string, cwd: string): boolean;
}

/** Whether `child` is `parent` or below it, in any letter case. */
function within(parent: string, child: string): boolean {
  const relative = path.relative(parent.toLowerCase(), child.toLowerCase());
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * The list's writes for one launch, or `null` when the launch did not ask for them.
 *
 * @param roots - This launch's folders.
 * @param spellings - A folder's spellings: as given and where it really is.
 */
export function protectedWrites(
  roots: ShellGuardRoots,
  spellings: (folder: string) => string[]
): ProtectedWrites | null {
  if (!roots.protectedWrites) return null;
  const full = roots.full === true;
  const agentHomes = roots.agentHomes();
  const test = protectedPathTest(
    {
      cwd: roots.cwd,
      data: roots.dorkHome,
      home: roots.home,
      accounts: roots.accounts,
      agentFolders: [roots.cwd],
      agentHomes,
      full,
    },
    'write'
  );
  const entries = protectedPathsAt(full).filter((entry) => entry.deny === 'write');
  // Where each entry starts, before any wildcard: removing a folder above one removes it too.
  const fixed = entries.flatMap((entry) => {
    const bases =
      entry.root === 'data'
        ? [roots.dorkHome]
        : entry.root === 'home'
          ? [roots.home]
          : entry.root === 'account'
            ? roots.accounts
            : entry.root === 'agent-home'
              ? agentHomes
              : [];
    const literal = entry.path.split('/').filter((_, i, all) => {
      return !all.slice(0, i + 1).some((one) => one.includes('*'));
    });
    return bases.flatMap(spellings).map((base) => path.join(base, ...literal));
  });
  // Every literal name in the list, for a word that names one by a spelling not worked out yet.
  const names = [
    ...new Set(
      entries.flatMap((entry) =>
        entry.path
          .split('/')
          .map((part) => part.split('*')[0]!.toLowerCase())
          .filter((part) => part.length >= 3)
      )
    ),
  ];
  // A target is checked as named and where it really is, most often one path: walk it once.
  const walked = new Map<string, boolean>();
  const takes = (target: string): boolean => {
    let found = walked.get(target);
    if (found === undefined) walked.set(target, (found = wholeTakesProtectedWrite(target, full)));
    return found;
  };
  const reaches = (target: string, whole: boolean): boolean =>
    test(target) || (whole && (fixed.some((one) => within(target, one)) || takes(target)));
  return {
    reaches,
    mayName: (word, cwd) => {
      const lower = word.toLowerCase();
      if (names.some((name) => lower.includes(name))) return true;
      // A relative word inside a protected folder names a protected path whatever it says.
      try {
        return reaches(cwd, false) || reaches(path.resolve(cwd, word), false);
      } catch {
        return true;
      }
    },
  };
}
