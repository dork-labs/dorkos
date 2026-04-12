import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, LayoutDashboard, Plus, Search, Store, Users, Zap } from 'lucide-react';
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
import { formatShortcutKey, getAgentDisplayName, SHORTCUTS } from '@/layers/shared/lib';
import { useResolvedAgents } from '@/layers/entities/agent';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useSessions } from '@/layers/entities/session';
import type { Session } from '@dorkos/shared/types';
import { PromoSlot } from '@/layers/features/feature-promos';
import { useAgentHubStore } from '@/layers/features/agent-hub';
import { AgentListItem } from './AgentListItem';
import { AddAgentMenu } from './AddAgentMenu';
import { AgentOnboardingCard } from './AgentOnboardingCard';

/**
 * Unified dashboard sidebar — top-level navigation and expandable agent list.
 *
 * The dashboard sidebar is the primary sidebar that persists across all routes.
 * Agents are sourced from the mesh registry (full roster, no cap), sorted
 * alphabetically, and split into a Pinned section and an All section.
 */
export function DashboardSidebar() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const queryClient = useQueryClient();
  const transport = useTransport();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const setGlobalPaletteOpen = useAppStore((s) => s.setGlobalPaletteOpen);
  const setSidebarLevel = useAppStore((s) => s.setSidebarLevel);
  const pinnedAgentPaths = useAppStore((s) => s.pinnedAgentPaths);
  const pinAgent = useAppStore((s) => s.pinAgent);
  const unpinAgent = useAppStore((s) => s.unpinAgent);
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const setActiveRightPanelTab = useAppStore((s) => s.setActiveRightPanelTab);

  // ── Default agent from config ──
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });
  const defaultAgentName = config?.agents?.defaultAgent ?? 'dorkbot';
  const defaultAgentDir = config?.agents?.defaultDirectory ?? '~/.dork/agents';
  const defaultAgentPath = `${defaultAgentDir}/${defaultAgentName}`;

  // ── Full mesh roster, sorted alphabetically by last path segment ──
  const { data: meshData } = useMeshAgentPaths();

  const allPaths = useMemo(() => {
    const paths = (meshData?.agents ?? []).map((a) => a.projectPath);
    return [...paths].sort((a, b) => {
      const nameA = a.split('/').pop()?.toLowerCase() ?? '';
      const nameB = b.split('/').pop()?.toLowerCase() ?? '';
      return nameA.localeCompare(nameB);
    });
  }, [meshData]);

  // ── Pinned paths filtered to those that exist in the full roster ──
  const pinnedPaths = useMemo(() => {
    const pathSet = new Set(allPaths);
    return pinnedAgentPaths.filter((p) => pathSet.has(p));
  }, [pinnedAgentPaths, allPaths]);

  const { data: agents } = useResolvedAgents(allPaths);

  // ── Auto-pin default agent on first install (once, when no pins exist) ──
  useEffect(() => {
    if (pinnedAgentPaths.length === 0 && defaultAgentPath && allPaths.includes(defaultAgentPath)) {
      pinAgent(defaultAgentPath);
    }
  }, [pinnedAgentPaths.length, defaultAgentPath, allPaths, pinAgent]);

  // ── Disambiguate duplicate display names (e.g. two "server" dirs) ──
  const displayNames = useMemo(() => {
    const result = new Map<string, string>();
    const nameGroups = new Map<string, string[]>();

    // Group paths by their base display name
    for (const p of allPaths) {
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
  }, [allPaths, agents]);

  // ── Sessions for the active agent ──
  const { sessions, activeSessionId } = useSessions();
  const previewSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3),
    [sessions]
  );

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

  const handleDrillIntoSessions = useCallback(() => {
    setSidebarLevel('session');
  }, [setSidebarLevel]);

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPath((prev) => (prev === path ? null : path));
  }, []);

  const handleTogglePin = useCallback(
    (path: string) => {
      if (pinnedAgentPaths.includes(path)) {
        unpinAgent(path);
      } else {
        pinAgent(path);
      }
    },
    [pinnedAgentPaths, pinAgent, unpinAgent]
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
            icon={Store}
            label="Dork Hub"
            isActive={pathname === '/marketplace' || pathname.startsWith('/marketplace/')}
            onClick={() => navigate({ to: '/marketplace' })}
          />
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => setGlobalPaletteOpen(true)}
              className="group text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center justify-between gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all duration-100 active:scale-[0.98]"
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
                  const isActive = selectedCwd === path;
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
                      totalSessionCount={isActive ? sessions.length : 0}
                      activeSessionId={activeSessionId}
                      onSessionClick={handleSessionClick}
                      onNewSession={handleNewSession}
                      onDrillIntoSessions={handleDrillIntoSessions}
                    />
                  );
                })}
              </SidebarMenu>
            </>
          )}

          {/* All agents — alphabetical, with label when pinned section exists */}
          {pinnedPaths.length > 0 && (
            <SidebarGroupLabel className="text-muted-foreground/50 mt-3 text-[9px] font-medium tracking-wider uppercase">
              All
            </SidebarGroupLabel>
          )}
          <SidebarMenu>
            {allPaths.map((path) => {
              const isActive = selectedCwd === path;
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
                  totalSessionCount={isActive ? sessions.length : 0}
                  activeSessionId={activeSessionId}
                  onSessionClick={handleSessionClick}
                  onNewSession={handleNewSession}
                  onDrillIntoSessions={handleDrillIntoSessions}
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
        className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"
      >
        <Icon className="size-(--size-icon-sm)" />
        {label}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
