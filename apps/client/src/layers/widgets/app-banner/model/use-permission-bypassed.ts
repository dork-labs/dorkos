import { useQueryClient } from '@tanstack/react-query';
import type { PermissionMode } from '@dorkos/shared/types';

interface SessionData {
  permissionMode?: PermissionMode;
}

/**
 * Whether the given session is running with every permission bypassed. Reads the
 * session from the query cache (populated by the chat session hooks) so it costs
 * nothing extra; returns false when there is no session or it is not in bypass
 * mode. Shared by the permission banner and its descriptor hook so both agree on
 * a single eligibility check.
 *
 * @param sessionId - The active session id, or null when none is selected.
 */
export function usePermissionBypassed(sessionId: string | null): boolean {
  const queryClient = useQueryClient();
  if (!sessionId) return false;
  const session = queryClient.getQueryData<SessionData>(['session', sessionId]);
  return session?.permissionMode === 'bypassPermissions';
}
