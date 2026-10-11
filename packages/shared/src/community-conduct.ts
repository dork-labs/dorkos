/**
 * A member's own side of a community's moderation, on the `CommunityAdapter` port
 * (specs/official-community-space D6-D8): whether they may post right now, the rules they agreed
 * to, the name they go by, and reporting someone else's message.
 *
 * Every one of these is the connected PERSON's own act. None takes an acting-member option, so no
 * port caller can accept the rules, rename, or report as one of that person's agents, and none
 * can do it for anybody else: who the person is comes from the adapter's own credential.
 *
 * Re-exported whole by `community-adapter.ts`, so callers import it from there like the rest of
 * the port. This module imports nothing from that one, which re-exports it: a cycle would read
 * its schemas before they exist.
 *
 * @module shared/community-conduct
 */
import { z } from 'zod';

/** The longest note a report may carry. */
export const COMMUNITY_REPORT_NOTE_MAX_LENGTH = 1_000;

/** A community's rules, and the version the connected person accepted. Version 0 means none. */
export const CommunityRulesSchema = z.strictObject({
  /** The rules as they stand, or `null` when the community has none. */
  text: z.string().nullable(),
  /** The current version; every change is a new one. */
  version: z.number().int().nonnegative(),
  /** The version this person last accepted; 0 when never. */
  acceptedVersion: z.number().int().nonnegative(),
});
/** {@link CommunityRulesSchema}. */
export type CommunityRules = z.infer<typeof CommunityRulesSchema>;

/**
 * Whether the connected person may post in one room right now, as far as the community's
 * moderation goes: a mute, the room's slow mode, and the rules.
 */
export const CommunityStandingSchema = z.strictObject({
  /** When this person's mute ends, or `null` when they are not muted. */
  mutedUntil: z.iso.datetime().nullable(),
  /** Seconds each person waits between posts in this room; 0 is off. */
  slowModeSeconds: z.number().int().nonnegative(),
  /** The community's rules and this person's acceptance of them. */
  rules: CommunityRulesSchema,
});
/** {@link CommunityStandingSchema}. */
export type CommunityStanding = z.infer<typeof CommunityStandingSchema>;

/** Why a message was reported. */
export const CommunityReportReasonSchema = z.enum([
  'spam',
  'harassment',
  'off_topic',
  'illegal',
  'other',
]);
/** {@link CommunityReportReasonSchema}. */
export type CommunityReportReason = z.infer<typeof CommunityReportReasonSchema>;

/** Report one message to the community's moderators. */
export const ReportCommunityEntryInputSchema = z.strictObject({
  reason: CommunityReportReasonSchema,
  /** What the moderators should know, in the reporter's words. Only moderators read it. */
  note: z.string().trim().min(1).max(COMMUNITY_REPORT_NOTE_MAX_LENGTH).optional(),
});
/** {@link ReportCommunityEntryInputSchema}. */
export type ReportCommunityEntryInput = z.infer<typeof ReportCommunityEntryInputSchema>;
