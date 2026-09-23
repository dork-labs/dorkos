import { z } from 'zod';

import {
  IdSchema,
  MicroAmountSchema,
  PositiveMicroAmountSchema,
  TimestampSchema,
} from './primitives.js';

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
    includedCreditsMicro: MicroAmountSchema,
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
      grantedMicro: MicroAmountSchema,
      remainingMicro: MicroAmountSchema,
      resetsAt: TimestampSchema,
    }),
    purchased: z.object({
      remainingMicro: MicroAmountSchema,
      holds: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          'How many first-purchase holds are in force. Absent means the server did not say; zero means none.'
        ),
    }),
    pendingMicro: MicroAmountSchema.optional().describe(
      'Credit the caller has paid for that is not spendable yet, because a hold is still in force. Absent means the server did not say.'
    ),
    heldMicro: MicroAmountSchema.describe('Reserved against turns currently running.'),
    owedMicro: MicroAmountSchema.describe(
      'Debt from a turn that overran its reservation. May be "0"; when it is not, show it.'
    ),
    autoReload: z.object({
      enabled: z.boolean(),
      ceilingMicro: MicroAmountSchema.nullable(),
    }),
  })
  .describe(
    'The caller`s credit position. Every amount is an exact integer of micro-units carried as a string.'
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
    listPriceMicro: MicroAmountSchema.describe('The upstream list price for this row.'),
    dorkosPriceMicro: MicroAmountSchema.describe('What DorkOS charged for this row.'),
    costBasis: CostBasisSchema,
  })
  .describe(
    'One row of the caller`s own usage, projected. No supplier and no price-list version appear here.'
  );

/** `GET /v1/usage` — the caller`s own usage for a window. */
export const UsageResponseSchema = z
  .object({
    from: TimestampSchema,
    to: TimestampSchema,
    groupBy: UsageGroupBySchema,
    state: UsageStateSchema,
    rows: z.array(UsageRowSchema),
    totals: z.object({
      listPriceMicro: MicroAmountSchema,
      dorkosPriceMicro: MicroAmountSchema,
    }),
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
    inputMicro: MicroAmountSchema,
    outputMicro: MicroAmountSchema,
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
  })
  .describe(
    'The published per-model price list. The only route in this contract that carries a price.'
  );

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
    trailing30Micro: MicroAmountSchema,
    suggestedPlanId: IdSchema.describe('An opaque identifier. Never switch on this value.'),
    suggestedPlanDisplayName: z.string(),
    suggestedPlanPriceMicro: MicroAmountSchema,
    savingMicro: MicroAmountSchema.describe('The subtraction the server already did.'),
    computedAt: TimestampSchema,
    dismissible: z.literal(true),
  })
  .describe('One already-computed comparison. 404 from this route means "no nudge", not an error.');

/** One already-computed comparison. */
export type Nudge = z.infer<typeof NudgeSchema>;

/**
 * A request for a hosted page.
 *
 * `skuId` is an identifier the client received from the server. A client never
 * constructs one and never enumerates the set. The amount and its rendering
 * belong to the hosted page, not to this contract.
 */
export const HostedPageRequestSchema = z
  .object({
    skuId: IdSchema.optional().describe(
      'An opaque identifier the server supplied earlier. Clients never construct or enumerate one.'
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

/** `GET /v1/statement` — a download link for the caller`s itemised statement. */
export const StatementResponseSchema = z
  .object({
    period: z.string(),
    downloadUrl: z.string().url(),
    expiresAt: TimestampSchema.describe('When the download link stops working.'),
  })
  .describe('A short-lived download link for the caller`s own itemised usage statement.');

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
    amountMicro: PositiveMicroAmountSchema.describe('How much credit to buy, in micro-units.'),
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
 * `POST /v1/refunds` — ask for one charge to be refunded.
 *
 * Opaque identifiers only. The amount is the charge`s own, so the request never
 * names one, and a refund asked for after the window has closed is refused with
 * `refund_window_closed`. How long the window is is server policy and is not
 * published here.
 */
export const RefundRequestSchema = z
  .object({
    chargeId: IdSchema.describe('The charge to refund, as an opaque identifier the server issued.'),
  })
  .describe('Ask for one charge to be refunded. Opaque identifiers only, and no amount.');

/** Ask for one charge to be refunded. */
export type RefundRequest = z.infer<typeof RefundRequestSchema>;

/** `POST /v1/refunds` — the accepted refund. */
export const RefundResponseSchema = z
  .object({
    refundId: IdSchema,
    chargeId: IdSchema,
    refundedMicro: MicroAmountSchema.describe('How much came back, in micro-units.'),
    refundedAt: TimestampSchema,
  })
  .describe('The accepted refund: which charge it settles, how much came back, and when.');

/** The accepted refund. */
export type RefundResponse = z.infer<typeof RefundResponseSchema>;
