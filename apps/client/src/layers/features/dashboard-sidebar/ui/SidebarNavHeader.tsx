import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Activity, FolderGit2, LayoutDashboard, Search, Store, Users, Zap } from 'lucide-react';
import {
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  Kbd,
} from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { cn, formatShortcutKey, SHORTCUTS } from '@/layers/shared/lib';

/**
 * Top-level route navigation for the dashboard sidebar: Dashboard, Activity,
 * Agents, Tasks, Workspaces, Marketplace, and the command-palette Search row.
 * Self-contained (reads its own router + app-store state) so the orchestrator
 * stays focused on the agent roster.
 */
export function SidebarNavHeader() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const setGlobalPaletteOpen = useAppStore((s) => s.setGlobalPaletteOpen);

  return (
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
  );
}

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
