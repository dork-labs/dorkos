/**
 * Message-search Transport methods (HTTP adapter) — one read, no writes
 * (spec `message-search` §8, `GET /api/search`), through the generated API
 * client (DOR-5473).
 *
 * @module shared/lib/transport/search-methods
 */
import type { SearchQuery, SearchResponse } from '@dorkos/shared/search-schemas';
import { createTransportApiClient } from './api-client';

/** Create the message-search methods bound to a base URL. */
export function createSearchMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    search(query: SearchQuery): Promise<SearchResponse> {
      // The client drops `undefined`, which is what the route wants: an
      // omitted `source` searches everything the caller may read, and an
      // omitted `limit` takes the server's default. Sending the words
      // `undefined` would be an unknown source and a 400.
      // The envelope goes back untouched, `warnings` included — a source that
      // is behind is a 200 the box renders a line for, not an error.
      return api.call('search.list', {
        query: { q: query.q, limit: query.limit, source: query.source },
      });
    },
  };
}
