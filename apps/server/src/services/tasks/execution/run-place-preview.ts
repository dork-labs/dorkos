/**
 * Where a parked schedule's runs would stand, for its approval card (DOR-4067,
 * design pass row 3).
 *
 * It asks the run's own guard ({@link decideRunPlacement}), fed the same folder
 * the scheduler's `resolveRunPlacement` starts from, so the card and the run
 * cannot disagree. Two differences, both because a read must not change
 * anything: a managed binding is named, never provisioned, and an agent-less
 * run's fresh folder is named, never made.
 *
 * An agent-made schedule's agent was settled at creation (`agentScheduleTarget`
 * in `lifecycle/agent-schedule-target.ts`) and stored as `agentId`, which is
 * what this reads.
 *
 * @module services/tasks/execution/run-place-preview
 */
import { readManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Task, TaskRunPlace } from '@dorkos/shared/types';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { decideRunPlacement } from './run-place-guard.js';

/** The registry lookup this needs; `MeshCore` satisfies it. */
export interface RunPlaceMesh {
  /** The agent's own folder, or nothing when the registry does not hold it. */
  getProjectPath(agentId: string): string | null | undefined;
}

/** Collaborators, injected so a test can name the server's folders. */
export interface RunPlacePreviewDeps {
  /** Where an agent-less run starts, before the guard: the server's own folder. */
  serverCwd(): string;
  /** Where a `none` binding starts, before the guard. */
  defaultCwd: string;
  /** The agent's manifest, for its workspace binding. */
  readManifest(agentPath: string): Promise<AgentManifest | null>;
}

const PRODUCTION_DEPS: RunPlacePreviewDeps = {
  serverCwd: () => process.cwd(),
  defaultCwd: DEFAULT_CWD,
  readManifest: (agentPath) => readManifest(agentPath),
};

/**
 * Where this schedule's runs would stand, or `undefined` when no run could
 * start (an agent the registry no longer holds, or a folder the guard refuses).
 *
 * @param task - The schedule; only its agent matters.
 * @param mesh - The agent registry.
 * @param deps - See {@link RunPlacePreviewDeps}.
 */
export async function previewRunPlace(
  task: Pick<Task, 'agentId'>,
  mesh: RunPlaceMesh | undefined,
  deps: RunPlacePreviewDeps = PRODUCTION_DEPS
): Promise<TaskRunPlace | undefined> {
  if (!task.agentId) return placeOf({ cwd: deps.serverCwd() });
  const agentPath = mesh?.getProjectPath(task.agentId);
  if (!agentPath) return undefined;
  // The run's chain reads an unreadable manifest as the home binding, too.
  const mode = await deps.readManifest(agentPath).then(
    (manifest) => manifest?.workspace.mode ?? 'home',
    () => 'home'
  );
  if (mode === 'managed') return { kind: 'agent_checkout' };
  return placeOf({ cwd: mode === 'none' ? deps.defaultCwd : agentPath, agentPath });
}

/** The guard's answer for one placement, in the card's terms. */
function placeOf(placement: { cwd: string; agentPath?: string }): TaskRunPlace | undefined {
  const { cwd, agentPath } = placement;
  switch (decideRunPlacement(placement)) {
    case 'fresh':
      return { kind: 'private' };
    case 'agent':
      return agentPath === undefined ? undefined : { kind: 'agent', path: agentPath };
    case 'keep':
      return cwd === agentPath ? { kind: 'agent', path: cwd } : { kind: 'folder', path: cwd };
    case 'refuse':
      return undefined;
  }
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
  mesh: RunPlaceMesh | undefined,
  deps: RunPlacePreviewDeps = PRODUCTION_DEPS
): Promise<Task> {
  if (task.status !== 'pending_approval') return task;
  const runPlace = await previewRunPlace(task, mesh, deps);
  return runPlace ? { ...task, runPlace } : task;
}
