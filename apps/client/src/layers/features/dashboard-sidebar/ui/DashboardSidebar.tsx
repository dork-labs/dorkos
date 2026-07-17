import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
  SidebarGroupLabel,
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
  pinPath,
  unpinPath,
} from '@/layers/entities/config';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useAgentSessions, useRenameSession } from '@/layers/entities/session';
import type { Session } from '@dorkos/shared/types';
import { PromoSlot } from '@/layers/features/feature-promos';
import { useAgentHubStore } from '@/layers/features/agent-hub';
import { AgentListItem } from './AgentListItem';
import { AddAgentMenu } from './AddAgentMenu';
import { AgentOnboardingCard } from './AgentOnboardingCard';

/**
 * Legacy localStorage key that held pinned agent paths before organization moved
 * to server config (DOR-329). Its presence is the one-time migration flag.
 */
const LEGACY_PINNED_STORAGE_KEY = 'dorkos-pinned-agents';

/**
 * Unified dashboard sidebar — top-level navigation and expandable agent list.
 *
 * The dashboard sidebar is the primary sidebar that persists across all routes.
 * Agents are sourced from the mesh registry (full roster, no cap), sorted
 * alphabetically by display name (falling back to the directory name), and
 * split into a Pinned section and an All section.
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

  // ── Full mesh roster (unsorted; display-name sort is derived below) ──
  const { data: meshData } = useMeshAgentPaths();

  const rawPaths = useMemo(() => (meshData?.agents ?? []).map((a) => a.projectPath), [meshData]);

  const { data: agents } = useResolvedAgents(rawPaths);

  // ── Disambiguate duplicate display names (e.g. two "server" dirs) ──
  const displayNames = useMemo(() => {
    const result = new Map<string, string>();
    const nameGroups = new Map<string, string[]>();

    // Group paths by their base display name
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
      // Walk up from the end of each path until we find a differentiating segment.
      // Paths may have different lengths, so compare by offset from the end.
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

  // ── Roster sorted alphabetically by resolved display name ──
  // getAgentDisplayName resolves displayName → name → directory name, so agents
  // without a custom name fall back to sorting by their directory name. Sorting
  // by the disambiguated label keeps the order consistent with what's rendered.
  const allPaths = useMemo(() => {
    return [...rawPaths].sort((a, b) => {
      const nameA = (displayNames.get(a) ?? '').toLowerCase();
      const nameB = (displayNames.get(b) ?? '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }, [rawPaths, displayNames]);

  // ── Pinned paths filtered to those that exist in the full roster ──
  const pinnedPaths = useMemo(() => {
    const pathSet = new Set(allPaths);
    return pinnedAgentPaths.filter((p) => pathSet.has(p));
  }, [pinnedAgentPaths, allPaths]);

  // ── Unpinned paths — agents not in the pinned section ──
  const unpinnedPaths = useMemo(() => {
    const pinnedSet = new Set(pinnedPaths);
    return allPaths.filter((p) => !pinnedSet.has(p));
  }, [allPaths, pinnedPaths]);

  // ── One-time migration of legacy localStorage pins → server config (DOR-329) ──
  // Runs once after config loads. If the old `dorkos-pinned-agents` key exists
  // and the server has no pins yet, seed the server pins from it (order
  // preserved); server state wins when it already has pins. The key's presence
  // IS the migration flag — it is removed afterward either way, so re-mounts and
  // reloads are no-ops.
  const pinMigrationDoneRef = useRef(false);
  useEffect(() => {
    if (pinMigrationDoneRef.current) return;
    // Wait for the real server config before deciding "server has no pins".
    if (config === undefined) return;
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

  // ── Handlers ──
  const handleSelectAgent = useCallback(
    (agentPath: string) => {
      // Include a session ID so the URL always has ?session=, which ensures
      // ChatPanel's focus effect fires on every agent switch.  Mirror the
      // sessionRouteLoader logic: reuse the most-recent cached session for the
      // target agent, or generate a fresh UUID.
      const cached = queryClient.getQueryData<Session[]>(['sessions', agentPath]);
      const sessionId = cached?.[0]?.id ?? crypto.randomUUID();
      navigate({ to: '/session', search: { dir: agentPath, session: sessionId } });
    },
    [navigate, queryClient]
  );

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      navigate({
        to: '/session',
        search: (prev) => ({ ...prev, session: sessionId }),
      });
    },
    [navigate]
  );

  const handleNewSession = useCallback(() => {
    navigate({
      to: '/session',
      search: { dir: selectedCwd ?? undefined, session: crypto.randomUUID() },
    });
  }, [navigate, selectedCwd]);

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPath((prev) => (prev === path ? null : path));
  }, []);

  const handleTogglePin = useCallback(
    (path: string) => {
      if (pinnedAgentPaths.includes(path)) {
        updateSidebarPrefs((prev) => unpinPath(prev, path));
      } else {
        updateSidebarPrefs((prev) => pinPath(prev, path));
      }
    },
    [pinnedAgentPaths, updateSidebarPrefs]
  );

  /** Open the Agent Hub right panel for a given agent path. */
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
        <SidebarGroup>
          <SidebarGroupLabel className="text-muted-foreground/70 text-[10px] font-medium tracking-wider uppercase">
            Agents
          </SidebarGroupLabel>
          <AddAgentMenu />

          {/* Pinned section — only if pins exist */}
          {pinnedPaths.length > 0 && (
            <>
              <SidebarGroupLabel className="text-muted-foreground/50 mt-1 text-[9px] font-medium tracking-wider uppercase">
                Pinned
              </SidebarGroupLabel>
              <SidebarMenu>
                {pinnedPaths.map((path) => {
                  const isActive = selectedCwd === path && pathname === '/session';
                  return (
                    <AgentListItem
                      key={`pinned-${path}`}
                      path={path}
                      agent={agents?.[path] ?? null}
                      displayName={displayNames.get(path)}
                      isActive={isActive}
                      isExpanded={expandedPath === path}
                      isPinned={true}
                      onSelect={() => handleSelectAgent(path)}
                      onToggleExpand={() => handleToggleExpand(path)}
                      onTogglePin={() => handleTogglePin(path)}
                      onOpenProfile={() => handleOpenProfile(path)}
                      sessions={isActive ? previewSessions : []}
                      isLoadingSessions={isActive && sessionsLoading}
                      activeSessionId={activeSessionId}
                      onSessionClick={handleSessionClick}
                      onNewSession={handleNewSession}
                      onForkSession={handleForkSession}
                      onRenameSession={handleRenameSession}
                    />
                  );
                })}
              </SidebarMenu>
            </>
          )}

          {/* Unpinned agents — only shown when there are pinned agents to separate from */}
          {pinnedPaths.length > 0 && unpinnedPaths.length > 0 && (
            <SidebarGroupLabel className="text-muted-foreground/50 mt-3 text-[9px] font-medium tracking-wider uppercase">
              Other
            </SidebarGroupLabel>
          )}
          <SidebarMenu>
            {(pinnedPaths.length > 0 ? unpinnedPaths : allPaths).map((path) => {
              const isActive = selectedCwd === path && pathname === '/session';
              return (
                <AgentListItem
                  key={path}
                  path={path}
                  agent={agents?.[path] ?? null}
                  displayName={displayNames.get(path)}
                  isActive={isActive}
                  isExpanded={expandedPath === path}
                  isPinned={pinnedAgentPaths.includes(path)}
                  onSelect={() => handleSelectAgent(path)}
                  onToggleExpand={() => handleToggleExpand(path)}
                  onTogglePin={() => handleTogglePin(path)}
                  onOpenProfile={() => handleOpenProfile(path)}
                  sessions={isActive ? previewSessions : []}
                  isLoadingSessions={isActive && sessionsLoading}
                  activeSessionId={activeSessionId}
                  onSessionClick={handleSessionClick}
                  onNewSession={handleNewSession}
                  onForkSession={handleForkSession}
                  onRenameSession={handleRenameSession}
                />
              );
            })}
          </SidebarMenu>

          {/* Progressive empty state — less prominent as the roster grows */}
          {allPaths.length <= 2 && (
            <AgentOnboardingCard onAddAgent={() => useAgentCreationStore.getState().open()} />
          )}
          {allPaths.length >= 3 && allPaths.length <= 4 && (
            <button
              type="button"
              onClick={() => useAgentCreationStore.getState().open()}
              className="text-muted-foreground hover:text-foreground mt-1 flex items-center gap-1.5 px-2 text-xs font-medium transition-colors"
            >
              <Plus className="size-3.5" />
              Add agent
            </button>
          )}
          {/* 5+ agents: no prompt — the + button in the header is sufficient */}
        </SidebarGroup>
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
