import { useMemo, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { LayoutGrid, MessageSquare, Clock, Plug2, type LucideIcon } from 'lucide-react';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { cn, getAgentDisplayName, groupSessionsByTime } from '@/layers/shared/lib';
import { SidebarContent, Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import { useActiveTaskRunCount } from '@/layers/entities/tasks';
import { useAgentToolStatus, useCurrentAgent } from '@/layers/entities/agent';
import {
  useAgentSessions,
  useSessionListWarnings,
  useRenameSession,
} from '@/layers/entities/session';
import { SessionsView } from './SessionsView';
import { TasksView } from './TasksView';
import { ConnectionsView } from './ConnectionsView';
import { OverviewTabPanel } from './OverviewTabPanel';
import { SidebarAgentHeader } from './SidebarAgentHeader';
import { useConnectionsStatus } from '../model/use-connections-status';
import { useTaskNotifications } from '../model/use-task-notifications';
import { useSidebarNavigation } from '../model/use-sidebar-navigation';

// ── Local tab strip ───────────────────────────────────────────
//
// The four fixed built-in tabs, in strip order. This union is intentionally
// self-contained: the registry-driven `sidebar.tabs` slot was retired when the
// web cockpit moved to the roster-plus-inspector layout, so this legacy shell
// carries its own hardcoded strip rather than reaching back into an extension
// point that no longer exists.
const LEGACY_TABS = ['overview', 'sessions', 'schedules', 'connections'] as const;
type LegacyTab = (typeof LEGACY_TABS)[number];

const TAB_META: Record<LegacyTab, { icon: LucideIcon; label: string }> = {
  overview: { icon: LayoutGrid, label: 'Overview' },
  sessions: { icon: MessageSquare, label: 'Sessions' },
  schedules: { icon: Clock, label: 'Schedules' },
  connections: { icon: Plug2, label: 'Connections' },
};

/** Whether `id` names one of the four built-in tabs this shell renders. */
function isLegacyTab(id: string): id is LegacyTab {
  return (LEGACY_TABS as readonly string[]).includes(id);
}

const STATUS_DOT_COLORS: Record<string, string> = {
  ok: 'bg-green-500',
  partial: 'bg-amber-500',
  error: 'bg-red-500',
};

interface LegacyTabStripProps {
  activeTab: LegacyTab;
  onTabChange: (tab: LegacyTab) => void;
  schedulesBadge: number;
  connectionsStatus: 'ok' | 'partial' | 'error' | 'none';
}

/**
 * Horizontal icon tab row for the embedded shell. A pared-down descendant of
 * the retired registry-backed `SidebarTabRow`: fixed to the four built-ins,
 * with ARIA tablist semantics, arrow-key roving focus, and a motion-animated
 * sliding indicator under the active tab.
 *
 * The old Cmd/Ctrl+1-4 tab shortcuts were dropped DELIBERATELY with the retired
 * tab-strip machinery (not an incidental regression) — this is the simplest
 * honest form for a deprecated embed, and the Obsidian north-star rework deletes
 * this component wholesale. Tabs are reachable by click and arrow keys.
 */
function LegacyTabStrip({
  activeTab,
  onTabChange,
  schedulesBadge,
  connectionsStatus,
}: LegacyTabStripProps) {
  const tabListRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const currentIndex = LEGACY_TABS.indexOf(activeTab);
      if (currentIndex === -1) return;
      let nextIndex = currentIndex;
      if (e.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % LEGACY_TABS.length;
        e.preventDefault();
      } else if (e.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + LEGACY_TABS.length) % LEGACY_TABS.length;
        e.preventDefault();
      }
      if (nextIndex !== currentIndex) {
        onTabChange(LEGACY_TABS[nextIndex]);
        const buttons = tabListRef.current?.querySelectorAll('[role="tab"]');
        (buttons?.[nextIndex] as HTMLElement)?.focus();
      }
    },
    [activeTab, onTabChange]
  );

  return (
    <div
      ref={tabListRef}
      role="tablist"
      aria-label="Sidebar views"
      // Makes the tablist itself focusable (jsx-a11y/interactive-supports-focus);
      // individual tab buttons manage their own tabIndex via roving tabindex.
      tabIndex={-1}
      className="border-border relative flex items-center gap-1 border-b px-2 py-1.5"
      onKeyDown={handleKeyDown}
    >
      {LEGACY_TABS.map((tabId) => {
        const isActive = activeTab === tabId;
        const { icon: Icon, label } = TAB_META[tabId];
        return (
          <Tooltip key={tabId}>
            <TooltipTrigger asChild>
              <button
                role="tab"
                id={`sidebar-tab-${tabId}`}
                aria-selected={isActive}
                aria-controls={`sidebar-tabpanel-${tabId}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => onTabChange(tabId)}
                className={cn(
                  'relative rounded-md p-2 transition-colors duration-150',
                  isActive
                    ? 'text-foreground'
                    : 'text-muted-foreground/50 hover:text-muted-foreground'
                )}
              >
                <Icon className="size-(--size-icon-sm)" />

                {/* Schedules numeric badge */}
                {tabId === 'schedules' && schedulesBadge > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-green-500 text-[10px] font-medium text-white">
                    {schedulesBadge > 9 ? '9+' : schedulesBadge}
                    <span className="animate-tasks absolute inset-0 rounded-full bg-green-500/30" />
                  </span>
                )}

                {/* Connections status dot */}
                {tabId === 'connections' && connectionsStatus !== 'none' && (
                  <span
                    className={cn(
                      'absolute -top-0.5 -right-0.5 size-1.5 rounded-full',
                      STATUS_DOT_COLORS[connectionsStatus]
                    )}
                  />
                )}

                {/* Sliding indicator */}
                {isActive && (
                  <motion.div
                    layoutId="sidebar-tab-indicator"
                    className="bg-brand absolute right-0 bottom-[-7px] left-0 h-0.5 rounded-full"
                    transition={{ type: 'spring', stiffness: 280, damping: 32 }}
                  />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

// ── SessionSidebar ────────────────────────────────────────────

/**
 * @deprecated Legacy embedded-shell sidebar — retained ONLY as the Obsidian
 * plugin's chrome ({@link App}, `apps/client/src/App.tsx`). The standalone web
 * cockpit retired the sidebar drill-in for a persistent roster plus the
 * right-panel inspector (`AppShell` no longer renders this component), and the
 * registry-backed `sidebar.tabs` slot it once composed from was deleted with it.
 *
 * This quarantined form stands alone: a hardcoded four-tab strip over its own
 * panels, with no extension-point dependency. It exists until the Obsidian
 * plugin's own layout rework lands (the plugin is a staged, under-verified
 * surface — see `contributing/obsidian-plugin-development.md`); delete this file
 * when that host stops mounting it.
 *
 * Footer and rail render in the embedding shell, not here.
 */
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

  // Active tab comes from the shared store so an embedded `switch_sidebar_tab`
  // command (and a Shape's pinned `sidebarTab`) still drives this strip, and the
  // choice persists across reloads. Only the four built-ins exist here, so any
  // stale or extension-namespaced id — from an old localStorage value or a
  // command targeting a tab that no longer exists — resolves to overview rather
  // than leaving the panel area blank.
  const sidebarActiveTab = useAppStore((s) => s.sidebarActiveTab);
  const setSidebarActiveTab = useAppStore((s) => s.setSidebarActiveTab);
  const activeTab: LegacyTab = isLegacyTab(sidebarActiveTab) ? sidebarActiveTab : 'overview';

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

  return (
    <>
      <SidebarAgentHeader
        agentName={currentAgent ? getAgentDisplayName(currentAgent) : undefined}
        onDashboard={handleDashboard}
        onNewSession={handleNewSession}
      />

      <LegacyTabStrip
        activeTab={activeTab}
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
          isVisible={activeTab === 'overview'}
        />

        {/* Sessions view */}
        <div
          role="tabpanel"
          id="sidebar-tabpanel-sessions"
          aria-labelledby="sidebar-tab-sessions"
          className={cn('h-full', activeTab !== 'sessions' && 'hidden')}
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
          className={cn('h-full', activeTab !== 'schedules' && 'hidden')}
        >
          <TasksView toolStatus={toolStatus.tasks} agentId={currentAgent?.id ?? null} />
        </div>

        {/* Connections view */}
        <div
          role="tabpanel"
          id="sidebar-tabpanel-connections"
          aria-labelledby="sidebar-tab-connections"
          className={cn('h-full', activeTab !== 'connections' && 'hidden')}
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
