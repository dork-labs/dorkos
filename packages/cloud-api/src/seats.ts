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

/** `POST /v1/addresses`. */
export const AddressCreateRequestSchema = z
  .object({ seatId: IdSchema, handle: z.string().min(1) })
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

/** `POST /v1/seats/{seatId}/assign`. */
export const SeatAssignRequestSchema = z
  .object({ subject: z.object({ kind: z.enum(['user', 'agent']), id: IdSchema }) })
  .describe('Put a person or an agent into a seat.');

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

/** `GET /v1/seats/{seatId}/grants`. */
export const GrantListResponseSchema = z
  .object({ grants: z.array(GrantSchema) })
  .describe('A seat`s entire grant set.');

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
