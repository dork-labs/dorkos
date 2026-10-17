/**
 * The doc index a space's wiki links resolve against (DOR-2982), as the
 * client reaches it. A slice of the `Transport` (`transport-slices.ts`).
 *
 * @module shared/transport-doc-links
 */
import type { DocIndex } from './doc-links.js';

/** Read the docs in one space. */
export interface DocLinksTransport {
  /**
   * Every doc reached from a working directory: path, title and slug. Rejects
   * with a 404 while the Docs experiment is off.
   *
   * @param cwd - The working directory the canvas reads files from.
   */
  getDocIndex(cwd: string): Promise<DocIndex>;
}
