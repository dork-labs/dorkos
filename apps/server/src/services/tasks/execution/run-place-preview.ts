/**
 * Where a parked schedule's runs would stand, for its approval card (DOR-4067,
 * design pass row 3).
 *
 * It runs the scheduler's own chain ({@link chainRunPlacement}) and asks the
 * run's own guard ({@link decideRunPlacement}), so the card follows the run's
 * rules: the binding, the boundary check, the desk guard and the home and data
 * folder rule. A read must change nothing, so three collaborators are swapped:
 *
 * - **A managed checkout is looked up, never made** (no git, no `lastUsedAt`
 *   bump). A ready one is what a run reuses. Without one, the card says it is
 *   not made yet: a run makes it first, or, when making it waits on a person's
 *   OK, works in the agent's own folder meanwhile. The card cannot tell those
 *   two apart without asking, so it says both.
 * - **A fresh run folder is named, never made.**
 * - **A broken manifest is read without its warning**, which the next run
 *   writes anyway; a list read is not a place to repeat it every poll.
 *
 * An agent-made schedule's agent was settled at creation (`agentScheduleTarget`
 * in `lifecycle/agent-schedule-target.ts`) and stored as `agentId`, which is
 * what this reads.
 *
 * @module services/tasks/execution/run-place-preview
 */
import fs from 'node:fs';
import path from 'node:path';
import { readManifest } from '@dorkos/shared/manifest';
import type { Task, TaskRunPlace } from '@dorkos/shared/types';
import type { Workspace } from '@dorkos/shared/workspace';
import { sessionCwdDeps, type ResolveSessionCwdDeps } from '../../workspace/resolve-session-cwd.js';
import { getWorkspaceManager } from '../../workspace/index.js';
import { decideRunPlacement } from './run-place-guard.js';
import { chainRunPlacement, type RunPlaceMesh } from './run-placement.js';

export type { RunPlaceMesh } from './run-placement.js';

/** Collaborators, injected so a test can name the server's folders. */
export interface RunPlacePreviewDeps {
  /** The cwd chain's collaborators. Their `ensureWorkspace` is replaced by {@link findCheckout}. */
  cwdDeps: () => ResolveSessionCwdDeps;
  /** The managed checkout `ensure` would find, or `null`. Reads only. */
  findCheckout: (projectKey: string, key: string) => Promise<Workspace | null>;
  /** Where an agent-less run starts: the server's own folder. */
  serverCwd: () => string;
}

/** A warn sink that drops the line. */
const QUIET = { warn: () => {} };

const PRODUCTION_DEPS: RunPlacePreviewDeps = {
  cwdDeps: () => sessionCwdDeps({ readManifest: (dir) => readManifest(dir, QUIET) }),
  // Not wired (a server without workspaces) reads as not made: a run's
  // `ensure` would fail the same way and work in the agent's own folder.
  findCheckout: async (projectKey, key) => {
    try {
      return await getWorkspaceManager().getByKey(projectKey, key);
    } catch {
      return null;
    }
  },
  serverCwd: () => process.cwd(),
};

/**
 * Where this schedule's runs would stand, or `undefined` when no run could
 * start (an agent the registry no longer holds, another agent's folder, or a
 * folder the guard refuses).
 *
 * @param task - The schedule; only its id and agent matter.
 * @param mesh - The agent registry.
 * @param deps - See {@link RunPlacePreviewDeps}.
 */
export async function previewRunPlace(
  task: Pick<Task, 'id' | 'agentId'>,
  mesh: RunPlaceMesh | null | undefined,
  deps: RunPlacePreviewDeps = PRODUCTION_DEPS
): Promise<TaskRunPlace | undefined> {
  let unmade = false;
  const cwdDeps: ResolveSessionCwdDeps = {
    ...deps.cwdDeps(),
    ensureWorkspace: async (req) => {
      const found = await deps.findCheckout(req.projectKey, req.key);
      if (found?.status === 'ready') return found;
      // The chain then answers the agent's own folder, as it does for a run
      // whose checkout waits on a person.
      unmade = true;
      throw new Error('The checkout is not made yet.');
    },
  };
  let chained;
  try {
    chained = await chainRunPlacement(task, mesh, {
      cwdDeps,
      serverCwd: deps.serverCwd(),
      log: false,
    });
  } catch {
    return undefined;
  }
  const { cwd, agentPath, managed } = chained;
  const placement = agentPath === undefined ? { cwd } : { cwd, agentPath };
  const decision = decideRunPlacement(placement);
  if (decision === 'refuse') return undefined;
  if (decision === 'fresh') return { kind: 'private' };
  if (agentPath === undefined) return { kind: 'folder', path: cwd, of: 'server' };
  const inOwnFolder = decision === 'agent' || samePlace(cwd, agentPath);
  // Only while runs really fall back to the agent's folder: a refused home falls further.
  if (unmade && inOwnFolder) return { kind: 'agent_checkout', ready: false };
  if (inOwnFolder) return { kind: 'agent', path: agentPath };
  if (managed) return { kind: 'agent_checkout', ready: true };
  return { kind: 'folder', path: cwd, of: 'default' };
}

/** Whether two spellings name one folder. */
function samePlace(a: string, b: string): boolean {
  const real = (dir: string) => {
    try {
      return fs.realpathSync.native(dir);
    } catch {
      return path.resolve(dir);
    }
  };
  return real(a) === real(b);
}

/**
 * The schedule with {@link previewRunPlace}'s answer, on a parked schedule only:
 * the approval card is the one reader. Call only after the HTTP caller cleared
 * the operator bar, as for the folder rules beside it.
 *
 * @param task - The schedule as presented.
 * @param mesh - The agent registry.
 * @param deps - See {@link RunPlacePreviewDeps}.
 */
export async function withTaskRunPlace(
  task: Task,
  mesh: RunPlaceMesh | null | undefined,
  deps: RunPlacePreviewDeps = PRODUCTION_DEPS
): Promise<Task> {
  if (task.status !== 'pending_approval') return task;
  const runPlace = await previewRunPlace(task, mesh, deps);
  return runPlace ? { ...task, runPlace } : task;
}
