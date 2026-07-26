import { useQuery } from '@tanstack/react-query';
import { useTransport, useAppStore } from '@/layers/shared/model';
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
}

/**
 * The session's detail row from the server, cached under the one key every
 * reader and writer shares. Mount it from anywhere that needs a session's
 * settings — TanStack Query dedupes the request, so several surfaces reading
 * one session cost a single fetch and can never disagree.
 *
 * @param sessionId - The active session id, or null when none is selected.
 *   When null the query is disabled and no request is made.
 * @param options - Fetch gate and field selector; see {@link UseSessionDetailOptions}.
 */
export function useSessionDetail<T = Session>(
  sessionId: string | null,
  options?: UseSessionDetailOptions<T>
) {
  const transport = useTransport();
  const selectedCwd = useAppStore((s) => s.selectedCwd);

  return useQuery({
    queryKey: sessionKeys.detail(sessionId, selectedCwd),
    queryFn: () => transport.getSession(sessionId!, selectedCwd ?? undefined),
    staleTime: 30_000,
    enabled: !!sessionId && (options?.enabled ?? true),
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
 * @param sessionId - The active session id, or null when none is selected.
 * @param options.enabled - Whether this caller may fetch the row itself.
 *   Defaults to true; a passive reporting surface should pass false on pages
 *   that show nothing about the session.
 */
export function useSessionPermissionMode(
  sessionId: string | null,
  options?: { enabled?: boolean }
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
  return resolvePermissionMode(overrides.permissionMode, confirmed);
}
