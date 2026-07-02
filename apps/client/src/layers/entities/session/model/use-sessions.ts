import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport, useAppStore } from '@/layers/shared/model';
import { useSessionId } from './use-session-id';
import type { Session } from '@dorkos/shared/types';

/**
 * Insert an optimistic session into the query cache.
 * Called by useChatSession when creating a session on first message.
 */
export function insertOptimisticSession(
  queryClient: ReturnType<typeof useQueryClient>,
  selectedCwd: string | null,
  session: Session
) {
  queryClient.setQueryData<Session[]>(['sessions', selectedCwd], (old) => [
    session,
    ...(old ?? []),
  ]);
}

/** Fetch and manage the session list for the current working directory. */
export function useSessions() {
  const [activeSessionId, setActiveSession] = useSessionId();
  const transport = useTransport();
  const { selectedCwd } = useAppStore();

  // Cold-load query: seeds the list on mount. Live updates thereafter arrive via
  // the global `/api/events` stream, bridged into this `['sessions', cwd]` cache
  // by `useGlobalSessionStream` (mounted once in AppShell) — so there is
  // intentionally NO timer poll here (the 5s/60s poll was removed; ADR-0265).
  //
  // The transport returns the aggregated-list envelope `{ sessions, warnings? }`
  // (ADR-0308). Unwrap it here: this cache deliberately stays `Session[]`
  // because many consumers (router loader, submit hook, global stream bridge,
  // rename) read and patch it as a bare array. Per-runtime `warnings` are not
  // surfaced in the UI yet — the runtime copy pass (spec task 4.2) owns that.
  const sessionsQuery = useQuery({
    queryKey: ['sessions', selectedCwd],
    queryFn: async () => {
      const { sessions } = await transport.listSessions(selectedCwd ?? undefined);
      return sessions;
    },
    enabled: selectedCwd !== null,
  });

  return {
    sessions: sessionsQuery.data ?? [],
    isLoading: sessionsQuery.isLoading,
    activeSessionId,
    setActiveSession,
  };
}
