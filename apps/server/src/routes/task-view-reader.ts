/**
 * How the task reads find what they answer with (DOR-4978): one schedule or
 * many, presented the way the app reads them, and the reader the capability
 * mount's `tasks.view_*` capabilities ask (`services/tasks/view/task-view-capabilities.ts`).
 *
 * The hand routes still present what a create or an edit returns, so both
 * share {@link presentTasks}.
 *
 * @module routes/task-view-reader
 */
import type { Task } from '@dorkos/shared/schemas';
import * as personReview from '../services/tasks/approvals/person-review.js';
import { withTaskRunPlace } from '../services/tasks/execution/run-place-preview.js';
import { withProposerNames } from '../services/tasks/task-provenance.js';
import {
  withTaskProjects,
  withTaskRunTimes,
} from '../services/tasks/approvals/task-presentation.js';
import { agentIdOfHome } from '../services/tasks/approvals/schedule-owner.js';
import type { TaskViewReader } from '../services/tasks/view/task-view-capabilities.js';
import { withTaskFolderRules } from './task-approval-rules.js';
import type { TasksRouterDeps } from './tasks-deps.js';

/**
 * Schedules, ready to send: run times attached, each proposer named, each
 * project stamped, and when each last ran (one query for all, DOR-2914), with
 * one identity lookup per distinct agent.
 *
 * @param deps - The store, scheduler and Mesh.
 * @param tasks - The schedules.
 * @returns The presented schedules, in the same order.
 */
export async function presentTasks(
  deps: Pick<TasksRouterDeps, 'store' | 'scheduler' | 'meshCore'>,
  tasks: Task[]
): Promise<Task[]> {
  // When each last ran, and whether its last finished run did its job.
  const history = deps.store.runHistory();
  const named = await withProposerNames(tasks);
  return withTaskProjects(
    deps.meshCore,
    named.map((task) => ({
      ...withTaskRunTimes(deps.scheduler, task),
      ...history(task.id),
      approvalRevision: personReview.taskReviewRevision(task),
    }))
  );
}

/**
 * The reader the task reads ask, over the running Tasks service.
 *
 * @param deps - What the Tasks routes read.
 * @returns The reader.
 */
export function taskViewReader(deps: TasksRouterDeps): TaskViewReader {
  const { store, meshCore } = deps;
  return {
    async listTasks(person) {
      const tasks = await presentTasks(deps, store.getTasks());
      // Folder rules and where a run would land are the person's to see: agent config
      // reads withhold them, so this list does too.
      if (!person) return tasks;
      return Promise.all(
        tasks.map(async (task) =>
          withTaskRunPlace(await withTaskFolderRules(task, meshCore), meshCore)
        )
      );
    },
    scheduleOwners: () =>
      new Map(store.getTasks().map((task) => [task.id, task.agentId ?? null] as const)),
    listRuns: (filter) => store.listRuns(filter),
    getRun: (id) => store.getRun(id),
    agentIdOfHome: (agentPath) => agentIdOfHome(meshCore, agentPath),
  };
}
