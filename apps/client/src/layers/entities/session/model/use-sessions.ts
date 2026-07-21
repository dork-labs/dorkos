import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport, useAppStore } from '@/layers/shared/model';
import { useSessionId } from './use-session-id';
import type { Session, SessionListWarning, SessionOrigin } from '@dorkos/shared/types';

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

/** Cache key for the per-runtime listing warnings that ride the session list. */
function sessionListWarningsKey(cwd: string | null) {
  return ['session-list-warnings', cwd] as const;
}

/** Fetch and manage the session list for the current working directory. */
export function useSessions() {
  const [activeSessionId, setActiveSession] = useSessionId();
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { selectedCwd } = useAppStore();

  // Cold-load query: seeds the list on mount. Live updates thereafter arrive via
  // the global `/api/events` stream, bridged into this `['sessions', cwd]` cache
  // by `useGlobalSessionStream` (mounted once in AppShell) — so there is
  // intentionally NO timer poll here (the 5s/60s poll was removed; ADR-0265).
  //
  // The transport returns the aggregated-list envelope `{ sessions, warnings? }`
  // (ADR-0310). Unwrap it here: this cache deliberately stays `Session[]`
  // because many consumers (router loader, submit hook, global stream bridge,
  // rename) read and patch it as a bare array. The per-runtime `warnings` ride
  // a sibling cache entry written below and surface through
  // {@link useSessionListWarnings}; they refresh on each cold load or refetch
  // of this query.
  const sessionsQuery = useQuery({
    queryKey: ['sessions', selectedCwd],
    queryFn: async () => {
      const { sessions, warnings } = await transport.listSessions(selectedCwd ?? undefined);
      queryClient.setQueryData<SessionListWarning[]>(
        sessionListWarningsKey(selectedCwd),
        warnings ?? []
      );
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

/**
 * Per-runtime session-list degradations for the current working directory
 * (ADR-0310): a runtime whose listing failed or timed out contributes one
 * warning and zero sessions instead of failing the whole list.
 *
 * The entries are written by the {@link useSessions} query function — this
 * hook is a subscribe-only observer (`enabled: false`), so it never fetches
 * on its own. Empty until the first session-list load completes.
 */
export function useSessionListWarnings(): SessionListWarning[] {
  const { selectedCwd } = useAppStore();
  const { data } = useQuery<SessionListWarning[]>({
    queryKey: sessionListWarningsKey(selectedCwd),
    // Never invoked (enabled: false) — the sessions queryFn owns the writes.
    queryFn: () => [],
    enabled: false,
  });
  return data ?? [];
}

/** Result of {@link useSessionOrigin}: both fields absent for a user-origin session. */
export interface SessionOriginData {
  origin: SessionOrigin | undefined;
  originLabel: string | undefined;
}

/**
 * Resolve a session's origin (and its origin label) from the session's row
 * in the `['sessions', cwd]` list cache, the same server-authoritative,
 * live-updated cache `useSessionRuntime` reads. Deliberately not a
 * dedicated fetch: the session header chip reuses whatever the sidebar
 * already has cached rather than issuing a second request for data the app
 * already holds (session-origin-legibility).
 *
 * @param sessionId - Session id, or nullish when no session context exists
 */
export function useSessionOrigin(sessionId: string | null | undefined): SessionOriginData {
  const { sessions } = useSessions();
  const session = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  return { origin: session?.origin, originLabel: session?.originLabel };
}
