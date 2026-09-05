import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { cn, getAgentDisplayName, groupSessionsByTime } from '@/layers/shared/lib';
import { BottomSlot, Button } from '@/layers/shared/ui';
import { useCurrentAgent } from '@/layers/entities/agent';
import { useConfig } from '@/layers/entities/config';
import {
  useSessions,
  useAgentSessions,
  useSessionListWarnings,
  useRenameSession,
  sessionKeys,
} from '@/layers/entities/session';
import { usePromoCandidate } from '@/layers/features/feature-promos';
import { EmbedSessionList } from './EmbedSessionList';

/**
 * Slim left chrome for the Obsidian embed: an agent header plus the
 * conversations roster.
 *
 * This is the current-architecture replacement for the retired `SessionSidebar`
 * (its Overview / Schedules / Connections tabs moved to the right-panel
 * Inspector — Pulse and Profile — or were dropped as legacy). The embed is
 * a focused single-agent session surface, so the sidebar's whole job is session
 * switching and starting a new session; the roster ({@link EmbedSessionList})
 * carries both. Rendered inside the embed's overlay Sheet, so picking a session
 * or starting a new one closes the overlay.
 *
 * **It is drawn in the cockpit sidebar's language** (DOR-1080). The roster used
 * to be `SessionsView` — the profile's Sessions panel, which is a panel in a page —
 * and
 * the embed wore hairlines the cockpit sidebar retired: separation here is the
 * `--sidebar-accent` tint ramp and nothing else (spec `sidebar-now-today-library`
 * R1). What the embed does NOT adopt is the zone structure: Heads up / Today /
 * Library all read router state that embedded mode has none of.
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
        await queryClient.invalidateQueries({ queryKey: sessionKeys.listRoot });
        handleSessionClick(forked.id);
      } catch (err) {
        toast.error("Couldn't branch off this conversation.", {
          description: err instanceof Error ? err.message : 'The original is untouched.',
        });
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

  const promo = usePromoCandidate('agent-sidebar');
  const { isLoading: configLoading } = useConfig();

  return (
    <div className="flex h-full flex-col">
      {/* No hairline under the header, and none above the promos below: the
          sidebar's separation is tint, never a line (R1). The header earns its
          edge from the roster's own top padding instead. */}
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-sidebar-foreground truncate text-sm font-medium">
          {currentAgent ? getAgentDisplayName(currentAgent) : 'Agent'}
        </span>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" onClick={handleNewSession}>
          <Plus className="size-(--size-icon-sm)" />
          <span className="text-xs">New</span>
        </Button>
      </header>

      <div className={cn('min-h-0 flex-1 overflow-hidden')}>
        <EmbedSessionList
          activeSessionId={activeSessionId}
          groupedSessions={groupedSessions}
          warnings={sessionListWarnings}
          onSessionClick={handleSessionClick}
          onForkSession={handleForkSession}
          onRenameSession={handleRenameSession}
        />
      </div>

      {/* The same one-card slot the cockpit's panel has, with the one
          candidate this surface has: a promo. The cockpit's other three —
          getting started, the update pill, the profile prompt — are cockpit
          chrome and have no meaning in a pane inside somebody else's app.

          What the embed gets for free here is the honest entrance: the promo
          used to animate up on every load (review Appendix C #14), and the
          slot's boot latch means a card that qualifies at load is simply
          there. */}
      <BottomSlot candidates={[promo]} ready={!configLoading} className="px-2 pb-2" />
    </div>
  );
}
