/**
 * Message-search Transport methods (in-process adapter) — the embed's half of
 * `Transport.search` (message-search spec §8, task 5.3 / DOR-691).
 *
 * The HTTP twin (`transport/search-methods.ts`) turns a query into
 * `GET /api/search` and hands the envelope back untouched. This one has no route
 * to call: a host wires the server's search service into
 * {@link DirectTransportServices.search}, and the same index answers in the same
 * process.
 *
 * **It carries no access rule and adds no filter.** The seam answers with the
 * scope the server resolved for the operator, and all this does is unwrap it. A
 * `.filter()` in this file would be a rule the route does not have; a widening
 * here would be one the route refuses.
 *
 * **A refusal is raised in the shape `fetchJSON` raises one** — `message`,
 * `code`, `status` and the parsed `body` — because the surfaces above this do
 * not know which transport they are on. `useMessageSearch` renders `error` and
 * the box draws the sentence; a plain `Error` here would show a person a
 * different answer to the same typo depending on which window they were in.
 *
 * **An unwired seam refuses too, and never answers emptily.** No host ships one
 * yet (see {@link DirectTransportServices.search}), and the embed's search
 * surfaces are gated off for exactly that reason — so nothing reaches this in
 * practice. It still has to be honest if something does: an empty result list is
 * indistinguishable from "no matches", which is the silent failure this whole
 * feature refuses everywhere else.
 *
 * @module shared/lib/direct/search-methods
 */
import type { SearchAnswer, SearchQuery, SearchResponse } from '@dorkos/shared/search-schemas';
import type { DirectTransportServices } from './services';

/** What a search says when this window has no index behind it. */
const NO_INDEX_HERE =
  'This window has no copy of your message history to search. Open DorkOS in a browser to search what was said.';

/** The code a caller can branch on when no index was ever wired. */
export const SEARCH_INDEX_UNAVAILABLE = 'SEARCH_INDEX_UNAVAILABLE';

/** Create the in-process message-search methods for the embedded transport. */
export function createDirectSearchMethods(services: DirectTransportServices) {
  return {
    async search(query: SearchQuery): Promise<SearchResponse> {
      const answer: SearchAnswer = services.search
        ? await services.search.search(query)
        : { ok: false, status: 503, error: NO_INDEX_HERE, code: SEARCH_INDEX_UNAVAILABLE };
      if (answer.ok) return answer.response;
      throw asHttpShapedError(answer);
    },
  };
}

/**
 * The error a refused search throws, matching `fetchJSON`'s exactly.
 *
 * @param refusal - The refusal the search contract produced.
 * @returns An `Error` carrying `code`, `status` and `body`, the three properties
 *   an HTTP refusal arrives with.
 */
function asHttpShapedError(refusal: Extract<SearchAnswer, { ok: false }>): Error {
  const err = new Error(refusal.error) as Error & {
    code?: string;
    status?: number;
    body?: unknown;
  };
  err.code = refusal.code;
  err.status = refusal.status;
  err.body = { error: refusal.error, code: refusal.code };
  return err;
}
