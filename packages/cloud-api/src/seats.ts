import { z } from 'zod';

import { IdSchema, TimestampSchema, pageOf } from './primitives.js';

/** Whether an organization is one person`s own or a shared one. */
export const OrgKindSchema = z
  .enum(['personal', 'org'])
  .describe('Whether an organization is one person`s own or a shared one.');

/** What a member may do in an organization. */
export const MemberRoleSchema = z
  .enum(['owner', 'admin', 'member'])
  .describe('What a member may do in an organization.');

/** An organization: the unit seats, addresses and billing hang off. */
export const OrgSchema = z
  .object({
    id: IdSchema,
    slug: z.string().describe('The short name that appears in a canonical address.'),
    name: z.string(),
    kind: OrgKindSchema,
    createdAt: TimestampSchema,
  })
  .describe('An organization: the unit seats, addresses and billing hang off.');

/** An organization. */
export type Org = z.infer<typeof OrgSchema>;

/** `POST /v1/orgs`. */
export const OrgCreateRequestSchema = z
  .object({ slug: z.string().min(1), name: z.string().min(1) })
  .describe('Create an organization.');

/** `PATCH /v1/orgs/{orgId}`. */
export const OrgUpdateRequestSchema = z
  .object({ name: z.string().min(1).optional(), slug: z.string().min(1).optional() })
  .describe('Rename an organization or change its slug.');

/** `GET /v1/orgs`. */
export const OrgListResponseSchema = pageOf(
  OrgSchema,
  'A page of the organizations the caller belongs to.'
);

/** One person`s membership of one organization. */
export const MemberSchema = z
  .object({
    id: IdSchema,
    orgId: IdSchema,
    userId: IdSchema,
    role: MemberRoleSchema,
    displayName: z
      .string()
      .optional()
      .describe(
        'The name to show for this person, taken from their account profile. Never their email address, and absent when they have set no name.'
      ),
    createdAt: TimestampSchema,
  })
  .describe('One person`s membership of one organization.');

/** One person`s membership of one organization. */
export type Member = z.infer<typeof MemberSchema>;

/** `GET /v1/orgs/{orgId}/members`. */
export const MemberListResponseSchema = pageOf(
  MemberSchema,
  'A page of an organization`s members.'
);

/** How far an invitation has got. */
export const InvitationStatusSchema = z
  .enum(['pending', 'accepted', 'rejected', 'canceled'])
  .describe('How far an invitation has got.');

/** An outstanding or settled invitation to join an organization. */
export const InvitationSchema = z
  .object({
    id: IdSchema,
    orgId: IdSchema,
    email: z.string(),
    role: MemberRoleSchema,
    status: InvitationStatusSchema,
    expiresAt: TimestampSchema,
    createdAt: TimestampSchema,
  })
  .describe('An outstanding or settled invitation to join an organization.');

/** An invitation to join an organization. */
export type Invitation = z.infer<typeof InvitationSchema>;

/** `POST /v1/orgs/{orgId}/invitations`. */
export const InvitationCreateRequestSchema = z
  .object({ email: z.string().min(1), role: MemberRoleSchema })
  .describe('Invite somebody to an organization.');

/** `GET /v1/orgs/{orgId}/invitations`. */
export const InvitationListResponseSchema = pageOf(
  InvitationSchema,
  'A page of an organization`s invitations.'
);

/** An agent identity an organization has registered. */
export const AgentSchema = z
  .object({
    id: IdSchema,
    orgId: IdSchema,
    ownerMemberId: IdSchema.nullable().describe(
      'The member who owns this agent, or null when nobody does yet.'
    ),
    displayName: z.string(),
    emoji: z.string().optional(),
    color: z.string().optional(),
    imageUrl: z.string().url().optional(),
    createdAt: TimestampSchema,
    retiredAt: TimestampSchema.optional(),
  })
  .describe('An agent identity an organization has registered.');

/** An agent identity an organization has registered. */
export type Agent = z.infer<typeof AgentSchema>;

/**
 * `POST /v1/orgs/{orgId}/agents` — an instance asserts a claim to an agent
 * identity. It mints nothing; a person approves the claim separately.
 */
export const AgentClaimRequestSchema = z
  .object({
    displayName: z.string().min(1),
    instanceId: IdSchema,
    emoji: z.string().optional(),
    color: z.string().optional(),
    principalKind: z
      .string()
      .min(1)
      .optional()
      .describe(
        'What kind of local principal `naturalKey` belongs to, as a server-recognised token. Optional here so a client one release behind keeps working; the server needs it to register anything.'
      ),
    naturalKey: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The raw local key that identifies the principal, sent once and hashed with a per-organization key on receipt. The server discards the input, so no response can be turned back into it. A client never hashes this itself: a client that could compute the hash could forge any identity.'
      ),
    authEnabled: z
      .boolean()
      .optional()
      .describe(
        'Whether the reporting instance has a local sign-in. The server reads absent as false; the parsed value is still undefined, because a default here would be a claim about what the client sent.'
      ),
    hasUsers: z
      .boolean()
      .optional()
      .describe(
        'Whether the reporting instance has any local users. The server reads absent as false; the parsed value is still undefined.'
      ),
  })
  .describe(
    'An instance asserting a claim to an agent identity. Mints nothing until a person approves it.'
  );

/** The state of an agent claim. */
export const AgentClaimSchema = z
  .object({
    claimId: IdSchema,
    agentId: IdSchema,
    instanceId: IdSchema,
    status: z.enum(['pending', 'approved', 'rejected', 'expired']),
    createdAt: TimestampSchema,
    approvedAt: TimestampSchema.nullable(),
  })
  .describe('The state of an agent claim awaiting a person`s approval.');

/** `GET /v1/orgs/{orgId}/agents`. */
export const AgentListResponseSchema = pageOf(AgentSchema, 'A page of an organization`s agents.');

/** Whether a seat holds a person or an agent. */
export const SeatKindSchema = z
  .enum(['person', 'agent'])
  .describe('Whether a seat holds a person or an agent.');

/** Where a seat is in its lifecycle. */
export const SeatStatusSchema = z
  .enum(['unassigned', 'assigned', 'suspended', 'released'])
  .describe('Where a seat is in its lifecycle.');

/** Whether an address is live or has been retired. */
export const AddressStatusSchema = z
  .enum(['active', 'retired'])
  .describe('Whether an address is live or has been retired.');

/** A routable address issued to a seat. */
export const AddressSchema = z
  .object({
    id: IdSchema,
    orgId: IdSchema,
    seatId: IdSchema,
    handle: z.string().describe('The local part of the address, unique within the organization.'),
    canonical: z.string().describe('The full `dork:<org-slug>/<handle>` form.'),
    status: AddressStatusSchema,
    issuedAt: TimestampSchema,
    retiredAt: TimestampSchema.optional(),
  })
  .describe('A routable address issued to a seat.');

/** A routable address issued to a seat. */
export type Address = z.infer<typeof AddressSchema>;

/**
 * The grammar every handle in this contract obeys.
 *
 * Published so the app can refuse a bad name before a request goes out, and so
 * the command acknowledgement can bound its refusal slugs by the same rule. It
 * is a strict subset of the handle grammar DorkOS uses locally, with the dot
 * removed so a handle is a single routing token.
 *
 * Lower case by grammar. The server refuses a mixed-case handle rather than
 * folding it, because the routing token is compared case-sensitively
 * downstream: a folded handle would pass every validator and then silently fail
 * to match its own subscription.
 *
 * Nothing in this contract is narrowed to it yet. Narrowing a field a caller
 * already sends would make a request that parsed before fail afterwards, which
 * is a `/v2` change however sensible it looks.
 */
export const HandleSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/,
    'must be lower-case, start and end with a letter or digit, and contain only letters, digits, hyphens and underscores'
  )
  .describe(
    'The grammar every handle obeys: lower case, 2 to 32 characters, starting and ending with a letter or a digit.'
  );

/**
 * `POST /v1/addresses`.
 *
 * `subject` is optional only so a client one release behind keeps working. The
 * seat being given an address has no holder yet, so the server needs it to know
 * who the holder will be.
 */
export const AddressCreateRequestSchema = z
  .object({
    seatId: IdSchema,
    handle: z.string().min(1),
    subject: z
      .object({ kind: z.enum(['user', 'agent']), id: IdSchema })
      .optional()
      .describe('Who or what will hold the seat this address belongs to.'),
    acknowledgeUnauthenticatedExposure: z
      .boolean()
      .optional()
      .describe(
        'Somebody accepting, explicitly, that an agent is being given an address while the reporting machine has no local sign-in. Spelled in full on purpose: a shorter name invites a default, and defaulting it would be the whole problem. The server reads absent as not accepted; the parsed value is still undefined.'
      ),
  })
  .describe('Issue an address to a seat.');

/** One seat in an organization. */
export const SeatSchema = z
  .object({
    id: IdSchema,
    orgId: IdSchema,
    kind: SeatKindSchema,
    status: SeatStatusSchema,
    subject: z
      .object({ kind: z.enum(['user', 'agent']), id: IdSchema })
      .nullable()
      .describe('Who or what currently occupies the seat, or null when nobody does.'),
    address: AddressSchema.nullable(),
    createdAt: TimestampSchema,
    assignedAt: TimestampSchema.optional(),
    releasedAt: TimestampSchema.optional(),
  })
  .describe('One seat in an organization.');

/** One seat in an organization. */
export type Seat = z.infer<typeof SeatSchema>;

/** `GET /v1/orgs/{orgId}/seats`. */
export const SeatListResponseSchema = pageOf(SeatSchema, 'A page of an organization`s seats.');

/**
 * `POST /v1/seats/{seatId}/assign`.
 *
 * Assignment binds the holder and issues the address together, in one
 * transaction, so the request carries both. Two calls would make a seat with a
 * holder and no address observable, which is not a state this service has.
 * `handle` is optional only so a client one release behind keeps working.
 */
export const SeatAssignRequestSchema = z
  .object({
    subject: z.object({ kind: z.enum(['user', 'agent']), id: IdSchema }),
    handle: z
      .string()
      .min(1)
      .optional()
      .describe('The name the seat`s address gets, written once and never renamed in place.'),
  })
  .describe('Put a person or an agent into a seat, and give it its address.');

/** Who may reach a seat, and for what. */
export const GrantSchema = z
  .object({
    id: IdSchema,
    seatId: IdSchema,
    granteeKind: z
      .enum(['org', 'seat', 'connected-channel', 'public'])
      .describe('What kind of thing the grant is about.'),
    granteeRef: IdSchema.nullable().describe(
      'Which one, or null when the kind is enough (`public`).'
    ),
    capability: z
      .enum(['address', 'trigger'])
      .describe('What the grantee may do: reach the address, or trigger the seat.'),
    effect: z.enum(['allow', 'deny']).describe('Deny wins over allow.'),
  })
  .describe('One rule about who may reach a seat, and for what.');

/** One rule about who may reach a seat. */
export type Grant = z.infer<typeof GrantSchema>;

/** `PUT /v1/seats/{seatId}/grants` — replace the whole set in one call. */
export const GrantReplaceRequestSchema = z
  .object({ grants: z.array(GrantSchema.omit({ id: true, seatId: true })) })
  .describe(
    'Replace a seat`s entire grant set. A partial update is not offered, so no two clients can interleave.'
  );

/**
 * `GET /v1/seats/{seatId}/grants`.
 *
 * **An empty `grants` list is not an empty permission set.** Zero stored rows
 * means the organization`s default, which the server resolves. `effective` is
 * how a client can show that: it carries the resolved verdict per grantee kind
 * and capability, so an interface can say what removing every rule actually
 * did. Absent when the server did not resolve it.
 */
export const GrantListResponseSchema = z
  .object({
    grants: z.array(GrantSchema),
    effective: z
      .array(
        z
          .object({
            granteeKind: GrantSchema.shape.granteeKind,
            capability: GrantSchema.shape.capability,
            effect: GrantSchema.shape.effect,
          })
          .describe('One resolved verdict: what a kind of grantee may do, after the default.')
      )
      .optional()
      .describe(
        'The resolved verdict per grantee kind and capability, including whatever the organization`s default supplies. Absent when the server did not resolve it.'
      ),
  })
  .describe('A seat`s entire grant set, and optionally what it resolves to.');

/** Something attached to a seat beyond what it includes by default. */
export const AddonSchema = z
  .object({
    id: IdSchema,
    seatId: IdSchema,
    kind: z
      .string()
      .describe('An opaque add-on identifier. The set is never enumerated in this package.'),
    status: z.enum(['attached', 'detached']),
    attachedAt: TimestampSchema,
    detachedAt: TimestampSchema.optional(),
  })
  .describe('Something attached to a seat beyond what it includes by default.');

/** Something attached to a seat beyond what it includes by default. */
export type Addon = z.infer<typeof AddonSchema>;

/** `POST /v1/seats/{seatId}/addons`. */
export const AddonAttachRequestSchema = z
  .object({ kind: IdSchema.describe('An opaque identifier the server supplied earlier.') })
  .describe('Attach an add-on to a seat.');

/** `GET /v1/seats/{seatId}/addons`. */
export const AddonListResponseSchema = z
  .object({ addons: z.array(AddonSchema) })
  .describe('Everything attached to a seat.');

/** Where something arrived from. */
export const InboxSourceKindSchema = z
  .enum(['email', 'a2a', 'seat', 'connected-channel'])
  .describe('Where an inbox item arrived from.');

/**
 * One item leased from a seat`s inbox.
 *
 * `leaseToken` is the receipt that acknowledges exactly this delivery. It
 * mirrors the connector event contract rather than inventing a second design.
 */
export const InboxItemSchema = z
  .object({
    id: IdSchema,
    leaseToken: z.string().min(1).describe('The receipt that acknowledges exactly this delivery.'),
    receivedAt: TimestampSchema,
    expiresAt: TimestampSchema.describe(
      'When the lease lapses and the item becomes pullable again.'
    ),
    sourceKind: InboxSourceKindSchema,
    sourceRef: z.string().describe('Which sender, in whatever form that source names one.'),
    envelope: z.unknown().describe('The source-shaped metadata of the item.'),
    bodyUrl: z.string().url().describe('Where to fetch the item body.'),
    sizeBytes: z.number().int().nonnegative(),
  })
  .describe('One item leased from a seat`s inbox.');

/** One item leased from a seat`s inbox. */
export type InboxItem = z.infer<typeof InboxItemSchema>;

/** `POST /v1/seats/{seatId}/inbox/pull`. */
export const InboxPullRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional().describe('Defaults to 50, capped at 100.'),
  })
  .describe(
    'Lease a batch of inbox items. Cursor-free by design, exactly like the connector event pull.'
  );

/** A leased batch of inbox items. */
export const InboxPullResponseSchema = z
  .object({ items: z.array(InboxItemSchema) })
  .describe('A leased batch of inbox items. No cursor, by design.');

/** `POST /v1/seats/{seatId}/inbox/ack`. */
export const InboxAckRequestSchema = z
  .object({
    items: z
      .array(z.object({ id: IdSchema, leaseToken: z.string().min(1) }))
      .min(1)
      .max(100),
  })
  .describe('Settle inbox leases with exact receipts. One to a hundred at a time.');

/** How many inbox leases were settled. */
export const InboxAckResponseSchema = z
  .object({ acknowledged: z.number().int().nonnegative() })
  .describe('How many inbox leases the server settled.');

/**
 * `GET /v1/seats/{seatId}/inbox` — a read-only cursor-paginated browse.
 *
 * Separate from the pull on purpose: it takes no lease and changes no status,
 * which is what stops an interface refresh from acknowledging somebody`s mail.
 */
export const InboxBrowseResponseSchema = pageOf(
  InboxItemSchema.omit({ leaseToken: true }),
  'A read-only page of a seat`s inbox. Takes no lease and changes no status.'
);

/** How reachable a seat is right now. */
export const PresenceStateSchema = z
  .enum(['offline', 'unknown', 'reachable', 'active'])
  .describe('How reachable a seat is right now.');

/** `GET /v1/seats/{seatId}/presence`. */
export const PresenceSchema = z
  .object({
    seatId: IdSchema,
    state: PresenceStateSchema,
    lastSeenAt: TimestampSchema.nullable(),
    source: z.enum(['cloud-link', 'heartbeat']).describe('Which signal this reading came from.'),
  })
  .describe('How reachable a seat is right now, and where that reading came from.');

/** How reachable a seat is right now. */
export type Presence = z.infer<typeof PresenceSchema>;

/**
 * One seat became active in one subscription period.
 *
 * The wire event a fair-billing consumer subscribes to. It says that an agent
 * seat did something that counts, once, and it carries nothing else.
 *
 * Four properties are the whole design, and each is load-bearing:
 *
 *   - **At most one event per seat per subscription period.** The first
 *     qualifying event is kept. A second is a no-op, not an update, so a
 *     consumer that sees one has seen everything there is for that seat in that
 *     period.
 *   - **`eventId` is an idempotency key.** A redelivery with the same key is a
 *     complete no-op. A consumer may be delivered the same event more than once
 *     and must not count it twice.
 *   - **The period is the organization`s subscription period, not a calendar
 *     month.** It is clamped on a short month rather than rolled over, so a
 *     period that starts on the 31st ends on the last day of a 30-day month and
 *     does not spill into the next one.
 *   - **Nothing from a message ever appears here.** No message, subject, body,
 *     sender or email field, and no presence value. `sourceRef` is opaque: it
 *     says which source, never who sent anything.
 *
 * Person seats never produce one of these. A person seat is not billed for
 * being active.
 */
export const SeatActivityEventSchema = z
  .object({
    eventId: IdSchema.describe(
      'Idempotency key. A redelivery with the same key is a complete no-op.'
    ),
    billingAccountId: IdSchema.describe(
      'The account this activity is billed to, as an opaque identifier. A consumer groups by it and never parses it.'
    ),
    seatId: IdSchema.describe(
      'Agent seats only. A person seat never produces a seat-activity event.'
    ),
    periodStart: TimestampSchema.describe(
      'The start of the organization`s subscription period — NOT a calendar month.'
    ),
    periodEnd: TimestampSchema.describe(
      'The end of the organization`s subscription period — NOT a calendar month. Clamped on a short month rather than rolled over.'
    ),
    occurredAt: TimestampSchema.describe('When the qualifying activity happened.'),
    reason: z
      .enum([
        'inbound-from-org-seat',
        'inbound-from-connected-channel',
        'turn-triggered-by-qualifying-message',
        'turn-triggered-by-attached-addon',
        'addon-attached',
      ])
      .describe('What made the seat active. Mechanism: it names a kind of activity, nothing else.'),
    sourceKind: z
      .enum(['seat', 'connected-channel', 'addon'])
      .describe(
        'What kind of thing the activity came from. Deliberately not the inbox`s own source kinds: `addon` is not a place mail arrives from, and `email` is absent because no mail source is ever named here. Do not reuse inbox handling on this field.'
      ),
    sourceRef: z.string().describe('Opaque. Never a sender, never anything from a message.'),
  })
  .describe(
    'One agent seat became active in one subscription period. At most one per seat per period; a redelivery is a no-op. Carries no message and no presence.'
  );

/** One agent seat became active in one subscription period. */
export type SeatActivityEvent = z.infer<typeof SeatActivityEventSchema>;
