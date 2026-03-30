import { ChevronLeft, Plus } from 'lucide-react';
import { formatShortcutKey, SHORTCUTS } from '@/layers/shared/lib';
import {
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  Kbd,
} from '@/layers/shared/ui';
import { AgentIdentity } from '@/layers/entities/agent';
import type { AgentVisual } from '@/layers/entities/agent';

interface SidebarAgentHeaderProps {
  agentVisual: AgentVisual;
  agentName: string | undefined;
  onDashboard: () => void;
  onNewSession: () => void;
}

/** Sidebar header with dashboard back-link, agent identity, and new-session button. */
export function SidebarAgentHeader({
  agentVisual,
  agentName,
  onDashboard,
  onNewSession,
}: SidebarAgentHeaderProps) {
  return (
    <SidebarHeader className="border-b p-3">
      {/* Dashboard back + agent identity */}
      <div className="flex items-center gap-2 py-1">
        <SidebarMenuButton
          data-slot="dashboard-link"
          type="button"
          size="sm"
          tooltip="Dashboard"
          aria-label="Dashboard"
          onClick={onDashboard}
          className="text-muted-foreground hover:bg-accent hover:text-foreground h-7! w-7! shrink-0 justify-center p-0 transition-all duration-100 active:scale-[0.98]"
        >
          <ChevronLeft className="size-(--size-icon-sm)" />
        </SidebarMenuButton>
        <AgentIdentity
          {...agentVisual}
          name={agentName ?? 'No agent'}
          size="sm"
          className="min-w-0 flex-1"
        />
      </div>

      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            onClick={onNewSession}
            className="group border-border text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center justify-between gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all duration-100 active:scale-[0.98] disabled:opacity-50"
          >
            <span className="flex items-center gap-1.5">
              <Plus className="size-(--size-icon-sm)" />
              New session
            </span>
            <Kbd className="shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
              {formatShortcutKey(SHORTCUTS.NEW_SESSION)}
            </Kbd>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
  );
}
