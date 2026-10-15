/**
 * The one definition of "fetch this session's detail row".
 *
 * Shared because two things ask it: {@link useSessionRow}, which keeps a chat's
 * settings painted, and the `/session` route loader, which checks a chat it
 * opened from cache in the background (DOR-2891). Both landing in the same
 * cache entry through the same function is what lets TanStack Query answer the
 * second asker from the first one's request instead of sending another.
 *
 * @module entities/session/api/session-detail-query
 */
import type { QueryClient } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { Session } from '@dorkos/shared/types';
import { sessionKeys } from './query-keys';

/** What the detail query needs: somewhere to ask, somewhere to write. */
export interface SessionDetailQueryDeps {
  /** Transport the row is fetched over. */
  transport: Transport;
  /** Query client the native-read evidence is written to. */
  queryClient: QueryClient;
}

/**
 * Query options for one session's detail row, read under `cwd`.
 *
 * A successful read is also recorded as native evidence
 * ({@link sessionKeys.nativeDetail}): settings writes and optimistic rows can
 * make the detail entry look present before the runtime has created anything,
 * and only an actual server read proves the session exists.
 *
 * @param deps - Transport to fetch over and query client to write through.
 * @param sessionId - The session id. The query must be disabled while null.
 * @param cwd - The directory the session's reads name, or null to let the
 *   server resolve it.
 */
export function sessionDetailQueryOptions(
  deps: SessionDetailQueryDeps,
  sessionId: string | null,
  cwd: string | null
) {
  return {
    queryKey: sessionKeys.detail(sessionId, cwd),
    queryFn: async (): Promise<Session> => {
      const session = await deps.transport.getSession(sessionId!, cwd ?? undefined);
      deps.queryClient.setQueryData(sessionKeys.nativeDetail(sessionId, cwd), session);
      return session;
    },
    // **Dropped wifi is not a reason to stop asking localhost.** TanStack's
    // default `networkMode: 'online'` PAUSES a fetch whenever
    // `navigator.onLine` is false, and this server is not on the internet —
    // the ruling `useConfig` states at length, applied here because the trust
    // dial reads this and a paused read left it with nothing to say
    // (DOR-2103). `as const` keeps the literal type, as in
    // `sessionListQueryOptions`.
    networkMode: 'always' as const,
  };
}
