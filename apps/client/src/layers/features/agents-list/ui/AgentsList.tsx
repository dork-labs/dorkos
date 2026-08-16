import { useMemo, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { TopologyAgent } from '@dorkos/shared/mesh-schemas';
import { useMeshMemberIds } from '@/layers/entities/mesh';
import { useAgentAttentionMap } from '@/layers/entities/session';
import {
  findTeamOwner,
  teamMemberLabel,
  useTeamRoster,
  type TeamRosterFilters,
} from '@/layers/entities/team';
import { applySortAndFilter } from '@/layers/shared/lib';
import { useFilterState, useProfileDeepLink, useTransport } from '@/layers/shared/model';
import { FilterBar } from '@/layers/shared/ui/filter-bar';
import { ScrollArea } from '@/layers/shared/ui/scroll-area';
import { Skeleton } from '@/layers/shared/ui/skeleton';
import { useProfileStore } from '@/layers/features/profile';
import {
  agentFilterSchema,
  agentSortMenuOptions,
  agentSortOptions,
  ATTENTION_SORT_FIELD,
} from '../lib/agent-filter-schema';
import { isPastOnboardingGrace, sortAgentsByAttention } from '../lib/agent-attention';
import { narrowAgentsByRoster } from '../lib/roster-narrowing';
import type { AgentTableRow } from '../lib/agent-columns';
import { AgentEmptyFilterState, AgentRosterFilterEmpty } from './AgentEmptyFilterState';
import { AgentFleetTable } from './AgentFleetTable';

interface AgentsListProps {
  agents: TopologyAgent[];
  isLoading: boolean;
  /**
   * What the Team page's roster controls say, when a route is driving them.
   *
   * The table is one of `/team`'s views, so `?kind=`, `?owner=` and `?q=` have
   * to narrow it exactly as they narrow the cards. Optional because the dev
   * playground renders this list with no route behind it.
   */
  rosterFilters?: TeamRosterFilters;
}

/**
 * Agent fleet surface — filter bar plus the fleet table.
 *
 * The default order is attention, not inventory: rows group into needs you /
 * working / quiet so the page's first row answers "who needs me". Picking any
 * field from the sort menu flattens the groups and sorts purely by that field —
 * the grouping is the default answer, not a cage.
 */
export function AgentsList({ agents, isLoading, rosterFilters }: AgentsListProps) {
  const navigate = useNavigate();
  const transport = useTransport();
  const { open: openProfile } = useProfileDeepLink();
  // The table knows an agent by its DIRECTORY; the profile is addressed by the
  // id the mesh registered, so the row action needs the same join the sidebar's
  // faces use (`SidebarChrome.viewProfileFor`).
  const memberIdByPath = useMeshMemberIds();

  const filterState = useFilterState(agentFilterSchema, {
    debounce: { search: 200 },
  });

  // The roster is read once, for two jobs: narrowing the fleet to what the Team
  // page's controls admit, and naming each agent's owner in the Managed by cell.
  const { data: rosterData } = useTeamRoster();
  const rosterMembers = useMemo(() => rosterData?.members ?? [], [rosterData]);

  // The Team page's filters narrow the population BEFORE this table's own
  // filter bar runs, so "showing 2 of 3" counts what the roster admitted rather
  // than a fleet the URL already excluded.
  const rosterAgents = useMemo(
    () => narrowAgentsByRoster(agents, rosterMembers, rosterFilters),
    [agents, rosterMembers, rosterFilters]
  );

  // Derive dynamic namespace options from the agent list
  const namespaceOptions = useMemo(
    () => [
      ...new Set(rosterAgents.map((a) => a.namespace).filter((ns): ns is string => Boolean(ns))),
    ],
    [rosterAgents]
  );

  // No `sort` param means attention order, so a first visit lands on it.
  const isAttentionOrder = !filterState.sortField || filterState.sortField === ATTENTION_SORT_FIELD;

  // Filter first. Attention order is applied after enrichment below, because it
  // reads the chat state and registration age that only the enriched row carries.
  const filteredAgents = useMemo(
    () =>
      isAttentionOrder
        ? agentFilterSchema.applyFilters(rosterAgents, filterState.values)
        : applySortAndFilter(
            rosterAgents,
            agentFilterSchema,
            filterState.values,
            agentSortOptions,
            {
              field: filterState.sortField,
              direction: filterState.sortDirection,
            }
          ),
    [
      rosterAgents,
      isAttentionOrder,
      filterState.values,
      filterState.sortField,
      filterState.sortDirection,
    ]
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

  // Who each agent belongs to, keyed by the manifest id both sides carry.
  //
  // The roster is the one place that knows: the mesh describes a fleet, and
  // ownership is derived at read time from the `authors` table beside it
  // (spec §W1.6). Resolved here rather than in a cell so the table is handed a
  // label, the same way the Team card is.
  const ownerLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const member of rosterMembers) {
      if (member.kind !== 'agent') continue;
      const owner = findTeamOwner(member, rosterMembers);
      if (owner) labels.set(member.id, teamMemberLabel(owner));
    }
    return labels;
  }, [rosterMembers]);

  // Enrich topology agents with computed fields, then apply attention order
  const tableData: AgentTableRow[] = useMemo(() => {
    const rows = filteredAgents.map((agent) => ({
      ...agent,
      // An agent with no project folder can hold no chats at all — exact-cwd
      // membership (DOR-203) has nothing to match — which is what 'fresh' means.
      chatState: (agent.projectPath ? chatStates[agent.projectPath] : undefined) ?? 'fresh',
      isPastOnboardingGrace: isPastOnboardingGrace(agent.registeredAt),
      isDefault: config?.agents?.defaultAgent === agent.name,
      managedBy: ownerLabels.get(agent.id) ?? null,
    }));
    return isAttentionOrder ? sortAgentsByAttention(rows, filterState.sortDirection) : rows;
  }, [
    filteredAgents,
    chatStates,
    config?.agents?.defaultAgent,
    ownerLabels,
    isAttentionOrder,
    filterState.sortDirection,
  ]);

  // One profile, one address (spec `profile-unification` §1.6): the docked panel
  // belongs to `/session`, and everywhere else the profile is the sheet at
  // `?profile=<id>`. This table is one of `/team`'s views, so its row action
  // opens exactly what the same page's cards open — a table that docked instead
  // gave one page two answers.
  //
  // The fallback is `SidebarChrome.viewProfileFor`'s, and so is its honesty:
  // with no roster id there is no sheet to address, so the panel opens on the
  // directory the row always has. **It will not draw a profile** — `ProfileDock`
  // resolves the identity through that same map and settles on `AgentNotFound`,
  // naming the directory that went dead. That is the whole of what it buys: a
  // panel that opens and says the agent is gone, rather than a dead control.
  const handleViewProfile = useCallback(
    (projectPath: string) => {
      const memberId = memberIdByPath.get(projectPath);
      if (memberId === undefined) {
        useProfileStore.getState().openProfileDocked(projectPath);
        return;
      }
      openProfile(memberId);
    },
    [memberIdByPath, openProfile]
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
      onViewProfile: handleViewProfile,
      onStartSession: handleStartSession,
    }),
    [handleNavigate, handleViewProfile, handleStartSession]
  );

  /**
   * The table, or whichever empty state is true.
   *
   * Which one depends on WHO emptied it: the Team page's roster filters and
   * this table's own filter bar need different words, because they have
   * different ways out.
   */
  function renderBody() {
    if (rosterAgents.length === 0 && agents.length > 0) {
      return <AgentRosterFilterEmpty peopleOnly={rosterFilters?.kind === 'people'} />;
    }
    if (filteredAgents.length === 0 && rosterAgents.length > 0) {
      return (
        <AgentEmptyFilterState
          onClearFilters={filterState.clearAll}
          filterDescription={filterState.describeActive()}
        />
      );
    }
    return <AgentFleetTable rows={tableData} grouped={isAttentionOrder} callbacks={callbacks} />;
  }

  if (isLoading) {
    return (
      <div className="space-y-3 p-4 sm:px-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <FilterBar state={filterState} className="sm:px-6">
        <FilterBar.Search placeholder="Filter agents..." />
        <FilterBar.Primary name="status" />
        <FilterBar.AddFilter dynamicOptions={{ namespace: namespaceOptions }} />
        <FilterBar.Sort options={agentSortMenuOptions} defaultField={ATTENTION_SORT_FIELD} />
        {/* Counted against what the roster admitted, not the whole fleet:
            "2 of 3" beside a URL that already excluded 40 agents would be
            answering a question nobody asked. */}
        <FilterBar.ResultCount
          count={filteredAgents.length}
          total={rosterAgents.length}
          noun="agent"
        />
        <FilterBar.ActiveFilters />
      </FilterBar>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-4 pb-4 sm:px-6">{renderBody()}</div>
      </ScrollArea>
    </div>
  );
}
