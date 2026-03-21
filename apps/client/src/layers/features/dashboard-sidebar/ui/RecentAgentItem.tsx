import { SidebarMenuItem, SidebarMenuButton } from '@/layers/shared/ui';
import { useAgentVisual } from '@/layers/entities/agent';
import { cn } from '@/layers/shared/lib';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

interface RecentAgentItemProps {
  path: string;
  agent: AgentManifest | null;
  onClick: () => void;
}

/**
 * Single agent row in the dashboard sidebar's recent agents list.
 * Shows agent color dot, icon emoji, and name. Falls back to path basename when no manifest.
 */
export function RecentAgentItem({ path, agent, onClick }: RecentAgentItemProps) {
  const visual = useAgentVisual(agent, path);
  const displayName = agent?.name ?? path.split('/').pop() ?? 'Agent';

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={onClick}
        className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all duration-100 active:scale-[0.98]"
      >
        <span
          className={cn('size-2 shrink-0 rounded-full')}
          style={{ backgroundColor: visual.color }}
        />
        {visual.emoji && <span className="text-xs">{visual.emoji}</span>}
        <span className="truncate">{displayName}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
