import { useCallback, useMemo, useState } from 'react';
import type { TopologyAgent } from '@dorkos/shared/mesh-schemas';
import { applySortAndFilter } from '@/layers/shared/lib';
import type { FilterValues } from '@/layers/shared/lib/filter-engine';
import type { UseFilterStateReturn } from '@/layers/shared/model';
import { FilterBar } from '@/layers/shared/ui/filter-bar';
import { Badge } from '@/layers/shared/ui/badge';
import { agentFilterSchema, agentSortOptions } from '@/layers/features/agents-list';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

// ── Mock data ─────────────────────────────────────────────────

const MOCK_AGENTS: TopologyAgent[] = [
  {
    id: '01HQABC0000000000001',
    name: 'code-reviewer',
    description: 'Reviews pull requests and suggests improvements.',
    runtime: 'claude-code',
    capabilities: ['code-review', 'testing', 'documentation'],
    behavior: { responseMode: 'always', escalationThreshold: 0.8 },
    budget: { maxHopsPerMessage: 3, maxCallsPerHour: 60 },
    registeredAt: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
    registeredBy: 'kai',
    personaEnabled: false,
    enabledToolGroups: {},
    icon: '🔍',
    color: '#6366f1',
    namespace: 'core',
    healthStatus: 'active',
    relayAdapters: [],
    relaySubject: null,
    pulseScheduleCount: 2,
    lastSeenAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    lastSeenEvent: 'message',
    projectPath: '/home/kai/projects/core',
  },
  {
    id: '01HQABC0000000000002',
    name: 'deploy-bot',
    description: 'Handles CI/CD pipeline orchestration.',
    runtime: 'cursor',
    capabilities: ['deployment', 'monitoring'],
    behavior: { responseMode: 'direct-only' },
    budget: { maxHopsPerMessage: 1, maxCallsPerHour: 30 },
    registeredAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    registeredBy: 'priya',
    personaEnabled: true,
    enabledToolGroups: {},
    icon: '🚀',
    color: '#f59e0b',
    namespace: 'infra',
    healthStatus: 'inactive',
    relayAdapters: ['telegram'],
    relaySubject: null,
    pulseScheduleCount: 0,
    lastSeenAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
    lastSeenEvent: 'ping',
    projectPath: '/home/priya/infra',
  },
  {
    id: '01HQABC0000000000003',
    name: 'test-runner',
    description: 'Runs test suites and reports coverage deltas.',
    runtime: 'codex',
    capabilities: ['testing', 'coverage'],
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 2, maxCallsPerHour: 120 },
    registeredAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
    registeredBy: 'kai',
    personaEnabled: false,
    enabledToolGroups: {},
    icon: '🧪',
    color: '#10b981',
    namespace: 'core',
    healthStatus: 'stale',
    relayAdapters: [],
    relaySubject: null,
    pulseScheduleCount: 1,
    lastSeenAt: new Date(Date.now() - 1000 * 60 * 60 * 72).toISOString(),
    lastSeenEvent: 'message',
    projectPath: '/home/kai/projects/core',
  },
  {
    id: '01HQABC0000000000004',
    name: 'incident-responder',
    description: 'Monitors alerts and escalates production incidents.',
    runtime: 'claude-code',
    capabilities: ['monitoring', 'alerting', 'escalation'],
    behavior: { responseMode: 'always', escalationThreshold: 0.5 },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 200 },
    registeredAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    registeredBy: 'priya',
    personaEnabled: true,
    enabledToolGroups: {},
    icon: '🔥',
    color: '#ef4444',
    namespace: 'infra',
    healthStatus: 'unreachable',
    relayAdapters: ['slack', 'telegram'],
    relaySubject: null,
    pulseScheduleCount: 3,
    lastSeenAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    lastSeenEvent: 'error',
    projectPath: '/home/priya/infra',
  },
  {
    id: '01HQABC0000000000005',
    name: 'doc-writer',
    description: 'Generates and maintains technical documentation.',
    runtime: 'cursor',
    capabilities: ['documentation', 'code-review'],
    behavior: { responseMode: 'direct-only' },
    budget: { maxHopsPerMessage: 2, maxCallsPerHour: 40 },
    registeredAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 1).toISOString(),
    registeredBy: 'kai',
    personaEnabled: false,
    enabledToolGroups: {},
    icon: '📝',
    color: '#8b5cf6',
    namespace: 'docs',
    healthStatus: 'active',
    relayAdapters: [],
    relaySubject: null,
    pulseScheduleCount: 0,
    lastSeenAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    lastSeenEvent: 'message',
    projectPath: '/home/kai/projects/docs',
  },
  {
    id: '01HQABC0000000000006',
    name: 'db-optimizer',
    description: 'Analyzes query plans and suggests schema improvements.',
    runtime: 'other',
    capabilities: ['database', 'performance'],
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 2, maxCallsPerHour: 20 },
    registeredAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
    registeredBy: 'priya',
    personaEnabled: false,
    enabledToolGroups: {},
    icon: '🗄️',
    color: '#0ea5e9',
    namespace: 'infra',
    healthStatus: 'inactive',
    relayAdapters: [],
    relaySubject: null,
    pulseScheduleCount: 1,
    lastSeenAt: new Date(Date.now() - 1000 * 60 * 60 * 4).toISOString(),
    lastSeenEvent: 'ping',
    projectPath: '/home/priya/infra',
  },
];

// ── useMockFilterState ─────────────────────────────────────────

type AgentFilterDefs = typeof agentFilterSchema extends { definitions: infer D } ? D : never;

/**
 * Local-state drop-in replacement for useFilterState.
 *
 * Mirrors the UseFilterStateReturn API using useState instead of URL params
 * so the playground works outside TanStack Router.
 */
function useMockFilterState(): UseFilterStateReturn<AgentFilterDefs> {
  const { defaultValues } = agentFilterSchema;

  const [values, setValues] = useState<FilterValues<AgentFilterDefs>>(
    () => defaultValues as FilterValues<AgentFilterDefs>
  );
  const [sortField, setSortField] = useState('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const set = useCallback((name: keyof AgentFilterDefs, value: unknown) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const clear = useCallback(
    (name: keyof AgentFilterDefs) => {
      setValues((prev) => ({
        ...prev,
        [name]: (defaultValues as FilterValues<AgentFilterDefs>)[name],
      }));
    },
    [defaultValues]
  );

  const clearAll = useCallback(() => {
    setValues(defaultValues as FilterValues<AgentFilterDefs>);
    setSortField('');
    setSortDirection('asc');
  }, [defaultValues]);

  const setSort = useCallback((field: string, direction: 'asc' | 'desc' = 'asc') => {
    setSortField(field);
    setSortDirection(direction);
  }, []);

  const isFiltered = agentFilterSchema.isFiltered(values);
  const activeCount = agentFilterSchema.activeCount(values);

  const describeActive = useCallback(() => agentFilterSchema.describeActive(values), [values]);

  return {
    values,
    inputValues: values,
    sortField,
    sortDirection,
    isFiltered,
    activeCount,
    set,
    clear,
    clearAll,
    setSort,
    describeActive,
    schema: agentFilterSchema as UseFilterStateReturn<AgentFilterDefs>['schema'],
  };
}

// ── Status badge color map ─────────────────────────────────────

const STATUS_BADGE_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  active: 'default',
  inactive: 'secondary',
  stale: 'outline',
  unreachable: 'destructive',
};

// ── Showcase ───────────────────────────────────────────────────

/** FilterBar showcase — interactive demo with mock agent data. */
export function FilterBarShowcase() {
  const filterState = useMockFilterState();

  const namespaceOptions = useMemo(
    () => [
      ...new Set(MOCK_AGENTS.map((a) => a.namespace).filter((ns): ns is string => Boolean(ns))),
    ],
    []
  );

  const filteredAgents = useMemo(
    () =>
      applySortAndFilter(MOCK_AGENTS, agentFilterSchema, filterState.values, agentSortOptions, {
        field: filterState.sortField,
        direction: filterState.sortDirection,
      }),
    [filterState.values, filterState.sortField, filterState.sortDirection]
  );

  return (
    <>
      <PlaygroundSection
        title="FilterBar — Full Demo"
        description="All filter types in action: text search, enum (multi + single), date range, sort, and active filter chips. Uses mock agent data with local state instead of URL params."
      >
        <ShowcaseDemo responsive>
          <div className="border-border rounded-lg border">
            <FilterBar state={filterState}>
              <FilterBar.Search placeholder="Filter agents..." />
              <FilterBar.Primary name="status" />
              <FilterBar.AddFilter dynamicOptions={{ namespace: namespaceOptions }} />
              <FilterBar.Sort options={agentSortOptions} />
              <FilterBar.ResultCount
                count={filteredAgents.length}
                total={MOCK_AGENTS.length}
                noun="agent"
              />
              <FilterBar.ActiveFilters />
            </FilterBar>
            <div className="divide-border divide-y px-4 pb-2">
              {filteredAgents.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center text-sm">
                  No agents match the current filters.
                </p>
              ) : (
                filteredAgents.map((agent) => (
                  <div key={agent.id} className="flex items-center justify-between py-2.5">
                    <div className="flex items-center gap-2">
                      <span
                        className="flex size-6 items-center justify-center rounded-full text-xs"
                        style={{ backgroundColor: agent.color }}
                        aria-hidden="true"
                      >
                        {agent.icon}
                      </span>
                      <div>
                        <p className="text-sm font-medium">{agent.name}</p>
                        <p className="text-muted-foreground text-[11px]">{agent.namespace}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {agent.runtime}
                      </Badge>
                      <Badge
                        variant={STATUS_BADGE_VARIANT[agent.healthStatus] ?? 'outline'}
                        className="text-[10px]"
                      >
                        {agent.healthStatus}
                      </Badge>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="FilterBar — Responsive"
        description="Use the viewport controls to preview how the filter bar wraps at tablet and mobile widths."
      >
        <ShowcaseDemo responsive>
          <div className="border-border rounded-lg border">
            <FilterBar state={filterState}>
              <FilterBar.Search placeholder="Filter agents..." />
              <FilterBar.Primary name="status" />
              <FilterBar.AddFilter dynamicOptions={{ namespace: namespaceOptions }} />
              <FilterBar.Sort options={agentSortOptions} />
              <FilterBar.ResultCount
                count={filteredAgents.length}
                total={MOCK_AGENTS.length}
                noun="agent"
              />
              <FilterBar.ActiveFilters />
            </FilterBar>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="FilterBar — Empty Filter State"
        description="When all agents are filtered out, the list body shows a clear-filters prompt. Interact with the filter bar above to trigger this state."
      >
        <ShowcaseLabel>No results (apply filters above to see)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="border-border rounded-lg border">
            <FilterBar state={filterState}>
              <FilterBar.Search placeholder="Filter agents..." />
              <FilterBar.Primary name="status" />
              <FilterBar.ActiveFilters />
            </FilterBar>
            <div className="px-4 pb-4">
              {filteredAgents.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <p className="text-muted-foreground text-sm">
                    No agents match{' '}
                    <span className="text-foreground font-medium">
                      &ldquo;{filterState.describeActive()}&rdquo;
                    </span>
                    .
                  </p>
                  <button
                    type="button"
                    onClick={filterState.clearAll}
                    className="text-primary text-xs underline-offset-2 hover:underline"
                  >
                    Clear all filters
                  </button>
                </div>
              ) : (
                <p className="text-muted-foreground py-4 text-center text-xs">
                  Apply filters above to see the empty state.
                </p>
              )}
            </div>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
