/**
 * Whether DorkOS itself may run `git` in a folder (DOR-3343, the kill switch).
 *
 * `git` reads a repository's own settings, and some of those settings name a
 * program to run. When the repository is one an agent can write — its home, a
 * workspace or worktree it works in, a room's files — an agent with file tools
 * alone could choose that program, and DorkOS would run it as the server. Until
 * every git call goes through one runner that checks those settings first, the
 * server answers "not a repository" in agent folders without starting git.
 *
 * A folder is refused when any of these is, or is inside, an agent folder: the
 * folder itself, the repository it sits in (the nearest folder holding `.git`),
 * and, for a `.git` file, the git folder it points at and that folder's shared
 * `commondir`. Agent folders are the DorkOS data directory (agents, workspaces,
 * rooms), the configured agents and workspace directories, every registered
 * agent home, and any folder the home resolver says belongs to an agent. Read
 * from the filesystem alone: deciding never runs git. Anything unreadable
 * refuses.
 *
 * @module services/core/agent-identity/may-run-git
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { isInsideAgentHome, isInsideRoomsDir, isWithin, resolveAgentHome } from './agent-home.js';

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
 * The folder, the repository it sits in, and for a `.git` file the git folder
 * and `commondir` it names. `null` when a `.git` file cannot be read.
 *
 * @param dir - An absolute, normalized folder.
 */
function gitPlaces(dir: string): string[] | null {
  const places = [dir];
  const top = nearestGitAncestor(dir);
  if (top === null) return places;
  places.push(top);
  const dotGit = path.join(top, '.git');
  if (fs.lstatSync(dotGit).isDirectory()) return places;
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
  if (!match) return null;
  const gitDir = path.resolve(top, match[1]!);
  places.push(gitDir);
  try {
    const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    places.push(path.resolve(gitDir, common));
  } catch {
    // No commondir: a submodule's git folder, which is its own common folder.
  }
  return places;
}

function nearestGitAncestor(dir: string): string | null {
  let current = dir;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
