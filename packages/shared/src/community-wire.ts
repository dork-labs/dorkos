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
  bootstrapClaim: '/api/v1/bootstrap/claim',
  invites: '/api/v1/invites',
  invitePreview: '/api/v1/invites/preview',
  inviteRedeem: '/api/v1/invites/redeem',
  pairingStart: '/api/v1/pairings/start',
  pairingApprove: '/api/v1/pairings/approve',
  pairingPoll: '/api/v1/pairings/poll',
  pairingExchange: '/api/v1/pairings/exchange',
  channels: '/api/v1/channels',
  channel: '/api/v1/channels/:id',
  channelMembers: '/api/v1/channels/:id/members',
  entries: '/api/v1/channels/:id/entries',
  channelAttachments: '/api/v1/channels/:id/attachments',
  channelReadCursor: '/api/v1/channels/:id/read-cursor',
  channelEvents: '/api/v1/channels/:id/events',
  attachment: '/api/v1/attachments/:id',
  agents: '/api/v1/agents',
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
/** Owner claim requires the secret again; grant identity stays in an HTTP-only cookie. */
export const CommunityWireBootstrapClaimRequestSchema = z.strictObject({
  secret: id,
  name: z.string().min(1),
});
/** Owner claim yields public community and member identity. */
export const CommunityWireBootstrapClaimResponseSchema = z.strictObject({
  community: CommunityWireCommunitySchema,
  memberId: id,
});

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
  text: z.string(),
  /** Member IDs resolved from handles at write time against the joined roster. */
  mentions,
  parentEntryId: id.nullable(),
  threadRootEntryId: id.nullable(),
  createdAt: timestamp,
  /** Server-minted cursor for room-event resume immediately after this entry. */
  cursor,
  attachments: z.array(CommunityWireAttachmentSchema).max(8),
});
/** One committed entry. */
export type CommunityWireEntry = z.infer<typeof CommunityWireEntrySchema>;
/** Post as the bearer or cookie identity; agent selection is by private bearer. */
export const CommunityWireEntryPostRequestSchema = z.strictObject({
  text: z.string().min(1),
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
/** Preview and redeem consume a fragment token through same-origin POST. */
export const CommunityWireInviteTokenRequestSchema = z.strictObject({ token: id });
/** Rate-limited preview reveals only name, inviter and optional channel. */
export const CommunityWireInvitePreviewResponseSchema = z.strictObject({
  communityName: z.string().min(1),
  inviterName: z.string().min(1),
  channelName: z.string().nullable(),
});
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
/** A grant description the member can inspect and revoke without seeing its token. */
export const CommunityWireGrantSchema = z.strictObject({
  id,
  memberId: id,
  scopes: z.array(z.enum(['read', 'post', 'enroll-agent'])),
  createdAt: timestamp,
});
/** Current member's local-install grants. */
export const CommunityWireGrantListResponseSchema = z.strictObject({
  grants: z.array(CommunityWireGrantSchema),
});

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
  localAgentId: id,
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
});
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
  'UNAVAILABLE',
]);
/** Public error response; no database cause, credential or path is serialized. */
export const CommunityWireErrorSchema = z.strictObject({
  code: CommunityWireErrorCodeSchema,
  message: z.string().min(1),
});
/** Public error response. */
export type CommunityWireError = z.infer<typeof CommunityWireErrorSchema>;
