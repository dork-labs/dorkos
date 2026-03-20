import { useMemo, useCallback, useEffect, useRef, useContext } from 'react';
import { useAppStore, useIsMobile } from '@/layers/shared/model';
import { cn, groupSessionsByTime, TIMING, formatShortcutKey, SHORTCUTS } from '@/layers/shared/lib';
import {
  SidebarContent,
  SidebarContext,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  Kbd,
} from '@/layers/shared/ui';
import { usePulseEnabled, useCompletedRunBadge, useActiveRunCount } from '@/layers/entities/pulse';
import { useAgentToolStatus, useCurrentAgent } from '@/layers/entities/agent';
import { toast } from 'sonner';
import { useSessions } from '@/layers/entities/session';
import { SidebarTabRow } from './SidebarTabRow';
import { SessionsView } from './SessionsView';
import { SchedulesView } from './SchedulesView';
import { ConnectionsView } from './ConnectionsView';
import { Home, Plus } from 'lucide-react';
import { useNavigate, useLocation } from '@tanstack/react-router';
import { useConnectionsStatus } from '../model/use-connections-status';

/** Primary sidebar body — session list, schedule tabs, and connections. Footer and rail render in AppShell. */
export function SessionSidebar() {
  const { sessions, activeSessionId, setActiveSession } = useSessions();
  const { setSidebarOpen, setPulseOpen } = useAppStore();
  const isMobile = useIsMobile();
  // Suppresses auto-select after user intentionally clicks "New session"
  const intentionallyNullRef = useRef(false);
  const pulseEnabled = usePulseEnabled();
  const { unviewedCount, clearBadge } = useCompletedRunBadge(pulseEnabled);
  const enablePulseNotifications = useAppStore((s) => s.enablePulseNotifications);
  const pulseOpen = useAppStore((s) => s.pulseOpen);
  // Null when rendered in embedded mode (no SidebarProvider); used to close the mobile Sheet.
  const sidebarCtx = useContext(SidebarContext);
  const routerLocation = useLocation();

  // Auto-select most recent session when directory changes and no session is active.
  // Skip when the user intentionally cleared the session via "New session" button.
  // Skip when on the dashboard — it intentionally has no active session.
  useEffect(() => {
    if (intentionallyNullRef.current) {
      intentionallyNullRef.current = false;
      return;
    }
    // On the dashboard route, no session should be auto-selected.
    if (routerLocation.pathname === '/') return;
    if (!activeSessionId && sessions.length > 0) {
      setActiveSession(sessions[0].id);
    }
  }, [activeSessionId, sessions, setActiveSession, routerLocation.pathname]);

  const handleNewSession = useCallback(() => {
    intentionallyNullRef.current = true;
    setActiveSession(null);
    if (isMobile) {
      setTimeout(() => {
        setSidebarOpen(false);
        sidebarCtx?.setOpenMobile(false);
      }, TIMING.SIDEBAR_AUTO_CLOSE_MS);
    }
  }, [setActiveSession, isMobile, setSidebarOpen, sidebarCtx]);

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      setActiveSession(sessionId);
      if (isMobile) {
        setSidebarOpen(false);
        sidebarCtx?.setOpenMobile(false);
      }
    },
    [isMobile, setActiveSession, setSidebarOpen, sidebarCtx]
  );

  // Clear completion badge when Pulse panel opens
  useEffect(() => {
    if (pulseOpen) clearBadge();
  }, [pulseOpen, clearBadge]);

  // Toast on new run completions
  const prevUnviewedRef = useRef(0);
  useEffect(() => {
    if (!enablePulseNotifications) return;
    if (unviewedCount > prevUnviewedRef.current) {
      toast('Pulse run completed', {
        description: 'A scheduled run has finished.',
        duration: 6000,
        action: {
          label: 'View history',
          onClick: () => setPulseOpen(true),
        },
      });
    }
    prevUnviewedRef.current = unviewedCount;
  }, [unviewedCount, enablePulseNotifications, setPulseOpen]);

  // Flow badge count to Zustand so useDocumentTitle can render it
  const setPulseBadgeCount = useAppStore((s) => s.setPulseBadgeCount);
  useEffect(() => {
    setPulseBadgeCount(unviewedCount);
    return () => setPulseBadgeCount(0);
  }, [unviewedCount, setPulseBadgeCount]);

  const groupedSessions = useMemo(() => groupSessionsByTime(sessions), [sessions]);

  const { sidebarActiveTab, setSidebarActiveTab } = useAppStore();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const { data: currentAgent } = useCurrentAgent(selectedCwd);
  const toolStatus = useAgentToolStatus(selectedCwd);
  const pulseToolEnabled = toolStatus.pulse !== 'disabled-by-server';
  const { data: activeRunCount = 0 } = useActiveRunCount(pulseToolEnabled);

  const connectionsStatus = useConnectionsStatus(selectedCwd);
  const navigate = useNavigate();

  const visibleTabs = useMemo(() => {
    const tabs: ('sessions' | 'schedules' | 'connections')[] = ['sessions'];
    if (pulseToolEnabled) tabs.push('schedules');
    // Connections always visible (Mesh has no server feature flag)
    tabs.push('connections');
    return tabs;
  }, [pulseToolEnabled]);

  // Fall back to 'sessions' if active tab becomes hidden due to feature flag changes
  useEffect(() => {
    if (!visibleTabs.includes(sidebarActiveTab)) {
      setSidebarActiveTab('sessions');
    }
  }, [visibleTabs, sidebarActiveTab, setSidebarActiveTab]);

  // Keyboard shortcuts for sidebar tab switching (Cmd/Ctrl + 1/2/3)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);

  useEffect(() => {
    if (!sidebarOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const tabMap: Record<string, 'sessions' | 'schedules' | 'connections'> = {
        '1': 'sessions',
        '2': 'schedules',
        '3': 'connections',
      };
      const tab = tabMap[e.key];
      if (tab && visibleTabs.includes(tab)) {
        e.preventDefault();
        setSidebarActiveTab(tab);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [sidebarOpen, visibleTabs, setSidebarActiveTab]);

  const handleDashboard = useCallback(() => {
    intentionallyNullRef.current = true;
    navigate({ to: '/' });
    if (isMobile) {
      setSidebarOpen(false);
      sidebarCtx?.setOpenMobile(false);
    }
  }, [navigate, isMobile, setSidebarOpen, sidebarCtx]);

  // Cmd/Ctrl+Shift+N → new session (global, works regardless of sidebar state)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        handleNewSession();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleNewSession]);

  return (
    <>
      <SidebarHeader className="border-b p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              data-slot="dashboard-link"
              onClick={handleDashboard}
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all duration-100 active:scale-[0.98]"
            >
              <Home className="size-(--size-icon-sm)" />
              Dashboard
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={handleNewSession}
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

      <SidebarTabRow
        activeTab={sidebarActiveTab}
        onTabChange={setSidebarActiveTab}
        schedulesBadge={activeRunCount}
        connectionsStatus={connectionsStatus}
        visibleTabs={visibleTabs}
      />

      <SidebarContent data-testid="session-list" className="!overflow-hidden">
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
          <ConnectionsView toolStatus={toolStatus} agentId={currentAgent?.id} />
        </div>
      </SidebarContent>
    </>
  );
}
