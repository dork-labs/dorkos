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
import {
  CommunityAdminAdmissionPolicySchema,
  CommunityAdminLifecycleSchema,
} from './community-admin-wire.js';
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
  communityName: '/api/v1/community-names/:name',
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
  invitePending: '/api/v1/invites/pending',
  pairingStart: '/api/v1/pairings/start',
  pairingApprove: '/api/v1/pairings/approve',
  pairingDecline: '/api/v1/pairings/decline',
  pairingPoll: '/api/v1/pairings/poll',
  pairingCancel: '/api/v1/pairings/cancel',
  pairingExchange: '/api/v1/pairings/exchange',
  channels: '/api/v1/channels',
  attention: '/api/v1/attention',
  channel: '/api/v1/channels/:id',
  channelMembers: '/api/v1/channels/:id/members',
  channelAgents: '/api/v1/channels/:id/agents',
  entries: '/api/v1/channels/:id/entries',
  threads: '/api/v1/channels/:id/threads',
  entry: '/api/v1/entries/:id',
  channelAttachments: '/api/v1/channels/:id/attachments',
  channelReadCursor: '/api/v1/channels/:id/read-cursor',
  channelEvents: '/api/v1/channels/:id/events',
  attachment: '/api/v1/attachments/:id',
  exports: '/api/v1/exports',
  exportArchive: '/api/v1/exports/:id',
  exportArchiveBytes: '/api/v1/exports/:id/archive',
  exportCancel: '/api/v1/exports/:id/cancel',
  agents: '/api/v1/agents',
  me: '/api/v1/me',
  connectionAccess: '/api/v1/me/connection-access',
  meConnection: '/api/v1/me/connection',
  hostAccess: '/api/v1/me/host-access',
  members: '/api/v1/members',
  authOptions: '/api/v1/auth-options',
  hostLinks: '/api/v1/host-links',
  memberRole: '/api/v1/members/:id/role',
  meGrants: '/api/v1/me/grants',
  meExport: '/api/v1/me/export',
  meLeave: '/api/v1/me/leave',
  ownerTransfer: '/api/v1/owner/transfer',
  ownerExport: '/api/v1/owner/export',
  ownerErasures: '/api/v1/owner/erasures',
  accountFormerMemberships: '/api/v1/account/former-memberships',
  accountErasures: '/api/v1/account/erasures',
  accountErasureCancel: '/api/v1/account/erasures/:id/cancel',
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
/**
 * The shortest new password a Community accepts, wherever one is set: sign-up, first-install
 * setup, adding a password to a provider account, and offline recovery. Signing in with an older,
 * shorter password still works.
 */
export const COMMUNITY_PASSWORD_MIN_LENGTH = 12;

/** First-install setup creates the host account and initial tenant in one transaction. */
export const CommunityWireBootstrapCompleteRequestSchema = z.strictObject({
  secret: id,
  accountName: z.string().trim().min(1).max(128),
  email: z.email(),
  password: z.string().min(COMMUNITY_PASSWORD_MIN_LENGTH).max(128),
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
  /** While held: the date after which the host plans to delete the community, if published. */
  deletionNoticeAt: timestamp.nullable(),
  /** The community's current short address, if it has one. */
  shortName: z.string().nullable(),
  memberId: id,
  displayName: z.string().min(1),
  role: z.enum(['owner', 'admin', 'member']),
});
/** Public exact-match short-name lookup: the community a live name leads to. */
export const CommunityWireShortNameLookupSchema = z.strictObject({
  communityId: z.uuid(),
  /** The current name, which differs from the one asked for when that one was retired. */
  shortName: z.string().min(3).max(32),
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
  /** The host's OpenID Connect sign-in and its button text, or `null` when the host set none. */
  oidc: z.strictObject({ label: z.string().trim().min(1).max(40) }).nullable(),
});
/** Public sign-in options: which buttons the sign-in page shows beside email and password. */
export type CommunityWireAuthOptions = z.infer<typeof CommunityWireAuthOptionsSchema>;

const REPORT_MAILBOX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * Whether `value` is a `mailto:` report address a Report link can safely add its own body to:
 * exactly one mailbox, with no query, fragment, second recipient or header of its own, even
 * once percent-decoded. Returns the canonical `mailto:<address>`, or `null` when refused.
 */
export function parseCommunityReportMailto(value: string): string | null {
  if (!value.startsWith('mailto:')) return null;
  const raw = value.slice('mailto:'.length);
  // A bare trailing `?` or `#` parses as an empty query or fragment, and would swallow the body.
  if (/[?#]/u.test(raw)) return null;
  let address: string;
  try {
    address = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (/[,;&?%\s\p{Cc}]/u.test(address) || !REPORT_MAILBOX.test(address)) return null;
  return `mailto:${address}`;
}

/**
 * The host's own terms, privacy notice and abuse-report address, each `null` when the host set
 * none. Terms and privacy are `https:` pages; a report address may also be one bare `mailto:`
 * mailbox (see {@link parseCommunityReportMailto}).
 */
export const CommunityWireHostLinksSchema = z.strictObject({
  termsUrl: z.url({ protocol: /^https$/ }).nullable(),
  privacyUrl: z.url({ protocol: /^https$/ }).nullable(),
  reportAbuseUrl: z
    .union([
      z.url({ protocol: /^https$/ }),
      z.string().refine((value) => parseCommunityReportMailto(value) === value),
    ])
    .nullable(),
});
/** Host-set public links shown on sign-in, in account settings and on each message. */
export type CommunityWireHostLinks = z.infer<typeof CommunityWireHostLinksSchema>;

/** How the signed-in account can sign in: a password, the host's OIDC issuer, or both. */
export const CommunityWireAccountSignInMethodsSchema = z.strictObject({
  password: z.boolean(),
  oidc: z.boolean(),
});
/** How the signed-in account can sign in. */
export type CommunityWireAccountSignInMethods = z.infer<
  typeof CommunityWireAccountSignInMethodsSchema
>;
/** Add a first password to an account that signs in only through a provider. */
export const CommunityWireAccountPasswordRequestSchema = z.strictObject({
  newPassword: z.string().min(COMMUNITY_PASSWORD_MIN_LENGTH).max(128),
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
/**
 * Tenant-authorized aggregate activity for the currently authenticated human.
 * Counts deliberately omit channel, author, and entry identity. Every mention
 * is also unread activity, so a response claiming more mentions than unread
 * messages is rejected here, at the trust boundary, rather than surviving until
 * it poisons a local response built from many remotes.
 */
export const CommunityWireAttentionResponseSchema = z
  .strictObject({
    unreadCount: z.number().int().nonnegative(),
    mentionCount: z.number().int().nonnegative(),
  })
  .refine((attention) => attention.mentionCount <= attention.unreadCount, {
    message: 'Mentions must be a subset of unread activity.',
    path: ['mentionCount'],
  });
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
/**
 * The entry as it stands after a message or one of its files was removed: its tombstone, or the
 * message without that file. No cursor: a removal does not move the room.
 */
export const CommunityWireEntryRemoveResponseSchema = z.strictObject({
  entry: CommunityWireEntrySchema,
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

/**
 * Ask for the reply counts under up to one page of top-level entries, named by
 * id as `roots=a,b,c`.
 *
 * A route of its own rather than a field on the entry, because every wire
 * object is strict: a `thread` field on {@link CommunityWireEntrySchema} would
 * make an older installation refuse every page an upgraded server sends. A
 * caller that gets a 404 here is talking to a server from before this route
 * and simply shows no counts.
 */
export const CommunityWireThreadSummaryQuerySchema = z.strictObject({
  roots: z
    .string()
    .min(1)
    .transform((roots) => roots.split(','))
    .pipe(
      z
        .array(id)
        .min(1)
        .max(100)
        .refine((ids) => new Set(ids).size === ids.length)
    ),
});
/** One thread root's replies, as counted at one moment. */
export const CommunityWireThreadSummarySchema = z.strictObject({
  rootEntryId: id,
  /** Replies below the root. Never counts the root itself, and never zero. */
  replyCount: z.number().int().positive(),
  lastReplyAt: timestamp,
  /**
   * The channel sequence of the newest reply counted. A reply the caller sees
   * later with a higher `seq` arrived after this count and is not in it.
   */
  lastReplySeq: z.number().int().positive(),
});
/** One thread summary. See {@link CommunityWireThreadSummarySchema}. */
export type CommunityWireThreadSummary = z.infer<typeof CommunityWireThreadSummarySchema>;
/** Summaries for the asked-for roots that have replies; a root with none is left out. */
export const CommunityWireThreadSummaryListSchema = z.strictObject({
  threads: z.array(CommunityWireThreadSummarySchema).max(100),
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
/**
 * Rate-limited preview reveals only name, inviter, optional channel, and whether the host holds
 * the community: a held community keeps its invitations, and they work again after release.
 */
export const CommunityWireInvitePreviewResponseSchema = z.strictObject({
  communityName: z.string().min(1),
  inviterName: z.string().min(1),
  channelName: z.string().nullable(),
  held: z.boolean(),
});
/**
 * A reload reads its still-live pending admission back from the HttpOnly cookie, so the review
 * survives without the raw invitation. `account` is present only for a signed-in browser and
 * says whether joining would create, keep, or reactivate that account's membership, and
 * whether this join attempt already belongs to a different account.
 */
export const CommunityWireInvitePendingResponseSchema = z.strictObject({
  expiresAt: timestamp,
  communityName: z.string().min(1),
  inviterName: z.string().min(1),
  channelName: z.string().nullable(),
  account: z
    .strictObject({
      membership: z.enum(['none', 'active', 'inactive']),
      boundToAnotherAccount: z.boolean(),
    })
    .nullable(),
});
/** The pending admission a clean join URL resumes after a reload or sign-in callback. */
export type CommunityWireInvitePending = z.infer<typeof CommunityWireInvitePendingResponseSchema>;
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
/**
 * Whether the account behind the exact installation grant making the request
 * runs this host, and so may create communities on it.
 *
 * A separate read rather than a field on the connection-access response, which
 * is strict: an installation built before this field existed would reject the
 * whole access check, and so mark a working connection offline. A host built
 * before this read answers 404, which a caller treats as "not an operator".
 *
 * The answer only decides whether an installation OFFERS a way to the host's
 * own creation page. It grants nothing: that page signs the person in and
 * checks host authority again before creating anything.
 */
export const CommunityWireHostAccessResponseSchema = z.strictObject({
  hostOperator: z.boolean(),
});
/** Host authority of the account behind one installation grant. */
export type CommunityWireHostAccessResponse = z.infer<typeof CommunityWireHostAccessResponseSchema>;
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
/** Why an export job stopped without an archive. */
export const CommunityWireExportFailureCodeSchema = z.enum([
  'EXPORT_TIMED_OUT',
  'EXPORT_ACCESS_ENDED',
  'EXPORT_CONTENT_CHANGING',
  'EXPORT_STORAGE_UNAVAILABLE',
]);
/** One export failure code. */
export type CommunityWireExportFailureCode = z.infer<typeof CommunityWireExportFailureCodeSchema>;

/**
 * One export job or archive, as its requester sees it. An export is prepared in the background;
 * `progress` counts messages plus files written, against the total once the job has counted them.
 * Only the same-origin browser bundle parses this object.
 */
export const CommunityWireExportSchema = z.strictObject({
  id,
  scope: z.enum(['personal', 'owner']),
  state: z.enum(['queued', 'building', 'ready', 'failed', 'cancelled', 'expired']),
  progress: z.strictObject({
    done: z.int().nonnegative(),
    total: z.int().nonnegative().nullable(),
  }),
  /** Set once ready. */
  byteSize: z.int().positive().nullable(),
  failureCode: CommunityWireExportFailureCodeSchema.nullable(),
  createdAt: timestamp,
  readyAt: timestamp.nullable(),
  expiresAt: timestamp.nullable(),
});
/** One export job or archive. */
export type CommunityWireExport = z.infer<typeof CommunityWireExportSchema>;
/** Answer to creating, reading or cancelling one export. */
export const CommunityWireExportResponseSchema = z.strictObject({
  export: CommunityWireExportSchema,
});
/** The caller's exports that are open or ended within the last seven days, newest first. */
export const CommunityWireExportListSchema = z.strictObject({
  exports: z.array(CommunityWireExportSchema).max(50),
});

/** A relative, forward-slash path of one entry inside an export archive. */
const archivePath = z
  .string()
  .min(1)
  .max(1_024)
  .refine((path) => path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'));
const nullableId = id.nullable();

/** One `channels/NNNNNN.ndjson` line of an export archive (version 2). */
export const CommunityExportChannelRowSchema = z.strictObject({
  id,
  name: z.string().min(1),
  description: z.string().nullable(),
  visibility: z.enum(['public', 'private']),
  archived: z.boolean(),
  created_at: timestamp,
});
/**
 * One `members/NNNNNN.ndjson` line. `email` is present for owner exports (null for an erased
 * member) and, in a personal export, only on the requester's own row.
 */
export const CommunityExportMemberRowSchema = z.strictObject({
  id,
  display_name: z.string(),
  handle: z.string(),
  role: z.enum(['owner', 'admin', 'member']),
  active: z.boolean(),
  created_at: timestamp,
  removed_at: timestamp.nullable(),
  email: z.string().nullable(),
});
/** One `agents/NNNNNN.ndjson` line. */
export const CommunityExportAgentRowSchema = z.strictObject({
  id,
  owner_member_id: id,
  display_name: z.string(),
  handle: z.string(),
  active: z.boolean(),
  created_at: timestamp,
  revoked_at: timestamp.nullable(),
});
/** One `channel-members/NNNNNN.ndjson` line: a person's membership of a channel. */
export const CommunityExportChannelMemberRowSchema = z.strictObject({
  channel_id: id,
  member_id: id,
  joined_at: timestamp,
});
/** One `agent-channel-members/NNNNNN.ndjson` line: an agent's membership of a channel. */
export const CommunityExportAgentChannelMemberRowSchema = z.strictObject({
  channel_id: id,
  agent_id: id,
  joined_at: timestamp,
});
/** One `audit-events/NNNNNN.ndjson` line (owner exports only). */
export const CommunityExportAuditEventRowSchema = z.strictObject({
  id,
  community_id: id,
  actor_member_id: nullableId,
  actor_kind: z.enum(['member', 'system']),
  action: z.string().min(1),
  subject_id: z.string().nullable(),
  prior_state: z.string().nullable(),
  next_state: z.string().nullable(),
  changed_fields: z.array(z.string()),
  created_at: timestamp,
});
/**
 * One `entries/NNNNNN.ndjson` line: a message. `removal` says who removed it (`author`,
 * `moderator`, `host`) or that its author was erased; the text is then the tombstone sentence.
 */
export const CommunityExportEntryRowSchema = z.strictObject({
  id,
  channel_id: id,
  seq: z.int().positive(),
  author_member_id: nullableId,
  author_agent_id: nullableId,
  author_display_name: z.string(),
  text: z.string(),
  mentions: z.array(id),
  parent_entry_id: nullableId,
  thread_root_entry_id: nullableId,
  created_at: timestamp,
  removal: z.enum(['author', 'moderator', 'host', 'erased']).nullable(),
});
/** One `attachments/NNNNNN.ndjson` line: a file's metadata; its bytes are at `archivePath`. */
export const CommunityExportAttachmentRowSchema = z.strictObject({
  id,
  channelId: id,
  entryId: id,
  uploaderMemberId: nullableId,
  uploaderAgentId: nullableId,
  name: z.string().min(1),
  contentType: z.string().min(1),
  byteSize: z.int().positive(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  uploadedAt: timestamp,
  archivePath,
});

const exportFileKeys = {
  channels: z.array(archivePath),
  members: z.array(archivePath),
  agents: z.array(archivePath),
  channelMembers: z.array(archivePath),
  agentChannelMembers: z.array(archivePath),
  auditEvents: z.array(archivePath),
  entries: z.array(archivePath),
  attachments: z.array(archivePath),
};
const count = z.int().nonnegative();

/**
 * `manifest.json` of an export archive, version 2: the last entry before the central directory.
 * Rows live in the NDJSON files it lists, each line parsed by its row schema above.
 */
export const CommunityExportManifestV2Schema = z.strictObject({
  version: z.literal(2),
  scope: z.enum(['personal', 'owner']),
  exportId: id,
  requesterMemberId: id,
  createdAt: timestamp,
  completedAt: timestamp,
  community: z.strictObject({
    id,
    name: z.string().min(1).max(80),
    description: z.string().max(1_000).nullable(),
    admissionPolicy: CommunityAdminAdmissionPolicySchema,
    lifecycle: z.enum(['active', 'archived']),
    lifecycleVersion: z.int().positive(),
    settingsVersion: z.int().positive(),
    icon: z
      .strictObject({
        path: z.literal('community/icon'),
        contentType: z.string().min(1),
        byteSize: z.int().positive(),
        checksum: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .nullable(),
  }),
  files: z.strictObject(exportFileKeys),
  counts: z.strictObject({
    channels: count,
    members: count,
    agents: count,
    channelMembers: count,
    agentChannelMembers: count,
    auditEvents: count,
    entries: count,
    attachments: count,
  }),
});
/** Version 2 export manifest. */
export type CommunityExportManifestV2 = z.infer<typeof CommunityExportManifestV2Schema>;

/**
 * One request to erase a person from one community (`membership`) or from the
 * whole host (`account`). It waits 72 hours in `scheduled`, when the person can
 * still cancel it. Only the same-origin browser bundle parses this object.
 */
export const CommunityWireErasureSchema = z.strictObject({
  id,
  kind: z.enum(['membership', 'account']),
  state: z.enum(['scheduled', 'running', 'completed', 'cancelled']),
  communityId: id.nullable(),
  /** Set only on the person's own account routes, for their own memberships. */
  communityName: z.string().nullable(),
  executeAfter: timestamp,
  createdAt: timestamp,
  completedAt: timestamp.nullable(),
  cancelledAt: timestamp.nullable(),
});
/** One erasure request. */
export type CommunityWireErasure = z.infer<typeof CommunityWireErasureSchema>;
/**
 * Ask to erase yourself. Accounts with a password confirm it; accounts that
 * sign in only through a provider must have signed in within five minutes.
 * An account erasure also asks for the account's email, typed exactly.
 */
export const CommunityWireErasureCreateRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('membership'),
    communityId: z.uuid(),
    password: id.max(128).optional(),
  }),
  z.strictObject({
    kind: z.literal('account'),
    confirmEmail: z.string().min(1).max(320),
    password: id.max(128).optional(),
  }),
]);
/** One erasure request, created, repeated or cancelled. */
export const CommunityWireErasureResponseSchema = z.strictObject({
  erasure: CommunityWireErasureSchema,
});
/** The account's open erasures and those it cancelled in the last 30 days. */
export const CommunityWireErasureListResponseSchema = z.strictObject({
  erasures: z.array(CommunityWireErasureSchema),
});
/** A community this account belonged to and has left or been removed from. */
export const CommunityWireFormerMembershipSchema = z.strictObject({
  communityId: id,
  communityName: z.string().min(1),
  leftAt: timestamp.nullable(),
  erasure: CommunityWireErasureSchema.nullable(),
});
/** Communities this account has left, for erasing yourself from one of them. */
export const CommunityWireFormerMembershipListResponseSchema = z.strictObject({
  memberships: z.array(CommunityWireFormerMembershipSchema),
});
/**
 * A self-erasure that has finished in this community. The owner sees only the
 * erased member's id and when it finished, never a scheduled one.
 */
export const CommunityWireOwnerErasureSchema = z.strictObject({
  id,
  memberId: id,
  completedAt: timestamp,
});
/** Completed self-erasures in one community, newest first. */
export const CommunityWireOwnerErasureListResponseSchema = z.strictObject({
  erasures: z.array(CommunityWireOwnerErasureSchema),
});

/** Stable error codes for expected authorization, state and quota refusals. */
export const CommunityWireErrorCodeSchema = z.enum([
  'REAUTH_REQUIRED',
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
  'REAUTH_FAILED',
  'COMMUNITY_SELECTION_REQUIRED',
  'COMMUNITY_UNAVAILABLE',
  'COMMUNITY_ARCHIVED',
  'COMMUNITY_SUSPENDED',
  'COMMUNITY_DELETION_PENDING',
  'UNAVAILABLE',
  'MEMBER_LIMIT_REACHED',
  'STORAGE_LIMIT_REACHED',
  'AGENT_LIMIT_REACHED',
  'COMMUNITY_HELD',
  'SHORT_NAME_TAKEN',
  'SHORT_NAME_RESERVED',
  'PASSWORD_REQUIRED',
]);
/** A Community's machine-readable error code; the closed set a client may branch on. */
export type CommunityWireErrorCode = z.infer<typeof CommunityWireErrorCodeSchema>;
/** Public error response; no database cause, credential or path is serialized. */
export const CommunityWireErrorSchema = z.strictObject({
  code: CommunityWireErrorCodeSchema,
  message: z.string().min(1),
});
/** Public error response. */
export type CommunityWireError = z.infer<typeof CommunityWireErrorSchema>;

/*
 * Browser paths a Community serves to people, not to installations.
 *
 * A DorkOS installation never performs membership or administration on a
 * person's behalf: inviting, leaving and changing a Community's settings all
 * need the person's own Community sign-in, and some need their password. So
 * the DorkOS app opens these pages on the Community's own origin instead, and
 * both sides agree on the paths here.
 */

/** The sections of one Community's settings page, in the order it shows them. */
export const COMMUNITY_SETTINGS_SECTIONS = [
  'community',
  'members',
  'agents',
  'account',
  'settings',
] as const;
/** One section of a Community's settings page. */
export type CommunitySettingsSection = (typeof COMMUNITY_SETTINGS_SECTIONS)[number];

/**
 * The path that opens one Community's settings, optionally at one section.
 *
 * The page still decides what the signed-in person may see: a section their
 * role does not allow falls back to one it does.
 *
 * @param communityId - The Community's own id on its host.
 * @param section - The section to open, or the page's default for the person's role.
 */
export function communitySettingsPath(
  communityId: string,
  section?: CommunitySettingsSection
): string {
  const base = `/c/${encodeURIComponent(communityId)}/settings`;
  return section ? `${base}/${section}` : base;
}

/**
 * The path of a host's administration page, where a host operator creates a
 * community. It sits on the host's origin, not under any one community.
 */
export const COMMUNITY_HOST_ADMIN_PATH = '/host';

/**
 * Read a settings path back.
 *
 * @param pathname - A browser path on the Community's origin.
 * @param basePath - The community's base path when it was reached by its short name
 *   (`/<name>`); omitted, the canonical `/c/<id>` base is read.
 * @returns The requested section (`null` for the default), or `null` when the
 *   path is not a settings path at all.
 */
export function parseCommunitySettingsPath(
  pathname: string,
  basePath?: string
): { section: CommunitySettingsSection | null } | null {
  // A community reached by its short name has `/<name>` as its base instead of `/c/<id>`.
  const base = basePath ? basePath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') : String.raw`\/c\/[^/]+`;
  const match = new RegExp(`^${base}\\/settings(?:\\/([^/]+))?\\/?$`, 'u').exec(pathname);
  if (!match) return null;
  const section = match[1];
  if (section === undefined) return { section: null };
  return (COMMUNITY_SETTINGS_SECTIONS as readonly string[]).includes(section)
    ? { section: section as CommunitySettingsSection }
    : { section: null };
}

/**
 * Whether a pasted value is a Community invitation link: an https address (or
 * plain http on this machine) with no sign-in in it, whose path is a
 * Community's join page and whose fragment carries the invite.
 *
 * The fragment never reaches a server, which is why the link can be opened as
 * it is without the DorkOS app reading or keeping the invite itself.
 *
 * @param value - Text the person pasted.
 */
export function isCommunityInvitationUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  // A link that carries a sign-in in its address is never one a Community issues.
  if (url.username || url.password) return false;
  // Plain http only for a Community on this machine; anywhere else the invite
  // would cross the network unencrypted.
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return false;
  if (!/^\/(?:c\/[^/]+\/)?join\/?$/u.test(url.pathname)) return false;
  const fragment = new URLSearchParams(url.hash.slice(1));
  return Boolean(fragment.get('invite') ?? fragment.get('token'));
}
