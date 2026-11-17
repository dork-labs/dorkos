/**
 * The folder chain for one scheduled run, before the run-place guard
 * (`run-place-guard.ts`) has its say. The scheduler runs it to place a real run,
 * and the approval card runs it, with read-only collaborators, to say where
 * that run would stand (`run-place-preview.ts`). One function for both, so the
 * card cannot follow rules the run does not.
 *
 * @module services/tasks/execution/run-placement
 */
import type { Task } from '@dorkos/shared/types';
import {
  resolveSessionCwd,
  type ResolveSessionCwdDeps,
} from '../../workspace/resolve-session-cwd.js';
import { assertOwnDesk, deskBindingFor } from '../../core/agent-identity/index.js';
import { unregisteredAgentError } from './run-place-guard.js';

/** The registry lookup this needs; `MeshCore` satisfies it. */
export interface RunPlaceMesh {
  /** The agent's own folder, or nothing when the registry does not hold it. */
  getProjectPath(agentId: string): string | null | undefined;
}

/** Where the chain put a run, before the guard. */
export interface ChainedRunPlacement {
  /** The directory the turn would run in. */
  cwd: string;
  /** The agent's own folder, holding `.dork/agent.json`; absent with no agent. */
  agentPath?: string;
  /** Whether `cwd` is the agent's managed checkout. */
  managed: boolean;
}

/** What the chain is run with. Production defaults everywhere but a preview. */
export interface RunPlacementOptions {
  /** The cwd chain's collaborators; the production set when absent. */
  cwdDeps?: ResolveSessionCwdDeps;
  /** Where an agent-less run starts. Defaults to the server's own folder. */
  serverCwd?: string;
  /** Write the chain's one log line. A preview reads quietly. */
  log?: boolean;
}

/**
 * Where a scheduled run would stand, before the guard.
 *
 * Moved unchanged from `TaskSchedulerService.resolveRunPlacement`: an agent's
 * run follows the shared cwd chain and the desk guard; an agent-less run starts
 * in `process.cwd()`, not `DEFAULT_CWD` (the two differ only where
 * `DORKOS_DEFAULT_CWD` is set, and moving those runs is not this function's call).
 *
 * @param task - The schedule; its id names a broken link in the error.
 * @param mesh - The agent registry. Absent, every run is agent-less.
 * @param options - See {@link RunPlacementOptions}.
 * @throws When the agent is not in the registry.
 * @throws {DeskNotOwnError} When the folder is another agent's (spec
 *   `agent-home-desk` §3.4).
 */
export async function chainRunPlacement(
  task: Pick<Task, 'id' | 'agentId'>,
  mesh: RunPlaceMesh | null | undefined,
  options: RunPlacementOptions = {}
): Promise<ChainedRunPlacement> {
  if (task.agentId && mesh) {
    const projectPath = mesh.getProjectPath(task.agentId);
    if (!projectPath) throw unregisteredAgentError(task.agentId, task.id);
    const resolved = await resolveSessionCwd({ agentPath: projectPath }, options.cwdDeps, {
      log: options.log ?? true,
    });
    // **The desk guard** (spec `agent-home-desk` §3.4, DOR-2356): a run for
    // this agent never stands in another agent's home, a copy of it, or a
    // room's folder. A refusal throws, and the run is recorded failed with
    // the reason — nothing reaches a runtime.
    assertOwnDesk(
      projectPath,
      resolved.cwd,
      deskBindingFor(resolved),
      ...(options.cwdDeps ? [options.cwdDeps.defaultCwd] : [])
    );
    return {
      cwd: resolved.cwd,
      agentPath: projectPath,
      managed: resolved.rung === 'agent-managed',
    };
  }
  return { cwd: options.serverCwd ?? process.cwd(), managed: false };
}
