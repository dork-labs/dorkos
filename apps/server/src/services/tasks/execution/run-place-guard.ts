/**
 * Where a scheduled run may stand (DOR-4060): never the person's home folder,
 * DorkOS's data folder or a folder above either, the same rule an agent's own
 * new chat meets.
 *
 * An agent's run that the folder chain sent to such a place (a `none` binding,
 * or a home the boundary refused, both falling to the server's default) runs
 * in that agent's own folder instead. A run with no agent that would stand in
 * the home folder, above it, or in the data folder runs instead in a fresh,
 * empty folder of its own under `<data>/scheduled-runs/`: made new for each run
 * (private to this user), so no instruction file or setting one run leaves can
 * load into the next. A folder that merely holds the data folder (a dev
 * checkout) still runs: every file tool refuses its secrets.
 *
 * @module services/tasks/execution/run-place-guard
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { isProtectedLaunchFolder } from '../../session/launch/launch-caller.js';
import { isProtectedPath } from '../../runtimes/shared/policy/protected-path-check.js';
import { protectedPathRoots } from '../../runtimes/shared/policy/protected-path-roots.js';

/** Where agent-less runs get their own folders, inside the data folder. */
export const SCHEDULED_RUNS_DIR = 'scheduled-runs';

/** The name `mkdtemp` gives a run folder: `run-` and six letters or digits. */
const RUN_FOLDER_NAME = /^run-[A-Za-z0-9]{6}$/;

/** The sentence a run records when that folder holds anything but run folders. */
export const SCHEDULED_RUNS_UNSAFE_MESSAGE =
  "The scheduled-runs folder holds something it shouldn't, so this run didn't start.";

/** The sentence a refused run records. */
export const GLOBAL_RUN_HOME_MESSAGE =
  "Scheduled runs can't use your home folder. Pick an agent for this schedule.";

/**
 * The placement a run may use, or a throw that records the run failed.
 *
 * @param placement - Where the folder chain put the run, and the agent's home.
 * @returns The same placement, the agent's own folder, or a fresh run folder.
 * @throws When an agent's own folder is itself protected, or the scheduled-runs
 *   folder is not a private folder holding only run folders.
 */
export function guardRunPlacement<T extends { cwd: string; agentPath?: string }>(placement: T): T {
  const { cwd, agentPath } = placement;
  if (agentPath === undefined) {
    if (isHomeOrDataFolder(cwd)) return { ...placement, cwd: freshRunFolder() };
    return placement;
  }
  if (!isProtectedLaunchFolder(cwd, agentPath)) return placement;
  if (!isProtectedLaunchFolder(agentPath, agentPath)) return { ...placement, cwd: agentPath };
  throw new Error(GLOBAL_RUN_HOME_MESSAGE);
}

/** A folder's real path, or its resolved spelling when it cannot be read. */
function realOr(dir: string): string {
  try {
    return fs.realpathSync.native(path.resolve(dir));
  } catch {
    return path.resolve(dir);
  }
}

/** Whether `dir` is `root` or inside it. */
function isWithin(root: string, dir: string): boolean {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Whether an agent-less run would stand in the home folder or above it, in the
 * data folder or inside it, or in a protected folder. Fails closed.
 *
 * @param cwd - Where the run would stand.
 */
function isHomeOrDataFolder(cwd: string): boolean {
  const target = realOr(cwd);
  try {
    const roots = protectedPathRoots(target);
    if (isProtectedPath(target, 'read', roots)) return true;
    return isWithin(realOr(roots.data), target) || isWithin(target, realOr(roots.home));
  } catch {
    return true;
  }
}

/**
 * The error a run for an agent the registry no longer holds throws: a broken
 * link a person has to fix, so the run must not start. Moved here unchanged
 * from `task-scheduler-service.ts`.
 *
 * @param agentId - The agent the task names.
 * @param taskId - The task.
 */
export function unregisteredAgentError(agentId: string, taskId: string): Error {
  return new Error(
    `Agent ${agentId} not found in registry -- task ${taskId} cannot run. ` +
      'The agent may have been unregistered. Re-link the task to a valid agent or directory.'
  );
}

/**
 * A brand-new, empty folder for one agent-less run, private to this user.
 *
 * The parent must be a plain folder this user owns (never a symlink), holding
 * only earlier run folders: a file or link planted there, such as a
 * `CLAUDE.md` the runtime would load from a parent folder, refuses the run.
 */
function freshRunFolder(): string {
  const parent = path.join(realOr(resolveDorkHome()), SCHEDULED_RUNS_DIR);
  try {
    fs.mkdirSync(parent, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const stat = fs.lstatSync(parent);
  const owner = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner) {
    throw new Error(SCHEDULED_RUNS_UNSAFE_MESSAGE);
  }
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    // Only folders this guard made: a planted `.claude/` or `.git/` is a folder too.
    if (!entry.isDirectory() || !RUN_FOLDER_NAME.test(entry.name)) {
      throw new Error(SCHEDULED_RUNS_UNSAFE_MESSAGE);
    }
  }
  // mkdtemp makes the folder with mode 0700, under a name nobody chose.
  return fs.mkdtempSync(path.join(parent, 'run-'));
}
