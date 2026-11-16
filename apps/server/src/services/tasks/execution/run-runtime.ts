/**
 * Which runtime a task's runs start on: the task's own, then its agent's (when
 * this build runs it), then the default. Kept apart from the rest of run
 * resolution so checks that only need the runtime (a task's rules, a trial's
 * mode; review of DOR-3637) read the same ladder without loading it all.
 *
 * @module services/tasks/execution/run-runtime
 */
import { readManifest } from '@dorkos/shared/manifest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { Task } from '@dorkos/shared/types';
import type { MeshCore } from '@dorkos/mesh';

/**
 * What this resolver needs from the runtime registry — no more, so a test can
 * hand it three functions instead of a registry with a database behind it.
 *
 * `runtimeRegistry` satisfies it structurally.
 */
export interface RunExecutionRuntimes {
  /** Whether a runtime type is registered and can take a run. */
  has(type: string): boolean;
  /** The runtime a caller that named none gets. */
  getDefaultType(): string;
  /** Every registered runtime's capability profile, keyed by type. */
  getAllCapabilities(): Record<string, RuntimeCapabilities>;
}

/**
 * Which runtime this task's next run executes on, before asking whether it is
 * registered.
 *
 * Split out so the answer and the availability check are separate facts: the
 * check needs to know WHICH tier answered, because a task that named its own
 * runtime and a machine with nothing registered are different problems with
 * different fixes.
 *
 * The tier is reported accurately, `agent` included — it used to report the
 * agent tier as `default`, which was simply wrong about where the answer came
 * from (DOR-1615 review).
 *
 * @param task - The task about to fire.
 * @param runtimes - The registry.
 * @param agentRuntime - The runtime the task's agent manifest names, if any.
 */
export function resolveRuntimeType(
  task: Pick<Task, 'runtime'>,
  runtimes: RunExecutionRuntimes,
  agentRuntime: string | undefined
): { type: string; tier: 'task' | 'agent' | 'default' } {
  if (task.runtime) return { type: task.runtime, tier: 'task' };
  // The agent's runtime only when this build can actually run it. An agent
  // pinned to a runtime with no adapter here — the packaged desktop app bundles
  // only the claude-code SDK — falls through to the default rather than failing
  // a run nobody asked it to own. The same tolerance `resolveForAgent` applies.
  if (agentRuntime && runtimes.has(agentRuntime)) return { type: agentRuntime, tier: 'agent' };
  return { type: runtimes.getDefaultType(), tier: 'default' };
}

/**
 * The runtime a task's runs start on, by the ladder above, reading the agent's
 * runtime off its manifest when the task names none. A manifest that cannot be
 * read gives no opinion, as it does for a run.
 *
 * @param task - The task, with its own runtime if it names one.
 * @param runtimes - The registry.
 * @param agentPath - The task's agent directory, when it has an agent.
 */
export async function resolveTaskRunRuntime(
  task: Pick<Task, 'runtime'>,
  runtimes: RunExecutionRuntimes,
  agentPath: string | null | undefined
): Promise<string> {
  let agentRuntime: string | undefined;
  if (!task.runtime && agentPath) {
    try {
      agentRuntime = (await readManifest(agentPath))?.runtime ?? undefined;
    } catch {
      agentRuntime = undefined;
    }
  }
  return resolveRuntimeType(task, runtimes, agentRuntime).type;
}

/**
 * {@link resolveTaskRunRuntime} for a task by its agent id: the one lookup the
 * mode labels, the folder-rule preview, the trial and the rules check share,
 * so the card's modes and the server's checks cannot drift apart.
 *
 * @param task - The task, with its own runtime and agent id.
 * @param runtimes - The registry.
 * @param meshCore - Finds the agent's folder; absent when Mesh is off.
 */
export function taskRunRuntime(
  task: Pick<Task, 'runtime' | 'agentId'>,
  runtimes: RunExecutionRuntimes,
  meshCore?: Pick<MeshCore, 'getProjectPath'>
): Promise<string> {
  const agentPath = task.agentId ? meshCore?.getProjectPath(task.agentId) : null;
  return resolveTaskRunRuntime(task, runtimes, agentPath);
}
