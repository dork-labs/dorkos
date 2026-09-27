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
    'An exact integer count of micro-units, carried as a string so no value goes through a JavaScript number. A micro-unit is a millionth of the major unit of the currency the response names.'
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
 * The metadata key that says what kind of amount a field carries.
 *
 * Set with `.meta()` on {@link MoneyMicroSchema} and {@link CreditMicroSchema},
 * so it reaches the generated JSON Schema as an `amountKind` keyword as well as
 * the runtime registry (`z.globalRegistry.get(schema)`). A renderer reads it to
 * decide whether an amount is shown as money or as credits.
 */
export const AMOUNT_KIND_META = 'amountKind' as const;

/**
 * The two kinds of amount this contract carries.
 *
 * Mechanism, not catalog: it says how an amount is counted, never what anybody
 * bought.
 */
export const AmountKindSchema = z
  .enum(['money', 'credit'])
  .describe(
    'What an amount counts: money paid, refunded, offered or capped, or credits held, spent or priced.'
  );

/** What an amount counts. */
export type AmountKind = z.infer<typeof AmountKindSchema>;

const INTEGER_STRING = /^-?(0|[1-9][0-9]*)$/;
const POSITIVE_INTEGER_STRING = /^[1-9][0-9]*$/;

/**
 * An amount of money, as an exact integer count of micro-units carried as a
 * string.
 *
 * The same wire shape and the same TypeScript type as {@link MicroAmountSchema};
 * only the description and the {@link AMOUNT_KIND_META} mark differ. Render it
 * in the response's `denomination.currency`, never as credits.
 */
export const MoneyMicroSchema = z
  .string()
  .regex(INTEGER_STRING, 'must be a base-10 integer count of micro-units carried as a string')
  .describe(
    "An exact integer count of micro-units of the response's currency: money paid, refunded, offered or capped."
  )
  .meta({ [AMOUNT_KIND_META]: 'money' });

/**
 * A strictly positive amount of money: the shape of an amount a purchase is
 * made of.
 *
 * The same wire shape as {@link PositiveMicroAmountSchema}, marked as money.
 */
export const PositiveMoneyMicroSchema = z
  .string()
  .regex(
    POSITIVE_INTEGER_STRING,
    'must be a positive base-10 integer count of micro-units carried as a string'
  )
  .describe(
    'A strictly positive exact integer count of micro-units of money to be paid, in the currency the service names.'
  )
  .meta({ [AMOUNT_KIND_META]: 'money' });

/**
 * An amount of credits, as an exact integer count of micro-units carried as a
 * string.
 *
 * The same wire shape and the same TypeScript type as {@link MicroAmountSchema};
 * only the description and the {@link AMOUNT_KIND_META} mark differ. Divide by
 * the response's `denomination.microPerCredit` to get credits. The scale is
 * served, never assumed: this package publishes no value for it.
 */
export const CreditMicroSchema = z
  .string()
  .regex(INTEGER_STRING, 'must be a base-10 integer count of micro-units carried as a string')
  .describe(
    "An exact integer count of micro-units of the response's currency, counted as credits: divide by the response's denomination.microPerCredit to get credits."
  )
  .meta({ [AMOUNT_KIND_META]: 'credit' });

/**
 * The unit a response's amounts are in: which currency the micro-units are
 * millionths of, and how many of them one credit is.
 *
 * Served by the service at runtime on every response that carries an amount.
 * This package publishes no value for either field, and a client never
 * hard-codes one. A response without it came from an older service; a client
 * that receives none shows that it could not read the amount rather than
 * guessing a unit.
 */
export const DenominationSchema = z
  .object({
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'must be an ISO 4217 currency code')
      .describe('An ISO 4217 code. Rendered, never enumerated.'),
    microPerCredit: PositiveMicroAmountSchema.describe(
      'How many micro-units of currency one credit is. Served by the service; a client never hard-codes it.'
    ),
  })
  .describe(
    'The unit these amounts are in: the currency their micro-units are millionths of, and how many micro-units one credit is.'
  );

/** The unit a response's amounts are in. */
export type Denomination = z.infer<typeof DenominationSchema>;

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

/**
 * A link a person may be sent to: `https:` and nothing else.
 *
 * A plain `url()` accepts any scheme, including `javascript:`, `file:` and
 * `data:`, and a link this contract hands to a browser must never be one of
 * those. The scheme is checked twice on purpose: once by the URL parser, and
 * once as a `pattern` that reaches the generated JSON Schema, so a consumer
 * validating from the JSON Schema alone refuses the same values.
 */
export const HttpsUrlSchema = z
  .url({ protocol: /^https$/ })
  .regex(/^https:\/\//, 'must be an https: link')
  .describe('An absolute https: link. Any other scheme is refused.');

/**
 * A link to a server the DorkOS app talks to: `https:`, or plain `http:` to
 * this machine's loopback address only.
 *
 * Loopback `http:` is allowed so a service and a server running side by side on
 * one machine (development, a self-hosted test) can describe each other. Any
 * other `http:` host, and every other scheme, is refused.
 */
export const ServerUrlSchema = z
  .url({ protocol: /^https?$/ })
  .regex(
    /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?([/?#]|$))/,
    'must be an https: link, or http: to a loopback address'
  )
  .describe('An absolute https: link, or an http: link to a loopback address only.');

/**
 * The metadata key that marks a field as a one-time credential.
 *
 * Set on a schema with `.meta()`, so it reaches the generated JSON Schema as
 * well as the runtime registry (`z.globalRegistry.get(schema)`). A consumer
 * that relays a response (the DorkOS server relaying to its browser, for
 * instance) can refuse to pass any marked field on, and this package's tests
 * prove marked fields appear only where the contract says they may.
 */
export const ONE_TIME_CREDENTIAL_META = 'x-dorkos-one-time-credential' as const;

/**
 * What a tolerant enum field reads as when the service sends a value this
 * release does not know.
 */
export const UNRECOGNISED = 'unrecognised' as const;

/**
 * Wraps a published enum so a value added in a later release reads as
 * {@link UNRECOGNISED} instead of failing the whole response.
 *
 * The additive rule lets the service add enum members in a minor release. For
 * a field inside a list or a poll, a strict enum would turn one new state on
 * one item into a failed parse of the whole page. This keeps every other item
 * and gives the app one value to render generically ("in a state this version
 * does not know"). A value that is not a string at all still fails: tolerance
 * is for new members, not for a broken response. The known set stays published
 * as the wrapped enum itself, so a consumer can still narrow on it.
 *
 * @param known - The published enum of known members.
 */
export function tolerantEnum<T extends z.ZodEnum>(known: T) {
  return z.union([
    known,
    z
      .string()
      .transform((): typeof UNRECOGNISED => UNRECOGNISED)
      .describe('A value this release does not know. It reads as unrecognised.'),
  ]);
}
