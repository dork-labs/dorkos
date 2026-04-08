import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Activity, LayoutDashboard, Search, Star, Store, Users, Zap } from 'lucide-react';
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
import { useResolvedAgents, useAgentVisual, AgentIdentity } from '@/layers/entities/agent';
import { PromoSlot } from '@/layers/features/feature-promos';
import { RecentAgentItem } from './RecentAgentItem';

/** Maximum number of recent agents shown in the sidebar. */
const MAX_RECENT_AGENTS = 8;

/**
 * Dashboard sidebar — navigation links and recent agents list.
 * Shows Dashboard/Sessions/Agents navigation and up to 8 recent agents from the app store.
 */
export function DashboardSidebar() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const transport = useTransport();
  const recentCwds = useAppStore((s) => s.recentCwds);
  const setGlobalPaletteOpen = useAppStore((s) => s.setGlobalPaletteOpen);
  const paths = recentCwds.map((r) => r.path);
  const { data: agents } = useResolvedAgents(paths);

  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });

  const defaultAgentName = config?.agents?.defaultAgent ?? 'dorkbot';
  const defaultAgentDir = config?.agents?.defaultDirectory ?? '~/.dork/agents';
  const defaultAgentPath = `${defaultAgentDir}/${defaultAgentName}`;

  const { data: defaultAgentResolved } = useResolvedAgents([defaultAgentPath]);
  const defaultManifest = defaultAgentResolved?.[defaultAgentPath] ?? null;
  const defaultVisual = useAgentVisual(defaultManifest, defaultAgentPath);

  return (
    <>
      <SidebarHeader className="border-b p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === '/'}
              onClick={() => navigate({ to: '/' })}
              className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"
            >
              <LayoutDashboard className="size-(--size-icon-sm)" />
              Dashboard
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === '/activity'}
              onClick={() => navigate({ to: '/activity' })}
              className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"
            >
              <Activity className="size-(--size-icon-sm)" />
              Activity
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === '/agents'}
              onClick={() => navigate({ to: '/agents' })}
              className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"
            >
              <Users className="size-(--size-icon-sm)" />
              Agents
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === '/tasks'}
              onClick={() => navigate({ to: '/tasks' })}
              className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"
            >
              <Zap className="size-(--size-icon-sm)" />
              Tasks
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === '/marketplace' || pathname.startsWith('/marketplace/')}
              onClick={() => navigate({ to: '/marketplace' })}
              className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"
            >
              <Store className="size-(--size-icon-sm)" />
              Dork Hub
            </SidebarMenuButton>
          </SidebarMenuItem>
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
            <Star className="mr-1 inline size-3" />
            Default Agent
          </SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => navigate({ to: '/session', search: { dir: defaultAgentPath } })}
                className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all duration-100 active:scale-[0.98]"
              >
                <AgentIdentity
                  {...defaultVisual}
                  name={defaultManifest?.name ?? defaultAgentName}
                  size="xs"
                />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        {recentCwds.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-muted-foreground/70 text-[10px] font-medium tracking-wider uppercase">
              Recent Agents
            </SidebarGroupLabel>
            <SidebarMenu>
              {recentCwds.slice(0, MAX_RECENT_AGENTS).map((recent) => (
                <RecentAgentItem
                  key={recent.path}
                  path={recent.path}
                  agent={agents?.[recent.path] ?? null}
                  onClick={() => navigate({ to: '/session', search: { dir: recent.path } })}
                />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
        <PromoSlot placement="dashboard-sidebar" maxUnits={3} />
      </SidebarContent>
    </>
  );
}
