import { useQuery } from '@tanstack/react-query';
import { useTransport, useAppStore } from '@/layers/shared/model';
import { isSessionRequestReady } from '@/layers/shared/lib';
import type { PermissionMode, Session } from '@dorkos/shared/types';
// Same-slice imports via sibling modules (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionKeys } from '../api/query-keys';
import { resolvePermissionMode } from '../lib/permission-mode';
import { useSessionSettingsOverride } from './session-settings-overrides';

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
   * Read a session belonging to a DIFFERENT working directory than the one this
   * window has selected.
   *
   * A session row is addressed by id **and** directory — the server resolves the
   * transcript under the agent's project path — so the id alone is not enough
   * for a caller talking about somebody else's session. Almost every caller is
   * reporting on the session the person is currently inside, which is what the
   * default (this window's `selectedCwd`) is for. A parked schedule is the
   * exception: it names the session that PROPOSED it, which is usually not the
   * one on screen, and without its own directory the lookup would either miss or
   * — worse — read a different agent's session that happens to share the id.
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
 *   When null the query is disabled and no request is made. The same holds
 *   while the working directory is still resolving — see
 *   {@link isSessionRequestReady}.
 * @param options - Fetch gate, field selector and directory override; see
 *   {@link UseSessionDetailOptions}.
 */
export function useSessionDetail<T = Session>(
  sessionId: string | null,
  options?: UseSessionDetailOptions<T>
) {
  const transport = useTransport();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  // The caller's directory wins when it named one. Both paths land in the same
  // key factory, so a session read under an explicit directory shares its cache
  // entry with the same session read while that directory is selected.
  const cwd = options?.dir ?? selectedCwd;

  return useQuery({
    queryKey: sessionKeys.detail(sessionId, cwd),
    queryFn: () => transport.getSession(sessionId!, cwd!),
    staleTime: 30_000,
    enabled: isSessionRequestReady(sessionId, cwd) && (options?.enabled ?? true),
    select: options?.select,
  });
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
  options?: { enabled?: boolean; fallback?: PermissionMode }
): PermissionMode | null {
  // Selected down to the mode itself: this feeds the app-wide banner slot, so an
  // observer tracking the whole row would re-render the shell every time an
  // unrelated field (model, effort, fast-mode) was written to the same session.
  const { data: confirmed } = useSessionDetail(sessionId, {
    enabled: options?.enabled,
    select: (session) => session.permissionMode,
  });
  const overrides = useSessionSettingsOverride(sessionId ?? '');

  if (!sessionId) return null;
  // `confirmed` reads off `Session.permissionMode`, which carries any id the
  // session's own runtime reports (DOR-851; `test-mode`'s ids sit outside the
  // enum on purpose). Safe to narrow back to `PermissionMode` here — this
  // hook feeds display surfaces that read meaning off descriptors, never off
  // the literal name.
  return resolvePermissionMode(
    overrides.permissionMode,
    confirmed ?? options?.fallback
  ) as PermissionMode;
}
