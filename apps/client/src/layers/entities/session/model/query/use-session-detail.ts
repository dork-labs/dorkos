import { useEffect } from 'react';
import { useSafeNavigate } from '@/layers/shared/model';
import { toSession } from '@/layers/shared/lib';
import { useSessionSearch } from '../navigation/use-session-search';
import { setSessionRouteContext } from '../navigation/session-route-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { useSessionRouteContext } from '../navigation/session-route-context';
import type { PermissionModeId, Session } from '@dorkos/shared/types';
// Same-slice imports via sibling modules (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionKeys } from '../../api/query-keys';
import { resolvePermissionMode } from '../../lib/permission-mode';
import { useSessionSettingsOverride } from '../settings/session-settings-overrides';

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
}

/**
 * The session's detail row from the server, cached under the one key every
 * reader and writer shares. Mount it from anywhere that needs a session's
 * settings — TanStack Query dedupes the request, so several surfaces reading
 * one session cost a single fetch and can never disagree.
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
  const queryClient = useQueryClient();

  // Explicit legacy hints win; otherwise use this identity's resolved context.
  // A missing context requests server-side resolution, never a global default.
  const context = useSessionRouteContext(sessionId);
  const cwd = options?.dir ?? context?.cwd ?? null;

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
  const query = useQuery({
    queryKey: sessionKeys.detail(sessionId, cwd),
    queryFn: async () => {
      const session = await transport.getSession(sessionId!, cwd ?? undefined);
      queryClient.setQueryData(sessionKeys.nativeDetail(sessionId, cwd), session);
      return session;
    },
    staleTime: 30_000,
    enabled: Boolean(sessionId) && (options?.enabled ?? true),
    select: options?.select,
    // **Dropped wifi is not a reason to stop asking localhost.** TanStack's
    // default `networkMode: 'online'` PAUSES a fetch whenever
    // `navigator.onLine` is false, and this server is not on the internet —
    // the ruling `useConfig` states at length, applied here because the trust
    // dial reads this and a paused read left it with nothing to say
    // (DOR-2103).
    networkMode: 'always',
  });
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

/**
 * A session's effective permission mode — the single client-side answer to
 * "will this agent ask me before it acts?". Subscribes to the session cache, so
 * a surface reading it re-renders the moment the mode changes, and honours a
 * change the person just made before the server has confirmed it.
 *
 * Returns null when no session is selected, which is not the same as `'default'`:
 * nothing is running, so there is nothing to say about it.
 *
 * Precedence, most trusted first: the change in flight, the detail row, then
 * whatever the caller already knew.
 *
 * @param sessionId - The active session id, or null when none is selected.
 * @param options.enabled - Whether this caller may fetch the row itself.
 *   Defaults to true; a passive reporting surface should pass false on pages
 *   that show nothing about the session, and a surface rendering a whole list
 *   of sessions must pass false or it costs one request per row.
 * @param options.fallback - The mode this caller already holds from somewhere
 *   else, typically its row in the session list. Used when the detail cache has
 *   nothing for this session — the normal case for any session the person is
 *   not currently inside. Without it such a caller would be told `'default'`,
 *   which is a specific claim about the session, not an absence of one.
 */
export function useSessionPermissionMode(
  sessionId: string | null,
  options?: { enabled?: boolean; fallback?: PermissionModeId }
): PermissionModeId | null {
  // Selected down to the mode itself: this feeds the app-wide banner slot, so an
  // observer tracking the whole row would re-render the shell every time an
  // unrelated field (model, effort, fast-mode) was written to the same session.
  const { data: confirmed } = useSessionDetail(sessionId, {
    enabled: options?.enabled,
    select: (session) => session.permissionMode,
  });
  const overrides = useSessionSettingsOverride(sessionId ?? '');

  if (!sessionId) return null;
  // A {@link PermissionModeId}, not the narrower enum: `confirmed` reads off
  // `Session.permissionMode`, which carries any id the session's own runtime
  // reports (`test-mode`'s ids sit outside the enum on purpose). Every surface
  // downstream reads meaning off the runtime's own descriptors or treats the id
  // as an opaque display string, so none of them needed the narrowing this used
  // to assert (DOR-851, DOR-885).
  return resolvePermissionMode(overrides.permissionMode, confirmed ?? options?.fallback);
}
