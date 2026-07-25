import { useMemo, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { TopologyAgent } from '@dorkos/shared/mesh-schemas';
import { useAgentAttentionMap } from '@/layers/entities/session';
import { applySortAndFilter } from '@/layers/shared/lib';
import { useFilterState, useTransport } from '@/layers/shared/model';
import { FilterBar } from '@/layers/shared/ui/filter-bar';
import { ScrollArea } from '@/layers/shared/ui/scroll-area';
import { Skeleton } from '@/layers/shared/ui/skeleton';
import { useAgentHubStore } from '@/layers/features/agent-hub';
import { useAppStore } from '@/layers/shared/model';
import {
  agentFilterSchema,
  agentSortMenuOptions,
  agentSortOptions,
  ATTENTION_SORT_FIELD,
} from '../lib/agent-filter-schema';
import { isPastOnboardingGrace, sortAgentsByAttention } from '../lib/agent-attention';
import type { AgentTableRow } from '../lib/agent-columns';
import { AgentEmptyFilterState } from './AgentEmptyFilterState';
import { AgentFleetTable } from './AgentFleetTable';

interface AgentsListProps {
  agents: TopologyAgent[];
  isLoading: boolean;
}

/**
 * Agent fleet surface — filter bar plus the fleet table.
 *
 * The default order is attention, not inventory: rows group into needs you /
 * working / quiet so the page's first row answers "who needs me". Picking any
 * field from the sort menu flattens the groups and sorts purely by that field —
 * the grouping is the default answer, not a cage.
 */
export function AgentsList({ agents, isLoading }: AgentsListProps) {
  const navigate = useNavigate();
  const transport = useTransport();

  const filterState = useFilterState(agentFilterSchema, {
    debounce: { search: 200 },
  });

  // Derive dynamic namespace options from the agent list
  const namespaceOptions = useMemo(
    () => [...new Set(agents.map((a) => a.namespace).filter((ns): ns is string => Boolean(ns)))],
    [agents]
  );

  // No `sort` param means attention order, so a first visit lands on it.
  const isAttentionOrder = !filterState.sortField || filterState.sortField === ATTENTION_SORT_FIELD;

  // Filter first. Attention order is applied after enrichment below, because it
  // reads the chat state and registration age that only the enriched row carries.
  const filteredAgents = useMemo(
    () =>
      isAttentionOrder
        ? agentFilterSchema.applyFilters(agents, filterState.values)
        : applySortAndFilter(agents, agentFilterSchema, filterState.values, agentSortOptions, {
            field: filterState.sortField,
            direction: filterState.sortDirection,
          }),
    [agents, isAttentionOrder, filterState.values, filterState.sortField, filterState.sortDirection]
  );

  // Fleet-wide chat state per agent folder. `useAgentAttentionMap` is the app's
  // single source of per-agent "does this need my eyes?" truth (DOR-339): live
  // session lifecycle off the global event stream, joined with cross-agent
  // session recency from `/api/sessions/recent`. It has to be this and not a
  // count off `useSessions()` — that list is scoped to the selected working
  // directory, so a per-row count would be zero for every agent but one.
  const projectPaths = useMemo(
    () => agents.map((a) => a.projectPath).filter((path): path is string => Boolean(path)),
    [agents]
  );
  const chatStates = useAgentAttentionMap(projectPaths);

  // Fetch config once for default-agent badge
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });

  // Enrich topology agents with computed fields, then apply attention order
  const tableData: AgentTableRow[] = useMemo(() => {
    const rows = filteredAgents.map((agent) => ({
      ...agent,
      // An agent with no project folder can hold no chats at all — exact-cwd
      // membership (DOR-203) has nothing to match — which is what 'fresh' means.
      chatState: (agent.projectPath ? chatStates[agent.projectPath] : undefined) ?? 'fresh',
      isPastOnboardingGrace: isPastOnboardingGrace(agent.registeredAt),
      isDefault: config?.agents?.defaultAgent === agent.name,
    }));
    return isAttentionOrder ? sortAgentsByAttention(rows, filterState.sortDirection) : rows;
  }, [
    filteredAgents,
    chatStates,
    config?.agents?.defaultAgent,
    isAttentionOrder,
    filterState.sortDirection,
  ]);

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

  // Stable row-action handlers — only recreated when a callback changes
  const callbacks = useMemo(
    () => ({
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
        <FilterBar.Sort options={agentSortMenuOptions} defaultField={ATTENTION_SORT_FIELD} />
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
            <AgentFleetTable rows={tableData} grouped={isAttentionOrder} callbacks={callbacks} />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
