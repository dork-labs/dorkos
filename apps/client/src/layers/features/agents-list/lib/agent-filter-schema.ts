/**
 * Agent-specific filter schema and sort options for the agents list.
 *
 * Defines the filter fields, enum options, and sort accessors used by
 * the shared FilterBar system when rendering the fleet management surface.
 *
 * @module features/agents-list/lib/agent-filter-schema
 */
import type { TopologyAgent } from '@dorkos/shared/mesh-schemas';
import {
  createFilterSchema,
  textFilter,
  enumFilter,
  dateRangeFilter,
  createSortOptions,
} from '@/layers/shared/lib';

/** Filter schema for the agents list. */
export const agentFilterSchema = createFilterSchema<TopologyAgent>({
  search: textFilter({
    fields: [(a) => a.name, (a) => a.description, (a) => a.capabilities.join(' ')],
  }),
  status: enumFilter({
    field: (a) => a.healthStatus,
    options: ['active', 'inactive', 'stale', 'unreachable'],
    multi: true,
    label: 'Status',
    labels: {
      active: 'Active',
      inactive: 'Inactive',
      stale: 'Stale',
      unreachable: 'Unreachable',
    },
    colors: {
      active: 'text-emerald-400',
      inactive: 'text-amber-400',
      stale: 'text-muted-foreground',
      unreachable: 'text-red-400',
    },
  }),
  runtime: enumFilter({
    field: (a) => a.runtime,
    options: ['claude-code', 'cursor', 'codex', 'other'],
    label: 'Runtime',
    labels: { 'claude-code': 'Claude Code', cursor: 'Cursor', codex: 'Codex', other: 'Other' },
  }),
  lastSeen: dateRangeFilter({
    field: (a) => a.lastSeenAt,
    presets: ['1h', '24h', '7d', '30d'],
    label: 'Last seen',
  }),
  namespace: enumFilter({
    field: (a) => a.namespace,
    options: [],
    dynamic: true,
    label: 'Namespace',
  }),
});

/** Sort options for the agents list. */
export const agentSortOptions = createSortOptions<TopologyAgent>({
  name: { label: 'Name', accessor: (a) => a.name },
  lastSeen: { label: 'Last seen', accessor: (a) => a.lastSeenAt ?? '', direction: 'desc' },
  status: { label: 'Status', accessor: (a) => a.healthStatus },
  registered: { label: 'Registered', accessor: (a) => a.registeredAt, direction: 'desc' },
});
