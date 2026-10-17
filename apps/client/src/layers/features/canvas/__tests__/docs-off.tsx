/**
 * `@/layers/features/docs` with the Docs experiment off, for canvas tests.
 *
 * Reading the experiment needs the server config (a transport and a query
 * client) that most canvas tests do not serve. Off is also the default, and
 * Docs' own behaviour is tested in `features/docs`. Use it as
 * `vi.mock('@/layers/features/docs', () => import('./docs-off'))`.
 *
 * @module features/canvas/__tests__/docs-off
 */

/** Docs off: the editor gets no wiki links. */
export function useDocWikiLinks(): undefined {
  return undefined;
}

/** Docs off: the editor gets no embeds. */
export function useDocEmbeds(): undefined {
  return undefined;
}

/** Docs off: no "Save as web page". */
export function SaveAsWebPageButton(): null {
  return null;
}
