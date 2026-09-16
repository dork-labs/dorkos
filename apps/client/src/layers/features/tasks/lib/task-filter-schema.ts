/**
 * Task-specific filter schema and sort options for the tasks list.
 *
 * Defines the filter fields, enum options, and sort accessors used by
 * the shared FilterBar system when rendering the tasks management surface.
 *
 * @module features/tasks/lib/task-filter-schema
 */
import type { Task } from '@dorkos/shared/types';
import { isScheduleAwaitingApproval } from '@/layers/entities/tasks';
import { createFilterSchema, textFilter, enumFilter, createSortOptions } from '@/layers/shared/lib';

/**
 * Which status bucket a task's row falls into, for the filter and sort below.
 *
 * A package can ship a schedule switched off; discovery still parks it at
 * `pending_approval`, but it is not asking to run, so it buckets — and reads —
 * exactly like an ordinary paused task rather than one waiting on a person
 * (DOR-2059). {@link isScheduleAwaitingApproval} is the one place that
 * distinction is drawn.
 *
 * @param task - The task being bucketed.
 * @returns The status bucket this task's filter chip and sort order use.
 */
function taskStatusBucket(task: Task): 'active' | 'paused' | 'pending_approval' {
  if (isScheduleAwaitingApproval(task)) return 'pending_approval';
  if (!task.enabled || task.status === 'paused') return 'paused';
  return 'active';
}

/** Filter schema for the tasks list. */
export const taskFilterSchema = createFilterSchema<Task>({
  search: textFilter({
    fields: [(t) => t.name, (t) => t.description ?? '', (t) => t.prompt],
  }),
  agent: enumFilter({
    field: (t) => t.agentId,
    options: [],
    dynamic: true,
    label: 'Agent',
  }),
  status: enumFilter({
    field: taskStatusBucket,
    options: ['active', 'paused', 'pending_approval'],
    multi: true,
    label: 'Status',
    labels: {
      active: 'Active',
      paused: 'Paused',
      pending_approval: 'Pending Approval',
    },
    colors: {
      active: 'text-emerald-400',
      paused: 'text-muted-foreground',
      pending_approval: 'text-amber-400',
    },
  }),
  type: enumFilter({
    field: (t) => (t.cron ? 'scheduled' : 'on-demand'),
    options: ['scheduled', 'on-demand'],
    label: 'Type',
    labels: {
      scheduled: 'Scheduled',
      'on-demand': 'On-demand',
    },
  }),
});

/** Sort options for the tasks list. */
export const taskSortOptions = createSortOptions<Task>({
  name: { label: 'Name', accessor: (t) => t.name },
  lastRun: { label: 'Last run', accessor: (t) => t.updatedAt, direction: 'desc' },
  nextRun: { label: 'Next run', accessor: (t) => t.nextRun ?? null },
  status: {
    label: 'Status',
    accessor: taskStatusBucket,
  },
});

/**
 * Field the tasks list sorts by when the URL carries no `sort` param.
 *
 * `/tasks` has no `validateSearch`, so a fresh visit arrives with `sort`
 * undefined. Without a named default the list fell back to whatever order the
 * store returned and the sort control rendered "Sort: " with nothing after it.
 * Soonest-first is the useful lead for a page about scheduled work; paused tasks
 * carry no `nextRun` and sort to the end.
 */
export const TASK_DEFAULT_SORT_FIELD = 'nextRun';
