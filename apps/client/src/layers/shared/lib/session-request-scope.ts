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
 * **Mostly superseded — one caller left.** The server now resolves a session's
 * own directory when a request omits `?cwd=` (DOR-1322, DOR-1444), so for the
 * session-scoped reads a null directory became an answerable question rather
 * than an incomplete one; they moved to `isSessionScopeReady` +
 * `useSessionScopedCwd`, which waits only on a directory that is genuinely
 * still arriving. This predicate survives for `useSessionDetail` alone, which
 * is keyed into a shared cache other writers patch BY DIRECTORY
 * (`syncSessionDetailCache`), so a null key there would silently stop
 * receiving those patches rather than merely fetching differently. Do not add
 * callers; use the entity hook.
 *
 * @param sessionId - The active session id, or null when none is selected.
 * @param cwd - The selected working directory, or null while it resolves.
 */
export function isSessionRequestReady(sessionId: string | null, cwd: string | null): boolean {
  return sessionId !== null && cwd !== null;
}
