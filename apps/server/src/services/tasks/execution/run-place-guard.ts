/**
 * Where a scheduled run may stand (DOR-4060): never the person's home folder,
 * DorkOS's data folder or a folder above either, the same rule an agent's own
 * new chat meets.
 *
 * An agent's run that the folder chain sent to such a place (a `none` binding,
 * or a home the boundary refused, both falling to the server's default) runs
 * in that agent's own folder instead. A run with no agent has nowhere of its
 * own to go, so in the home folder, above it, or in the data folder it is
 * refused with a sentence a person can act on. A folder that merely holds the
 * data folder (a dev checkout) still runs: every file tool refuses its secrets.
 *
 * @module services/tasks/execution/run-place-guard
 */
import fs from 'node:fs';
import path from 'node:path';
import { isProtectedLaunchFolder } from '../../session/launch/launch-caller.js';
import { isProtectedPath } from '../../runtimes/shared/policy/protected-path-check.js';
import { protectedPathRoots } from '../../runtimes/shared/policy/protected-path-roots.js';

/** The sentence a refused agent-less run records. */
export const GLOBAL_RUN_HOME_MESSAGE =
  "Scheduled runs can't use your home folder. Pick an agent for this schedule.";

/**
 * The placement a run may use, or a throw that records the run failed.
 *
 * @param placement - Where the folder chain put the run, and the agent's home.
 * @returns The same placement, or the agent's own folder in its place.
 * @throws When an agent-less run would stand in a protected folder, or an
 *   agent's own folder is itself one.
 */
export function guardRunPlacement<T extends { cwd: string; agentPath?: string }>(placement: T): T {
  const { cwd, agentPath } = placement;
  if (agentPath === undefined) {
    if (isHomeOrDataFolder(cwd)) throw new Error(GLOBAL_RUN_HOME_MESSAGE);
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
