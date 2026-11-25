/**
 * The `/r/<dork-uri>` link (DOR-5046), as the client reaches it. A slice of the
 * `Transport` (`transport-slices.ts`).
 *
 * @module shared/transport-dork-links
 */
import type { ResolvedDorkLink } from './dork-link-schemas.js';

/** Find what a `dork:` link opens. */
export interface DorkLinkTransport {
  /**
   * The kind and ids a `dork:` reference opens, for the caller. Rejects with a
   * 404 when it opens nothing this caller may see: unknown, private and
   * malformed all answer the same.
   *
   * @param uri - The `dork:` string, as `dorkUriFromLink` read it from the link.
   */
  resolveDorkLink(uri: string): Promise<ResolvedDorkLink>;
}
