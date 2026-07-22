import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useAppStore, useTransport } from '@/layers/shared/model';
import {
  cn,
  getAgentDisplayName,
  groupSessionsByTime,
  formatShortcutKey,
  SHORTCUTS,
} from '@/layers/shared/lib';
import { Button, Kbd } from '@/layers/shared/ui';
import { useCurrentAgent } from '@/layers/entities/agent';
import {
  useSessions,
  useAgentSessions,
  useSessionListWarnings,
  useRenameSession,
} from '@/layers/entities/session';
import { PromoSlot } from '@/layers/features/feature-promos';
import { SessionsView } from './SessionsView';

/**
 * Slim left chrome for the Obsidian embed: an agent header plus the
 * conversations roster.
 *
 * This is the current-architecture replacement for the retired `SessionSidebar`
 * (its Overview / Schedules / Connections tabs moved to the right-panel
 * Inspector — Pulse and Agent Profile — or were dropped as legacy). The embed is
 * a focused single-agent session surface, so the sidebar's whole job is session
 * switching and starting a new session; the roster ({@link SessionsView}, the
 * same component the Agent Hub Sessions tab uses) carries both. Rendered inside
 * the embed's overlay Sheet, so picking a session or starting a new one closes
 * the overlay.
 */
export function EmbedSidebar() {
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  const { setActiveSession } = useSessions();
  const { sessions, activeSessionId } = useAgentSessions(selectedCwd);
  const sessionListWarnings = useSessionListWarnings();
  const { data: currentAgent } = useCurrentAgent(selectedCwd);
  const transport = useTransport();
  const queryClient = useQueryClient();
  const renameSession = useRenameSession(selectedCwd);

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      setActiveSession(sessionId);
      setSidebarOpen(false);
    },
    [setActiveSession, setSidebarOpen]
  );

  const handleNewSession = useCallback(() => {
    setActiveSession(crypto.randomUUID());
    setSidebarOpen(false);
  }, [setActiveSession, setSidebarOpen]);

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

  // useAgentSessions returns newest-first, so grouping consumes it directly.
  const groupedSessions = useMemo(() => groupSessionsByTime(sessions), [sessions]);

  return (
    <div className="flex h-full flex-col">
      <header className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-foreground truncate text-sm font-medium">
          {currentAgent ? getAgentDisplayName(currentAgent) : 'Agent'}
        </span>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" onClick={handleNewSession}>
          <Plus className="size-(--size-icon-sm)" />
          <span className="text-xs">New</span>
          <Kbd>{formatShortcutKey(SHORTCUTS.NEW_SESSION)}</Kbd>
        </Button>
      </header>

      <div className={cn('min-h-0 flex-1 overflow-hidden')}>
        <SessionsView
          activeSessionId={activeSessionId}
          groupedSessions={groupedSessions}
          warnings={sessionListWarnings}
          onSessionClick={handleSessionClick}
          onForkSession={handleForkSession}
          onRenameSession={handleRenameSession}
        />
      </div>

      {/* Feature promos targeted at the agent sidebar surface — self-hiding when
          there is nothing to show, so the slim chrome stays quiet by default. */}
      <div className="border-border border-t p-2 empty:border-0 empty:p-0">
        <PromoSlot placement="agent-sidebar" maxUnits={3} />
      </div>
    </div>
  );
}
