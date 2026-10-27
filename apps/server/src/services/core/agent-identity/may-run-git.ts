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
import path from 'node:path';
import { findGitPlaces } from '@dorkos/shared/safe-git';
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
    const found = findGitPlaces(dir);
    if (found === null) return false;
    const places = [...found.folders, ...found.gitDirs, ...found.worktrees];
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
