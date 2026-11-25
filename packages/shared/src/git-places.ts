/**
 * Where git could read settings from for one folder, found from the
 * filesystem alone: no git process runs. The safe git runner audits these
 * places, and the Codex file policy keeps them read-only.
 *
 * @module shared/git-places
 */
import fs from 'node:fs';
import path from 'node:path';

/** Where git could read settings from for one folder (see {@link findGitPlaces}). */
export interface GitPlaces {
  /** The folder, and every folder above it that holds a `.git`. */
  folders: string[];
  /** Every git folder: `.git` folders, the git folders `.git` files name, and their `commondir`s. */
  gitDirs: string[];
  /**
   * Every linked worktree of each repository found. A repository's worktrees
   * share its one settings file, so whoever can write one can change what git
   * reads in all of them.
   */
  worktrees: string[];
}

/** A `.git` file git can't follow, so git reads no repository through it. */
export interface BrokenGitPointer {
  /** The `.git` file. */
  file: string;
  /** The folder it names that is not there, or `null` when it names none. */
  missing: string | null;
}

/** How {@link findGitPlaces} treats a `.git` file it can't follow. */
export interface FindGitPlacesOptions {
  /**
   * Collect each such file here and keep looking, instead of answering `null`.
   * Its folder stays in {@link GitPlaces.folders}. For a caller that only keeps
   * git's files safe: git stops at that file and reads no repository through it.
   */
  brokenPointers?: BrokenGitPointer[];
}

/**
 * Every place git could read settings from for `dir`, from the filesystem
 * alone: the folder, each folder above it holding a `.git` (from both its
 * spelled and its real path, since git climbs past a `.git` that is not a real
 * repository), the git folder and `commondir` each `.git` file names, and each
 * repository's linked worktrees. `null` inside a git folder, or when a `.git`
 * file cannot be followed and `options.brokenPointers` is not given.
 *
 * @param dir - The folder git would run in.
 * @param options - Where to collect `.git` files that can't be followed.
 */
export function findGitPlaces(dir: string, options: FindGitPlacesOptions = {}): GitPlaces | null {
  const resolved = path.resolve(dir);
  const folders = new Set([resolved]);
  const gitDirs = new Set<string>();
  const commonDirs = new Set<string>();
  for (const start of new Set([resolved, nativeRealPath(resolved)])) {
    // Inside a git folder itself, git reads that folder as a repository of its
    // own (`.git/modules/x`, `.git/worktrees/x`). DorkOS never needs to.
    if (start.split(path.sep).includes('.git')) return null;
    folders.add(start);
    for (let current = start; ; current = path.dirname(current)) {
      // A folder shaped like a git folder is one git may read as a repository.
      if (looksLikeGitDir(current)) gitDirs.add(current);
      const dotGit = path.join(current, '.git');
      const stat = fs.lstatSync(dotGit, { throwIfNoEntry: false });
      if (stat) {
        folders.add(current);
        const common = stat.isDirectory() ? dotGit : addPointer(current, dotGit, gitDirs);
        if (typeof common === 'string') {
          gitDirs.add(common);
          commonDirs.add(common);
        } else if (options.brokenPointers) {
          options.brokenPointers.push({ file: dotGit, missing: common.missing });
        } else {
          return null;
        }
      }
      if (path.dirname(current) === current) break;
    }
  }
  const worktrees = new Set<string>();
  for (const common of commonDirs) addLinkedWorktrees(common, worktrees);
  return { folders: [...folders], gitDirs: [...gitDirs], worktrees: [...worktrees] };
}

/**
 * Add the git folder a `.git` file names, and answer the repository's shared
 * folder (its `commondir`); otherwise the folder it names that is not there
 * (`null` if it names none). Read exactly as git reads it: `gitdir: ` (one
 * space) at the very start, then the path up to the line ends stripped from
 * the end, with no other trimming, so the audit reads the same folder git does.
 */
function addPointer(
  top: string,
  dotGit: string,
  gitDirs: Set<string>
): string | { missing: string | null } {
  const text = readGitFile(dotGit);
  if (text === null || !text.startsWith('gitdir: ')) return { missing: null };
  const gitDir = path.resolve(top, text.slice('gitdir: '.length));
  if (!isDirectory(gitDir)) return { missing: gitDir };
  gitDirs.add(gitDir);
  const common = readGitFile(path.join(gitDir, 'commondir'));
  if (common === null) return gitDir; // A submodule's git folder is its own common folder.
  const commonDir = path.resolve(gitDir, common);
  return isDirectory(commonDir) ? commonDir : { missing: commonDir };
}

/**
 * A file's text with trailing line ends stripped, as git reads its pointer
 * files; `null` if unreadable.
 *
 * @param file - A pointer file such as `.git`, `commondir` or `gitdir`.
 */
export function readGitFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').replace(/[\r\n]+$/, '');
  } catch {
    return null;
  }
}

function isDirectory(dir: string): boolean {
  return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/** Whether a folder has the shape git accepts as a git folder: `HEAD`, `objects` and `refs`. */
function looksLikeGitDir(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, 'HEAD')) &&
    isDirectory(path.join(dir, 'objects')) &&
    isDirectory(path.join(dir, 'refs'))
  );
}

/**
 * Add the folder of every linked worktree a repository lists: each
 * `<common>/worktrees/<name>/gitdir` names that worktree's `.git` file. An
 * entry that cannot be read is one git cannot use either.
 */
function addLinkedWorktrees(common: string, worktrees: Set<string>): void {
  const admin = path.join(common, 'worktrees');
  let names: string[];
  try {
    names = fs.readdirSync(admin);
  } catch {
    return;
  }
  for (const name of names) {
    // No gitdir file: a half-made or pruned entry, which git cannot use either.
    const dotGit = readGitFile(path.join(admin, name, 'gitdir'));
    if (dotGit) worktrees.add(path.dirname(path.resolve(admin, name, dotGit)));
  }
}

/**
 * A folder's real path, or the folder as given when it can't be resolved.
 *
 * @param dir - The folder.
 */
export function nativeRealPath(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}
