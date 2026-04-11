import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Activity, LayoutDashboard, Search, Store, Users, Zap } from 'lucide-react';
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
import { useAppStore, useTransport } from '@/layers/shared/model';
import { formatShortcutKey, SHORTCUTS } from '@/layers/shared/lib';
import { useResolvedAgents } from '@/layers/entities/agent';
import { useSessions } from '@/layers/entities/session';
import { PromoSlot } from '@/layers/features/feature-promos';
import { AgentListItem } from './AgentListItem';

/** Maximum number of agents shown in the sidebar (default + recent). */
const MAX_AGENTS = 8;

/**
 * Unified dashboard sidebar — top-level navigation and expandable agent list.
 *
 * The dashboard sidebar is the primary sidebar that persists across all routes.
 * Agents expand to show recent sessions, create new sessions, and drill into
 * the full session sidebar.
 */
export function DashboardSidebar() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const transport = useTransport();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const recentCwds = useAppStore((s) => s.recentCwds);
  const setGlobalPaletteOpen = useAppStore((s) => s.setGlobalPaletteOpen);
  const setSidebarLevel = useAppStore((s) => s.setSidebarLevel);

  // ── Default agent from config ──
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });
  const defaultAgentName = config?.agents?.defaultAgent ?? 'dorkbot';
  const defaultAgentDir = config?.agents?.defaultDirectory ?? '~/.dork/agents';
  const defaultAgentPath = `${defaultAgentDir}/${defaultAgentName}`;

  // ── Build merged agent list: default first, then recent (deduped) ──
  const agentPaths = useMemo(() => {
    const recent = recentCwds.map((r) => r.path).filter((p) => p !== defaultAgentPath);
    return [defaultAgentPath, ...recent].slice(0, MAX_AGENTS);
  }, [recentCwds, defaultAgentPath]);

  const { data: agents } = useResolvedAgents(agentPaths);

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
      navigate({ to: '/session', search: { dir: agentPath } });
    },
    [navigate]
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
        {agentPaths.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-muted-foreground/70 text-[10px] font-medium tracking-wider uppercase">
              Agents
            </SidebarGroupLabel>
            <SidebarMenu>
              {agentPaths.map((path) => {
                const isActive = selectedCwd === path;
                return (
                  <AgentListItem
                    key={path}
                    path={path}
                    agent={agents?.[path] ?? null}
                    isActive={isActive}
                    isExpanded={expandedPath === path}
                    onSelect={() => handleSelectAgent(path)}
                    onToggleExpand={() => handleToggleExpand(path)}
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
          </SidebarGroup>
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
        className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"
      >
        <Icon className="size-(--size-icon-sm)" />
        {label}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
