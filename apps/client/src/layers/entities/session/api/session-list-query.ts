/**
 * The one definition of "fetch the sessions in this working directory".
 *
 * It is shared rather than inlined because two different things ask it: the
 * {@link useSessions} hook, which keeps the rail painted, and
 * `resolveSessionForCwd`, which has to answer "which conversation does this
 * agent open on?" for a directory this window has never displayed. A second
 * hand-rolled fetch would land the same rows in the same cache entry WITHOUT
 * refreshing the detail cache beside it — the exact split that let one cache
 * outrank the other with older news (DOR-496).
 *
 * @module entities/session/api/session-list-query
 */
import type { QueryClient } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { Session, SessionListWarning } from '@dorkos/shared/types';
// Same-slice imports via sibling modules (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionKeys } from './query-keys';
import { syncSessionDetailCache } from '../lib/sync-session-detail-cache';

/** What the session-list query needs to run: somewhere to ask, somewhere to write. */
export interface SessionListQueryDeps {
  /** Transport the list is fetched over. */
  transport: Transport;
  /** Query client the sibling warnings + detail caches are written through. */
  queryClient: QueryClient;
}

/**
 * Cache key for the per-runtime listing warnings that ride the session list.
 * Deliberately outside {@link sessionKeys.listRoot}: every entry under that
 * prefix is swept as a `Session[]`, and this one is not (DOR-497).
 *
 * @param cwd - The working directory, or null for the default one.
 */
export function sessionListWarningsKey(cwd: string | null) {
  return ['session-list-warnings', cwd] as const;
}

/**
 * Query options for one working directory's session list.
 *
 * The transport returns the aggregated-list envelope `{ sessions, warnings? }`
 * (ADR-0310). It is unwrapped here: this cache deliberately stays `Session[]`
 * because many consumers (router loader, submit hook, global stream bridge,
 * rename) read and patch it as a bare array. The per-runtime `warnings` ride a
 * sibling cache entry and surface through `useSessionListWarnings`.
 *
 * @param deps - Transport to fetch over and query client to write through.
 * @param cwd - The working directory, or null for the default one.
 */
export function sessionListQueryOptions(deps: SessionListQueryDeps, cwd: string | null) {
  return {
    queryKey: sessionKeys.list(cwd),
    queryFn: async (): Promise<Session[]> => {
      // Taken BEFORE the request: these rows describe the server as it was when
      // it answered, which is no later than now and no earlier than this. The
      // detail-cache sync needs that lower bound to tell an answer that predates
      // a settings PATCH from one that supersedes it (DOR-496).
      const observedAt = Date.now();
      const { sessions, warnings } = await deps.transport.listSessions(cwd ?? undefined);
      deps.queryClient.setQueryData<SessionListWarning[]>(
        sessionListWarningsKey(cwd),
        warnings ?? []
      );
      // These rows are the same answer the detail endpoint gives, so any detail
      // entry they cover is refreshed too. A refetch triggered from elsewhere —
      // a Claude account switch, a rename from a profile — would otherwise leave a
      // frozen detail entry outranking a list row that had just been corrected.
      syncSessionDetailCache(deps.queryClient, sessions, observedAt);
      return sessions;
    },
  };
}
