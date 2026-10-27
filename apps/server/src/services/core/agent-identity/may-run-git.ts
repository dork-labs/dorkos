/**
 * Whether DorkOS itself may run `git` in a folder (DOR-3343, the kill switch).
 *
 * `git` reads a repository's own settings, and some of those settings name a
 * program to run. When the repository is one an agent can write — its home, a
 * workspace or worktree it works in, a room's files — DorkOS must not read it
 * with git as the server. Until every git call goes through one runner that
 * checks those settings first, the server answers "not a repository" in agent
 * folders without starting git.
 *
 * A folder is refused when any of these is, or is inside, an agent folder: the
 * folder itself, and every folder above it that holds a `.git` (git keeps
 * climbing past one that is not a real repository), each walked both as spelled
 * and as the real path; and for each `.git` file, the git folder it points at
 * and that folder's shared `commondir`; and every linked worktree of each
 * repository found, since all of a repository's worktrees share its one
 * settings file (so a main checkout with a worktree in an agent folder is
 * refused too). Agent folders are the DorkOS data
 * directory (agents, workspaces, rooms), the configured agents and workspace
 * directories, every registered agent home, and any folder the home resolver
 * says belongs to an agent. Read from the filesystem alone: deciding never runs
 * git. Anything unreadable refuses, and so does every folder while the server
 * cannot yet say which folders are agent homes.
 *
 * @module services/core/agent-identity/may-run-git
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import {
  agentHomesKnown,
  isInsideAgentHome,
  isInsideRoomsDir,
  isWithin,
  resolveAgentHome,
} from './agent-home.js';

let configuredRoots: () => readonly string[] = () => [];

/**
 * Register the agent folders that config can move out of the data directory:
 * the agents directory and the workspace root. Read per call, so a changed
 * setting counts at once.
 *
 * @param roots - Returns the configured folders.
 */
export function setGitGuardRoots(roots: () => readonly string[]): void {
  configuredRoots = roots;
}

/**
 * Whether DorkOS may run `git` with `cwd` as its working folder.
 *
 * @param cwd - The folder git would run in.
 * @returns `false` for any agent folder, or when that cannot be told.
 */
export function mayRunGitHere(cwd: string): boolean {
  try {
    if (!agentHomesKnown()) return false;
    const dir = path.resolve(cwd);
    const places = gitPlaces(dir);
    if (places === null) return false;
    const roots = [resolveDorkHome(), ...configuredRoots()];
    for (const place of places) {
      if (isInsideRoomsDir(place) || isInsideAgentHome(place)) return false;
      if (roots.some((root) => isWithin(root, place))) return false;
    }
    return resolveAgentHome(dir).kind === 'none';
  } catch {
    return false;
  }
}

/**
 * Every place git could read settings from for `dir`: the folder, each folder
 * above it holding a `.git` (from both its spelled and its real path), the git
 * folder and `commondir` each `.git` file names, and every linked worktree of
 * each repository found. A worktree shares its repository's one settings
 * file, so an agent in any worktree can change what git reads in all of them.
 * `null` when a `.git` file cannot be read as a pointer.
 *
 * @param dir - An absolute, normalized folder.
 */
function gitPlaces(dir: string): string[] | null {
  const places = new Set([dir]);
  const commonDirs = new Set<string>();
  for (const start of new Set([dir, nativeRealPath(dir)])) {
    places.add(start);
    for (let current = start; ; current = path.dirname(current)) {
      const dotGit = path.join(current, '.git');
      const stat = fs.lstatSync(dotGit, { throwIfNoEntry: false });
      if (stat) {
        places.add(current);
        const common = stat.isDirectory() ? dotGit : addPointer(current, dotGit, places);
        if (common === null) return null;
        commonDirs.add(common);
      }
      if (path.dirname(current) === current) break;
    }
  }
  for (const common of commonDirs) addLinkedWorktrees(common, places);
  return [...places];
}

/**
 * Add the git folder and `commondir` a `.git` file names, and answer the
 * repository's shared folder; `null` if the file names none.
 */
function addPointer(top: string, dotGit: string, places: Set<string>): string | null {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
  if (!match) return null;
  const gitDir = path.resolve(top, match[1]!);
  places.add(gitDir);
  try {
    const common = path.resolve(
      gitDir,
      fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()
    );
    places.add(common);
    return common;
  } catch {
    // No commondir: a submodule's git folder, which is its own common folder.
    return gitDir;
  }
}

/**
 * Add the folder of every linked worktree a repository lists: each
 * `<common>/worktrees/<name>/gitdir` names that worktree's `.git` file. Read
 * from the filesystem alone; an entry that cannot be read is one git cannot
 * use either.
 */
function addLinkedWorktrees(common: string, places: Set<string>): void {
  const admin = path.join(common, 'worktrees');
  let names: string[];
  try {
    names = fs.readdirSync(admin);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      const dotGit = fs.readFileSync(path.join(admin, name, 'gitdir'), 'utf8').trim();
      if (dotGit) places.add(path.dirname(path.resolve(admin, name, dotGit)));
    } catch {
      // No gitdir file: a half-made or pruned entry.
    }
  }
}

/** The file system's own spelling of `dir`, or `dir` when it does not exist. */
function nativeRealPath(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}
