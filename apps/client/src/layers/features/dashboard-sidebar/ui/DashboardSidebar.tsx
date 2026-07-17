import { useState, useEffect, useMemo, useCallback, useRef, type ReactNode } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  FolderGit2,
  LayoutDashboard,
  Plus,
  Search,
  Store,
  Users,
  Zap,
} from 'lucide-react';
import {
  SidebarHeader,
  SidebarContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarGroup,
  Kbd,
} from '@/layers/shared/ui';
import { useAppStore, useTransport, useAgentCreationStore } from '@/layers/shared/model';
import { cn, formatShortcutKey, getAgentDisplayName, SHORTCUTS } from '@/layers/shared/lib';
import { toast } from 'sonner';
import { useResolvedAgents } from '@/layers/entities/agent';
import {
  useConfig,
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  createGroup,
  moveToGroup,
} from '@/layers/entities/config';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useAgentSessions, useRenameSession, useRecentSessions } from '@/layers/entities/session';
import type { Session } from '@dorkos/shared/types';
import { PromoSlot } from '@/layers/features/feature-promos';
import { useAgentHubStore } from '@/layers/features/agent-hub';
import { AgentListItem } from './AgentListItem';
import { AgentOnboardingCard } from './AgentOnboardingCard';
import { RecentSessionsSection } from './RecentSessionsSection';
import { PinnedSection } from './PinnedSection';
import { AgentGroupSection } from './AgentGroupSection';
import { UngroupedSection } from './UngroupedSection';
import { GroupCreateInput } from './GroupCreateInput';
import { sortAgentPaths } from '../model/sort-agents';

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
  const setGlobalPaletteOpen = useAppStore((s) => s.setGlobalPaletteOpen);
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

  // ── Disambiguate duplicate display names (e.g. two "server" dirs) ──
  const displayNames = useMemo(() => {
    const result = new Map<string, string>();
    const nameGroups = new Map<string, string[]>();

    for (const p of rawPaths) {
      const base = getAgentDisplayName(agents?.[p], p.split('/').pop() ?? 'Agent');
      const group = nameGroups.get(base) ?? [];
      group.push(p);
      nameGroups.set(base, group);
    }

    for (const [base, paths] of nameGroups) {
      if (paths.length === 1) {
        result.set(paths[0], base);
        continue;
      }
      // Walk up from the end of each path until a differentiating segment is found.
      const splitPaths = paths.map((p) => p.split('/').filter(Boolean));
      for (const [i, p] of paths.entries()) {
        const segments = splitPaths[i];
        let suffix = '';
        for (let offset = 2; offset < segments.length; offset++) {
          const candidate = segments[segments.length - offset];
          const isUnique = splitPaths.every(
            (other, j) =>
              j === i || other.length < offset || other[other.length - offset] !== candidate
          );
          if (isUnique) {
            suffix = candidate;
            break;
          }
        }
        result.set(p, suffix ? `${base} (${suffix})` : base);
      }
    }

    return result;
  }, [rawPaths, agents]);

  const displayNamesRecord = useMemo(() => Object.fromEntries(displayNames), [displayNames]);
  const sortCtx = useMemo(
    () => ({ displayNames: displayNamesRecord, agentActivity }),
    [displayNamesRecord, agentActivity]
  );

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

  const ungroupedPaths = useMemo(
    () =>
      sortAgentPaths(
        rawPaths.filter((p) => !groupedSet.has(p)),
        sidebarPrefs.ungroupedSortMode,
        sortCtx
      ),
    [rawPaths, groupedSet, sidebarPrefs.ungroupedSortMode, sortCtx]
  );

  const agentCount = rawPaths.length;
  const organized = sidebarPrefs.groups.length > 0 || pinnedPaths.length > 0;
  const showRecent = agentCount >= 2 && (recentQuery.isLoading || recentSessions.length > 0);

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
      navigate({
        to: '/session',
        search: { dir: session.cwd ?? undefined, session: session.id },
      });
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
        <AgentListItem
          key={`${keyPrefix}-${path}`}
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
        />
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
      <SidebarHeader className="border-b p-3">
        <SidebarMenu>
          <NavButton
            icon={LayoutDashboard}
            label="Dashboard"
            isActive={pathname === '/'}
            onClick={() => navigate({ to: '/' })}
          />
          <NavButton
            icon={Activity}
            label="Activity"
            isActive={pathname === '/activity'}
            onClick={() => navigate({ to: '/activity' })}
          />
          <NavButton
            icon={Users}
            label="Agents"
            isActive={pathname === '/agents'}
            onClick={() => navigate({ to: '/agents' })}
          />
          <NavButton
            icon={Zap}
            label="Tasks"
            isActive={pathname === '/tasks'}
            onClick={() => navigate({ to: '/tasks' })}
          />
          <NavButton
            icon={FolderGit2}
            label="Workspaces"
            isActive={pathname === '/workspaces'}
            onClick={() => navigate({ to: '/workspaces' })}
          />
          <NavButton
            icon={Store}
            label="Marketplace"
            isActive={pathname === '/marketplace' || pathname.startsWith('/marketplace/')}
            onClick={() => navigate({ to: '/marketplace' })}
          />
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => setGlobalPaletteOpen(true)}
              className="group text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center justify-between gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"
            >
              <span className="flex items-center gap-1.5">
                <Search className="size-(--size-icon-sm)" />
                Search
              </span>
              <Kbd className="shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                {formatShortcutKey(SHORTCUTS.COMMAND_PALETTE)}
              </Kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="p-3">
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

        {pinnedPaths.length > 0 && <PinnedSection paths={pinnedPaths} renderRow={renderAgentRow} />}

        {sidebarPrefs.groups.map((group) => (
          <AgentGroupSection
            key={group.id}
            group={group}
            memberPaths={knownGroupMembers.get(group.id) ?? []}
            sortCtx={sortCtx}
            renderRow={renderAgentRow}
          />
        ))}

        {groupCreation !== null && (
          <SidebarGroup>
            <SidebarMenu>
              <GroupCreateInput onCommit={handleCommitNewGroup} onCancel={handleCancelNewGroup} />
            </SidebarMenu>
          </SidebarGroup>
        )}

        <UngroupedSection
          paths={ungroupedPaths}
          organized={organized}
          renderRow={renderAgentRow}
          onNewGroup={() => handleRequestNewGroup()}
        />

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

// ── Private helper ──

function NavButton({
  icon: Icon,
  label,
  isActive,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        onClick={onClick}
        className={cn(
          'relative flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium',
          isActive &&
            'before:bg-primary before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full'
        )}
      >
        <Icon
          className={cn(
            'size-(--size-icon-sm) transition-colors duration-150',
            !isActive &&
              'text-muted-foreground group-hover/menu-item:text-sidebar-accent-foreground'
          )}
        />
        {label}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
