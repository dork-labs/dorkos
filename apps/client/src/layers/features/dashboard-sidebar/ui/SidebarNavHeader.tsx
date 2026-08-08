import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Cable, LayoutDashboard, Search, Store, Users } from 'lucide-react';
import {
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  Kbd,
} from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { isHomeSurfacePath, TOUR_ANCHORS } from '@/layers/shared/config';
import { cn, formatShortcutKey, SHORTCUTS } from '@/layers/shared/lib';

/**
 * Top-level route navigation for the dashboard sidebar: Home, Team, Connections,
 * Marketplace, and the command-palette Search row.
 *
 * Four places, not seven. Activity, scheduled work and workspaces are tabs of
 * the home surface now, so the sidebar answers "which part of DorkOS" and the
 * tab bar answers "which part of Home" — which is why Home reads active across
 * all four of its routes.
 *
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
          // The icon the window-tab strip already uses for `/`, so one place
          // does not wear two faces.
          icon={LayoutDashboard}
          label="Home"
          isActive={isHomeSurfacePath(pathname)}
          onClick={() => navigate({ to: '/' })}
        />
        <NavButton
          icon={Users}
          label="Team"
          isActive={pathname === '/team'}
          onClick={() => navigate({ to: '/team' })}
          // Named `nav-agents` for the page's old title, and staying that way:
          // it is what the e2e specs click. No tour points here — a step
          // anchored in the sidebar shows a phone nothing, because the sidebar
          // is a sheet that is unmounted until you open it.
          testId={TOUR_ANCHORS.navAgents}
        />
        <NavButton
          icon={Cable}
          label="Connections"
          isActive={pathname === '/connections'}
          onClick={() => navigate({ to: '/connections' })}
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
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  isActive: boolean;
  onClick: () => void;
  /** Stable tour/e2e anchor stamped on the button (see TOUR_ANCHORS). */
  testId?: string;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        onClick={onClick}
        data-testid={testId}
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
