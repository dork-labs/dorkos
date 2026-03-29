import { useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { cn, groupSessionsByTime } from '@/layers/shared/lib';
import { SidebarContent } from '@/layers/shared/ui';
import { useActiveRunCount } from '@/layers/entities/pulse';
import { useAgentToolStatus, useCurrentAgent, useAgentVisual } from '@/layers/entities/agent';
import { useSessions } from '@/layers/entities/session';
import { SidebarTabRow } from './SidebarTabRow';
import { SessionsView } from './SessionsView';
import { SchedulesView } from './SchedulesView';
import { ConnectionsView } from './ConnectionsView';
import { OverviewTabPanel } from './OverviewTabPanel';
import { SidebarAgentHeader } from './SidebarAgentHeader';
import { useConnectionsStatus } from '../model/use-connections-status';
import { usePulseNotifications } from '../model/use-pulse-notifications';
import { useSidebarTabs } from '../model/use-sidebar-tabs';
import { useSidebarNavigation } from '../model/use-sidebar-navigation';

/** Primary sidebar body — session list, schedule tabs, and connections. Footer and rail render in AppShell. */
export function SessionSidebar() {
  const { sessions, activeSessionId } = useSessions();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const { data: currentAgent } = useCurrentAgent(selectedCwd);
  const toolStatus = useAgentToolStatus(selectedCwd);
  const pulseToolEnabled = toolStatus.pulse !== 'disabled-by-server';
  const { data: activeRunCount = 0 } = useActiveRunCount(pulseToolEnabled);
  const agentVisual = useAgentVisual(currentAgent ?? null, selectedCwd ?? '');
  const connectionsStatus = useConnectionsStatus(selectedCwd);

  // Side-effect hooks
  usePulseNotifications();
  const { visibleTabs, sidebarActiveTab, setSidebarActiveTab } = useSidebarTabs();
  const { handleNewSession, handleSessionClick, handleDashboard } = useSidebarNavigation();
  const transport = useTransport();
  const queryClient = useQueryClient();

  const handleForkSession = useCallback(
    async (sessionId: string) => {
      try {
        const forked = await transport.forkSession(sessionId, undefined, selectedCwd ?? undefined);
        await queryClient.invalidateQueries({ queryKey: ['sessions'] });
        handleSessionClick(forked.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to fork session');
      }
    },
    [transport, selectedCwd, queryClient, handleSessionClick]
  );

  const groupedSessions = useMemo(() => groupSessionsByTime(sessions), [sessions]);
  const recentSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3),
    [sessions]
  );

  return (
    <>
      <SidebarAgentHeader
        agentVisual={agentVisual}
        agentName={currentAgent?.name}
        onDashboard={handleDashboard}
        onNewSession={handleNewSession}
      />

      <SidebarTabRow
        activeTab={sidebarActiveTab}
        onTabChange={setSidebarActiveTab}
        schedulesBadge={activeRunCount}
        connectionsStatus={connectionsStatus}
        visibleTabs={visibleTabs}
      />

      <SidebarContent data-testid="session-list" className="!overflow-hidden">
        <OverviewTabPanel
          recentSessions={recentSessions}
          activeSessionId={activeSessionId}
          onSessionClick={handleSessionClick}
          onViewMore={() => setSidebarActiveTab('sessions')}
          isVisible={sidebarActiveTab === 'overview'}
        />

        {/* Sessions view */}
        <div
          role="tabpanel"
          id="sidebar-tabpanel-sessions"
          aria-labelledby="sidebar-tab-sessions"
          className={cn('h-full', sidebarActiveTab !== 'sessions' && 'hidden')}
        >
          <SessionsView
            activeSessionId={activeSessionId}
            groupedSessions={groupedSessions}
            onSessionClick={handleSessionClick}
            onForkSession={handleForkSession}
          />
        </div>

        {/* Schedules view */}
        <div
          role="tabpanel"
          id="sidebar-tabpanel-schedules"
          aria-labelledby="sidebar-tab-schedules"
          className={cn('h-full', sidebarActiveTab !== 'schedules' && 'hidden')}
        >
          <SchedulesView toolStatus={toolStatus.pulse} agentId={currentAgent?.id ?? null} />
        </div>

        {/* Connections view */}
        <div
          role="tabpanel"
          id="sidebar-tabpanel-connections"
          aria-labelledby="sidebar-tab-connections"
          className={cn('h-full', sidebarActiveTab !== 'connections' && 'hidden')}
        >
          <ConnectionsView
            toolStatus={toolStatus}
            agentId={currentAgent?.id}
            activeSessionId={activeSessionId}
          />
        </div>
      </SidebarContent>
    </>
  );
}
