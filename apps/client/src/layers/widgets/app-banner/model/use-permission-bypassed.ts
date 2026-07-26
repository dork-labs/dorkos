import { useSessionPermissionMode } from '@/layers/entities/session';
import { isBypassPermissionMode } from '@/layers/shared/lib';
import { useSafePathname } from '@/layers/shared/model';

/**
 * Whether the given session is running with every permission bypassed — the
 * agent executes any tool without asking. Reads the session entity's one
 * permission-mode source rather than deriving it again, so the banner can never
 * stay quiet about a session the status line is already flagging. Returns false
 * when there is no session or it is not in a bypass mode.
 *
 * The banner is a passive reporter: it fetches the session row only on the route
 * that displays that session (the Obsidian embed is always one). Everywhere else
 * it still tracks the cache and warns off whatever is in it, but it does not go
 * request a row for a page — `/agents`, `/marketplace` — that shows nothing
 * about the session.
 *
 * @param sessionId - The active session id, or null when none is selected.
 */
export function usePermissionBypassed(sessionId: string | null): boolean {
  const isSessionRoute = useSafePathname() === '/session';
  return isBypassPermissionMode(useSessionPermissionMode(sessionId, { enabled: isSessionRoute }));
}
