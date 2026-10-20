/**
 * A space's settings as the app shows them on the space's Settings tab (DOR-3005): its settings,
 * the person's own membership, who is in it and its rules. Each is read by the local server
 * through the connection's own `read` grant, which never reaches the browser, and the last answer
 * is kept, so a space that cannot be reached still shows what it said last, and when.
 *
 * Read-only: every change still happens on the space's own web settings page.
 *
 * @module shared/community-space-settings
 */
import { z } from 'zod';
import { CommunityAdminSettingsSchema } from './community-admin-wire.js';
import {
  CommunityWireMemberDirectoryPageSchema,
  CommunityWireMemberResponseSchema,
  CommunityWireRulesSchema,
} from './community-wire.js';

/**
 * The four reads, each one fixed path on the space. Nothing else is reached through them: no
 * caller-built path, no query beyond the one each read always sends.
 */
export const COMMUNITY_SPACE_READS = ['settings', 'me', 'members', 'rules'] as const;
/** One of the four reads. */
export type CommunitySpaceRead = (typeof COMMUNITY_SPACE_READS)[number];

/** When a read's value came from the space, and whether the space could not be reached now. */
const freshness = {
  /** When the space sent this value. */
  fetchedAt: z.iso.datetime(),
  /** True when the space could not be reached and this is the last value it sent. */
  offline: z.boolean(),
};

/** `GET /api/community-connections/:ref/space/settings`. */
export const CommunitySpaceSettingsReadSchema = z.strictObject({
  value: CommunityAdminSettingsSchema,
  ...freshness,
});
/** `GET /api/community-connections/:ref/space/me`: the person's own membership and role. */
export const CommunitySpaceMeReadSchema = z.strictObject({
  value: CommunityWireMemberResponseSchema,
  ...freshness,
});
/** `GET /api/community-connections/:ref/space/members`: people, with their agents when sent. */
export const CommunitySpaceMembersReadSchema = z.strictObject({
  value: CommunityWireMemberDirectoryPageSchema,
  ...freshness,
});
/** `GET /api/community-connections/:ref/space/rules`. */
export const CommunitySpaceRulesReadSchema = z.strictObject({
  value: CommunityWireRulesSchema,
  ...freshness,
});

/** The schema each read answers with. */
export const COMMUNITY_SPACE_READ_SCHEMAS = {
  settings: CommunitySpaceSettingsReadSchema,
  me: CommunitySpaceMeReadSchema,
  members: CommunitySpaceMembersReadSchema,
  rules: CommunitySpaceRulesReadSchema,
} as const;

/** One read's answer: the value, when it was sent, and whether the space was reachable. */
export type CommunitySpaceReadResult<Read extends CommunitySpaceRead> = z.infer<
  (typeof COMMUNITY_SPACE_READ_SCHEMAS)[Read]
>;

/** A space's settings, read through the local server. */
export interface CommunitySpaceSettingsTransport {
  /** One of the space's four settings reads, or the last value it sent when it is unreachable. */
  readCommunitySpace<Read extends CommunitySpaceRead>(
    ref: string,
    read: Read
  ): Promise<CommunitySpaceReadResult<Read>>;
}
