import { useMemo, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { TopologyAgent } from '@dorkos/shared/mesh-schemas';
import { useSessions, selectAgentSessions } from '@/layers/entities/session';
import { applySortAndFilter } from '@/layers/shared/lib';
import { useFilterState, useTransport } from '@/layers/shared/model';
import { FilterBar } from '@/layers/shared/ui/filter-bar';
import { DataTable } from '@/layers/shared/ui/data-table';
import { ScrollArea } from '@/layers/shared/ui/scroll-area';
import { Skeleton } from '@/layers/shared/ui/skeleton';
import { useAgentHubStore } from '@/layers/features/agent-hub';
import { useAppStore } from '@/layers/shared/model';
import { agentFilterSchema, agentSortOptions } from '../lib/agent-filter-schema';
import { createAgentColumns, type AgentTableRow } from '../lib/agent-columns';
import { AgentEmptyFilterState } from './AgentEmptyFilterState';

interface AgentsListProps {
  agents: TopologyAgent[];
  isLoading: boolean;
}

/**
 * Agent fleet table — sortable, filterable DataTable of all registered agents.
 * Replaces the previous card-based layout with a responsive table that hides
 * secondary columns (Runtime, Project, Sessions) on mobile.
 */
export function AgentsList({ agents, isLoading }: AgentsListProps) {
  const navigate = useNavigate();
  const transport = useTransport();

  const filterState = useFilterState(agentFilterSchema, {
    debounce: { search: 200 },
  });

  const { sessions } = useSessions();

  // Derive dynamic namespace options from the agent list
  const namespaceOptions = useMemo(
    () => [...new Set(agents.map((a) => a.namespace).filter((ns): ns is string => Boolean(ns)))],
    [agents]
  );

  // Apply filters and sort (flat list — no namespace grouping)
  const filteredAgents = useMemo(
    () =>
      applySortAndFilter(agents, agentFilterSchema, filterState.values, agentSortOptions, {
        field: filterState.sortField,
        direction: filterState.sortDirection,
      }),
    [agents, filterState.values, filterState.sortField, filterState.sortDirection]
  );

  // Compute session counts per agent — canonical membership rule (DOR-203).
  const sessionCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const agent of agents) {
      counts[agent.id] = selectAgentSessions(sessions, agent.projectPath ?? null).length;
    }
    return counts;
  }, [agents, sessions]);

  // Fetch config once for default-agent badge
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });

  // Enrich topology agents with computed fields for the table
  const tableData: AgentTableRow[] = useMemo(
    () =>
      filteredAgents.map((agent) => ({
        ...agent,
        sessionCount: sessionCounts[agent.id] ?? 0,
        isDefault: config?.agents?.defaultAgent === agent.name,
      })),
    [filteredAgents, sessionCounts, config?.agents?.defaultAgent]
  );

  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const setActiveRightPanelTab = useAppStore((s) => s.setActiveRightPanelTab);

  const handleManage = useCallback(
    (projectPath: string) => {
      useAgentHubStore.getState().openHub(projectPath);
      setActiveRightPanelTab('agent-hub');
      setRightPanelOpen(true);
    },
    [setActiveRightPanelTab, setRightPanelOpen]
  );

  // ── Callbacks for column cell renderers ────────────────────────
  const handleNavigate = useCallback(
    (projectPath: string) => {
      void navigate({ to: '/session', search: { dir: projectPath } });
    },
    [navigate]
  );

  const handleStartSession = useCallback(
    (projectPath: string) => {
      void navigate({ to: '/session', search: { dir: projectPath } });
    },
    [navigate]
  );

  // Stable column definitions — only recreated when callbacks change
  const columns = useMemo(
    () =>
      createAgentColumns({
        onNavigate: handleNavigate,
        onManage: handleManage,
        onStartSession: handleStartSession,
      }),
    [handleNavigate, handleManage, handleStartSession]
  );

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <FilterBar state={filterState}>
        <FilterBar.Search placeholder="Filter agents..." />
        <FilterBar.Primary name="status" />
        <FilterBar.AddFilter dynamicOptions={{ namespace: namespaceOptions }} />
        <FilterBar.Sort options={agentSortOptions} />
        <FilterBar.ResultCount count={filteredAgents.length} total={agents.length} noun="agent" />
        <FilterBar.ActiveFilters />
      </FilterBar>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-4 pb-4">
          {filteredAgents.length === 0 && agents.length > 0 ? (
            <AgentEmptyFilterState
              onClearFilters={filterState.clearAll}
              filterDescription={filterState.describeActive()}
            />
          ) : (
            <DataTable
              columns={columns}
              data={tableData}
              emptyMessage="No agents registered."
              className="border-0"
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
