/**
 * Putting a root under discovery — at boot, and again whenever an agent
 * registers.
 *
 * This is one function rather than two lines inlined in `index.ts` because the
 * two lines have to stay in step: a root the watcher sees and the reconciler
 * does not has no safety net, and a root the reconciler sees and the watcher
 * does not takes up to five minutes to notice an edit. Keeping the pair in one
 * place is also what makes the registration-time path testable without booting
 * a server, which matters — it is the gap this wave exists to close.
 *
 * @module services/tasks/attach-task-roots
 */
import type { TaskFileWatcher } from './task-file-watcher.js';
import type { TaskReconciler } from './task-reconciler.js';
import { agentTaskRoots, type TaskRoot } from './skills-roots.js';

/** The two halves of discovery a root has to be handed to. */
export interface TaskRootAttachment {
  /** The live watcher, absent when the tasks subsystem is switched off. */
  watcher?: Pick<TaskFileWatcher, 'watch'>;
  /** The periodic reconciler, absent when the tasks subsystem is switched off. */
  reconciler?: Pick<TaskReconciler, 'addRoot'>;
}

/**
 * Start watching and reconciling one root.
 *
 * Safe to call more than once for the same root: both halves ignore a repeat
 * (`TaskFileWatcher.watch` logs and returns, `TaskReconciler.addRoot` is a
 * no-op). That matters now that roots arrive on agent registration as well as
 * at boot — an agent that registers twice must not be scanned twice per pass.
 *
 * @param into - The watcher and reconciler to attach to.
 * @param root - The root to discover schedules in.
 */
export function attachTaskRoot(into: TaskRootAttachment, root: TaskRoot): void {
  into.watcher?.watch(root);
  into.reconciler?.addRoot(root);
}

/**
 * Start watching every root that belongs to one agent — its `.agents/skills/`,
 * and nothing else since DOR-1486 retired the legacy `.dork/tasks/` root.
 *
 * Called at boot for each registered agent, and from the agent-created hook for
 * every agent that arrives afterwards. Before DOR-1485 only the boot half
 * existed, so a schedule shipped with a just-installed agent stayed invisible
 * for the rest of the process's life.
 *
 * @param into - The watcher and reconciler to attach to.
 * @param projectPath - The agent's project root.
 * @param agentId - The agent's id.
 */
export function attachAgentRoots(
  into: TaskRootAttachment,
  projectPath: string,
  agentId: string
): void {
  for (const root of agentTaskRoots(projectPath, agentId)) attachTaskRoot(into, root);
}
