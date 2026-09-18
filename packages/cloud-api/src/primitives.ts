import { z } from 'zod';

/**
 * The wire version this package describes. Every path in the contract is
 * prefixed with it, and the service serves `/v1` beside any future `/v2` for at
 * least two releases.
 */
export const WIRE_VERSION = 1 as const;

/** The `/v1` path prefix every route in this contract is served under. */
export const WIRE_PATH_PREFIX = '/v1' as const;

/**
 * The header every request and response carries, so a proxy or a log can tell
 * which contract a call belongs to without parsing its path.
 */
export const WIRE_VERSION_HEADER = 'X-DorkOS-Wire' as const;

/** The value of {@link WIRE_VERSION_HEADER} for this contract. */
export const WIRE_VERSION_HEADER_VALUE = String(WIRE_VERSION);

/**
 * An ISO-8601 timestamp with an explicit offset.
 *
 * Every time in this contract is absolute. A local time without an offset is
 * ambiguous on the wire and is rejected.
 */
export const TimestampSchema = z.iso
  .datetime({ offset: true })
  .describe('An ISO-8601 instant with an explicit UTC offset.');

/**
 * An opaque server-issued identifier.
 *
 * Opaque means exactly that: clients compare, store and echo these, and never
 * parse, order or enumerate them. Nothing in this package narrows an id to a
 * set of values — see the package README on catalog blindness.
 */
export const IdSchema = z
  .string()
  .min(1)
  .describe('An opaque server-issued identifier. Clients never parse or enumerate it.');

/**
 * An integer count of micro-units carried as a string.
 *
 * Money never crosses this wire as a JavaScript number. A `number` loses
 * precision above 2^53 micro-units and invites float arithmetic in a renderer,
 * so every amount is the exact integer, base-10, as text.
 */
export const MicroAmountSchema = z
  .string()
  .regex(
    /^-?(0|[1-9][0-9]*)$/,
    'must be a base-10 integer count of micro-units carried as a string'
  )
  .describe(
    'An exact integer count of micro-units, carried as a string so no value goes through a JavaScript number.'
  );

/**
 * A strictly positive integer count of micro-units carried as a string.
 *
 * The same unit and the same spelling as {@link MicroAmountSchema}, narrowed to
 * the amounts a purchase can be made of: no zero, no negative, no leading zero.
 * A request that names an amount uses this; a balance that reports one uses
 * {@link MicroAmountSchema}, because a reported position can legitimately be
 * zero or negative.
 *
 * The contract publishes no minimum and no ceiling. Both are server policy, and
 * a request under or over one is refused with a `Problem` rather than described
 * here.
 */
export const PositiveMicroAmountSchema = z
  .string()
  .regex(
    /^[1-9][0-9]*$/,
    'must be a positive base-10 integer count of micro-units carried as a string'
  )
  .describe(
    'A strictly positive exact integer count of micro-units, carried as a string so no amount goes through a JavaScript number.'
  );

/**
 * A value returned once and never again.
 *
 * Marks a field the caller must persist at the moment it is received: a token,
 * a credential, a one-time secret. The server cannot re-issue it, and a client
 * that logs it has leaked it. Consumers hold these as credential references,
 * never as configuration strings.
 */
export const SecretValueSchema = z
  .string()
  .min(1)
  .describe(
    'A credential returned exactly once. Store it as a credential reference; never log it or persist it as configuration.'
  );

/**
 * An opaque pagination cursor.
 *
 * Supplied by a previous page's `nextCursor`, passed back verbatim. It encodes
 * server-side position and carries no meaning a client may read.
 */
export const CursorSchema = z
  .string()
  .min(1)
  .describe('An opaque pagination cursor, passed back verbatim from a previous page.');

/** Query parameters every cursor-paginated collection accepts. */
export const PageParamsSchema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Maximum items in the page. The server may return fewer, and clamps anything larger.'
      ),
  })
  .describe('Cursor pagination parameters, shared by every collection in this contract.');

/** Cursor pagination parameters accepted by every collection route. */
export type PageParams = z.infer<typeof PageParamsSchema>;

/**
 * Wraps an item schema in the cursor-paginated page envelope every collection
 * in this contract returns.
 *
 * @param item - The schema for one element of the page.
 * @param description - What this particular page contains, for the generated types.
 */
export function pageOf<T extends z.ZodTypeAny>(item: T, description: string) {
  return z
    .object({
      items: z.array(item),
      nextCursor: CursorSchema.nullable().describe(
        'The cursor for the next page, or null when this is the last page.'
      ),
    })
    .describe(description);
}
