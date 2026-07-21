import { useState, useEffect, useMemo, useCallback, useRef, type ReactNode } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { Plus } from 'lucide-react';
import { SidebarContent, SidebarGroup, SidebarMenu } from '@/layers/shared/ui';
import { useAppStore, useTransport, useAgentCreationStore } from '@/layers/shared/model';
import { toast } from 'sonner';
import { useResolvedAgents } from '@/layers/entities/agent';
import {
  useConfig,
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  createGroup,
  moveToGroup,
  setGroupsHintDismissed,
} from '@/layers/entities/config';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import {
  useAgentSessions,
  useRenameSession,
  useRecentSessions,
  useAgentAttentionMap,
} from '@/layers/entities/session';
import type { Session } from '@dorkos/shared/types';
import { PromoSlot } from '@/layers/features/feature-promos';
import { useAgentHubStore } from '@/layers/features/agent-hub';
import { AgentListItem } from './AgentListItem';
import { AgentOnboardingCard } from './AgentOnboardingCard';
import { SidebarNavHeader } from './SidebarNavHeader';
import { RecentSessionsSection } from './RecentSessionsSection';
import { PinnedSection } from './PinnedSection';
import { AgentGroupSection } from './AgentGroupSection';
import { UngroupedSection } from './UngroupedSection';
import { GroupCreateInput } from './GroupCreateInput';
import { GroupsHintCard } from './GroupsHintCard';
import { SidebarDnd } from './dnd/SidebarDnd';
import { Sortable, SortableList, agentRowDndId, agentDndData } from './dnd/SidebarDndPrimitives';
import { disambiguateDisplayNames } from '../model/disambiguate-display-names';

/**
 * Legacy localStorage key that held pinned agent paths before organization moved
 * to server config (DOR-329). Its presence is the one-time migration flag.
 */
const LEGACY_PINNED_STORAGE_KEY = 'dorkos-pinned-agents';

/** Pending group-create flow: `pendingPath` (if set) is moved into the group on commit. */
interface GroupCreationState {
  pendingPath: string | null;
}

/**
 * Unified dashboard sidebar — top-level navigation plus the organized agent
 * roster (DOR-329): Recent sessions, Pinned references, user-defined groups, and
 * the ungrouped "Agents" list, with progressive disclosure so a small unorganized
 * fleet stays as clean as before.
 *
 * This component is a slim orchestrator: it wires data (roster, sidebar prefs,
 * recent sessions), computes membership maps, and composes the section
 * components. Section chrome, sorting, and CRUD live in those children.
 */
export function DashboardSidebar() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const queryClient = useQueryClient();
  const transport = useTransport();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const setActiveRightPanelTab = useAppStore((s) => s.setActiveRightPanelTab);

  // ── Server-persisted sidebar organization (DOR-329) ──
  const { data: config } = useConfig();
  const sidebarPrefs = useSidebarPrefs();
  const { update: updateSidebarPrefs } = useUpdateSidebarPrefs();
  const pinnedAgentPaths = sidebarPrefs.pinned;

  // ── Full mesh roster (unsorted; per-section sorting is derived below) ──
  const { data: meshData } = useMeshAgentPaths();
  const rawPaths = useMemo(() => (meshData?.agents ?? []).map((a) => a.projectPath), [meshData]);
  const { data: agents } = useResolvedAgents(rawPaths);

  // ── Cross-agent recent sessions + per-agent activity (drives the "recent" sort) ──
  const recentQuery = useRecentSessions();
  const recentSessions = useMemo(() => recentQuery.data?.sessions ?? [], [recentQuery.data]);
  const agentActivity = useMemo(() => recentQuery.data?.agentActivity ?? {}, [recentQuery.data]);

  // ── Display names (duplicates disambiguated) + the per-section sort context ──
  const displayNamesRecord = useMemo(
    () => disambiguateDisplayNames(rawPaths, agents ?? {}),
    [rawPaths, agents]
  );
  const sortCtx = useMemo(
    () => ({ displayNames: displayNamesRecord, agentActivity }),
    [displayNamesRecord, agentActivity]
  );

  // ── Attention + mute (DOR-339): one attention-map subscription for the whole
  // sidebar, and the individually-muted path set every section's filter and
  // every row's rendering reads. ──
  const attentionMap = useAgentAttentionMap(rawPaths);
  const mutedPathsSet = useMemo(() => new Set(sidebarPrefs.muted), [sidebarPrefs.muted]);

  // ── Membership maps (stale paths filtered at render, never pruned on write) ──
  const knownSet = useMemo(() => new Set(rawPaths), [rawPaths]);

  const pinnedPaths = useMemo(
    () => pinnedAgentPaths.filter((p) => knownSet.has(p)),
    [pinnedAgentPaths, knownSet]
  );

  const groupedSet = useMemo(() => {
    const set = new Set<string>();
    for (const g of sidebarPrefs.groups) {
      for (const p of g.agentPaths) if (knownSet.has(p)) set.add(p);
    }
    return set;
  }, [sidebarPrefs.groups, knownSet]);

  const knownGroupMembers = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const g of sidebarPrefs.groups) {
      map.set(
        g.id,
        g.agentPaths.filter((p) => knownSet.has(p))
      );
    }
    return map;
  }, [sidebarPrefs.groups, knownSet]);

  // Pre-filter/pre-sort — UngroupedSection filters then sorts internally,
  // same order of operations as a group section (spec: sorting applies after
  // filtering).
  const ungroupedRawPaths = useMemo(
    () => rawPaths.filter((p) => !groupedSet.has(p)),
    [rawPaths, groupedSet]
  );

  const agentCount = rawPaths.length;
  const organized = sidebarPrefs.groups.length > 0 || pinnedPaths.length > 0;
  const showRecent = agentCount >= 2 && (recentQuery.isLoading || recentSessions.length > 0);
  // Discovery nudge: only for a fleet big enough to benefit, with no groups yet,
  // and never again once dismissed (Resolved Q — organization is user investment).
  const showGroupsHint =
    agentCount >= 8 && sidebarPrefs.groups.length === 0 && !sidebarPrefs.groupsHintDismissed;

  // ── One-time migration of legacy localStorage pins → server config (DOR-329) ──
  // If the old `dorkos-pinned-agents` key exists and the server has no pins yet,
  // seed the server pins from it (order preserved); server state wins when it
  // already has pins. The key's presence IS the migration flag — it is removed
  // afterward either way, so re-mounts and reloads are no-ops.
  const pinMigrationDoneRef = useRef(false);
  useEffect(() => {
    if (pinMigrationDoneRef.current) return;
    if (config === undefined) return; // wait for real server config
    const raw = localStorage.getItem(LEGACY_PINNED_STORAGE_KEY);
    if (raw === null) {
      pinMigrationDoneRef.current = true;
      return;
    }
    pinMigrationDoneRef.current = true;
    let stored: string[] = [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) stored = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      stored = [];
    }
    if (pinnedAgentPaths.length === 0 && stored.length > 0) {
      updateSidebarPrefs((prev) => ({ ...prev, pinned: [...stored] }));
    }
    localStorage.removeItem(LEGACY_PINNED_STORAGE_KEY);
  }, [config, pinnedAgentPaths.length, updateSidebarPrefs]);

  // ── Sessions for the active agent (canonical cwd-scoped selector, DOR-203) ──
  const {
    sessions: agentSessions,
    activeSessionId,
    isLoading: sessionsLoading,
  } = useAgentSessions(selectedCwd);
  const previewSessions = useMemo(() => agentSessions.slice(0, 3), [agentSessions]);

  // ── Expanded agent tracking — auto-expand active agent ──
  const [expandedPath, setExpandedPath] = useState<string | null>(selectedCwd);
  useEffect(() => {
    setExpandedPath(selectedCwd);
  }, [selectedCwd]);

  // ── Inline group-create flow ──
  const [groupCreation, setGroupCreation] = useState<GroupCreationState | null>(null);
  const handleRequestNewGroup = useCallback((path?: string) => {
    setGroupCreation({ pendingPath: path ?? null });
  }, []);
  const handleCommitNewGroup = useCallback(
    (name: string) => {
      const pending = groupCreation?.pendingPath ?? null;
      updateSidebarPrefs((prev) => {
        const { next, id } = createGroup(prev, name);
        return pending ? moveToGroup(next, pending, id) : next;
      });
      setGroupCreation(null);
    },
    [groupCreation, updateSidebarPrefs]
  );
  const handleCancelNewGroup = useCallback(() => setGroupCreation(null), []);
  const handleDismissGroupsHint = useCallback(
    () => updateSidebarPrefs((prev) => setGroupsHintDismissed(prev, true)),
    [updateSidebarPrefs]
  );

  // ── Handlers ──
  const handleSelectAgent = useCallback(
    (agentPath: string) => {
      // Include a session ID so the URL always has ?session=, ensuring ChatPanel's
      // focus effect fires on every agent switch. Reuse the most-recent cached
      // session for the target agent, or generate a fresh UUID.
      const cached = queryClient.getQueryData<Session[]>(['sessions', agentPath]);
      const sessionId = cached?.[0]?.id ?? crypto.randomUUID();
      navigate({ to: '/session', search: { dir: agentPath, session: sessionId } });
    },
    [navigate, queryClient]
  );

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      navigate({ to: '/session', search: (prev) => ({ ...prev, session: sessionId }) });
    },
    [navigate]
  );

  const handleResumeRecentSession = useCallback(
    (session: Session) => {
      navigate({ to: '/session', search: { dir: session.cwd ?? undefined, session: session.id } });
    },
    [navigate]
  );

  const handleNewSession = useCallback(
    (dir?: string) => {
      navigate({
        to: '/session',
        search: { dir: dir ?? selectedCwd ?? undefined, session: crypto.randomUUID() },
      });
    },
    [navigate, selectedCwd]
  );

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPath((prev) => (prev === path ? null : path));
  }, []);

  const handleOpenProfile = useCallback(
    (path: string) => {
      useAgentHubStore.getState().openHub(path);
      setRightPanelOpen(true);
      setActiveRightPanelTab('agent-hub');
    },
    [setRightPanelOpen, setActiveRightPanelTab]
  );

  const handleForkSession = useCallback(
    async (sessionId: string) => {
      try {
        const forked = await transport.forkSession(sessionId, undefined, selectedCwd ?? undefined);
        await queryClient.invalidateQueries({ queryKey: ['sessions'] });
        navigate({ to: '/session', search: (prev) => ({ ...prev, session: forked.id }) });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to fork session');
      }
    },
    [transport, selectedCwd, queryClient, navigate]
  );

  const renameSession = useRenameSession(selectedCwd);
  const handleRenameSession = useCallback(
    (sessionId: string, title: string) => {
      renameSession.mutate({ sessionId, title });
    },
    [renameSession]
  );

  // ── Shared agent-row renderer (keeps section components lean; keyPrefix lets a
  // pinned reference coexist with its home copy) ──
  const renderAgentRow = useCallback(
    (path: string, keyPrefix: string): ReactNode => {
      const isActive = selectedCwd === path && pathname === '/session';
      return (
        <Sortable
          key={`${keyPrefix}-${path}`}
          id={agentRowDndId(keyPrefix, path)}
          data={agentDndData(keyPrefix, path)}
        >
          {(bindings) => (
            <AgentListItem
              path={path}
              agent={agents?.[path] ?? null}
              displayName={displayNamesRecord[path]}
              isActive={isActive}
              isExpanded={expandedPath === path}
              onSelect={() => handleSelectAgent(path)}
              onToggleExpand={() => handleToggleExpand(path)}
              onOpenProfile={() => handleOpenProfile(path)}
              onRequestNewGroup={handleRequestNewGroup}
              sessions={isActive ? previewSessions : []}
              isLoadingSessions={isActive && sessionsLoading}
              activeSessionId={activeSessionId}
              onSessionClick={handleSessionClick}
              onNewSession={() => handleNewSession(path)}
              onForkSession={handleForkSession}
              onRenameSession={handleRenameSession}
              sortable={bindings}
            />
          )}
        </Sortable>
      );
    },
    [
      selectedCwd,
      pathname,
      agents,
      displayNamesRecord,
      expandedPath,
      previewSessions,
      sessionsLoading,
      activeSessionId,
      handleSelectAgent,
      handleToggleExpand,
      handleOpenProfile,
      handleRequestNewGroup,
      handleSessionClick,
      handleNewSession,
      handleForkSession,
      handleRenameSession,
    ]
  );

  return (
    <>
      <SidebarNavHeader />

      <SidebarContent className="p-3">
        <SidebarDnd displayNames={displayNamesRecord}>
          {showRecent && (
            <RecentSessionsSection
              sessions={recentSessions}
              isLoading={recentQuery.isLoading}
              warnings={recentQuery.data?.warnings}
              agents={agents ?? {}}
              displayNames={displayNamesRecord}
              onSelectSession={handleResumeRecentSession}
            />
          )}

          {pinnedPaths.length > 0 && (
            <PinnedSection paths={pinnedPaths} renderRow={renderAgentRow} />
          )}

          <SortableList items={sidebarPrefs.groups.map((g) => `group-header::${g.id}`)}>
            <AnimatePresence initial={false}>
              {sidebarPrefs.groups.map((group) => (
                <motion.div
                  key={group.id}
                  initial={{ opacity: 0, y: -6 }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    transition: { duration: 0.2, ease: [0, 0, 0.2, 1] },
                  }}
                  exit={{ opacity: 0, y: -6, transition: { duration: 0.15 } }}
                >
                  <AgentGroupSection
                    group={group}
                    memberPaths={knownGroupMembers.get(group.id) ?? []}
                    sortCtx={sortCtx}
                    attention={attentionMap}
                    mutedPaths={mutedPathsSet}
                    renderRow={renderAgentRow}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </SortableList>

          <AnimatePresence>
            {groupCreation !== null && (
              <motion.div
                key="group-create"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0, 0, 0.2, 1] } }}
                exit={{ opacity: 0, y: -6, transition: { duration: 0.15 } }}
              >
                <SidebarGroup>
                  <SidebarMenu>
                    <GroupCreateInput
                      onCommit={handleCommitNewGroup}
                      onCancel={handleCancelNewGroup}
                    />
                  </SidebarMenu>
                </SidebarGroup>
              </motion.div>
            )}
          </AnimatePresence>

          <UngroupedSection
            paths={ungroupedRawPaths}
            organized={organized}
            sortMode={sidebarPrefs.ungroupedSortMode}
            filter={sidebarPrefs.ungroupedDisplayFilter}
            sortCtx={sortCtx}
            attention={attentionMap}
            mutedPaths={mutedPathsSet}
            renderRow={renderAgentRow}
            onNewGroup={() => handleRequestNewGroup()}
          />
        </SidebarDnd>

        <AnimatePresence>
          {showGroupsHint && (
            <GroupsHintCard
              onNewGroup={() => handleRequestNewGroup()}
              onDismiss={handleDismissGroupsHint}
            />
          )}
        </AnimatePresence>

        {/* Progressive empty state — less prominent as the roster grows */}
        {agentCount <= 2 && (
          <AgentOnboardingCard onAddAgent={() => useAgentCreationStore.getState().open()} />
        )}
        {agentCount >= 3 && agentCount <= 4 && (
          <button
            type="button"
            onClick={() => useAgentCreationStore.getState().open()}
            className="text-muted-foreground hover:text-foreground mt-1 flex items-center gap-1.5 px-2 text-xs font-medium transition-colors"
          >
            <Plus className="size-3.5" />
            Add agent
          </button>
        )}

        <PromoSlot placement="dashboard-sidebar" maxUnits={3} />
      </SidebarContent>
    </>
  );
}
