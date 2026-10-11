/**
 * The connected person's own side of a Community's moderation, for {@link RemoteCommunityAdapter}:
 * their standing in a channel, accepting the rules, their name, and reporting a message.
 *
 * Every request here goes out on the person's own grant. None can select an enrolled agent, so
 * no caller can accept the rules, rename, or report as one, and the Community refuses an agent
 * credential on each of these routes too.
 *
 * @module services/communities/remote/adapter/remote-community-conduct
 */
import {
  COMMUNITY_API_V1_ROUTES,
  CommunityWireChannelSlowModeSchema,
  CommunityWireMemberResponseSchema,
  CommunityWireReportReceiptSchema,
  CommunityWireRulesSchema,
  CommunityWireStandingSchema,
} from '@dorkos/shared/community-wire';
import {
  CommunityRoomNotFoundError,
  type CommunityMember,
  type CommunityRef,
  type CommunityRules,
  type CommunityStanding,
  type ReportCommunityEntryInput,
} from '@dorkos/shared/community-adapter';
import { PinnedHttpError } from '../pinned-origin.js';

/** One request on the connected person's own grant, as the adapter makes it. */
export type ConductRequest = (
  path: string,
  body: unknown,
  method: 'GET' | 'POST' | 'PATCH'
) => Promise<unknown>;

const withId = (route: string, roomId: string) => route.replace(':id', encodeURIComponent(roomId));

/** A channel the person cannot see answers as one that is not there, as everywhere else. */
function missingRoom(error: unknown, community: CommunityRef, roomId: string): unknown {
  return error instanceof PinnedHttpError && error.status === 404
    ? new CommunityRoomNotFoundError(community, roomId)
    : error;
}

/**
 * Read whether the person may post in one channel: their mute, its slow mode, and the rules.
 *
 * @param request - The adapter's request on the person's grant.
 * @param community - The community, for a refusal's address.
 * @param roomId - The channel.
 */
export async function readStanding(
  request: ConductRequest,
  community: CommunityRef,
  roomId: string
): Promise<CommunityStanding> {
  const [standing, slowMode, rules] = await Promise.all([
    request(COMMUNITY_API_V1_ROUTES.meStanding, undefined, 'GET'),
    request(withId(COMMUNITY_API_V1_ROUTES.channelSlowMode, roomId), undefined, 'GET').catch(
      (error: unknown) => {
        throw missingRoom(error, community, roomId);
      }
    ),
    request(COMMUNITY_API_V1_ROUTES.rules, undefined, 'GET'),
  ]);
  return {
    mutedUntil: CommunityWireStandingSchema.parse(standing).mutedUntil,
    slowModeSeconds: CommunityWireChannelSlowModeSchema.parse(slowMode).seconds,
    rules: CommunityWireRulesSchema.parse(rules),
  };
}

/**
 * Accept the rules in exactly this version.
 *
 * @param request - The adapter's request on the person's grant.
 * @param version - The version the person read.
 */
export async function acceptRules(
  request: ConductRequest,
  version: number
): Promise<CommunityRules> {
  return CommunityWireRulesSchema.parse(
    await request(COMMUNITY_API_V1_ROUTES.rulesAccept, { version }, 'POST')
  );
}

/**
 * Change the person's own name in this community.
 *
 * @param request - The adapter's request on the person's grant.
 * @param community - The community the returned member belongs to.
 * @param displayName - The new name.
 */
export async function renameSelf(
  request: ConductRequest,
  community: CommunityRef,
  displayName: string
): Promise<CommunityMember> {
  const { member } = CommunityWireMemberResponseSchema.parse(
    await request(COMMUNITY_API_V1_ROUTES.me, { displayName }, 'PATCH')
  );
  return {
    community,
    memberId: member.memberId,
    kind: member.kind,
    displayName: member.displayName,
    handle: member.handle,
    role: member.role,
    ownerMemberId: member.ownerMemberId,
    joinedAt: member.joinedAt,
  };
}

/**
 * Report someone else's message to the community's moderators.
 *
 * @param request - The adapter's request on the person's grant.
 * @param community - The community, for a refusal's address.
 * @param roomId - The channel the message is in.
 * @param entryId - The message.
 * @param input - Why, and the note.
 */
export async function reportEntry(
  request: ConductRequest,
  community: CommunityRef,
  roomId: string,
  entryId: string,
  input: ReportCommunityEntryInput
): Promise<void> {
  try {
    CommunityWireReportReceiptSchema.parse(
      await request(
        withId(COMMUNITY_API_V1_ROUTES.entryReports, entryId),
        { reason: input.reason, ...(input.note ? { note: input.note } : {}) },
        'POST'
      )
    );
  } catch (error) {
    throw missingRoom(error, community, roomId);
  }
}
