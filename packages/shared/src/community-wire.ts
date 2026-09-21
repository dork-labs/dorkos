/**
 * Version 1 of the standalone community HTTP contract. Ordinary response
 * projections contain no credential or storage path. Admission inputs carry
 * deployment or invite secrets, and invite creation returns its token once;
 * callers must keep those values out of logs and persistent browser state.
 * Every object is strict so an extra database field cannot silently pass a
 * response schema. One-time personal and agent bearers have a separate private
 * server-only subpath.
 *
 * @module shared/community-wire
 */
import { z } from 'zod';
import { CommunityAdminLifecycleSchema } from './community-admin-wire.js';
import { HANDLE_PATTERN } from './handle.js';

const id = z.string().min(1);
const timestamp = z.iso.datetime();
const cursor = z.string().min(1);
const idempotencyKey = z.string().min(1).max(128);
const attachmentIds = z
  .array(id)
  .max(8)
  .refine((ids) => new Set(ids).size === ids.length);
const mentions = z
  .array(id)
  .max(1_000)
  .refine((ids) => new Set(ids).size === ids.length);

/** A live community member's lowercase, typeable and unique address. */
export const CommunityWireHandleSchema = z.string().regex(HANDLE_PATTERN);

/** Canonical method paths beneath the independently deployed `/api/v1` origin. */
export const COMMUNITY_API_V1_ROUTES = {
  community: '/api/v1/community',
  bootstrapPreflight: '/api/v1/bootstrap/preflight',
  bootstrapComplete: '/api/v1/bootstrap/complete',
  ownerClaimPreflight: '/api/v1/owner-claims/preflight',
  ownerClaim: '/api/v1/owner-claims/claim',
  hostCommunities: '/api/v1/host/communities',
  hostCommunityLifecycle: '/api/v1/host/communities/:id/lifecycle',
  memberships: '/api/v1/memberships',
  invites: '/api/v1/invites',
  invitePreview: '/api/v1/invites/preview',
  invitePreflight: '/api/v1/invites/preflight',
  inviteBind: '/api/v1/invites/bind',
  inviteRedeem: '/api/v1/invites/redeem',
  pairingStart: '/api/v1/pairings/start',
  pairingApprove: '/api/v1/pairings/approve',
  pairingDecline: '/api/v1/pairings/decline',
  pairingPoll: '/api/v1/pairings/poll',
  pairingCancel: '/api/v1/pairings/cancel',
  pairingExchange: '/api/v1/pairings/exchange',
  channels: '/api/v1/channels',
  channel: '/api/v1/channels/:id',
  channelMembers: '/api/v1/channels/:id/members',
  channelAgents: '/api/v1/channels/:id/agents',
  entries: '/api/v1/channels/:id/entries',
  channelAttachments: '/api/v1/channels/:id/attachments',
  channelReadCursor: '/api/v1/channels/:id/read-cursor',
  channelEvents: '/api/v1/channels/:id/events',
  attachment: '/api/v1/attachments/:id',
  exportArchive: '/api/v1/exports/:id',
  agents: '/api/v1/agents',
  me: '/api/v1/me',
  connectionAccess: '/api/v1/me/connection-access',
  members: '/api/v1/members',
  authOptions: '/api/v1/auth-options',
  memberRole: '/api/v1/members/:id/role',
  meGrants: '/api/v1/me/grants',
  meExport: '/api/v1/me/export',
  meLeave: '/api/v1/me/leave',
  ownerTransfer: '/api/v1/owner/transfer',
  ownerExport: '/api/v1/owner/export',
} as const;

/** Public immutable identity and display metadata for one deployment. */
export const CommunityWireCommunitySchema = z.strictObject({
  id,
  name: z.string().min(1),
  description: z.string().nullable(),
  createdAt: timestamp,
});
/** Public community metadata. */
export type CommunityWireCommunity = z.infer<typeof CommunityWireCommunitySchema>;

/** Bootstrap preflight checks the deployment secret and issues a cookie grant. */
export const CommunityWireBootstrapPreflightRequestSchema = z.strictObject({ secret: id });
/** Bootstrap preflight reveals only whether a grant was issued. */
export const CommunityWireBootstrapPreflightResponseSchema = z.strictObject({
  granted: z.boolean(),
  expiresAt: timestamp,
});
/** First-install setup creates the host account and initial tenant in one transaction. */
export const CommunityWireBootstrapCompleteRequestSchema = z.strictObject({
  secret: id,
  accountName: z.string().trim().min(1).max(128),
  email: z.email(),
  password: z.string().min(8).max(128),
  communityName: z.string().trim().min(1).max(120),
  channelName: z.string().trim().min(1).max(80),
});
/** First-install setup returns only public tenant identities; sign-in remains a separate step. */
export const CommunityWireBootstrapCompleteResponseSchema = z.strictObject({
  community: CommunityWireCommunitySchema,
  memberId: id,
  channelId: id,
});
/** Owner claim yields public community and member identity. */
export const CommunityWireBootstrapClaimResponseSchema = z.strictObject({
  community: CommunityWireCommunitySchema,
  memberId: id,
});

/** Host-visible lifecycle metadata contains no membership or content data. */
export const CommunityWireHostCommunitySchema = CommunityWireCommunitySchema.extend({
  lifecycle: CommunityAdminLifecycleSchema,
});
/** Communities visible to a host operator as operational metadata. */
export const CommunityWireHostCommunityListResponseSchema = z.strictObject({
  communities: z.array(CommunityWireHostCommunitySchema),
});
/** One community the current host account may enter through its own membership. */
export const CommunityWireMembershipSummarySchema = z.strictObject({
  communityId: id,
  name: z.string().min(1),
  description: z.string().nullable(),
  lifecycle: CommunityAdminLifecycleSchema,
  memberId: id,
  displayName: z.string().min(1),
  role: z.enum(['owner', 'admin', 'member']),
});
/** Authenticated communities visible through the current account's own memberships. */
export const CommunityWireMembershipListResponseSchema = z.strictObject({
  memberships: z.array(CommunityWireMembershipSummarySchema),
});
/** Community selection row for the current host account. */
export type CommunityWireMembershipSummary = z.infer<typeof CommunityWireMembershipSummarySchema>;
/** A host operator creates a pending community before any membership exists. */
export const CommunityWireHostCommunityCreateRequestSchema = z.strictObject({
  name: z.string().min(1),
});
/** One-time owner claim returned only to the creating host operator. */
export const CommunityWireHostCommunityCreateResponseSchema = z.strictObject({
  community: CommunityWireHostCommunitySchema,
  ownerClaimToken: id,
  expiresAt: timestamp,
});
/** Host lifecycle controls can suspend or resume an existing claimed community. */
export const CommunityWireHostCommunityLifecycleRequestSchema = z.strictObject({
  lifecycle: z.enum(['active', 'suspended']),
});
/** A claim token is captured from memory and exchanged for an HTTP-only cookie. */
export const CommunityWireOwnerClaimPreflightRequestSchema = z.strictObject({ token: id });
/** Preflight exposes only the bound pending community and expiry. */
export const CommunityWireOwnerClaimPreflightResponseSchema = z.strictObject({
  granted: z.literal(true),
  communityId: id,
  expiresAt: timestamp,
});
/** Redeeming a claim needs no client-supplied community or role. */
export const CommunityWireOwnerClaimRequestSchema = z.strictObject({});

/** Human roles. Agent membership is a distinct kind, not an elevated role. */
export const CommunityWireHumanRoleSchema = z.enum(['owner', 'admin', 'member']);
/** Public roster row without account details or credential material. */
export const CommunityWireMemberSchema = z.strictObject({
  memberId: id,
  kind: z.enum(['human', 'agent']),
  displayName: z.string().min(1),
  handle: CommunityWireHandleSchema,
  role: CommunityWireHumanRoleSchema.nullable(),
  ownerMemberId: id.nullable(),
  /** Agent owner's display name, scoped to a roster this caller may already read. */
  ownerDisplayName: z.string().min(1).nullable().optional(),
  joinedAt: timestamp,
});
/** Public roster row. */
export type CommunityWireMember = z.infer<typeof CommunityWireMemberSchema>;
/** Authorized channel roster. */
export const CommunityWireMemberListResponseSchema = z.strictObject({
  members: z.array(CommunityWireMemberSchema),
});
/** Change a human between admin and ordinary member; only the owner may call this. */
export const CommunityWireMemberRoleUpdateRequestSchema = z.strictObject({
  role: z.enum(['admin', 'member']),
});
/** Role change receipt with the current member projection. */
export const CommunityWireMemberResponseSchema = z.strictObject({
  member: CommunityWireMemberSchema,
});
/** Bounded human directory for owner/admin member selection. */
export const CommunityWireMemberDirectoryQuerySchema = z.strictObject({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
/** One page of public human member descriptions, with no account fields. */
export const CommunityWireMemberDirectoryPageSchema = z.strictObject({
  members: z.array(CommunityWireMemberSchema).max(100),
  nextCursor: z.uuid().nullable(),
});
/** Public provider availability, without OAuth IDs, secrets or callback details. */
export const CommunityWireAuthOptionsSchema = z.strictObject({
  google: z.boolean(),
  github: z.boolean(),
});

/** Public channel projection. `joined` is for the current caller only. */
export const CommunityWireChannelSchema = z.strictObject({
  id,
  name: z.string().min(1),
  description: z.string().nullable(),
  visibility: z.enum(['public', 'private']),
  archived: z.boolean(),
  createdAt: timestamp,
  joined: z.boolean(),
  unreadCount: z.number().int().nonnegative(),
});
/** Public channel projection. */
export type CommunityWireChannel = z.infer<typeof CommunityWireChannelSchema>;
/** Create a channel; authority is derived from the session, never this body. */
export const CommunityWireChannelCreateRequestSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  visibility: z.enum(['public', 'private']).optional(),
});
/** Rename, describe or archive a channel. */
export const CommunityWireChannelUpdateRequestSchema = z.strictObject({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  archived: z.boolean().optional(),
});
/** List only channels visible to the current caller. */
export const CommunityWireChannelListResponseSchema = z.strictObject({
  channels: z.array(CommunityWireChannelSchema),
});
/** One channel response. */
export const CommunityWireChannelResponseSchema = z.strictObject({
  channel: CommunityWireChannelSchema,
});
/** Add a named member to a channel; the server verifies role authority. */
export const CommunityWireChannelMemberRequestSchema = z.strictObject({ memberId: id });
/** Join or remove an agent by its actual community member ID. */
export const CommunityWireAgentChannelMembershipRequestSchema = z.strictObject({ agentId: id });
/** Receipt for a successful agent channel join; removal returns empty 204. */
export const CommunityWireAgentChannelMembershipResponseSchema = z.strictObject({
  joined: z.literal(true),
});

/** Authorized attachment metadata. Storage keys and paths are intentionally absent. */
export const CommunityWireAttachmentSchema = z.strictObject({
  id,
  name: z.string().min(1),
  contentType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  checksum: id,
  createdAt: timestamp,
});
/** Authorized attachment metadata. */
export type CommunityWireAttachment = z.infer<typeof CommunityWireAttachmentSchema>;
/** Upload metadata sent beside streamed bytes; retry key is stable. */
export const CommunityWireAttachmentUploadRequestSchema = z.strictObject({
  name: z.string().min(1),
  contentType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  idempotencyKey,
});
/** An upload receipt contains an opaque ID, never an object-store URL. */
export const CommunityWireAttachmentUploadResponseSchema = z.strictObject({
  attachment: CommunityWireAttachmentSchema,
});

/** One committed entry with immutable author display snapshot. */
export const CommunityWireEntrySchema = z.strictObject({
  id,
  channelId: id,
  seq: z.number().int().positive(),
  authorMemberId: id,
  authorDisplayName: z.string().min(1),
  /** Immutable author principal kind, retained after a member or agent becomes inactive. */
  authorKind: z.enum(['human', 'agent']),
  text: z.string(),
  /** Member IDs resolved from handles at write time against the joined roster. */
  mentions,
  parentEntryId: id.nullable(),
  threadRootEntryId: id.nullable(),
  createdAt: timestamp,
  /** Server-minted cursor for room-event resume immediately after this entry. */
  cursor,
  attachments: z.array(CommunityWireAttachmentSchema).max(8),
  /** Owner-authorized agent-post correlation key; absent for every other reader. */
  originIdempotencyKey: idempotencyKey.optional(),
});
/** One committed entry. */
export type CommunityWireEntry = z.infer<typeof CommunityWireEntrySchema>;
/** Post as the bearer or cookie identity; agent selection is by private bearer. */
export const CommunityWireEntryPostRequestSchema = z.strictObject({
  text: z.string().min(1),
  /** Member ids resolved by the local caller, checked against the joined roster. */
  mentions: mentions.optional(),
  parentEntryId: id.optional(),
  idempotencyKey,
  attachmentIds: attachmentIds.optional(),
});
/** Committed entry and the same room-event resume cursor carried by that entry. */
export const CommunityWireEntryPostResponseSchema = z
  .strictObject({ entry: CommunityWireEntrySchema, cursor })
  .refine(({ entry, cursor }) => entry.cursor === cursor, {
    message: 'Receipt cursor must resume after its entry',
  });
/** Oldest-first page. `nextCursor` is a scoped PAGE cursor, separate from each entry's room-event resume cursor. */
export const CommunityWireEntryPageSchema = z.strictObject({
  entries: z.array(CommunityWireEntrySchema).max(100),
  nextCursor: cursor.nullable(),
});
/** Scoped history query, including a top-level or one-level thread selector. */
export const CommunityWireEntryPageQuerySchema = z.strictObject({
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  thread: id.optional(),
});

/** A read cursor may only advance, and only to an authorized entry. */
export const CommunityWireReadCursorRequestSchema = z.strictObject({ cursor });
/** Current caller's read position and derived unread count. */
export const CommunityWireReadCursorResponseSchema = z.strictObject({
  cursor: cursor.nullable(),
  unreadCount: z.number().int().nonnegative(),
});
/** Authorized SSE snapshot followed by committed entries or closure. */
export const CommunityWireEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('snapshot'),
    channel: CommunityWireChannelSchema,
    entries: z.array(CommunityWireEntrySchema).max(100),
    /** Authoritative channel sequence captured before this subscription's replay query. */
    capturedSeq: z.number().int().nonnegative(),
    cursor,
  }),
  /** Native consumers use this durable boundary to distinguish bounded replay from new work. */
  z.strictObject({
    type: z.literal('replay_complete'),
    capturedSeq: z.number().int().nonnegative(),
    cursor,
  }),
  z.strictObject({ type: z.literal('entry'), entry: CommunityWireEntrySchema, cursor }),
  z.strictObject({
    type: z.literal('closed'),
    reason: z.enum(['removed', 'archived', 'unavailable']),
    cursor,
  }),
]);
/** One SSE payload. */
export type CommunityWireEvent = z.infer<typeof CommunityWireEventSchema>;

/** Invite setup; the signed token is returned only on creation. */
export const CommunityWireInviteCreateRequestSchema = z.strictObject({
  channelId: id.optional(),
  expiresInDays: z.number().int().min(1).max(30).optional(),
  seats: z.number().int().min(1).max(100).optional(),
});
/** Issued invite metadata; a bearer URL is not part of ordinary listings. */
export const CommunityWireInviteSchema = z.strictObject({
  id,
  channelId: id.nullable(),
  createdAt: timestamp,
  expiresAt: timestamp,
  seats: z.number().int().positive(),
  uses: z.number().int().nonnegative(),
  revoked: z.boolean(),
});
/** Invite creation yields a one-time URL fragment token to the issuer. */
export const CommunityWireInviteCreateResponseSchema = z.strictObject({
  invite: CommunityWireInviteSchema,
  token: id,
});
/** Ordinary invite listings contain metadata but never a reusable token. */
export const CommunityWireInviteListResponseSchema = z.strictObject({
  invites: z.array(CommunityWireInviteSchema),
});
/** Invite preflight exchanges the fragment for a cookie-bound admission. */
export const CommunityWireInvitePreflightResponseSchema = z.strictObject({
  granted: z.literal(true),
  expiresAt: timestamp,
  communityName: z.string().min(1),
  inviterName: z.string().min(1),
  channelName: z.string().nullable(),
});
/** Preview and redeem consume a fragment token through same-origin POST. */
export const CommunityWireInviteTokenRequestSchema = z.strictObject({ token: id });
/** Rate-limited preview reveals only name, inviter and optional channel. */
export const CommunityWireInvitePreviewResponseSchema = z.strictObject({
  communityName: z.string().min(1),
  inviterName: z.string().min(1),
  channelName: z.string().nullable(),
});
/** Binding attaches a pending admission to exactly one signed-in account. */
export const CommunityWireInviteBindResponseSchema = z.strictObject({ bound: z.literal(true) });
/** Redemption needs no reusable invite value after preflight. */
export const CommunityWireInviteRedeemRequestSchema = z.strictObject({});
/** An invite redemption receipt contains admitted member identity. */
export const CommunityWireInviteRedeemResponseSchema = z.strictObject({ memberId: id });

/** A local install begins pairing with a verifier-derived challenge. */
export const CommunityWirePairingStartRequestSchema = z.strictObject({
  installName: z.string().min(1).max(120),
  challenge: id,
  scopes: z.array(z.enum(['read', 'post', 'enroll-agent'])).min(1),
});
/** Start receipt used to open the same-origin human approval page. */
export const CommunityWirePairingStartResponseSchema = z.strictObject({
  pairingId: id,
  approvalUrl: z.url(),
  expiresAt: timestamp,
});
/** Human approval acts on a pending request through their authenticated session. */
export const CommunityWirePairingApproveRequestSchema = z.strictObject({ pairingId: id });
/** Human approval receipt without a verifier, code or bearer. */
export const CommunityWirePairingApproveResponseSchema = z.strictObject({
  approved: z.literal(true),
});
/** An authenticated member may decline an approval request in the browser. */
export const CommunityWirePairingDeclineRequestSchema = z.strictObject({ pairingId: id });
/** Browser decline receipt; no verifier or one-time code is exposed. */
export const CommunityWirePairingDeclineResponseSchema = z.strictObject({
  cancelled: z.literal(true),
});
/** The requesting local server must prove its verifier to poll a pairing. */
export const CommunityWirePairingPollRequestSchema = z.strictObject({
  pairingId: id,
  verifier: id,
});
/** Cancellation uses the same verifier-bound identity as polling. */
export const CommunityWirePairingCancelRequestSchema = CommunityWirePairingPollRequestSchema;
/** Browser-safe pairing status; neither code nor bearer appears here. */
export const CommunityWirePairingStatusResponseSchema = z.strictObject({
  pairingId: id,
  status: z.enum(['pending', 'approved', 'expired', 'cancelled', 'redeemed']),
  installName: z.string().min(1),
  scopes: z.array(z.enum(['read', 'post', 'enroll-agent'])),
  expiresAt: timestamp,
});
/** Private exchange request is verifier-bound and accepted server-to-server only. */
export const CommunityWirePairingExchangeRequestSchema = z.strictObject({
  pairingId: id,
  code: id,
  verifier: id,
});
/** Effective operations granted to one local installation credential. */
export const CommunityWireGrantCapabilitiesSchema = z.strictObject({
  read: z.boolean(),
  post: z.boolean(),
  enrollAgent: z.boolean(),
  stream: z.boolean(),
});
/** Current effective access and the most recently verified Community authority. */
export const CommunityConnectionAccessSchema = z
  .strictObject({
    state: z.enum(['verified', 'unverified', 'reconnect-required']),
    effective: CommunityWireGrantCapabilitiesSchema,
    lastKnown: z
      .strictObject({
        lifecycle: z.enum(['active', 'archived', 'suspended', 'deletion_pending']),
        capabilities: CommunityWireGrantCapabilitiesSchema,
        verifiedAt: timestamp,
      })
      .nullable(),
  })
  .superRefine((access, context) => {
    const effective = Object.values(access.effective);
    if (access.state !== 'verified' && effective.some(Boolean)) {
      context.addIssue({ code: 'custom', message: 'Only verified access can be effective.' });
    }
    if (access.state === 'verified' && !access.lastKnown) {
      context.addIssue({
        code: 'custom',
        message: 'Verified access requires a verification result.',
      });
    }
    if (
      access.state === 'verified' &&
      access.lastKnown &&
      (access.effective.read !== access.lastKnown.capabilities.read ||
        access.effective.post !== access.lastKnown.capabilities.post ||
        access.effective.enrollAgent !== access.lastKnown.capabilities.enrollAgent ||
        access.effective.stream !== access.lastKnown.capabilities.stream)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Verified effective access must match the verification result.',
      });
    }
    if (
      access.lastKnown?.lifecycle === 'archived' &&
      (!access.lastKnown.capabilities.read ||
        access.lastKnown.capabilities.post ||
        access.lastKnown.capabilities.enrollAgent ||
        access.lastKnown.capabilities.stream)
    ) {
      context.addIssue({ code: 'custom', message: 'Archived access is history-only.' });
    }
    if (
      (access.lastKnown?.lifecycle === 'suspended' ||
        access.lastKnown?.lifecycle === 'deletion_pending') &&
      Object.values(access.lastKnown.capabilities).some(Boolean)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Suspended or deleting access has no effective capabilities.',
      });
    }
  });
/** Current effective access and the most recently verified Community authority. */
export type CommunityConnectionAccess = z.infer<typeof CommunityConnectionAccessSchema>;
/** Bearer-bound access for the exact installation grant making the request. */
export const CommunityWireConnectionAccessResponseSchema = z.strictObject({
  access: CommunityConnectionAccessSchema,
});
/** A grant description the member can inspect and revoke without seeing its token. */
export const CommunityWireGrantSchema = z.strictObject({
  id,
  memberId: id,
  installName: z.string().min(1).max(120),
  scopes: z.array(z.enum(['read', 'post', 'enroll-agent'])),
  lifecycle: z.enum(['active', 'archived']),
  capabilities: CommunityWireGrantCapabilitiesSchema,
  createdAt: timestamp,
});
/** Current member's local-install grants. */
export const CommunityWireGrantListResponseSchema = z.strictObject({
  grants: z.array(CommunityWireGrantSchema),
});
/** Disconnecting every installation requires current password confirmation. */
export const CommunityWireDisconnectAllRequestSchema = z.strictObject({ password: id });

/** An enrolled agent identity and owner bond, without a credential. */
export const CommunityWireAgentSchema = z.strictObject({
  memberId: id,
  displayName: z.string().min(1),
  handle: CommunityWireHandleSchema,
  ownerMemberId: id,
  active: z.boolean(),
});
/** An enrolled agent identity. */
export type CommunityWireAgent = z.infer<typeof CommunityWireAgentSchema>;
/** Enrollment request made under a scoped personal grant. */
export const CommunityWireAgentEnrollRequestSchema = z.strictObject({
  // A local harness owns this identifier. It is deliberately not constrained
  // to the community service's UUID vocabulary.
  localAgentId: z.string().min(1).max(256),
  displayName: z.string().min(1),
  /** The server derives a collision-safe handle when omitted. */
  handle: CommunityWireHandleSchema.optional(),
});
/** Public agent management response. */
export const CommunityWireAgentResponseSchema = z.strictObject({ agent: CommunityWireAgentSchema });
/** Public list of agents visible to the current member. */
export const CommunityWireAgentListResponseSchema = z.strictObject({
  agents: z.array(CommunityWireAgentSchema),
});

/** Owner transfer requires current owner reauthentication. */
export const CommunityWireOwnerTransferRequestSchema = z.strictObject({
  successorMemberId: id,
  password: id,
  lifecycleVersion: z.int().positive(),
});
/** Leaving confirms both account control and the exact selected community. */
export const CommunityWireMemberLeaveRequestSchema = z.strictObject({
  password: id,
  communityName: z.string().min(1),
});
/** Transfer receipt with the new current owner identity. */
export const CommunityWireOwnerTransferResponseSchema = z.strictObject({
  communityId: id,
  ownerMemberId: id,
  lifecycleVersion: z.int().positive(),
});
/** Owner export requires current password confirmation. */
export const CommunityWireOwnerExportRequestSchema = z.strictObject({ password: id });
/** Archive manifest metadata; archive bytes use an authorized download stream. */
export const CommunityWireExportResponseSchema = z.strictObject({
  archiveId: id,
  version: z.literal(1),
  createdAt: timestamp,
});

/** Stable error codes for expected authorization, state and quota refusals. */
export const CommunityWireErrorCodeSchema = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'NESTED_THREAD',
  'STATE_CONFLICT',
  'INVITE_EXPIRED',
  'CURSOR_STALE',
  'ATTACHMENT_TOO_LARGE',
  'UNSUPPORTED_ATTACHMENT_TYPE',
  'RATE_LIMITED',
  'COMMUNITY_SELECTION_REQUIRED',
  'COMMUNITY_UNAVAILABLE',
  'COMMUNITY_ARCHIVED',
  'COMMUNITY_SUSPENDED',
  'COMMUNITY_DELETION_PENDING',
  'UNAVAILABLE',
]);
/** Public error response; no database cause, credential or path is serialized. */
export const CommunityWireErrorSchema = z.strictObject({
  code: CommunityWireErrorCodeSchema,
  message: z.string().min(1),
});
/** Public error response. */
export type CommunityWireError = z.infer<typeof CommunityWireErrorSchema>;
