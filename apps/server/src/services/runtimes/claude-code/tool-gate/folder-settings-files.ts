/**
 * Which folders' settings a Claude Code launch may load, and what widening entries each one holds
 * now (DOR-5237). The folder list errs on the side of more folders: one too many only adds a
 * card. The shape is pinned against the real CLI in `folder-allows.binary.test.ts`.
 *
 * Files are read following links. One that exists but can't be read or parsed is reported as
 * {@link FolderSettingsEntries.unreadable}.
 *
 * @module services/runtimes/claude-code/tool-gate/folder-settings-files
 */
import fs from 'node:fs';
import path from 'node:path';
import { readSettingsFile, trimmedStrings } from '../repo-settings/repo-files.js';

/** A folder's two settings files. */
export const SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const;

/** One of {@link SETTINGS_FILES}. */
export type SettingsFileName = (typeof SETTINGS_FILES)[number];

/** What a folder's settings widen, as read now. */
export interface FolderSettingsEntries {
  /** `permissions.allow` entries, trimmed. */
  rules: string[];
  /** Folder entries (`permissions.additionalDirectories`), trimmed. */
  dirs: string[];
  /** A file exists that DorkOS could not read or parse. */
  unreadable: boolean;
}

/**
 * Read what a folder's settings files widen.
 *
 * @param folder - The folder whose `.claude/` is read.
 * @param files - Which of its settings files.
 */
export function readFolderSettingsEntries(
  folder: string,
  files: readonly SettingsFileName[] = SETTINGS_FILES
): FolderSettingsEntries {
  const out: FolderSettingsEntries = { rules: [], dirs: [], unreadable: false };
  for (const name of files) {
    const read = readSettingsFile(path.join(folder, '.claude', name));
    if (read.kind === 'absent') continue;
    if (read.kind !== 'parsed') {
      out.unreadable = true;
      continue;
    }
    const permissions = (read.value as { permissions?: Record<string, unknown> } | null)
      ?.permissions;
    out.rules.push(...trimmedStrings(permissions?.allow));
    out.dirs.push(...trimmedStrings(permissions?.additionalDirectories));
  }
  return out;
}

/**
 * The repo `start` stands in: the folder holding the nearest `.git`, and the checkout that owns
 * the git folder (`undefined` when none does, or DorkOS can't tell).
 */
function repoOf(start: string): { top: string; main: string | undefined } | undefined {
  for (let dir = start; ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    if (fs.existsSync(dotGit)) {
      return { top: dir, main: isFolder(dotGit) ? dir : mainCheckout(dir, dotGit) };
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** Whether `target` is a folder, links followed. */
function isFolder(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** The checkout owning the shared git folder a `.git` file leads to, if any. */
function mainCheckout(top: string, dotGit: string): string | undefined {
  try {
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1];
    if (!pointer) return undefined;
    const gitDir = path.resolve(top, pointer);
    const commondir = path.join(gitDir, 'commondir');
    // No commondir: the git folder is this repo's own.
    if (!fs.existsSync(commondir)) return fs.existsSync(gitDir) ? top : undefined;
    const common = fs.readFileSync(commondir, 'utf8').trim();
    const shared = path.resolve(gitDir, common);
    return path.basename(shared) === '.git' ? path.dirname(shared) : undefined;
  } catch {
    return undefined;
  }
}

/** The folders whose settings a launch in `cwd` may load, and where an Always allow lands. */
export interface SettingsFolders {
  /** The working folder, as given and by real path, the folders above it up to its repo's top, and the checkout owning the git folder. */
  folders: string[];
  /** The folder a person's Always allow is kept in. */
  alwaysAllowFolder: string;
  /** The folders whose local settings file a launch loads: the working folder and {@link alwaysAllowFolder}, by each spelling. */
  localFolders: string[];
}

/** One spelling of the working folder's share of {@link settingsFolders}. */
function foldersFrom(start: string, userHome: string): SettingsFolders {
  const repo = repoOf(start);
  const folders = [start];
  if (repo !== undefined && !samePlace(repo.top, userHome)) {
    for (let dir = start; dir !== repo.top;) {
      dir = path.dirname(dir);
      folders.push(dir);
    }
  }
  const main = repo?.main !== undefined && !samePlace(repo.main, userHome) ? repo.main : undefined;
  if (main !== undefined && !folders.includes(main)) folders.push(main);
  const alwaysAllowFolder = main ?? start;
  return { folders, alwaysAllowFolder, localFolders: [...new Set([start, alwaysAllowFolder])] };
}

/**
 * Settle, once per launch, which folders' settings it may load, from the working folder as given
 * and from its real path.
 *
 * @param cwd - The folder the turn launches in.
 * @param userHome - The person's home folder as the launch's Claude Code sees it, whose own
 *   settings are the person's, not a folder's.
 */
export function settingsFolders(cwd: string, userHome: string): SettingsFolders {
  const given = foldersFrom(path.resolve(cwd), userHome);
  let real: string;
  try {
    real = fs.realpathSync.native(cwd);
  } catch {
    return given;
  }
  if (real === path.resolve(cwd)) return given;
  const fromReal = foldersFrom(real, userHome);
  return {
    folders: [...new Set([...given.folders, ...fromReal.folders])],
    alwaysAllowFolder: fromReal.alwaysAllowFolder,
    localFolders: [...new Set([...given.localFolders, ...fromReal.localFolders])],
  };
}

/**
 * Whether two paths name the same folder: the same path, or the same real path, so another
 * spelling (a link, a different letter case) counts as the same place.
 *
 * @param a - One folder.
 * @param b - The other.
 */
export function samePlace(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
}

/**
 * Whether `folder` is the registered agent home, by any spelling: the home's own approvals apply
 * there, which are never looser than another folder's.
 *
 * @param folder - A folder whose settings a launch loads.
 * @param home - The registered agent home.
 */
export function isTheHome(folder: string, home: string): boolean {
  return samePlace(folder, home);
}
