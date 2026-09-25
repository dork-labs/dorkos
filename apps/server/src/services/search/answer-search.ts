/**
 * The whole of "answer a search", above the caller and below the wire
 * (message-search spec §6.1, §7; DOR-691).
 *
 * The route delegates its search decision here after resolving the caller:
 * malformed queries, unknown sources, and default limits are handled together.
 *
 * **It never resolves a caller and never widens one.** The scope arrives as data
 * from the route after `resolveCaller` and the rooms domain determine access.
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
 * @param raw - The Express query object, parsed rather than trusted.
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
