import type { Session } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuItem } from '@/layers/shared/ui';
import { PromoSlot } from '@/layers/features/feature-promos';
import { SessionItem } from './SessionItem';

interface OverviewTabPanelProps {
  recentSessions: Session[];
  activeSessionId: string | null;
  onSessionClick: (sessionId: string) => void;
  onViewMore: () => void;
  isVisible: boolean;
}

/** Overview tab — recent sessions summary and promotional content. */
export function OverviewTabPanel({
  recentSessions,
  activeSessionId,
  onSessionClick,
  onViewMore,
  isVisible,
}: OverviewTabPanelProps) {
  return (
    <div
      role="tabpanel"
      id="sidebar-tabpanel-overview"
      aria-labelledby="sidebar-tab-overview"
      className={cn('h-full', !isVisible && 'hidden')}
    >
      <div className="space-y-4 p-3">
        {recentSessions.length > 0 && (
          <SidebarGroup className="p-0">
            <SidebarGroupLabel className="text-muted-foreground/70 text-[10px] font-medium tracking-wider uppercase">
              Recent Sessions
            </SidebarGroupLabel>
            <SidebarMenu>
              {recentSessions.map((session) => (
                <SidebarMenuItem key={session.id}>
                  <SessionItem
                    session={session}
                    isActive={session.id === activeSessionId}
                    onClick={() => onSessionClick(session.id)}
                  />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
            <button
              onClick={onViewMore}
              className="text-muted-foreground hover:text-foreground mt-1 px-3 text-[11px] transition-colors"
            >
              View more
            </button>
          </SidebarGroup>
        )}

        <PromoSlot placement="agent-sidebar" maxUnits={3} />
      </div>
    </div>
  );
}
