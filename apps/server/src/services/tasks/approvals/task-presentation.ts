import type { TaskSchedulerService } from '../task-scheduler-service.js';
import type { Task } from '@dorkos/shared/types';
import type { MeshCore } from '@dorkos/mesh';
import { projectsOfFolders } from '../../projects/project-registry.js';

/** Stamp each schedule with its run folder's project, resolving each distinct folder once. */
export async function withTaskProjects(
  meshCore: MeshCore | undefined,
  tasks: Task[]
): Promise<Task[]> {
  const folders = tasks.map((task) =>
    task.agentId ? meshCore?.getProjectPath(task.agentId) : undefined
  );
  const projects = await projectsOfFolders(folders.flatMap((dir) => (dir ? [dir] : [])));
  return tasks.map((task, i) => {
    const folder = folders[i];
    return { ...task, project: folder ? (projects.get(folder) ?? null) : null };
  });
}

/**
 * How many upcoming runs a parked schedule carries in `nextRuns`.
 *
 * Three, because the question the preview answers is "is this cron what the
 * agent says it is?" — one occurrence cannot show a rhythm, and a long list is
 * a wall of timestamps nobody reads. Three shows the interval and the
 * time-of-day at a glance.
 */
const NEXT_RUNS_PREVIEW_COUNT = 3;

/**
 * Describe when a task will run, for one task on its way out of this router.
 *
 * **`nextRuns` is computed for `pending_approval` rows and nobody else**, and
 * the narrowness is the design (DOR-1394 review). Reading a cron means
 * constructing a throwaway `croner` job and asking it for three occurrences —
 * measured at roughly 1.4ms, synchronously, per task — and this route runs on
 * every app poll over every task there is. The only surface that reads the
 * field is the approval card, which only ever shows parked schedules, so
 * computing it for the rest would be milliseconds per poll spent on an answer
 * nothing asks for. Everything else reports `[]`.
 *
 * A parked schedule is exactly where the question cannot be answered any other
 * way: the scheduler never registers one, so it holds no job to ask.
 *
 * `nextRun` keeps its old meaning everywhere it already had one: the live
 * job's own answer, and `null` for a task that is not going to fire. The one
 * addition is `pending_approval`, which now reports its first previewed
 * occurrence instead of `null`. Paused and disabled tasks deliberately stay
 * `null` — Home reads this field to say what happens next, and a time for a
 * task nothing will fire is a promise nobody is keeping.
 */
export function withTaskRunTimes(scheduler: TaskSchedulerService, task: Task): Task {
  const live = scheduler.getNextRun(task.id)?.toISOString() ?? null;
  if (task.status !== 'pending_approval') return { ...task, nextRuns: [], nextRun: live };

  const nextRuns = scheduler.previewNextRuns(task.cron, task.timezone, NEXT_RUNS_PREVIEW_COUNT);
  return { ...task, nextRuns, nextRun: live ?? nextRuns[0] ?? null };
}
