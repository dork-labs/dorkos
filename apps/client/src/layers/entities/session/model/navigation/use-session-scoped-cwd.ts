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
import { getPlatform } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { useSessionSearch } from './use-session-search';

/** What a session-scoped request knows about where to look. */
export interface SessionScopedCwd {
  /**
   * The directory this session's reads are scoped to, or `null` when nothing
   * named one. `null` is an answer, not a gap — the server resolves the
   * session's own directory when a request omits `?cwd=`.
   */
  cwd: string | null;
  /**
   * Whether {@link cwd} is settled. `false` only in the embedded host, where
   * the directory arrives asynchronously into the store; a request fired
   * against an unsettled directory is the double-fetch DOR-495 removed.
   */
  resolved: boolean;
}

/**
 * The directory the ACTIVE session's own reads should use.
 *
 * Standalone (web): the URL is the whole answer and it is available on the
 * first render, so this is always `resolved`. `?dir=` names the directory;
 * nothing named one means `null`.
 *
 * Embedded (Obsidian): there is no URL, so the store is the only channel and
 * `resolved` follows it — unchanged from the behaviour every session-scoped
 * query had before.
 *
 * @returns The scoped directory and whether it is settled.
 */
export function useSessionScopedCwd(): SessionScopedCwd {
  // Both sources are subscribed unconditionally to satisfy the rules of hooks,
  // the same shape `useDirectoryState` uses.
  const storeDir = useAppStore((s) => s.selectedCwd);
  const search = useSessionSearch();

  if (getPlatform().isEmbedded) return { cwd: storeDir, resolved: storeDir !== null };
  return { cwd: search.dir ?? null, resolved: true };
}

/**
 * Whether a session-scoped request knows everything it needs to go out.
 *
 * Replaces the older `isSessionRequestReady(sessionId, cwd)`, which treated a
 * null directory as "still loading" and held the request back. That was right
 * while every per-session endpoint required the directory; now that they
 * resolve it themselves, a null directory is a complete question and only an
 * UNSETTLED one is worth waiting for (DOR-495's double-fetch is still real in
 * the embedded host).
 *
 * @param sessionId - The active session id, or null when none is selected.
 * @param scoped - The answer from {@link useSessionScopedCwd}.
 */
export function isSessionScopeReady(sessionId: string | null, scoped: SessionScopedCwd): boolean {
  return sessionId !== null && scoped.resolved;
}
