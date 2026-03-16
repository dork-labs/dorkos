import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport, useAppStore } from '@/layers/shared/model';
import { QUERY_TIMING } from '@/layers/shared/lib';
import { useSessionId } from './use-session-id';
import type { Session } from '@dorkos/shared/types';

/**
 * Insert an optimistic session into the query cache.
 * Called by useChatSession when creating a session on first message.
 */
export function insertOptimisticSession(
  queryClient: ReturnType<typeof useQueryClient>,
  selectedCwd: string | null,
  session: Session,
) {
  queryClient.setQueryData<Session[]>(
    ['sessions', selectedCwd],
    (old) => [session, ...(old ?? [])],
  );
}

/** Fetch and manage the session list for the current working directory. */
export function useSessions() {
  const [activeSessionId, setActiveSession] = useSessionId();
  const transport = useTransport();
  const { selectedCwd } = useAppStore();

  const sessionsQuery = useQuery({
    queryKey: ['sessions', selectedCwd],
    queryFn: () => transport.listSessions(selectedCwd ?? undefined),
    refetchInterval: QUERY_TIMING.SESSIONS_REFETCH_MS,
    enabled: selectedCwd !== null,
  });

  return {
    sessions: sessionsQuery.data ?? [],
    isLoading: sessionsQuery.isLoading,
    activeSessionId,
    setActiveSession,
  };
}
