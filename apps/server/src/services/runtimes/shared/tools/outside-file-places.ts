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
 * room's files wherever they land. On Claude Code, the CLI's own temp folder for the project
 * (`claude-code-scratch.ts`) does not mark.
 *
 * A path is compared after `~` is expanded, as written and, when it exists, as the filesystem
 * resolves it, against both spellings of each folder (`/tmp` and macOS's `/private/tmp`).
 *
 * @module services/runtimes/shared/tools/outside-file-places
 */
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandTilde } from '../../../../lib/boundary.js';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { PROJECTED_ATTACHMENTS_ROOT } from '../../../rooms/attachments/attachment-paths.js';
import { claudeCodeScratchFolders } from './claude-code-scratch.js';
import { hasWildcard, patternReachesFolder } from './outside-file-patterns.js';
import { linksReach, newLinkWalk } from './outside-file-links.js';
import { pathExists } from '../../claude-code/shell-guard/shell-command.js';

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
   * below, past no hidden folder.
   */
  searchReaches: (root: string) => boolean;
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
   * @param skipsHidden - Whether the search leaves hidden folders out, as `rg` does.
   */
  rootReaches: (absolute: string, skipsHidden: boolean) => boolean;
  /**
   * Whether an absolute wildcard pattern (`~/Down*` opened) could name a path in a folder of
   * outside files, or, for a search, a folder above one. Read against the folders' names, not
   * the disk.
   *
   * @param pattern - The pattern, already resolved against its working folder.
   * @param asRoot - Whether it is a search's root, which also reaches the folders below it.
   */
  patternReaches: (pattern: string, asRoot: boolean) => boolean;
  /**
   * Whether a search that follows links from this root reaches a folder of outside files
   * through one (`outside-file-links.ts`).
   */
  linksReach: (root: string) => boolean;
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
  const walk = newLinkWalk();

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

  /** Whether any spelling holds outside words, or, for a search, has a folder of them below. */
  const reaches = (spelled: string[] | null, asRoot: boolean, skipsHidden: boolean): boolean =>
    spelled === null ||
    spelled.some(
      (absolute) =>
        spelledInside(absolute) ||
        (asRoot &&
          folders.some(
            (folder) =>
              isBelow(folder, absolute) &&
              !(skipsHidden && hiddenBetween(absolute, folder)) &&
              exists(folder)
          ))
    );

  const holds = (target: string): boolean => {
    if (!target) return false;
    if (inProjectedAttachments(target)) return true;
    return reaches(forms(target), false, true);
  };

  const searchReaches = (root: string): boolean => !!root && reaches(forms(root), true, true);

  const holdsPath = (absolute: string, onDisk: boolean): boolean =>
    reaches(spellingsOf(absolute, onDisk), false, true);

  const rootReaches = (absolute: string, skipsHidden: boolean): boolean =>
    reaches(spellingsOf(absolute, true), true, skipsHidden);

  const patternReaches = (pattern: string, asRoot: boolean): boolean => {
    const parts = pattern.split(path.sep);
    const fixed = parts.findIndex(hasWildcard);
    if (fixed === -1) return asRoot ? rootReaches(pattern, false) : holdsPath(pattern, true);
    // The part before the first wildcard is a real folder: where it resolves counts too.
    const base = parts.slice(0, fixed).join(path.sep) || path.sep;
    if (holdsPath(base, true)) return true;
    const rest = parts.slice(fixed);
    const bases = spellingsOf(base, true);
    if (bases === null) return true;
    return bases.some((spelled) =>
      folders.some(
        (folder) =>
          isBelow(folder, spelled) &&
          patternReachesFolder(rest, path.relative(spelled, folder).split(path.sep), asRoot)
      )
    );
  };

  return {
    holds,
    searchReaches,
    holdsPath,
    rootReaches,
    patternReaches,
    linksReach: (root) => linksReach(root, (absolute) => reaches([absolute], true, false), walk),
  };
}
