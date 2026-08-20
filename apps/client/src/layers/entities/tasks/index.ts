/**
 * Tasks entity — domain hooks for task scheduling and run data fetching.
 *
 * @module entities/tasks
 */
export { useTasksEnabled } from './model/use-tasks-config';
export {
  useTasks,
  useCreateTask,
  useUpdateTask,
  useDeleteTask,
  useTriggerTask,
  TASKS_KEY,
} from './model/use-tasks';
export { useTasksSync } from './model/use-tasks-sync';
export {
  useTaskRuns,
  useTaskRun,
  useCancelTaskRun,
  useActiveTaskRunCount,
  TASK_RUNS_KEY,
} from './model/use-task-runs';
export { useTaskTemplates } from './model/use-task-templates';
export type { TaskTemplate } from './model/use-task-templates';
export { useTaskTemplateDialog } from './model/use-task-template-dialog';
