import { isBypassPermissionMode, useSessionPermissionMode } from '@/layers/entities/session';

/**
 * Whether the given session is running with every permission bypassed — the
 * agent executes any tool without asking. Reads the session entity's one
 * permission-mode source rather than deriving it again, so the banner can never
 * stay quiet about a session the status line is already flagging. Returns false
 * when there is no session or it is not in a bypass mode.
 *
 * @param sessionId - The active session id, or null when none is selected.
 */
export function usePermissionBypassed(sessionId: string | null): boolean {
  return isBypassPermissionMode(useSessionPermissionMode(sessionId));
}
