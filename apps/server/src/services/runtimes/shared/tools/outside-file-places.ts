/**
 * The folders whose files hold someone else's words (DOR-5236): this computer's temp folders, the
 * person's Downloads folder, and where room attachments are kept. A file read from one of them, or a
 * search rooted at or above one, marks the turn as one that read outside words, as a web page does
 * (`outside-text-tools.ts`).
 *
 * Kept small on purpose. A read inside the agent's own folder or the turn's working folder does not
 * mark when that folder sits below one of these (a throwaway project under the temp folder stays
 * clean), but a Downloads folder inside a working folder of the whole home still marks. Room
 * attachments copied into an agent's tree (`PROJECTED_ATTACHMENTS_ROOT`) always mark: they are a
 * room's files wherever they land, and a search marks when such a folder is on disk below its root:
 * in the root, in the tree whose `.dork` the root is, or in an own folder. A search by `rg`,
 * Claude Code's `Grep` or OpenCode's `grep` that keeps its ignore files in force leaves them out
 * while the ignore file the projection writes beside them holds exactly its one line. On Claude
 * Code, the CLI's own temp folder for the project (`claude-code-scratch.ts`) does not mark.
 *
 * A path is compared after `~` is expanded, as written and, when it exists, as the filesystem
 * resolves it, against both spellings of each folder (`/tmp` and macOS's `/private/tmp`).
 *
 * @module services/runtimes/shared/tools/outside-file-places
 */
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROJECTED_ATTACHMENTS_IGNORE,
  PROJECTED_ATTACHMENTS_IGNORE_LINE,
  PROJECTED_ATTACHMENTS_ROOT,
} from '@dorkos/shared/room-attachment-paths';
import { expandTilde } from '../../../../lib/boundary.js';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { claudeCodeScratchFolders } from './claude-code-scratch.js';
import { hasWildcard, patternReachesFolder } from './outside-file-patterns.js';
import { linksReach, newLinkWalk } from './outside-file-links.js';
import { pathExists } from '../../claude-code/shell-guard/shell-command.js';
import { readScript } from './shell-script-files.js';

/** Where a call runs: the turn's working folder and the agent's own folder, when known. */
export interface CallPlace {
  /** The turn's (or the command's) working folder. */
  cwd?: string;
  /** The agent's own folder. */
  agentHome?: string;
  /** Whether the call runs in Claude Code, whose own temp folder for the project stays unmarked. */
  claudeCode?: boolean;
}

/** The tests one call's paths are put to. */
export interface OutsideFileTests {
  /** Whether reading this path hands the turn outside words. */
  holds: (target: string) => boolean;
  /**
   * Whether a search rooted here reaches outside words: it holds them, or a folder of them is
   * below that the search enters.
   *
   * @param root - The root, as the call names it.
   * @param walk - How the search walks the tree; a search tool enters hidden folders by default.
   */
  searchReaches: (root: string, walk?: SearchWalk) => boolean;
  /**
   * Whether an absolute path lies in a folder of outside files.
   *
   * @param absolute - The path, already resolved against its working folder.
   * @param onDisk - Whether to also check where the filesystem resolves it.
   */
  holdsPath: (absolute: string, onDisk: boolean) => boolean;
  /**
   * Whether a search rooted at an absolute path reaches outside words.
   *
   * @param absolute - The root, already resolved against its working folder.
   * @param walk - How the search walks the tree.
   */
  rootReaches: (absolute: string, walk: SearchWalk) => boolean;
  /**
   * Whether an absolute wildcard pattern (`~/Down*` opened) could name a path in a folder of
   * outside files, or, for a search, a folder above one. Read against the folders' names, not
   * the disk.
   *
   * As a search's root, only a folder that is on disk (or that the line makes) counts, a wildcard
   * opens no hidden name it does not spell, and a search that leaves hidden folders out reaches
   * none below.
   *
   * @param pattern - The pattern, already resolved against its working folder.
   * @param asRoot - Whether it is a search's root, which also reaches the folders below it.
   * @param walk - For a root: how the search walks the tree.
   */
  patternReaches: (pattern: string, asRoot: boolean, walk?: SearchWalk) => boolean;
  /**
   * Whether a search that follows links from this root reaches a folder of outside files
   * through one (`outside-file-links.ts`).
   */
  linksReach: (root: string) => boolean;
}

/** How a search walks the tree below its root. */
export interface SearchWalk {
  /** Whether it leaves hidden folders out, as `rg` does. */
  skipsHidden: boolean;
  /** Whether it honours ripgrep's ignore files, as `rg` and the search tools built on it do. */
  ignoreFiles: boolean;
}

/** A search that enters every folder: `grep -r`, `find`. */
const ENTERS_ALL: SearchWalk = { skipsHidden: false, ignoreFiles: false };

/**
 * Whether the room attachments copied into `tree` are left out by the ignore file the projection
 * writes beside them: it holds exactly {@link PROJECTED_ATTACHMENTS_IGNORE_LINE}.
 */
function projectionIgnored(tree: string): boolean {
  const read = readScript(path.join(tree, PROJECTED_ATTACHMENTS_IGNORE));
  return (
    read.kind === 'text' && read.text.replace(/\r?\n$/, '') === PROJECTED_ATTACHMENTS_IGNORE_LINE
  );
}

/** A glob that leaves rg's ignore files in force: a negation, or one that names a file extension. */
const IGNORE_KEEPING_GLOB = /^!|(?:^|\/)\*\.(?:[\w.-]+|\{[\w.,-]+\})$/;

/**
 * Whether every glob a search is given leaves its ignore files in force. A glob that includes
 * paths (`*`, `**`, `src/**`) makes ripgrep read files its ignore files leave out.
 *
 * @param globs - The globs, as the search is given them.
 */
export function globsKeepIgnores(globs: readonly string[]): boolean {
  return globs.every((glob) => IGNORE_KEEPING_GLOB.test(glob));
}

/** The fixed temp folders on a Unix-like system, in both spellings macOS uses. */
const UNIX_TEMP_FOLDERS = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp'];

/** How many paths one call may resolve on disk; past it the call counts as reading outside words. */
const MAX_RESOLVED = 512;

/** A folder's spellings: as given, and as the filesystem resolves it, when it can. */
function spellings(folder: string): string[] {
  const absolute = path.resolve(folder);
  const real = resolvedOnDisk(absolute);
  return real === undefined || real === absolute ? [absolute] : [absolute, real];
}

/**
 * Where the filesystem resolves a path: the path itself when it is there, else its folder joined
 * with its name (a file not there yet, behind a link or in the disk's own letter case).
 */
function resolvedOnDisk(absolute: string): string | undefined {
  try {
    return realpathSync.native(absolute);
  } catch {
    try {
      return path.join(realpathSync.native(path.dirname(absolute)), path.basename(absolute));
    } catch {
      // Neither it nor its folder is there yet: it still counts as written.
      return undefined;
    }
  }
}

/** Whether `target` is `folder` or inside it. Both absolute. */
function isInside(target: string, folder: string): boolean {
  const relative = path.relative(folder, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Whether `target` is strictly inside `folder`. Both absolute. */
function isBelow(target: string, folder: string): boolean {
  return target !== folder && isInside(target, folder);
}

/** Whether the way from `root` down to `folder` passes a hidden folder, which a search skips. */
function hiddenBetween(root: string, folder: string): boolean {
  return path
    .relative(root, folder)
    .split(path.sep)
    .some((part) => part.startsWith('.') && part !== '..');
}

/**
 * Whether a search rooted at a wildcard reaches a folder past its hidden names: the shell opens a
 * wildcard into a hidden name only when the pattern spells its dot, and below the pattern a search
 * that leaves hidden folders out skips them.
 */
function shownToSearch(
  pattern: readonly string[],
  below: readonly string[],
  skipsHidden: boolean
): boolean {
  const aligned = !pattern.includes('**');
  return below.every((part, depth) => {
    if (!part.startsWith('.')) return true;
    if (aligned && depth < pattern.length) return pattern[depth]!.startsWith('.');
    return !skipsHidden;
  });
}

/** The download folder a Linux desktop names (`XDG_DOWNLOAD_DIR`), when it is not the home itself. */
function xdgDownloads(): string | undefined {
  // eslint-disable-next-line no-restricted-syntax -- the desktop's own XDG variable, mirrored here, not a DorkOS setting env.ts models
  const named = process.env.XDG_DOWNLOAD_DIR;
  if (!named) return undefined;
  const home = expandTilde('~');
  const spelled = expandTilde(named.replace(/^\$HOME(?=\/|$)/, home));
  if (!path.isAbsolute(spelled)) return undefined;
  const folder = path.resolve(spelled);
  return folder === home ? undefined : folder;
}

/** The folders whose files hold outside words, read fresh so a moved data folder is honoured. */
function outsideFileFolders(): string[] {
  const folders = [os.tmpdir(), expandTilde('~/Downloads'), path.join(resolveDorkHome(), 'rooms')];
  const downloads = xdgDownloads();
  if (downloads) folders.push(downloads);
  if (process.platform !== 'win32') folders.push(...UNIX_TEMP_FOLDERS);
  return [...new Set(folders.flatMap(spellings))];
}

/** The projected attachments folder as path segments, to find it inside any agent's tree. */
const PROJECTED_SEGMENTS = PROJECTED_ATTACHMENTS_ROOT.split('/');

/** Whether a path, absolute or relative, lies in a room attachments folder copied into a tree. */
function inProjectedAttachments(target: string): boolean {
  const parts = target.split(/[\\/]+/);
  return parts.some((_, at) =>
    PROJECTED_SEGMENTS.every((segment, offset) => parts[at + offset] === segment)
  );
}

/**
 * The tests for one call: the folders are looked up once, however many paths the call names.
 *
 * @param place - Where the call runs.
 * @param made - Whether the call's own command line makes a folder before it searches.
 * @returns Tests taking a path as the call names it: absolute, `~`-relative or relative to
 *   `place.cwd`. A relative path with no known working folder is taken to be the agent's own.
 */
export function outsideFileTests(
  place: CallPlace = {},
  made: (folder: string) => boolean = () => false
): OutsideFileTests {
  const folders = outsideFileFolders();
  const ownFolders = [place.cwd, place.agentHome].filter(
    (folder): folder is string => !!folder && path.isAbsolute(folder)
  );
  const own = ownFolders.flatMap(spellings);
  const scratch =
    place.claudeCode && place.cwd && path.isAbsolute(place.cwd)
      ? claudeCodeScratchFolders(spellings(place.cwd), spellings)
      : [];
  let resolved = 0;
  /** Whether each folder of outside files is on disk, looked up once per call. */
  const present = new Map<string, boolean>();
  const exists = (folder: string): boolean => {
    let found = present.get(folder);
    if (found === undefined) {
      // A folder the same command line makes first counts as there: the check runs before it does.
      found = pathExists(folder) || made(folder);
      present.set(folder, found);
    }
    return found;
  };
  const linkWalk = newLinkWalk();

  /** An absolute path as written and, when asked, as the filesystem resolves it; `null` past the cap. */
  const looked = new Map<string, string[]>();
  const spellingsOf = (absolute: string, onDisk: boolean): string[] | null => {
    if (!onDisk) return [absolute];
    const known = looked.get(absolute);
    if (known) return known;
    if (resolved >= MAX_RESOLVED) return null;
    resolved += 1;
    const real = resolvedOnDisk(absolute);
    const found = real === undefined || real === absolute ? [absolute] : [absolute, real];
    looked.set(absolute, found);
    return found;
  };

  /** The path as written and, when it exists, as the filesystem resolves it; `null` past the cap. */
  const forms = (target: string): string[] | null => {
    const named = expandTilde(target);
    if (!path.isAbsolute(named) && !place.cwd) return [];
    // A bare word (a command's argument, a word of prose) is read as written: only something
    // spelled as a path is looked up on disk.
    const onDisk = /[\\/]/.test(target) || target.startsWith('.');
    return spellingsOf(path.resolve(place.cwd ?? path.sep, named), onDisk);
  };

  /** Whether one absolute spelling of a path lies in a folder of outside files. */
  const spelledInside = (absolute: string): boolean => {
    if (inProjectedAttachments(absolute)) return true;
    if (scratch.some((folder) => isInside(absolute, folder))) return false;
    return folders.some(
      (folder) =>
        isInside(absolute, folder) &&
        // The agent's own tree counts as its own only when it sits below this folder.
        !own.some((mine) => isBelow(mine, folder) && isInside(absolute, mine))
    );
  };

  /**
   * The folders a search rooted at `root` may find below it: the folders of outside files, and
   * room attachments copied into the root, into the tree whose `.dork` or `.dork/.temp` the root
   * is, or into an own folder, with the tree each copy sits in.
   */
  const foldersBelow = (root: string): Array<{ folder: string; tree?: string }> => {
    const trees = [root, ...own];
    if (path.basename(root) === '.dork') trees.push(path.dirname(root));
    if (path.basename(root) === '.temp' && path.basename(path.dirname(root)) === '.dork') {
      trees.push(path.dirname(path.dirname(root)));
    }
    return [
      ...folders.map((folder) => ({ folder })),
      ...[...new Set(trees)].map((tree) => ({
        folder: path.join(tree, PROJECTED_ATTACHMENTS_ROOT),
        tree,
      })),
    ];
  };

  /** Whether a folder below a root is there for the search to find. */
  const found = (entry: { folder: string; tree?: string }, walk: SearchWalk): boolean =>
    exists(entry.folder) &&
    // Read only once the copied attachments are there: one small file.
    !(walk.ignoreFiles && entry.tree !== undefined && projectionIgnored(entry.tree));

  /** Whether any spelling holds outside words, or, for a search, has a folder of them below. */
  const reaches = (spelled: string[] | null, asRoot: boolean, walk: SearchWalk): boolean =>
    spelled === null ||
    spelled.some(
      (absolute) =>
        spelledInside(absolute) ||
        (asRoot &&
          foldersBelow(absolute).some(
            (entry) =>
              isBelow(entry.folder, absolute) &&
              !(walk.skipsHidden && hiddenBetween(absolute, entry.folder)) &&
              found(entry, walk)
          ))
    );

  const holds = (target: string): boolean => {
    if (!target) return false;
    if (inProjectedAttachments(target)) return true;
    return reaches(forms(target), false, ENTERS_ALL);
  };

  const searchReaches = (root: string, walk: SearchWalk = ENTERS_ALL): boolean =>
    !!root && reaches(forms(root), true, walk);

  const holdsPath = (absolute: string, onDisk: boolean): boolean =>
    reaches(spellingsOf(absolute, onDisk), false, ENTERS_ALL);

  const rootReaches = (absolute: string, walk: SearchWalk): boolean =>
    reaches(spellingsOf(absolute, true), true, walk);

  const patternReaches = (
    pattern: string,
    asRoot: boolean,
    walk: SearchWalk = ENTERS_ALL
  ): boolean => {
    const parts = pattern.split(path.sep);
    const fixed = parts.findIndex(hasWildcard);
    if (fixed === -1) return asRoot ? rootReaches(pattern, walk) : holdsPath(pattern, true);
    // The part before the first wildcard is a real folder: where it resolves counts too.
    const base = parts.slice(0, fixed).join(path.sep) || path.sep;
    if (holdsPath(base, true)) return true;
    const rest = parts.slice(fixed);
    const bases = spellingsOf(base, true);
    if (bases === null) return true;
    return bases.some((spelled) =>
      (asRoot ? foldersBelow(spelled) : folders.map((folder) => ({ folder }))).some((entry) => {
        if (!isBelow(entry.folder, spelled)) return false;
        const below = path.relative(spelled, entry.folder).split(path.sep);
        if (!patternReachesFolder(rest, below, asRoot)) return false;
        // rg reads a path it is given whatever its ignore files say: they leave out only what it
        // finds walking below one, so they count only when the folder is below what is named.
        const walked = !rest.includes('**') && below.length > rest.length;
        const named = walked ? walk : { ...walk, ignoreFiles: false };
        return !asRoot || (shownToSearch(rest, below, walk.skipsHidden) && found(entry, named));
      })
    );
  };

  return {
    holds,
    searchReaches,
    holdsPath,
    rootReaches,
    patternReaches,
    linksReach: (root) =>
      linksReach(root, (absolute) => reaches([absolute], true, ENTERS_ALL), linkWalk),
  };
}
