import { z } from 'zod';

import {
  CreditMicroSchema,
  DenominationSchema,
  IdSchema,
  MoneyMicroSchema,
  PositiveMoneyMicroSchema,
  TimestampSchema,
  tolerantEnum,
} from './primitives.js';

/**
 * The optional `denomination` every amount-bearing response carries.
 *
 * Optional so a response from an older service still parses. A client that
 * receives none must not guess a unit.
 */
const denominationField = DenominationSchema.optional().describe(
  'The unit these amounts are in. Absent from an older service; a client that receives none must not guess one.'
);

/**
 * How remote access works for the caller.
 *
 * Mechanism, not catalog: it says how the tunnel behaves, not what anybody
 * bought.
 */
export const RemoteAccessCapabilitySchema = z
  .enum(['byo', 'on_demand', 'always_available'])
  .describe(
    'How remote access works for the caller: their own tunnel, opened on demand, or always up.'
  );

/** Whether a custom address is unavailable, purchasable as an add-on, or already included. */
export const CustomAddressCapabilitySchema = z
  .enum(['none', 'addon', 'included'])
  .describe(
    'Whether a custom address is unavailable, available as an add-on, or already included.'
  );

/** Which support channel the caller reaches. */
export const SupportCapabilitySchema = z
  .enum(['community', 'priority'])
  .describe('Which support channel the caller reaches.');

/**
 * The seat block of the entitlement.
 *
 * There is deliberately no field here for a count of local agents. Local agents
 * are free and unlimited and no cloud surface counts them — the absence is part
 * of the contract, and `src/__tests__/catalog-blindness.test.ts` keeps it.
 */
export const EntitlementSeatsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    assigned: z.number().int().nonnegative(),
    byKind: z.object({
      person: z.number().int().nonnegative(),
      agent: z.number().int().nonnegative(),
    }),
  })
  .describe('Seat counts for the caller`s organization. Counts only.');

/**
 * The hosted-community block of the entitlement.
 *
 * Numbers, so the app can say how many more communities a person can start, or
 * grey out Start, without ever knowing what they bought. A null limit means
 * there is no fixed number: the count is not capped, or a community draws on
 * the account's shared storage rather than an allowance of its own.
 */
export const EntitlementCommunityLimitsSchema = z
  .object({
    maxCommunities: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        'How many hosted communities the account may keep open. Null means no fixed count.'
      ),
    maxMembersPerCommunity: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe('The most active members one hosted community may have. Null means no limit.'),
    maxStorageBytesPerCommunity: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        'The most bytes of files one hosted community may store. Null means communities draw on the account`s shared storage instead.'
      ),
  })
  .describe('The limits on the caller`s hosted communities. Counts and sizes only.');

/** The measurable limits of the caller`s entitlement. */
export const EntitlementLimitsSchema = z
  .object({
    personSeatsIncluded: z.number().int().nonnegative(),
    agentSeatsIncluded: z.number().int().nonnegative(),
    includedCreditsMicro: CreditMicroSchema,
    cloudHours: z.number().nonnegative(),
    storageGb: z.number().nonnegative(),
    remoteAccess: RemoteAccessCapabilitySchema,
    alwaysAvailableInstances: z.number().int().nonnegative(),
    customAddress: CustomAddressCapabilitySchema,
    managedConnectionActions: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        'Null means the allowance is counted per seat rather than for the organization as a whole.'
      ),
    support: SupportCapabilitySchema,
    emailAddressPerSeat: z.boolean(),
    communities: EntitlementCommunityLimitsSchema.optional().describe(
      'The limits on hosted communities. Absent means the service did not say.'
    ),
  })
  .describe(
    'The measurable limits of the caller`s entitlement. Interface behaviour is driven by these values, never by the plan identifier.'
  );

/**
 * `GET /v1/entitlements` — what the caller is allowed to do.
 *
 * A caller with no subscription gets 200 and the free entitlement, never a 404.
 * Somebody who has never touched billing is a valid caller and the normal case.
 *
 * `planId` is opaque. There is no compile-time exhaustiveness over plans here,
 * deliberately: a client renders `planDisplayName` and branches on the limit
 * values, never on the identifier.
 */
export const EntitlementsSchema = z
  .object({
    planId: IdSchema.describe(
      'An opaque identifier for the caller`s current subscription. Never switch on this value.'
    ),
    planDisplayName: z.string().describe('The server-supplied string to show a person.'),
    periodStart: TimestampSchema,
    periodEnd: TimestampSchema,
    limits: EntitlementLimitsSchema,
    used: z.object({
      personSeats: z.number().int().nonnegative(),
      agentSeats: z.number().int().nonnegative(),
      communities: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          'How many hosted communities count against `limits.communities.maxCommunities`. Absent means the service did not say.'
        ),
    }),
    seats: EntitlementSeatsSchema,
    canCreateSeat: z.boolean(),
    canInviteMember: z.boolean(),
    staleAt: TimestampSchema.describe('When this snapshot should be refetched.'),
    denomination: denominationField,
  })
  .describe(
    'What the caller is allowed to do. A caller with no subscription gets the free entitlement, never a 404.'
  );

/** What the caller is allowed to do. */
export type Entitlements = z.infer<typeof EntitlementsSchema>;

/**
 * `GET /v1/balance` — the caller`s credit position.
 *
 * `owedMicro` is not optional and not cosmetic: it is debt carried from a turn
 * that overran its reservation. When it is non-zero an interface must show it,
 * and a purchase that repays it renders the repayment as its own line before
 * the new balance rather than as a quietly smaller number.
 */
export const BalanceSchema = z
  .object({
    allowance: z.object({
      grantedMicro: CreditMicroSchema,
      remainingMicro: CreditMicroSchema,
      resetsAt: TimestampSchema,
    }),
    purchased: z.object({
      remainingMicro: CreditMicroSchema,
      holds: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          'How many first-purchase holds are in force. Absent means the server did not say; zero means none.'
        ),
    }),
    pendingMicro: CreditMicroSchema.optional().describe(
      'Credit the caller has paid for that is not spendable yet, because a hold is still in force. Absent means the server did not say.'
    ),
    heldMicro: CreditMicroSchema.describe('Reserved against turns currently running.'),
    owedMicro: CreditMicroSchema.describe(
      'Debt from a turn that overran its reservation. May be "0"; when it is not, show it.'
    ),
    autoReload: z.object({
      enabled: z.boolean(),
      ceilingMicro: MoneyMicroSchema.nullable(),
    }),
    denomination: denominationField,
  })
  .describe(
    'The caller`s credit position. Every amount is an exact integer of micro-units carried as a string, counted as credits except the auto-reload ceiling, which is money.'
  );

/** The caller`s credit position. */
export type Balance = z.infer<typeof BalanceSchema>;

/**
 * Where a usage line`s price came from.
 *
 * `published_price` is the published DorkOS price. It is a separate value from
 * `managed`, which means rates an organization configured for itself and
 * explicitly not a public price — rendering published prices under `managed`
 * would tell a person their rate is non-public, which inverts the meaning.
 */
export const CostBasisSchema = z
  .enum(['byo_key', 'managed', 'published_price'])
  .describe(
    'Where a usage line`s price came from: the caller`s own key, rates their organization configured, or the published DorkOS price.'
  );

/** Where a usage line`s price came from. */
export type CostBasis = z.infer<typeof CostBasisSchema>;

/**
 * How a credit or subscription position reads at a glance.
 *
 * Widened past subscription language on purpose: `exhausted` describes a credit
 * balance that has run out, which a subscription vocabulary has no word for.
 */
export const UsageStateSchema = z
  .enum(['inactive', 'active', 'grace', 'exhausted', 'unknown'])
  .describe('How a credit or subscription position reads at a glance.');

/** How to group a usage query. */
export const UsageGroupBySchema = z
  .enum(['seat', 'model', 'day'])
  .describe('How to group a usage query.');

/** `GET /v1/usage` query parameters. */
export const UsageQuerySchema = z
  .object({
    from: TimestampSchema,
    to: TimestampSchema,
    groupBy: UsageGroupBySchema,
  })
  .describe('The window and grouping for a usage query.');

/**
 * One row of the caller`s usage.
 *
 * Carries BOTH the upstream list price and what DorkOS charged, which means it
 * carries the difference between them. That is deliberate rather than
 * accidental: somebody paying for inference through DorkOS can see what the
 * routing costs them without having to ask. Dropping `listPriceMicro` is the
 * change that would undo it, and dropping a field is a `/v2` change.
 *
 * There is deliberately no supplier field and no price-list version identifier
 * here. Neither is published, and neither may be inferred client-side.
 */
export const UsageRowSchema = z
  .object({
    key: z
      .string()
      .describe(
        'The grouping key: an opaque seat identifier, an opaque model identifier, or a date.'
      ),
    displayName: z.string().describe('The server-supplied string to show for this row.'),
    units: z
      .number()
      .nonnegative()
      .describe('How much was used, in the unit the row is measured in.'),
    unit: z.string().describe('What `units` counts, as a server-supplied string.'),
    listPriceMicro: MoneyMicroSchema.describe('The upstream list price for this row.'),
    dorkosPriceMicro: CreditMicroSchema.describe('What DorkOS charged for this row.'),
    costBasis: CostBasisSchema,
  })
  .describe(
    'One row of the caller`s own usage, projected. No supplier and no price-list version appear here.'
  );

/**
 * One billing period of a charge that is not inference, such as storage
 * beyond what an account includes.
 *
 * Unlike an inference row it has no seat, no model and no upstream list price:
 * nothing is resold, so there is no difference to publish. `unit` and
 * `displayName` are server-supplied strings a client renders exactly as given,
 * so no unit, rate or allowance is named by this package.
 *
 * A period's edges fall on midnight UTC, and `periodEnd` is exclusive, so a
 * calendar month runs from the 1st to the 1st of the next month.
 */
export const OtherChargeRowSchema = z
  .object({
    periodStart: TimestampSchema.describe(
      'When this billing period started, inclusive. Midnight UTC.'
    ),
    periodEnd: TimestampSchema.describe(
      'When this billing period ends, exclusive: the first instant after it, at midnight UTC. A calendar month ends at the start of the next.'
    ),
    units: z
      .number()
      .nonnegative()
      .finite()
      .describe(
        'How much was charged for, in `unit`. The service rounds it to three decimal places.'
      ),
    unit: z.string().describe('What `units` counts, as a server-supplied string.'),
    displayName: z.string().describe('The server-supplied string to show for this charge.'),
    dorkosPriceMicro: CreditMicroSchema.describe('What DorkOS charged for this period.'),
    costBasis: CostBasisSchema,
  })
  .describe(
    'One billing period of a charge that is not inference. It has no seat, no model and no upstream list price.'
  );

/** One billing period of a charge that is not inference. */
export type OtherChargeRow = z.infer<typeof OtherChargeRowSchema>;

/**
 * The charges in a usage window that are not inference.
 *
 * Kept apart from `rows` and `totals` so neither changes meaning: `totals`
 * still sums inference only, and a client that predates this block sums
 * exactly what it summed before.
 */
export const OtherChargesSchema = z
  .object({
    rows: z
      .array(OtherChargeRowSchema)
      .describe(
        'The billing periods that started inside the window, `from` inclusive, `to` exclusive.'
      ),
    dorkosPriceMicro: CreditMicroSchema.describe('What DorkOS charged across these rows.'),
  })
  .describe(
    'The charges in a usage window that are not inference, with their own total. Inference totals do not include them.'
  );

/** The charges in a usage window that are not inference. */
export type OtherCharges = z.infer<typeof OtherChargesSchema>;

/** `GET /v1/usage` — the caller`s own usage for a window. */
export const UsageResponseSchema = z
  .object({
    from: TimestampSchema,
    to: TimestampSchema,
    groupBy: UsageGroupBySchema,
    state: UsageStateSchema,
    rows: z.array(UsageRowSchema),
    totals: z
      .object({
        listPriceMicro: MoneyMicroSchema,
        dorkosPriceMicro: CreditMicroSchema,
      })
      .describe('The inference rows summed. Charges under `otherCharges` are not included.'),
    otherCharges: OtherChargesSchema.optional()
      .catch(undefined)
      .describe(
        'Charges in the window that are not inference. A service that has none, or predates the field, omits it. Parsed with this package`s zod schema, a malformed block is dropped and the inference rows still arrive; a JSON Schema validator fails the whole response instead.'
      ),
    denomination: denominationField,
  })
  .describe('The caller`s own usage for a window, grouped as asked.');

/** The caller`s own usage for a window. */
export type UsageResponse = z.infer<typeof UsageResponseSchema>;

/** One entry of the published price list. */
export const PriceListEntrySchema = z
  .object({
    modelId: IdSchema.describe(
      'An opaque model identifier. This list is the only place a price belongs.'
    ),
    displayName: z.string(),
    unit: z.string().describe('What the prices below are per, as a server-supplied string.'),
    inputMicro: CreditMicroSchema,
    outputMicro: CreditMicroSchema,
    cacheReadMicro: CreditMicroSchema.optional().describe(
      'The rate for reading prompt-cached input, in the entry`s existing unit. Absent means the service did not say.'
    ),
    cacheWriteMicro: CreditMicroSchema.optional().describe(
      'The rate for writing input to the prompt cache, in the entry`s existing unit. Absent means the service did not say.'
    ),
  })
  .describe('One entry of the published price list.');

/**
 * `GET /v1/price-list` — the published per-model price list.
 *
 * Published by design. It carries nothing about how the list is arrived at and
 * no commercial terms. It is not the only route carrying an amount — `/v1/usage`
 * and `/v1/nudge` both do, for the caller's own figures — but it is the only one
 * that publishes the list itself.
 */
export const PriceListResponseSchema = z
  .object({
    version: z.string().describe('An opaque version string for this list.'),
    effectiveFrom: TimestampSchema,
    entries: z.array(PriceListEntrySchema),
    denomination: denominationField,
  })
  .describe('The published per-model price list.');

/**
 * `GET /v1/nudge` — one already-computed comparison, delivered reduced.
 *
 * The server does the subtraction; the client renders what it is given and
 * computes nothing. Exactly one subscription and one price ever appear. The
 * route sits behind a server flag and answers 404 until it is switched on, so a
 * client treats 404 here as "no nudge", not as an error.
 */
export const NudgeSchema = z
  .object({
    trailing30Micro: CreditMicroSchema,
    suggestedPlanId: IdSchema.describe('An opaque identifier. Never switch on this value.'),
    suggestedPlanDisplayName: z.string(),
    suggestedPlanPriceMicro: MoneyMicroSchema,
    savingMicro: MoneyMicroSchema.describe('The subtraction the server already did.'),
    computedAt: TimestampSchema,
    dismissible: z.literal(true),
    denomination: denominationField,
  })
  .describe('One already-computed comparison. 404 from this route means "no nudge", not an error.');

/** One already-computed comparison. */
export type Nudge = z.infer<typeof NudgeSchema>;

/**
 * How often an offer recurs.
 *
 * Mechanism, not catalog: it says how a charge repeats, not what is on sale.
 */
export const OfferIntervalSchema = z
  .enum(['month', 'year'])
  .describe('How often an offer recurs: every month, or every year.');

/** How often an offer recurs. */
export type OfferInterval = z.infer<typeof OfferIntervalSchema>;

/**
 * One thing the service will sell the caller, as `GET /v1/offers` lists it.
 *
 * It is the only place a client is handed a `skuId`, which is the string
 * `POST /v1/checkout` takes back. `skuId` and `planId` are different identifier
 * spaces and neither can stand in for the other: one subscription has one
 * `planId` and one `skuId` per interval. `planId` is the same opaque token
 * `GET /v1/entitlements` publishes, so a page compares the two to mark what the
 * caller is on; this shape deliberately carries no "current" flag of its own.
 *
 * It carries no "recommended" flag and no badge. Render the offers in the order
 * the service sends them and do not re-sort them; the order carries no meaning
 * beyond that.
 *
 * `interval` is tolerant: an interval added in a later release reads as
 * `unrecognised`, so one new offer cannot fail the whole list. Generate the JSON
 * Schema with `{ io: 'input' }`. `limits` is the published entitlement-limits
 * shape itself, so its own description speaks of an entitlement.
 */
export const OfferSchema = z
  .object({
    skuId: IdSchema.describe(
      'The opaque identifier `POST /v1/checkout` takes back. Never constructed, parsed or enumerated by a client.'
    ),
    planId: IdSchema.describe(
      'The opaque identifier `GET /v1/entitlements` publishes for the same subscription. Not interchangeable with `skuId`. Never switch on this value.'
    ),
    displayName: z.string().describe('The server-supplied string to show a person.'),
    interval: tolerantEnum(OfferIntervalSchema).describe(
      'How often the offer recurs. An interval this release does not know reads as unrecognised.'
    ),
    amountMicro: MoneyMicroSchema.describe(
      'The price for one interval, in micro-units of money. Rendered, never computed with.'
    ),
    // The published limits shape itself, by reference: one shape, one place to
    // extend. A `.describe()` here would make a copy.
    limits: EntitlementLimitsSchema,
  })
  .describe('One thing the service will sell the caller.');

/** One thing the service will sell the caller. */
export type Offer = z.infer<typeof OfferSchema>;

/**
 * `GET /v1/offers` — everything the service will sell the caller right now.
 *
 * A bearer token or the person's own browser session. An account with nothing
 * on sale gets 200 and an empty list, never a 404: nothing on sale is a normal
 * state, and a client that met a 404 would report an outage.
 */
export const OffersResponseSchema = z
  .object({
    offers: z.array(OfferSchema),
    denomination: denominationField,
  })
  .describe(
    'Everything the service will sell the caller right now. An empty list is a normal answer, never a 404.'
  );

/** Everything the service will sell the caller right now. */
export type OffersResponse = z.infer<typeof OffersResponseSchema>;

/**
 * A request for a hosted page.
 *
 * `skuId` is an identifier the client received from the server, from
 * `GET /v1/offers` ({@link OffersResponseSchema}). A client never constructs one
 * and never enumerates the set. The amount and its rendering belong to the
 * hosted page, not to this contract.
 *
 * `POST /v1/checkout` and `POST /v1/portal` accept either credential: a bearer
 * token, or the person's own browser session. Their request and response shapes
 * are the same either way. A request authenticated by a browser session must
 * come from an origin the service trusts, or it is refused with `forbidden`.
 */
export const HostedPageRequestSchema = z
  .object({
    skuId: IdSchema.optional().describe(
      'An opaque identifier the server supplied earlier, from `GET /v1/offers`. Clients never construct or enumerate one.'
    ),
    returnUrl: z
      .string()
      .url()
      .optional()
      .describe('Where to send the person when the hosted page is done.'),
  })
  .describe('A request for a hosted checkout or billing-portal page.');

/**
 * The hosted page to open.
 *
 * `POST /v1/checkout`, `POST /v1/topup` and `POST /v1/portal` all answer with
 * this. No origin is baked into this package: the URL is a runtime value.
 */
export const HostedPageResponseSchema = z
  .object({ url: z.string().url() })
  .describe('The hosted page to open. A runtime value; no origin is baked into this package.');

/** `GET /v1/statement` query parameters. */
export const StatementQuerySchema = z
  .object({
    period: z.string().min(1).describe('The billing period to fetch, as the server labels it.'),
  })
  .describe('Which billing period to fetch a statement for.');

/**
 * `GET /v1/statement` — the caller`s own statement for one period: a download
 * link, and optionally its lines and totals.
 *
 * `lines` and `totals` are the same projection `GET /v1/usage` publishes, one
 * line per model for the statement's period. They cover inference usage only:
 * any other charge in the period appears in the downloadable statement, not
 * here, so `totals` is not the whole bill when there are other charges.
 *
 * `from` and `to` are the window the period covers. A period is labelled by a
 * month, but it need not be a calendar month, so a client never derives the
 * window from the label.
 *
 * All four are optional, and a service sends `lines` and `totals` together or
 * not at all. A service that predates them answers with the link alone; a client
 * that meets no `lines` but has `from` and `to` can read the same projection
 * from `GET /v1/usage` with `groupBy=model` for that window.
 *
 * `totals` is the exact sum of the lines. Render it from the exact figures, never
 * by adding rounded lines.
 */
export const StatementResponseSchema = z
  .object({
    period: z.string(),
    downloadUrl: z.string().url(),
    expiresAt: TimestampSchema.describe('When the download link stops working.'),
    from: TimestampSchema.optional().describe(
      'The start of the window this period covers. Absent from an older service.'
    ),
    to: TimestampSchema.optional().describe(
      'The end of the window this period covers. Absent from an older service.'
    ),
    lines: z
      .array(UsageRowSchema)
      .optional()
      .describe(
        'The statement`s inference usage, one line per model, in the shape `GET /v1/usage` publishes. Other charges are only in the download. Sent together with `totals`, or neither. Absent from an older service.'
      ),
    totals: z
      .object({
        listPriceMicro: MoneyMicroSchema.describe('The upstream list price across every line.'),
        dorkosPriceMicro: CreditMicroSchema.describe('What DorkOS charged across every line.'),
      })
      .optional()
      .describe(
        'The exact totals of the lines, which is inference usage only. Sent together with `lines`, or neither. Absent from an older service.'
      ),
    denomination: denominationField,
  })
  .describe(
    'The caller`s own statement for one period: a short-lived download link, and optionally its lines and totals.'
  );

/** The caller`s own statement for one period. */
export type StatementResponse = z.infer<typeof StatementResponseSchema>;

/**
 * `POST /v1/topup` — buy credit, answered with {@link HostedPageResponseSchema}.
 *
 * The amount is opaque to this contract beyond being a positive integer of the
 * contract`s own micro-unit: the minimum, the first-purchase ceiling and
 * anything either of them is worth are server policy and appear nowhere here. A
 * request under the minimum is refused with `topup_below_minimum`, and one over
 * the first-purchase ceiling with `first_purchase_cap`.
 *
 * {@link HostedPageRequestSchema} stays the shape for `POST /v1/checkout` and
 * `POST /v1/portal`, which name a hosted page rather than an amount.
 *
 * `amountMicro` is required, because a top-up request that names no amount is
 * not a top-up request. That does not make this row breaking: this shape is
 * published BESIDE the hosted-page request the route accepted before, not in
 * place of it. Within `/v1` a request shape this package has already published
 * keeps being accepted — withdrawing one is a `/v2` change — so a caller on the
 * older release keeps working, and a caller that wants to name an amount sends
 * this.
 */
export const TopupRequestSchema = z
  .object({
    amountMicro: PositiveMoneyMicroSchema.describe(
      'How much to pay for credit, in micro-units of money.'
    ),
    returnUrl: z
      .string()
      .url()
      .optional()
      .describe('Where to send the person when the hosted page is done.'),
  })
  .describe(
    'A request to buy credit. Carries an amount and nothing about what an amount is worth.'
  );

/** A request to buy credit. */
export type TopupRequest = z.infer<typeof TopupRequestSchema>;

/**
 * Why the two refund shapes below are withdrawn, and why they are still here.
 *
 * DorkOS Cloud does not offer refunds through this API. No release of the
 * service ever served `POST /v1/refunds`; it answers `not_found`.
 *
 * The shapes stay exported because this package is additive within `/v1`:
 * deleting an export would break the build of anyone who imported it from an
 * earlier release, and that is a `/v2` change. They are marked deprecated in the
 * types and in the JSON Schema, and they go when `/v2` does.
 */
const REFUNDS_WITHDRAWN =
  'Withdrawn: DorkOS Cloud does not offer refunds through this API, and no release of the service answers this route. Kept only so imports from an earlier release keep compiling.';

/**
 * `POST /v1/refunds` — withdrawn. A request no release of the service accepts.
 *
 * @deprecated DorkOS Cloud does not offer refunds through this API, and the
 * route answers `not_found`. Kept only so an import from an earlier release
 * still compiles; it is removed in `/v2`.
 */
export const RefundRequestSchema = z
  .object({
    chargeId: IdSchema.describe('The charge to refund, as an opaque identifier the server issued.'),
  })
  .meta({ description: REFUNDS_WITHDRAWN, deprecated: true });

/**
 * A withdrawn refund request.
 *
 * @deprecated See {@link RefundRequestSchema}.
 */
export type RefundRequest = z.infer<typeof RefundRequestSchema>;

/**
 * `POST /v1/refunds` — withdrawn. An answer no release of the service sends.
 *
 * @deprecated DorkOS Cloud does not offer refunds through this API, and the
 * route answers `not_found`. Kept only so an import from an earlier release
 * still compiles; it is removed in `/v2`.
 */
export const RefundResponseSchema = z
  .object({
    refundId: IdSchema,
    chargeId: IdSchema,
    refundedMicro: MoneyMicroSchema.describe('How much came back, in micro-units.'),
    refundedAt: TimestampSchema,
  })
  .meta({ description: REFUNDS_WITHDRAWN, deprecated: true });

/**
 * A withdrawn refund answer.
 *
 * @deprecated See {@link RefundResponseSchema}.
 */
export type RefundResponse = z.infer<typeof RefundResponseSchema>;
