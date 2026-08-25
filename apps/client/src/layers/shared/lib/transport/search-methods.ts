/**
 * Message-search Transport methods (HTTP adapter) — one read, no writes
 * (spec `message-search` §8, `GET /api/search`).
 *
 * @module shared/lib/transport/search-methods
 */
import type { SearchQuery, SearchResponse } from '@dorkos/shared/search-schemas';
import { buildQueryString, fetchJSON } from './http-client';

/** Create the message-search methods bound to a base URL. */
export function createSearchMethods(baseUrl: string) {
  return {
    search(query: SearchQuery): Promise<SearchResponse> {
      // `buildQueryString` drops `undefined`, which is what the route wants: an
      // omitted `source` searches everything the caller may read, and an
      // omitted `limit` takes the server's default. Sending the words
      // `undefined` would be an unknown source and a 400.
      const qs = buildQueryString({
        q: query.q,
        limit: query.limit,
        source: query.source,
      });
      // The envelope goes back untouched, `warnings` included — a source that
      // is behind is a 200 the box renders a line for, not an error.
      return fetchJSON<SearchResponse>(baseUrl, `/search${qs}`);
    },
  };
}
