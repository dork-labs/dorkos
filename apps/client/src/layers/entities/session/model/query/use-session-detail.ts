import { useEffect, useMemo } from 'react';
import { useSafeNavigate } from '@/layers/shared/model';
import { toSession } from '@/layers/shared/lib';
import { useSessionSearch } from '../navigation/use-session-search';
import { setSessionRouteContext } from '../navigation/session-route-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { useSessionRouteContext } from '../navigation/session-route-context';
import type { Session } from '@dorkos/shared/types';
// Same-slice imports via sibling modules (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionKeys } from '../../api/query-keys';
import { sessionDetailQueryOptions } from '../../api/session-detail-query';
import { findCachedSessionRow } from '../../lib/cached-session-row';

/** Options for {@link useSessionDetail}. */
export interface UseSessionDetailOptions<T> {
  /**
   * Whether this caller may fetch. Defaults to true. A caller that only reports
   * on a session someone else owns can pass false: the query still subscribes to
   * the cache and re-renders on writes, it just never issues a request of its
   * own.
   */
  enabled?: boolean;
  /**
   * Narrow the row to the part this caller uses. Without it the observer tracks
   * the whole row object, whose identity changes on every refetch and every
   * unrelated settings write — so a caller reading one field would re-render on
   * all of them.
   */
  select?: (session: Session) => T;
  /**
   * Optional legacy directory hint for a session owned by another surface.
   * Existing sessions normally resolve by identity on the server. The active
   * route supplies its resolved context; other callers omit this hint safely.
   */
  dir?: string;
  /**
   * For a surface that only names the chat, like a tab or a History row: read
   * once, never refetch on window focus, never retry a miss. Live title changes
   * still arrive, because the session stream merges fresh rows into every
   * cached detail entry. Without it, ten open chat tabs are ten reads each time
   * the window regains focus.
   */
  nameOnly?: boolean;
}

/**
 * The directory a session's detail is read under.
 *
 * Explicit legacy hints win; then this identity's resolved route context; then
 * the directory a cached row names. A tab reads its chat before the route
 * loader has installed the context, and asking under no directory cost a
 * second read of the row the loader was already fetching under the row's own
 * directory (DOR-2891). With nothing at all, null asks the server to resolve
 * it, never a global default.
 *
 * The cached row is looked up once per session, not on every render: a list
 * that lands after the read went out would otherwise move the read to a new
 * key and send it again.
 */
function useSessionReadCwd(sessionId: string | null, dir: string | undefined): string | null {
  const queryClient = useQueryClient();
  const context = useSessionRouteContext(sessionId);
  const cachedCwd = useMemo(
    () =>
      sessionId
        ? (findCachedSessionRow(queryClient, sessionId, { listsOnly: true })?.cwd ?? null)
        : null,
    [queryClient, sessionId]
  );
  if (dir !== undefined) return dir;
  if (context) return context.cwd;
  return cachedCwd;
}

/**
 * The session's detail row from the server, cached under the one key every
 * reader and writer shares, and nothing else: no router, no navigation. For a
 * surface that only names a chat, like a tab, which may sit outside any route
 * and must never steer one. {@link useSessionDetail} is this plus the active
 * route's draft hand-off.
 *
 * @param sessionId - The session id, or null for none (no request is made).
 * @param options - Fetch gate, field selector and directory override; see
 *   {@link UseSessionDetailOptions}.
 */
export function useSessionRow<T = Session>(
  sessionId: string | null,
  options?: UseSessionDetailOptions<T>
) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const cwd = useSessionReadCwd(sessionId, options?.dir);

  return useQuery({
    ...sessionDetailQueryOptions({ transport, queryClient }, sessionId, cwd),
    staleTime: options?.nameOnly ? Infinity : 30_000,
    ...(options?.nameOnly && { refetchOnWindowFocus: false, retry: false }),
    enabled: Boolean(sessionId) && (options?.enabled ?? true),
    select: options?.select,
  });
}

/**
 * The session's detail row from the server, cached under the one key every
 * reader and writer shares. Mount it from anywhere that needs a session's
 * settings — TanStack Query dedupes the request, so several surfaces reading
 * one session cost a single fetch and can never disagree.
 *
 * Also finishes a draft: once the active route's draft session exists on the
 * server, the URL drops its draft markers.
 *
 * @param sessionId - The active session id, or null when none is selected.
 *   When null the query is disabled and no request is made.
 * @param options - Fetch gate, field selector and directory override; see
 *   {@link UseSessionDetailOptions}.
 */
export function useSessionDetail<T = Session>(
  sessionId: string | null,
  options?: UseSessionDetailOptions<T>
) {
  const transport = useTransport();
  const context = useSessionRouteContext(sessionId);
  const cwd = useSessionReadCwd(sessionId, options?.dir);
  const navigate = useSafeNavigate();
  const search = useSessionSearch();
  // Settings PATCHes and optimistic list rows can make detail look successful
  // before the runtime has created anything. Only an actual native read counts.
  const native = useQuery<Session>({
    queryKey: sessionKeys.nativeDetail(sessionId, cwd),
    queryFn: () => transport.getSession(sessionId!, cwd ?? undefined),
    enabled: false,
    staleTime: Infinity,
  });
  const query = useSessionRow(sessionId, options);
  useEffect(() => {
    if (
      !navigate ||
      search.draft !== '1' ||
      search.session !== sessionId ||
      !query.isSuccess ||
      !native.data ||
      !context?.cwd
    )
      return;
    if (context.draft) setSessionRouteContext(sessionId!, { ...context, draft: false });
    void navigate({
      ...toSession((prev) => ({
        ...prev,
        draft: undefined,
        launchRef: undefined,
        agentId: undefined,
      })),
      replace: true,
    });
  }, [navigate, search.draft, search.session, sessionId, query.isSuccess, native.data, context]);
  return query;
}
