import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport, useAppStore } from '@/layers/shared/model';
import { useSessionId } from './use-session-id';
// Same-slice import via the sibling module (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionKeys } from '../api/query-keys';
import { sessionListQueryOptions, sessionListWarningsKey } from '../api/session-list-query';
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
  queryClient.setQueryData<Session[]>(sessionKeys.list(selectedCwd), (old) => [
    session,
    ...(old ?? []),
  ]);
}

/** Fetch and manage the session list for the current working directory. */
export function useSessions() {
  const [activeSessionId, setActiveSession] = useSessionId();
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { selectedCwd } = useAppStore();

  // Cold-load query: seeds the list on mount. Live updates thereafter arrive via
  // the global `/api/events` stream, bridged into this session-list cache
  // by `useGlobalSessionStream` (mounted once in AppShell) — so there is
  // intentionally NO timer poll here (the 5s/60s poll was removed; ADR-0265).
  //
  // The fetch itself is `sessionListQueryOptions`, shared with the session
  // resolver so both fill this cache entry on identical terms.
  const sessionsQuery = useQuery({
    ...sessionListQueryOptions({ transport, queryClient }, selectedCwd),
    enabled: selectedCwd !== null,
  });

  return {
    sessions: sessionsQuery.data ?? [],
    isLoading: sessionsQuery.isLoading,
    /**
     * True once the list is a real answer rather than an absent one. The query
     * is disabled until a working directory is chosen, and a disabled query
     * reports `isLoading: false` with no data — so `sessions.length === 0` on
     * its own cannot tell "this project has no sessions" from "nobody asked
     * yet". Anything that makes a positive claim about emptiness must gate on
     * this instead of on the array's length.
     */
    isAnswered: selectedCwd !== null && !sessionsQuery.isLoading && !sessionsQuery.isError,
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
 * in the {@link sessionKeys.list} cache, the same server-authoritative,
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
