import { useSessions } from './use-sessions';

/**
 * Resolve the runtime type that owns a session, from the session's row in
 * the `['sessions', cwd]` list cache (server-authoritative and live-updated
 * by the global session stream).
 *
 * Returns `undefined` when the session has no row yet — a loader-minted id
 * whose first message has not been sent, or a session outside the selected
 * working directory. A session is not bound to a runtime until the server
 * lists it, so callers own the fallback (typically the server-default
 * runtime via `useCapabilitiesForRuntime(null)`).
 *
 * Deliberately not a fetch: the runtime-type endpoint infers-on-miss (it
 * never 404s), so a pre-launch fetch cached forever could pin the wrong
 * runtime for the session's lifetime. The list cache carries the same fact
 * without that trap (spec additional-agent-runtimes, task 4.2 fold-in).
 *
 * @param sessionId - Session id, or nullish when no session context exists
 */
export function useSessionRuntime(sessionId: string | null | undefined): string | undefined {
  const { sessions } = useSessions();
  if (!sessionId) return undefined;
  return sessions.find((s) => s.id === sessionId)?.runtime;
}
