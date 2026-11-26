/**
 * The `/api` 404's sentence (`http/unclaimed.ts`), in a file that imports
 * nothing, so a capability door that answers the same 404 can say it too.
 *
 * @module http/problems/api-not-found
 */

/** The `/api` 404's explanation. */
export const API_NOT_FOUND_DETAIL = 'This server has no API route at that path.';
