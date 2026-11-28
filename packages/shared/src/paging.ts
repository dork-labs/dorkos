/**
 * The one paging shape every list in the API uses (DOR-4982): a `cursor` and a
 * `limit` in the query, and `{ <plural noun>: [...], nextCursor }` back, with
 * `nextCursor` null on the last page. The REST paths and the agent tools read
 * the same fields.
 *
 * @module shared/paging
 */
import { z } from 'zod';

/** How many one page holds when the caller leaves `limit` out. */
export const PAGE_LIMIT_DEFAULT = 50;

/** The most one page of an ordinary list holds. */
export const PAGE_LIMIT_MAX = 200;

/** The page cursor field: the `nextCursor` of the page before. */
export const pageCursorInput = z
  .string()
  .min(1)
  .max(4096)
  .optional()
  .describe('The `nextCursor` of the page before; leave it out for the first page.');

/**
 * A page size field, 1 to `max`, {@link PAGE_LIMIT_DEFAULT} when left out.
 *
 * @param max - The most one page may hold.
 */
export function pageLimitInput(max: number = PAGE_LIMIT_MAX) {
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(max)
    .default(PAGE_LIMIT_DEFAULT)
    .describe(`How many this page holds, 1 to ${max}.`);
}

/**
 * A paging parameter a list used before the one shape, refused by name rather
 * than ignored, so an old caller gets a `400` saying to use `cursor` instead of
 * page one for ever. No aliases (ADR 261123-170832): it never pages.
 *
 * @param name - The old parameter's name, e.g. `before`.
 */
export function retiredPageParam(name: string) {
  const message = `${name} is no longer accepted: pass the last page's nextCursor as cursor.`;
  // A string that never passes, rather than `z.never()`, so the API document
  // and the tool catalog can still describe it (query values arrive as text).
  return z
    .string()
    .refine(() => false, { message })
    .optional()
    .describe(`Refused: \`${name}\` was removed; page with \`cursor\`.`);
}

/** The query fields of a page: where to go on from, and how many. */
export const PageQuerySchema = z.object({ cursor: pageCursorInput, limit: pageLimitInput() });

/** The query fields of a page, as parsed. */
export type PageQuery = z.infer<typeof PageQuerySchema>;

/** The `nextCursor` field of a page: pass it as `cursor` for the next one, null on the last. */
export const nextCursorOutput = z
  .string()
  .nullable()
  .describe('Pass as `cursor` for the next page; null on the last one.');

/** The sentence a refused page cursor answers with over HTTP, on hand routes and the mount alike. */
export const INVALID_CURSOR_DETAIL =
  'That cursor wasn’t given by this list. Leave it out to start again.';
