import { useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { cn, getAgentDisplayName, groupSessionsByTime } from '@/layers/shared/lib';
import { SidebarContent } from '@/layers/shared/ui';
import { useActiveTaskRunCount } from '@/layers/entities/tasks';
import { useAgentToolStatus, useCurrentAgent } from '@/layers/entities/agent';
import {
  useAgentSessions,
  useSessionListWarnings,
  useRenameSession,
} from '@/layers/entities/session';
import { SidebarTabRow } from './SidebarTabRow';
import { SessionsView } from './SessionsView';
import { TasksView } from './TasksView';
import { ConnectionsView } from './ConnectionsView';
import { OverviewTabPanel } from './OverviewTabPanel';
import { SidebarAgentHeader } from './SidebarAgentHeader';
import { SidebarTabErrorBoundary } from './SidebarTabErrorBoundary';
import { useConnectionsStatus } from '../model/use-connections-status';
import { useTaskNotifications } from '../model/use-task-notifications';
import { useSidebarTabs } from '../model/use-sidebar-tabs';
import { isBuiltinSidebarTab } from '../model/sidebar-contributions';
import { useSidebarNavigation } from '../model/use-sidebar-navigation';

/** Primary sidebar body — session list, schedule tabs, and connections. Footer and rail render in AppShell. */
export function SessionSidebar() {
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  // Canonical cwd-scoped membership (DOR-203) — must agree with the dashboard sidebar.
  const { sessions, activeSessionId } = useAgentSessions(selectedCwd);
  // Runtime-named "couldn't list" notices from the aggregated list (ADR-0310).
  const sessionListWarnings = useSessionListWarnings();
  const { data: currentAgent } = useCurrentAgent(selectedCwd);
  const toolStatus = useAgentToolStatus(selectedCwd);
  const tasksToolEnabled = toolStatus.tasks !== 'disabled-by-server';
  const { data: activeRunCount = 0 } = useActiveTaskRunCount(tasksToolEnabled);
  const connectionsStatus = useConnectionsStatus(selectedCwd);

  // Side-effect hooks
  useTaskNotifications();
  // `displayTab` (not the raw active id) drives ALL rendering below: while a
  // contributed id has no registered tab yet (extension remount in flight, or
  // orphaned after an uninstall), it resolves to 'overview' so the panel area
  // shows the overview placeholder instead of going blank.
  const { visibleTabs, displayTab, setSidebarActiveTab } = useSidebarTabs();
  const { handleNewSession, handleSessionClick, handleDashboard } = useSidebarNavigation();
  const transport = useTransport();
  const queryClient = useQueryClient();
  const renameSession = useRenameSession(selectedCwd);

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
    (sessionId: string, title: string) => {
      renameSession.mutate({ sessionId, title });
    },
    [renameSession]
  );

  // useAgentSessions returns newest-first, so grouping and the top-3 preview
  // consume it directly.
  const groupedSessions = useMemo(() => groupSessionsByTime(sessions), [sessions]);
  const recentSessions = useMemo(() => sessions.slice(0, 3), [sessions]);

  // The extension-contributed tab being displayed, if any. Built-in panels
  // render from the prop-fed markup below; a contributed tab renders its
  // self-contained component (behind an error boundary so a throwing extension
  // can't take the sidebar down with it). `displayTab` only ever names a
  // renderable tab, so this is defined exactly when a contributed tab shows.
  const activeContributedTab = useMemo(
    () => visibleTabs.find((t) => t.id === displayTab && !isBuiltinSidebarTab(t.id)),
    [visibleTabs, displayTab]
  );

  return (
    <>
      <SidebarAgentHeader
        agentName={currentAgent ? getAgentDisplayName(currentAgent) : undefined}
        onDashboard={handleDashboard}
        onNewSession={handleNewSession}
      />

      <SidebarTabRow
        tabs={visibleTabs}
        activeTab={displayTab}
        onTabChange={setSidebarActiveTab}
        schedulesBadge={activeRunCount}
        connectionsStatus={connectionsStatus}
      />

      <SidebarContent data-testid="session-list" className="!overflow-hidden">
        <OverviewTabPanel
          recentSessions={recentSessions}
          activeSessionId={activeSessionId}
          onSessionClick={handleSessionClick}
          onViewMore={() => setSidebarActiveTab('sessions')}
          isVisible={displayTab === 'overview'}
        />

        {/* Sessions view */}
        <div
          role="tabpanel"
          id="sidebar-tabpanel-sessions"
          aria-labelledby="sidebar-tab-sessions"
          className={cn('h-full', displayTab !== 'sessions' && 'hidden')}
        >
          <SessionsView
            activeSessionId={activeSessionId}
            groupedSessions={groupedSessions}
            warnings={sessionListWarnings}
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
          className={cn('h-full', displayTab !== 'schedules' && 'hidden')}
        >
          <TasksView toolStatus={toolStatus.tasks} agentId={currentAgent?.id ?? null} />
        </div>

        {/* Connections view */}
        <div
          role="tabpanel"
          id="sidebar-tabpanel-connections"
          aria-labelledby="sidebar-tab-connections"
          className={cn('h-full', displayTab !== 'connections' && 'hidden')}
        >
          <ConnectionsView
            toolStatus={toolStatus}
            agentId={currentAgent?.id}
            activeSessionId={activeSessionId}
          />
        </div>

        {/* Extension-contributed tab panel — mounted only while active so its
            component (e.g. a polling widget) isn't running in the background. */}
        {activeContributedTab && (
          <div
            role="tabpanel"
            id={`sidebar-tabpanel-${activeContributedTab.id}`}
            aria-labelledby={`sidebar-tab-${activeContributedTab.id}`}
            className="h-full overflow-y-auto"
          >
            <SidebarTabErrorBoundary tabId={activeContributedTab.id}>
              <activeContributedTab.component />
            </SidebarTabErrorBoundary>
          </div>
        )}
      </SidebarContent>
    </>
  );
}
