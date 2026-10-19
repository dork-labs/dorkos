/**
 * The doc index a space's wiki links resolve against (DOR-2982), as the
 * client reaches it. A slice of the `Transport` (`transport-slices.ts`).
 *
 * @module shared/transport-doc-links
 */
import type { DocIndex, DocResolve } from './doc-links.js';

/** Read the docs in one space, and find one beyond the index's limits. */
export interface DocLinksTransport {
  /**
   * Every doc reached from a working directory: path, title and slug. Rejects
   * with a 404 while the Docs experiment is off.
   *
   * @param cwd - The working directory the canvas reads files from.
   */
  getDocIndex(cwd: string): Promise<DocIndex>;
  /**
   * The doc one wiki-link target names, looked for through the whole space:
   * for a link a truncated index could not place.
   *
   * @param cwd - The working directory the canvas reads files from.
   * @param target - What the author typed before `#` and `|`.
   * @param from - The linking doc's path in the space, or `null`.
   */
  resolveDocLink(cwd: string, target: string, from: string | null): Promise<DocResolve>;
}
