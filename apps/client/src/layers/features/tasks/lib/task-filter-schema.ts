/**
 * Task-specific filter schema and sort options for the tasks list.
 *
 * Defines the filter fields, enum options, and sort accessors used by
 * the shared FilterBar system when rendering the tasks management surface.
 *
 * @module features/tasks/lib/task-filter-schema
 */
import type { Task } from '@dorkos/shared/types';
import { createFilterSchema, textFilter, enumFilter, createSortOptions } from '@/layers/shared/lib';

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
    field: (t) => {
      if (t.status === 'pending_approval') return 'pending_approval';
      if (!t.enabled) return 'paused';
      return 'active';
    },
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
    accessor: (t) => {
      if (t.status === 'pending_approval') return 'pending_approval';
      if (!t.enabled) return 'paused';
      return 'active';
    },
  },
});
