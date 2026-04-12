import { useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { cn, getAgentDisplayName, groupSessionsByTime } from '@/layers/shared/lib';
import { SidebarContent } from '@/layers/shared/ui';
import { useActiveTaskRunCount } from '@/layers/entities/tasks';
import { useAgentToolStatus, useCurrentAgent } from '@/layers/entities/agent';
import { useSessions } from '@/layers/entities/session';
import { SidebarTabRow } from './SidebarTabRow';
import { SessionsView } from './SessionsView';
import { TasksView } from './TasksView';
import { ConnectionsView } from './ConnectionsView';
import { OverviewTabPanel } from './OverviewTabPanel';
import { SidebarAgentHeader } from './SidebarAgentHeader';
import { useConnectionsStatus } from '../model/use-connections-status';
import { useTaskNotifications } from '../model/use-task-notifications';
import { useSidebarTabs } from '../model/use-sidebar-tabs';
import { useSidebarNavigation } from '../model/use-sidebar-navigation';

/** Primary sidebar body — session list, schedule tabs, and connections. Footer and rail render in AppShell. */
export function SessionSidebar() {
  const { sessions, activeSessionId } = useSessions();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const { data: currentAgent } = useCurrentAgent(selectedCwd);
  const toolStatus = useAgentToolStatus(selectedCwd);
  const tasksToolEnabled = toolStatus.tasks !== 'disabled-by-server';
  const { data: activeRunCount = 0 } = useActiveTaskRunCount(tasksToolEnabled);
  const connectionsStatus = useConnectionsStatus(selectedCwd);

  // Side-effect hooks
  useTaskNotifications();
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

  const handleRenameSession = useCallback(
    async (sessionId: string, title: string) => {
      try {
        await transport.updateSession(sessionId, { title }, selectedCwd ?? undefined);
        await queryClient.invalidateQueries({ queryKey: ['sessions'] });
      } catch {
        toast.error('Failed to rename session');
      }
    },
    [transport, selectedCwd, queryClient]
  );

  const groupedSessions = useMemo(() => groupSessionsByTime(sessions), [sessions]);
  const recentSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3),
    [sessions]
  );

  return (
    <>
      <SidebarAgentHeader
        agentName={currentAgent ? getAgentDisplayName(currentAgent) : undefined}
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
            onRenameSession={handleRenameSession}
          />
        </div>

        {/* Schedules view */}
        <div
          role="tabpanel"
          id="sidebar-tabpanel-schedules"
          aria-labelledby="sidebar-tab-schedules"
          className={cn('h-full', sidebarActiveTab !== 'schedules' && 'hidden')}
        >
          <TasksView toolStatus={toolStatus.tasks} agentId={currentAgent?.id ?? null} />
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
