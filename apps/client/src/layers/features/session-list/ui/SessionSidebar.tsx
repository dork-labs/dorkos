import { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport, useAppStore, useIsMobile, useTheme, type Theme } from '@/layers/shared/model';
import { groupSessionsByTime } from '@/layers/shared/lib';
import { PathBreadcrumb, HoverCard, HoverCardContent, HoverCardTrigger } from '@/layers/shared/ui';
import { useSessionId, useDirectoryState } from '@/layers/entities/session';
import { SessionItem } from './SessionItem';
import { DirectoryPicker } from './DirectoryPicker';
import { Plus, PanelLeftClose, FolderOpen, Sun, Moon, Monitor, Route, HeartPulse, Bug, Settings } from 'lucide-react';
import { SettingsDialog } from '@/layers/features/settings';
import type { Session } from '@dorkos/shared/types';

export function SessionSidebar() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [activeSessionId, setActiveSession] = useSessionId();
  const { setSidebarOpen, devtoolsOpen, toggleDevtools } = useAppStore();
  const isMobile = useIsMobile();
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedCwd] = useDirectoryState();
  const { theme, setTheme } = useTheme();

  const themeOrder: Theme[] = ['light', 'dark', 'system'];
  const ThemeIcon = { light: Sun, dark: Moon, system: Monitor }[theme];
  const cycleTheme = useCallback(() => {
    const idx = themeOrder.indexOf(theme);
    setTheme(themeOrder[(idx + 1) % themeOrder.length]);
  }, [theme, setTheme]);

  const { data: sessions = [] } = useQuery({
    queryKey: ['sessions', selectedCwd],
    queryFn: () => transport.listSessions(selectedCwd ?? undefined),
    enabled: selectedCwd !== null,
  });

  // Auto-select most recent session when directory changes and no session is active
  useEffect(() => {
    if (!activeSessionId && sessions.length > 0) {
      setActiveSession(sessions[0].id);
    }
  }, [activeSessionId, sessions, setActiveSession]);

  const createMutation = useMutation({
    mutationFn: () =>
      transport.createSession({ permissionMode: 'default', cwd: selectedCwd ?? undefined }),
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ['sessions', selectedCwd] });
      setActiveSession(session.id);
      setJustCreatedId(session.id);
      setTimeout(() => setJustCreatedId(null), 300);
      if (isMobile) setTimeout(() => setSidebarOpen(false), 300);
    },
  });

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      setActiveSession(sessionId);
      if (isMobile) setSidebarOpen(false);
    },
    [isMobile, setActiveSession, setSidebarOpen]
  );

  const groupedSessions = useMemo(() => groupSessionsByTime(sessions), [sessions]);

  return (
    <div className="sidebar-container flex flex-col h-full p-3">
      {/* Header: New Chat + Collapse */}
      <div className="mb-3 space-y-1.5">
        {/* Working directory breadcrumb */}
        <div className="flex items-center gap-1.5">
          {selectedCwd && (
            <button
              onClick={() => setPickerOpen(true)}
              className="flex items-center gap-1 flex-1 rounded-md px-2 py-1.5 hover:bg-accent transition-colors duration-150 min-w-0"
              aria-label="Change working directory"
              title={selectedCwd}
            >
              <FolderOpen className="size-(--size-icon-sm) text-muted-foreground flex-shrink-0" />
              <PathBreadcrumb path={selectedCwd} maxSegments={3} size="sm" />
            </button>
          )}
          <button
            onClick={() => setSidebarOpen(false)}
            className="p-2 rounded-md hover:bg-accent transition-colors duration-150"
            aria-label="Close sidebar"
          >
            <PanelLeftClose className="size-(--size-icon-md) text-muted-foreground" />
          </button>
        </div>
        <button
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          className="flex items-center justify-center gap-1.5 w-full rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.98] transition-all duration-100 disabled:opacity-50"
        >
          <Plus className="size-(--size-icon-sm)" />
          New chat
        </button>
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto -mx-1 px-1">
        {groupedSessions.length > 0 ? (
          <div className="space-y-5">
            {groupedSessions.map((group) => {
              const hideHeader = groupedSessions.length === 1 && group.label === 'Today';
              return (
              <div key={group.label}>
                {!hideHeader && (
                  <h3 className="px-3 mb-1.5 text-2xs font-medium text-muted-foreground/70 uppercase tracking-wider">
                    {group.label}
                  </h3>
                )}
                <div className="space-y-0.5">
                  {group.sessions.map((session: Session) => (
                    <SessionItem
                      key={session.id}
                      session={session}
                      isActive={session.id === activeSessionId}
                      isNew={session.id === justCreatedId}
                      onClick={() => handleSessionClick(session.id)}
                    />
                  ))}
                </div>
              </div>
              );
            })}
          </div>
        ) : (
          <div className="flex items-center justify-center h-32">
            <p className="text-sm text-muted-foreground/60">No conversations yet</p>
          </div>
        )}
      </div>
      {/* Footer */}
      <div className="flex items-center pt-2 mt-2 border-t border-border">
        <a
          href="https://dorkian.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-2xs text-muted-foreground/50 hover:text-muted-foreground transition-colors duration-150"
        >
          DorkOS by Dorkian
        </a>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-1 max-md:p-2 rounded-md text-muted-foreground/50 hover:text-muted-foreground transition-colors duration-150"
            aria-label="Settings"
          >
            <Settings className="size-(--size-icon-sm)" />
          </button>
          <HoverCard openDelay={200} closeDelay={100}>
            <HoverCardTrigger asChild>
              <button
                className="p-1 max-md:p-2 rounded-md text-muted-foreground/50 hover:text-muted-foreground transition-colors duration-150"
                aria-label="Relay status"
              >
                <Route className="size-(--size-icon-sm)" />
              </button>
            </HoverCardTrigger>
            <HoverCardContent side="top" align="center" className="w-auto px-3 py-1.5 text-xs">
              Relay not connected
            </HoverCardContent>
          </HoverCard>
          <HoverCard openDelay={200} closeDelay={100}>
            <HoverCardTrigger asChild>
              <button
                className="p-1 max-md:p-2 rounded-md text-muted-foreground/50 hover:text-muted-foreground transition-colors duration-150"
                aria-label="Heartbeat status"
              >
                <HeartPulse className="size-(--size-icon-sm)" />
              </button>
            </HoverCardTrigger>
            <HoverCardContent side="top" align="center" className="w-auto px-3 py-1.5 text-xs">
              Pulse not detected
            </HoverCardContent>
          </HoverCard>
        <button
          onClick={cycleTheme}
          className="p-1 max-md:p-2 rounded-md text-muted-foreground/50 hover:text-muted-foreground transition-colors duration-150"
          title={`Theme: ${theme}`}
          aria-label={`Theme: ${theme}. Click to cycle.`}
        >
          <ThemeIcon className="size-(--size-icon-sm)" />
        </button>
          {import.meta.env.DEV && (
            <button
              onClick={toggleDevtools}
              className={`p-1 max-md:p-2 rounded-md transition-colors duration-150 ${
                devtoolsOpen
                  ? 'text-amber-500'
                  : 'text-amber-500/60 hover:text-amber-500'
              }`}
              title={devtoolsOpen ? 'Hide React Query devtools' : 'Show React Query devtools'}
              aria-label="Toggle React Query devtools"
            >
              <Bug className="size-(--size-icon-sm)" />
            </button>
          )}
        </div>
      </div>
      <DirectoryPicker open={pickerOpen} onOpenChange={setPickerOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
