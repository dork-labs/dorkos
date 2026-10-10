/**
 * The Community wire for a space's moderation (specs/official-community-space D6-D8): bans,
 * mutes, slow mode, rules and their acceptance, display names, and the report queue. Re-exported
 * whole by `community-wire.ts`, so callers import it from there like the rest of the wire.
 *
 * This module imports nothing from `community-wire.ts`, which re-exports it: a cycle would read
 * its schemas before they exist.
 *
 * @module shared/community-moderation-wire
 */
import { z } from 'zod';

const id = z.string().min(1);
const nullableId = id.nullable();
const timestamp = z.iso.datetime();

/** The moderation routes, merged into `COMMUNITY_API_V1_ROUTES`. */
export const COMMUNITY_MODERATION_ROUTES = {
  channelSlowMode: '/api/v1/channels/:id/slow-mode',
  memberMute: '/api/v1/members/:id/mute',
  mutes: '/api/v1/mutes',
  meStanding: '/api/v1/me/standing',
  rules: '/api/v1/rules',
  rulesAccept: '/api/v1/rules/accept',
  reservedNames: '/api/v1/reserved-names',
  entryReports: '/api/v1/entries/:id/reports',
  reports: '/api/v1/reports',
  reportResolve: '/api/v1/reports/:id/resolve',
} as const;

/**
 * The moderation error codes, merged into `CommunityWireErrorCodeSchema`. Each was added after
 * the first release, so an older reader sees an unknown code.
 */
export const COMMUNITY_MODERATION_ERROR_CODES = [
  /**
   * `403`: an owner or admin muted this person, so they and their agents cannot post until
   * `until`.
   */
  'COMMUNITY_MUTED',
  /**
   * `429`: the channel is in slow mode and this person posted there too recently; `Retry-After`
   * says when they can post again.
   */
  'COMMUNITY_SLOW_MODE',
  /**
   * `403`: the space has rules this person (or, for an agent, its owner) has not accepted in
   * their current version.
   */
  'COMMUNITY_RULES_NOT_ACCEPTED',
] as const;

/** Seconds each person waits between posts in a slow-mode channel; 0 is off. */
export const CommunityWireSlowModeSecondsSchema = z.int().min(0).max(21_600);
/** A channel's slow mode, readable by anyone who can read the channel. */
export const CommunityWireChannelSlowModeSchema = z.strictObject({
  seconds: CommunityWireSlowModeSecondsSchema,
});

/** The longest mute: one year, in minutes. */
export const COMMUNITY_MUTE_MAX_MINUTES = 525_600;
/** Mute a member for a while: they and their agents cannot post until it ends. */
export const CommunityWireMuteRequestSchema = z.strictObject({
  minutes: z.int().min(1).max(COMMUNITY_MUTE_MAX_MINUTES),
});
/** The mute now in force. */
export const CommunityWireMuteResponseSchema = z.strictObject({
  memberId: id,
  mutedUntil: timestamp,
});
/** One person muted now, as owners and admins see the list. */
export const CommunityWireMuteSchema = z.strictObject({
  memberId: id,
  displayName: z.string(),
  handle: z.string(),
  mutedUntil: timestamp,
});
/** {@link CommunityWireMuteSchema}. */
export type CommunityWireMute = z.infer<typeof CommunityWireMuteSchema>;
/** Everyone muted now, soonest to end first. */
export const CommunityWireMuteListResponseSchema = z.strictObject({
  mutes: z.array(CommunityWireMuteSchema).max(500),
});
/** The caller's own standing: whether they can post now. */
export const CommunityWireStandingSchema = z.strictObject({
  mutedUntil: timestamp.nullable(),
});

/** {@link CommunityWireStandingSchema}. */
export type CommunityWireStanding = z.infer<typeof CommunityWireStandingSchema>;
/** The longest rules text. */
export const COMMUNITY_RULES_MAX_LENGTH = 20_000;
/** A space's rules and the version the caller accepted. Version 0 means no rules. */
export const CommunityWireRulesSchema = z.strictObject({
  text: z.string().nullable(),
  version: z.int().nonnegative(),
  acceptedVersion: z.int().nonnegative(),
});
/** {@link CommunityWireRulesSchema}. */
export type CommunityWireRules = z.infer<typeof CommunityWireRulesSchema>;
/**
 * Replace the rules (owners and admins). `null` removes them. Every change is a new version
 * everyone accepts again; `expectedVersion` refuses an edit over someone else's.
 */
export const CommunityWireRulesUpdateRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(COMMUNITY_RULES_MAX_LENGTH).nullable(),
  expectedVersion: z.int().nonnegative(),
});
/** Accept the rules as they stand in this exact version. */
export const CommunityWireRulesAcceptRequestSchema = z.strictObject({
  version: z.int().positive(),
});

/** A display name a person picks for one space, as account names are limited. */
export const CommunityWireDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  // No control characters, and no invisible or direction-changing format characters: a name is
  // shown on one line everywhere, and reads the same as what it compares as. The zero-width
  // joiner stays, for emoji sequences; comparison ignores it.
  .refine((name) => !/[\p{Cc}\p{Zl}\p{Zp}]|(?!\u200D)\p{Cf}/u.test(name), {
    message: 'Use letters, numbers and spaces.',
  });
/** Change the caller's own display name in this space. */
export const CommunityWireDisplayNameUpdateRequestSchema = z.strictObject({
  displayName: CommunityWireDisplayNameSchema,
});
/** Display names nobody but the space may use, such as the space's own name or its staff's. */
export const CommunityWireReservedNamesSchema = z.strictObject({
  names: z.array(CommunityWireDisplayNameSchema).max(200),
});

/** Why a message was reported. */
export const CommunityWireReportReasonSchema = z.enum([
  'spam',
  'harassment',
  'off_topic',
  'illegal',
  'other',
]);
/** Report a message to the space's owners and admins. A member reports one message once. */
export const CommunityWireReportRequestSchema = z.strictObject({
  reason: CommunityWireReportReasonSchema,
  note: z.string().trim().min(1).max(1_000).optional(),
});
/** The receipt a reporter gets; it never says what moderators did. */
export const CommunityWireReportReceiptSchema = z.strictObject({ reported: z.literal(true) });
/** One report, as owners and admins see the queue. */
export const CommunityWireReportSchema = z.strictObject({
  id,
  entryId: id,
  channelId: id,
  /** `member` for a person's report; `check` for an automated, watch-only check's hint. */
  source: z.enum(['member', 'check']),
  checkName: z.string().nullable(),
  reason: CommunityWireReportReasonSchema,
  note: z.string().nullable(),
  status: z.enum(['open', 'actioned', 'dismissed']),
  action: z.enum(['remove', 'mute', 'ban']).nullable(),
  reporter: z.strictObject({ memberId: id, displayName: z.string() }).nullable(),
  author: z.strictObject({
    memberId: id,
    displayName: z.string(),
    kind: z.enum(['human', 'agent']),
  }),
  /**
   * The message as it stands, at most 280 characters; null when it is in a private channel the
   * reader has not joined, so a report never opens a channel to someone outside it.
   */
  excerpt: z.string().nullable(),
  createdAt: timestamp,
  resolvedAt: timestamp.nullable(),
});
/** One report, as owners and admins see the queue. */
export type CommunityWireReport = z.infer<typeof CommunityWireReportSchema>;
/** Reports, oldest open first. */
export const CommunityWireReportListResponseSchema = z.strictObject({
  reports: z.array(CommunityWireReportSchema).max(200),
});
/** Which reports to list. */
export const CommunityWireReportListQuerySchema = z.strictObject({
  status: z.enum(['open', 'resolved']).optional(),
});
/**
 * Resolve a report, and with it every open report of the same message: remove the message,
 * mute or ban its author (an agent's owner), or dismiss.
 */
export const CommunityWireReportResolveRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('remove') }),
  z.strictObject({
    action: z.literal('mute'),
    minutes: z.int().min(1).max(COMMUNITY_MUTE_MAX_MINUTES),
  }),
  z.strictObject({
    action: z.literal('ban'),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  z.strictObject({ action: z.literal('dismiss') }),
]);
/** One way to resolve a report. */
export type CommunityWireReportResolveRequest = z.infer<
  typeof CommunityWireReportResolveRequestSchema
>;
/** How many open reports of the message this resolved. */
export const CommunityWireReportResolveResponseSchema = z.strictObject({
  resolved: z.int().nonnegative(),
});

/** Ban a member: they leave the space and cannot come back with that account or email. */
export const CommunityWireBanRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500).optional(),
});
/** One standing ban, as owners and admins see it. Never carries the email or its key. */
export const CommunityWireBanSchema = z.strictObject({
  id,
  /** The membership the ban ended; null for a ban an import restored without its member. */
  memberId: id.nullable(),
  displayName: z.string(),
  handle: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: timestamp,
});
/** One standing ban. */
export type CommunityWireBan = z.infer<typeof CommunityWireBanSchema>;
/** The ban a ban request made or found standing. */
export const CommunityWireBanResponseSchema = z.strictObject({ ban: CommunityWireBanSchema });
/** Standing bans, newest first. */
export const CommunityWireBanListResponseSchema = z.strictObject({
  bans: z.array(CommunityWireBanSchema).max(500),
});
