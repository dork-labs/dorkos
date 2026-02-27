import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useTransport,
  useAppStore,
  useIsMobile,
  useTheme,
  type Theme,
} from '@/layers/shared/model';
import { cn, groupSessionsByTime, TIMING, updateTabBadge } from '@/layers/shared/lib';
import {
  PathBreadcrumb,
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFullscreenToggle,
  DirectoryPicker,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/layers/shared/ui';
import { usePulseEnabled, useActiveRunCount, useCompletedRunBadge } from '@/layers/entities/pulse';
import { useRelayEnabled } from '@/layers/entities/relay';
import { useMeshEnabled } from '@/layers/entities/mesh';
import { toast } from 'sonner';
import { useSessionId, useDirectoryState } from '@/layers/entities/session';
import { SessionItem } from './SessionItem';
import {
  Plus,
  PanelLeftClose,
  FolderOpen,
  Sun,
  Moon,
  Monitor,
  Route,
  Network,
  HeartPulse,
  Bug,
  Settings,
} from 'lucide-react';
import { SettingsDialog } from '@/layers/features/settings';
import { PulsePanel } from '@/layers/features/pulse';
import { RelayPanel } from '@/layers/features/relay';
import { MeshPanel } from '@/layers/features/mesh';
import type { Session } from '@dorkos/shared/types';

const themeOrder: Theme[] = ['light', 'dark', 'system'];

export function SessionSidebar() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [activeSessionId, setActiveSession] = useSessionId();
  const {
    setSidebarOpen,
    devtoolsOpen,
    toggleDevtools,
    pickerOpen,
    setPickerOpen,
    settingsOpen,
    setSettingsOpen,
    pulseOpen,
    setPulseOpen,
    relayOpen,
    setRelayOpen,
    meshOpen,
    setMeshOpen,
  } = useAppStore();
  const isMobile = useIsMobile();
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const relayEnabled = useRelayEnabled();
  const meshEnabled = useMeshEnabled();
  const [selectedCwd, setSelectedCwd] = useDirectoryState();
  const pulseEnabled = usePulseEnabled();
  const { data: activeRunCount = 0 } = useActiveRunCount(pulseEnabled);
  const { unviewedCount, clearBadge } = useCompletedRunBadge(pulseEnabled);
  const enablePulseNotifications = useAppStore((s) => s.enablePulseNotifications);
  const { theme, setTheme } = useTheme();
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
      setTimeout(() => setJustCreatedId(null), TIMING.NEW_SESSION_HIGHLIGHT_MS);
      if (isMobile) setTimeout(() => setSidebarOpen(false), TIMING.SIDEBAR_AUTO_CLOSE_MS);
    },
  });

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      setActiveSession(sessionId);
      if (isMobile) setSidebarOpen(false);
    },
    [isMobile, setActiveSession, setSidebarOpen]
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

  // Tab title badge for background tab awareness
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        updateTabBadge(unviewedCount);
      } else {
        updateTabBadge(0);
      }
    };
    if (document.hidden && unviewedCount > 0) {
      updateTabBadge(unviewedCount);
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      updateTabBadge(0);
    };
  }, [unviewedCount]);

  const groupedSessions = useMemo(() => groupSessionsByTime(sessions), [sessions]);

  return (
    <div data-testid="session-sidebar" className="sidebar-container flex h-full flex-col p-3">
      {/* Header: New Chat + Collapse */}
      <div className="mb-3 space-y-1.5">
        {/* Working directory breadcrumb */}
        <div className="flex items-center gap-1.5">
          {selectedCwd && (
            <button
              onClick={() => setPickerOpen(true)}
              className="hover:bg-accent flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1.5 transition-colors duration-150"
              aria-label="Change working directory"
              title={selectedCwd}
            >
              <FolderOpen className="text-muted-foreground size-(--size-icon-sm) flex-shrink-0" />
              <PathBreadcrumb path={selectedCwd} maxSegments={3} size="sm" />
            </button>
          )}
          <button
            onClick={() => setSidebarOpen(false)}
            className="hover:bg-accent rounded-md p-2 transition-colors duration-150"
            aria-label="Close sidebar"
          >
            <PanelLeftClose className="text-muted-foreground size-(--size-icon-md)" />
          </button>
        </div>
        <button
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          className="border-border text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all duration-100 active:scale-[0.98] disabled:opacity-50"
        >
          <Plus className="size-(--size-icon-sm)" />
          New chat
        </button>
      </div>

      {/* Session List */}
      <div data-testid="session-list" className="-mx-1 flex-1 overflow-y-auto px-1">
        {groupedSessions.length > 0 ? (
          <div className="space-y-5">
            {groupedSessions.map((group) => {
              const hideHeader = groupedSessions.length === 1 && group.label === 'Today';
              return (
                <div key={group.label}>
                  {!hideHeader && (
                    <h3 className="text-2xs text-muted-foreground/70 mb-1.5 px-3 font-medium tracking-wider uppercase">
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
          <div className="flex h-32 items-center justify-center">
            <p className="text-muted-foreground/60 text-sm">No conversations yet</p>
          </div>
        )}
      </div>
      {/* Footer */}
      <div className="border-border mt-2 flex items-center border-t pt-2">
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
            className="text-muted-foreground/50 hover:text-muted-foreground rounded-md p-1 transition-colors duration-150 max-md:p-2"
            aria-label="Settings"
          >
            <Settings className="size-(--size-icon-sm)" />
          </button>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setRelayOpen(true)}
                className={cn(
                  'rounded-md p-1 transition-colors duration-150 max-md:p-2',
                  relayEnabled
                    ? 'text-muted-foreground/50 hover:text-muted-foreground'
                    : 'text-muted-foreground/25 hover:text-muted-foreground/40'
                )}
                aria-label="Relay messaging"
              >
                <Route className="size-(--size-icon-sm)" />
              </button>
            </TooltipTrigger>
            {!relayEnabled && (
              <TooltipContent side="top">Relay is disabled</TooltipContent>
            )}
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setMeshOpen(true)}
                className={cn(
                  'rounded-md p-1 transition-colors duration-150 max-md:p-2',
                  meshEnabled
                    ? 'text-muted-foreground/50 hover:text-muted-foreground'
                    : 'text-muted-foreground/25 hover:text-muted-foreground/40'
                )}
                aria-label="Mesh agent discovery"
              >
                <Network className="size-(--size-icon-sm)" />
              </button>
            </TooltipTrigger>
            {!meshEnabled && (
              <TooltipContent side="top">Mesh is disabled</TooltipContent>
            )}
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setPulseOpen(true)}
                className={cn(
                  'relative rounded-md p-1 transition-colors duration-150 max-md:p-2',
                  pulseEnabled
                    ? 'text-muted-foreground/50 hover:text-muted-foreground'
                    : 'text-muted-foreground/25 hover:text-muted-foreground/40'
                )}
                aria-label="Pulse scheduler"
              >
                <HeartPulse className="size-(--size-icon-sm)" />
                {activeRunCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-green-500 animate-pulse" />
                )}
                {activeRunCount === 0 && unviewedCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-amber-500" />
                )}
              </button>
            </TooltipTrigger>
            {!pulseEnabled && (
              <TooltipContent side="top">Pulse is disabled</TooltipContent>
            )}
          </Tooltip>
          <button
            onClick={cycleTheme}
            className="text-muted-foreground/50 hover:text-muted-foreground rounded-md p-1 transition-colors duration-150 max-md:p-2"
            title={`Theme: ${theme}`}
            aria-label={`Theme: ${theme}. Click to cycle.`}
          >
            <ThemeIcon className="size-(--size-icon-sm)" />
          </button>
          {import.meta.env.DEV && (
            <button
              onClick={toggleDevtools}
              className={`rounded-md p-1 transition-colors duration-150 max-md:p-2 ${
                devtoolsOpen ? 'text-amber-500' : 'text-amber-500/60 hover:text-amber-500'
              }`}
              title={devtoolsOpen ? 'Hide React Query devtools' : 'Show React Query devtools'}
              aria-label="Toggle React Query devtools"
            >
              <Bug className="size-(--size-icon-sm)" />
            </button>
          )}
        </div>
      </div>
      <DirectoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={(path) => setSelectedCwd(path)}
        initialPath={selectedCwd}
      />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ResponsiveDialog open={pulseOpen} onOpenChange={setPulseOpen}>
        <ResponsiveDialogContent className="max-h-[85vh] max-w-2xl gap-0 p-0">
          <ResponsiveDialogHeader className="border-b px-4 py-3">
            <ResponsiveDialogTitle className="text-sm font-medium">
              Pulse Scheduler
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="sr-only">
              Manage scheduled AI agent tasks
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <div className="overflow-y-auto">
            <PulsePanel />
          </div>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
      <ResponsiveDialog open={relayOpen} onOpenChange={setRelayOpen}>
        <ResponsiveDialogContent className="max-h-[85vh] max-w-2xl gap-0 p-0">
          <ResponsiveDialogHeader className="border-b px-4 py-3">
            <ResponsiveDialogTitle className="text-sm font-medium">
              Relay
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="sr-only">
              Inter-agent messaging activity and endpoints
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <div className="overflow-y-auto">
            <RelayPanel />
          </div>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
      <ResponsiveDialog open={meshOpen} onOpenChange={setMeshOpen}>
        <ResponsiveDialogContent className="h-[85vh] max-w-2xl gap-0 p-0">
          <ResponsiveDialogFullscreenToggle />
          <ResponsiveDialogHeader className="border-b px-4 py-3">
            <ResponsiveDialogTitle className="text-sm font-medium">
              Mesh
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="sr-only">
              Agent discovery and registry
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <div className="flex min-h-0 flex-1 flex-col">
            <MeshPanel />
          </div>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </div>
  );
}
