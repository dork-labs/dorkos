/**
 * The whole of "answer a search", above the caller and below the wire
 * (message-search spec §6.1, §7; DOR-691).
 *
 * `GET /api/search` used to hold this itself, and that was fine while HTTP was
 * the only way in. It is not any more: the Obsidian embed reaches the same index
 * in-process through `DirectTransport`, with no route between it and the service.
 * So everything the route decided ONCE THE CALLER WAS KNOWN — what a malformed
 * query is refused with, what an unregistered source is refused with, what a
 * missing `limit` defaults to — lives here, where both surfaces call it.
 *
 * **It never resolves a caller and never widens one.** The scope arrives as data
 * from whoever knows who is asking: the route from `resolveCaller` plus the rooms
 * domain, the embed from the operator it is by construction. This module cannot
 * tell the two apart, which is exactly why the embed cannot be the laxer of the
 * two.
 *
 * @module server/services/search/answer-search
 */
import type { Db } from '@dorkos/db';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MIN_QUERY_LENGTH,
  SearchQuerySchema,
  type SearchAnswer,
} from '@dorkos/shared/search-schemas';
import { SEARCH_SOURCES } from './registry.js';
import { searchForCaller, type SearchScope } from './search-service.js';

/**
 * Answer one search for one already-resolved caller.
 *
 * @param db - The database holding the index.
 * @param scope - What this caller may see, resolved by whoever knows who they
 *   are. Never derived here.
 * @param raw - The request as it arrived: an Express query object, or the
 *   `SearchQuery` an in-process caller handed the Transport. Parsed rather than
 *   trusted in both cases — a typed caller can still be a stale build.
 * @returns The envelope, or the refusal the HTTP route would have sent.
 */
export function answerSearch(db: Db, scope: SearchScope, raw: unknown): SearchAnswer {
  const parsed = SearchQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: refusalFor(parsed.error.issues[0]?.path[0]),
      code: 'INVALID_SEARCH_QUERY',
    };
  }

  const { q, limit, source } = parsed.data;
  if (source !== undefined && !SEARCH_SOURCES.some((registered) => registered.id === source)) {
    return {
      ok: false,
      status: 400,
      error: `There is nothing here called '${source}'. Searchable sources are: ${SEARCH_SOURCES.map((registered) => registered.id).join(', ')}.`,
      code: 'UNKNOWN_SEARCH_SOURCE',
    };
  }

  return {
    ok: true,
    response: searchForCaller(db, scope, {
      query: q,
      limit: limit ?? SEARCH_DEFAULT_LIMIT,
      ...(source !== undefined && { source }),
    }),
  };
}

/**
 * The sentence that says what was actually wrong with the request.
 *
 * Three fields can fail and they fail for unrelated reasons, so one message for
 * all of them tells two callers out of three something untrue — a `limit=0` is
 * not a query that was too short. The FIELD is read from Zod's own issue path
 * rather than re-derived by re-checking the input here, which would be a second
 * copy of the schema's rules.
 *
 * **It fails closed**: a path this function does not recognise — a field added to
 * the schema without a sentence added here — falls to the general answer rather
 * than to no answer, so the request is still refused.
 *
 * @param field - The first failing key, from `issues[0].path`.
 * @returns One plain sentence, for the refusal body.
 */
function refusalFor(field: PropertyKey | undefined): string {
  switch (field) {
    case 'q':
      return `Search needs a word of at least ${SEARCH_MIN_QUERY_LENGTH} letters to look for.`;
    case 'limit':
      return 'How many results you want has to be a whole number above zero.';
    case 'source':
      return 'The source to search has to be a name, not an empty value.';
    default:
      return 'That search request could not be read.';
  }
}
