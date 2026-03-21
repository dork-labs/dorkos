import { useNavigate, useRouterState } from '@tanstack/react-router';
import { LayoutDashboard, MessageSquare, Users } from 'lucide-react';
import {
  SidebarHeader,
  SidebarContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarGroup,
  SidebarGroupLabel,
} from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { useResolvedAgents } from '@/layers/entities/agent';
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
  const recentCwds = useAppStore((s) => s.recentCwds);
  const paths = recentCwds.map((r) => r.path);
  const { data: agents } = useResolvedAgents(paths);

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
              isActive={pathname === '/session'}
              onClick={() => navigate({ to: '/session' })}
              className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"
            >
              <MessageSquare className="size-(--size-icon-sm)" />
              Sessions
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
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="p-3">
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
      </SidebarContent>
    </>
  );
}
