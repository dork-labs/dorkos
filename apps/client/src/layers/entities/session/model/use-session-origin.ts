import type { SessionOrigin } from '@dorkos/shared/types';
import { useSessions } from './use-sessions';

/** Result of {@link useSessionOrigin}: both fields absent for a user-origin session. */
export interface SessionOriginData {
  origin: SessionOrigin | undefined;
  originLabel: string | undefined;
}

/**
 * Resolve a session's origin (and its origin label) from the session's row
 * in the `['sessions', cwd]` list cache, the same server-authoritative,
 * live-updated cache {@link useSessionRuntime} reads. Deliberately not a
 * dedicated fetch: the session header chip reuses whatever the sidebar
 * already has cached rather than issuing a second request for data the app
 * already holds (session-origin-legibility).
 *
 * @param sessionId - Session id, or nullish when no session context exists
 */
export function useSessionOrigin(sessionId: string | null | undefined): SessionOriginData {
  const { sessions } = useSessions();
  const session = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  return { origin: session?.origin, originLabel: session?.originLabel };
}
