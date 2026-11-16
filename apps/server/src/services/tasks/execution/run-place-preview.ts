/**
 * Where a parked schedule's runs would stand, for its approval card (DOR-4067,
 * design pass row 3).
 *
 * It runs the scheduler's own chain ({@link chainRunPlacement}) and asks the
 * run's own guard ({@link decideRunPlacement}), so the card follows the run's
 * rules: the binding, the boundary check, the desk guard and the home and data
 * folder rule. A read must change nothing, so two collaborators are swapped:
 *
 * - **A managed checkout is looked up, never made.** An existing, ready one is
 *   reused at run time too. Without one the run asks a person first and works
 *   in the agent's own folder meanwhile, which is what the lookup's refusal
 *   makes the chain answer here.
 * - **A fresh run folder is named, never made.**
 *
 * An agent-made schedule's agent was settled at creation (`agentScheduleTarget`
 * in `lifecycle/agent-schedule-target.ts`) and stored as `agentId`, which is
 * what this reads.
 *
 * @module services/tasks/execution/run-place-preview
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Task, TaskRunPlace } from '@dorkos/shared/types';
import { sanitizeWorkspaceKey, type EnsureWorkspaceRequest } from '@dorkos/shared/workspace';
import { sessionCwdDeps, type ResolveSessionCwdDeps } from '../../workspace/resolve-session-cwd.js';
import { getWorkspaceManager } from '../../workspace/index.js';
import { decideRunPlacement } from './run-place-guard.js';
import { chainRunPlacement, type RunPlaceMesh } from './run-placement.js';

export type { RunPlaceMesh } from './run-placement.js';

/** Collaborators, injected so a test can name the server's folders. */
export interface RunPlacePreviewDeps {
  /** The cwd chain's collaborators, with a read-only `ensureWorkspace`. */
  cwdDeps: () => ResolveSessionCwdDeps;
  /** Where an agent-less run starts: the server's own folder. */
  serverCwd: () => string;
}

/**
 * The managed checkout the run would reuse, or a refusal when there is none:
 * the same answer `ensure` gives a run before it would make one.
 *
 * @param req - The checkout the chain asks for.
 */
async function existingCheckout(req: EnsureWorkspaceRequest) {
  const key = sanitizeWorkspaceKey(req.key);
  const found = (await getWorkspaceManager().list({ projectKey: req.projectKey })).find(
    (workspace) => workspace.key === key && workspace.status === 'ready'
  );
  if (!found) throw new Error('No ready checkout yet; a run would ask a person first.');
  return found;
}

const PRODUCTION_DEPS: RunPlacePreviewDeps = {
  cwdDeps: () => sessionCwdDeps({ ensureWorkspace: existingCheckout }),
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
  let chained;
  try {
    chained = await chainRunPlacement(task, mesh, {
      cwdDeps: deps.cwdDeps(),
      serverCwd: deps.serverCwd(),
      log: false,
    });
  } catch {
    return undefined;
  }
  const { cwd, agentPath, managed } = chained;
  const placement = agentPath === undefined ? { cwd } : { cwd, agentPath };
  switch (decideRunPlacement(placement)) {
    case 'fresh':
      return { kind: 'private' };
    case 'refuse':
      return undefined;
    case 'agent':
      return agentPath === undefined ? undefined : { kind: 'agent', path: agentPath };
    case 'keep':
      if (managed) return { kind: 'agent_checkout' };
      return agentPath !== undefined && samePlace(cwd, agentPath)
        ? { kind: 'agent', path: agentPath }
        : { kind: 'folder', path: cwd };
  }
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
