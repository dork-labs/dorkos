/**
 * When a session-scoped request is allowed to leave the client.
 *
 * @module shared/lib/session-request-scope
 */

/**
 * Whether a session request knows everything the server needs to answer it.
 *
 * Every per-session endpoint is scoped by BOTH the session id and the working
 * directory: without the directory the server resolves its own default root,
 * finds the session outside it, and refuses. The working directory arrives a
 * moment after the first render — the app store starts at `null` and is filled
 * in from `?dir=` or the server default — so a query that only waits for the
 * session id fires once into that gap, fails, and then fires again correctly
 * when the directory lands. Two requests per navigation, one of them guaranteed
 * to error, and a console error each time (DOR-495).
 *
 * Use this in the `enabled` gate of any query keyed by `[..., sessionId, cwd]`,
 * so no request goes out with an incomplete key.
 *
 * @param sessionId - The active session id, or null when none is selected.
 * @param cwd - The selected working directory, or null while it resolves.
 */
export function isSessionRequestReady(sessionId: string | null, cwd: string | null): boolean {
  return sessionId !== null && cwd !== null;
}
