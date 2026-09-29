import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport, useAppStore } from '@/layers/shared/model';
import { useSessionId } from '../navigation/use-session-id';
// Same-slice import via the sibling module (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionKeys } from '../../api/query-keys';
import { sessionListQueryOptions } from '../../api/session-list-query';
import { useSessionDetail } from './use-session-detail';
import type { Session, SessionOrigin, SessionStartedBy } from '@dorkos/shared/types';

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

/**
 * Who started a session, when an extension or another chat did (spec
 * `flow-multiproject` §7.7).
 *
 * Read from the session's detail row, the one the chat route already fetches
 * and the live session stream patches, and from the list while that row is on
 * its way. The detail row is the one that always answers: the list holds only
 * the chats of the folder this window has selected. A chat an extension started
 * runs in its project's root, which is often not that folder. Read-only
 * (`enabled: false`), for the reason the session header reads its title that
 * way: this reports on a row another surface owns.
 *
 * A chat it was started from is named by the server when it can be, and
 * otherwise by the title the list holds for it.
 *
 * @param sessionId - Session id, or nullish when no session context exists
 * @returns The starter, or null for a chat a person started.
 */
export function useSessionStartedBy(sessionId: string | null | undefined): SessionStartedBy | null {
  const { sessions } = useSessions();
  const { data: fromDetail } = useSessionDetail(sessionId ?? null, {
    enabled: false,
    select: (session) => session.startedBy ?? null,
  });
  // The list answers first when the chat is in the selected folder, so a
  // started chat's prompt folds from its first frame instead of flashing open
  // until the detail row lands.
  const fromList = sessionId ? sessions.find((s) => s.id === sessionId)?.startedBy : undefined;
  const startedBy = fromDetail ?? fromList ?? null;
  if (!startedBy) return null;
  if (startedBy.kind !== 'chat' || startedBy.title !== null) return startedBy;
  const parent = sessions.find((s) => s.id === startedBy.sessionId);
  return parent?.title ? { ...startedBy, title: parent.title } : startedBy;
}
