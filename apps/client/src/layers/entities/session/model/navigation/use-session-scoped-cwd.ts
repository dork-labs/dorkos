/**
 * Which working directory a SESSION's own reads are scoped to.
 *
 * Deliberately not the same question as "which directory is selected". The app
 * store's `selectedCwd` answers "where would new work happen" — the composer
 * launching a fresh conversation, the directory picker, the agent switcher —
 * and {@link useDefaultCwd} fills it with the SERVER's default as soon as
 * nothing else has. That default is a fine answer for new work and a wrong one
 * for a conversation that already exists somewhere else.
 *
 * The distinction became load-bearing with DOR-1444. Opening a session URL
 * without `&dir=` used to bind correctly for about one render — the stream
 * attached with no directory, which the server can now resolve from the
 * session's own live binding — and then `selectedCwd` flipped from `null` to
 * the server default, the stream re-attached carrying `?cwd=<default>`, and the
 * window was back to reading a directory the session is not in. The history and
 * task queries never even got the good render: they are keyed on `selectedCwd`,
 * so they fetched the default directory's transcript and found nothing.
 *
 * So a session-scoped read asks THIS hook, and gets `null` when nothing named a
 * directory — which is now a complete request the server answers by resolving
 * the session's real directory itself. Substituting a default here would
 * un-ask the question.
 *
 * @module entities/session/model/navigation/use-session-scoped-cwd
 */

import { useSessionSearch } from './use-session-search';

/** What a session-scoped request knows about where to look. */
export interface SessionScopedCwd {
  /**
   * The directory this session's reads are scoped to, or `null` when nothing
   * named one. `null` is an answer, not a gap — the server resolves the
   * session's own directory when a request omits `?cwd=`.
   */
  cwd: string | null;
}

/**
 * The directory the ACTIVE session's own reads should use.
 *
 * Standalone (web): the URL is the whole answer and it is available on the
 * first render. `?dir=` names the directory;
 * nothing named one means `null`.
 *
 * @returns The scoped directory.
 */
export function useSessionScopedCwd(): SessionScopedCwd {
  const search = useSessionSearch();
  return { cwd: search.dir ?? null };
}
