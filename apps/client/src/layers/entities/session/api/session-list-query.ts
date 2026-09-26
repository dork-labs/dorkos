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
import type { Session } from '@dorkos/shared/types';
// Same-slice imports via sibling modules (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionKeys } from './query-keys';
import { syncSessionDetailCache } from '../lib/sync-session-detail-cache';

/** What the session-list query needs to run: somewhere to ask, somewhere to write. */
export interface SessionListQueryDeps {
  /** Transport the list is fetched over. */
  transport: Transport;
  /** Query client used to refresh the detail cache. */
  queryClient: QueryClient;
}

/**
 * Query options for one working directory's session list.
 *
 * The transport returns the aggregated-list envelope `{ sessions, warnings? }`
 * (ADR-0310). It is unwrapped here: this cache deliberately stays `Session[]`
 * because many consumers (router loader, submit hook, global stream bridge,
 * rename) read and patch it as a bare array.
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
      const { sessions } = await deps.transport.listSessions(cwd ?? undefined);
      // These rows are the same answer the detail endpoint gives, so any detail
      // entry they cover is refreshed too. A refetch triggered from elsewhere —
      // a Claude account switch, a rename from a profile — would otherwise leave a
      // frozen detail entry outranking a list row that had just been corrected.
      syncSessionDetailCache(deps.queryClient, sessions, observedAt);
      return sessions;
    },
    // **Dropped wifi is not a reason to stop asking localhost.** TanStack's
    // default `networkMode: 'online'` PAUSES a fetch whenever
    // `navigator.onLine` is false, and this server is not on the internet —
    // the ruling `useConfig` states at length, applied here because the trust
    // dial reads this and a paused read left it with nothing to say
    // (DOR-2103).
    //
    // `as const` is load-bearing: this is a plain object literal rather than an
    // inline `useQuery({...})`, so without it the value widens to `string`,
    // stops matching TanStack's `NetworkMode` union, and collapses the inferred
    // `data` type at every call site (measured — it made `Session[]` implicitly
    // `any` in `ChatPanel`).
    networkMode: 'always' as const,
  };
}
