import { useQuery } from '@tanstack/react-query';
import { useTransport, useAppStore } from '@/layers/shared/model';
import type { PermissionMode } from '@dorkos/shared/types';
// Same-slice imports via sibling modules (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionKeys } from '../api/query-keys';
import { resolvePermissionMode } from '../lib/permission-mode';
import { useSessionSettingsOverride } from './session-settings-overrides';

/**
 * The session's detail row from the server, cached under the one key every
 * reader and writer shares. Mount it from anywhere that needs a session's
 * settings — TanStack Query dedupes the request, so several surfaces reading
 * one session cost a single fetch and can never disagree.
 *
 * @param sessionId - The active session id, or null when none is selected.
 *   When null the query is disabled and no request is made.
 */
export function useSessionDetail(sessionId: string | null) {
  const transport = useTransport();
  const selectedCwd = useAppStore((s) => s.selectedCwd);

  return useQuery({
    queryKey: sessionKeys.detail(sessionId, selectedCwd),
    queryFn: () => transport.getSession(sessionId!, selectedCwd ?? undefined),
    staleTime: 30_000,
    enabled: !!sessionId,
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
 */
export function useSessionPermissionMode(sessionId: string | null): PermissionMode | null {
  const { data: session } = useSessionDetail(sessionId);
  const overrides = useSessionSettingsOverride(sessionId ?? '');

  if (!sessionId) return null;
  return resolvePermissionMode(overrides.permissionMode, session?.permissionMode);
}
