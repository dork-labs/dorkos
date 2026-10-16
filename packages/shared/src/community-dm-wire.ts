/**
 * The Community wire for direct messages with an agent (DOR-2955, specs/everything-is-a-space
 * C6). Re-exported whole by `community-wire.ts`, so callers import it from there like the rest of
 * the wire.
 *
 * A direct message holds one person and one agent. Its id is a channel id, so its messages,
 * files, read cursor and live stream use the channel routes unchanged; only listing and creating
 * one are new. An agent takes them only when its owner turned that on. All of it is new routes
 * with their own schemas: `GET /channels`, which installed apps parse strictly, never lists one.
 *
 * This module imports nothing from `community-wire.ts`, which re-exports it: a cycle would read
 * its schemas before they exist.
 *
 * @module shared/community-dm-wire
 */
import { z } from 'zod';
import { HANDLE_PATTERN } from './handle.js';

const id = z.string().min(1);
const timestamp = z.iso.datetime();

/** The direct-message routes, merged into `COMMUNITY_API_V1_ROUTES`. */
export const COMMUNITY_DM_ROUTES = {
  dms: '/api/v1/dms',
  agentDms: '/api/v1/agents/:id/dms',
} as const;

/**
 * The direct-message error codes, merged into `CommunityWireErrorCodeSchema`. Added after the
 * first release, so an older reader sees an unknown code.
 */
export const COMMUNITY_DM_ERROR_CODES = [
  /**
   * `409`: this agent does not take direct messages: its owner has not turned them on, or the
   * agent or its owner is no longer in the space.
   */
  'AGENT_NOT_TAKING_DMS',
] as const;

/** Start a direct message with an agent, or find the one already started. */
export const CommunityWireDirectMessageCreateRequestSchema = z.strictObject({ agentId: id });

/** One direct message, as either of its two members reads it. */
export const CommunityWireDirectMessageSchema = z.strictObject({
  /** A channel id: read, post, attach and stream through the channel routes. */
  id,
  /** The person. */
  member: z.strictObject({ memberId: id, displayName: z.string().min(1) }),
  /** The agent, and the person whose agent it is. */
  agent: z.strictObject({
    memberId: id,
    displayName: z.string().min(1),
    handle: z.string().regex(HANDLE_PATTERN),
    ownerMemberId: id,
    ownerDisplayName: z.string().min(1),
  }),
  createdAt: timestamp,
  unreadCount: z.number().int().nonnegative(),
});
/** One direct message. */
export type CommunityWireDirectMessage = z.infer<typeof CommunityWireDirectMessageSchema>;
/** `POST /dms`: the direct message, `201` when it was just started and `200` when it existed. */
export const CommunityWireDirectMessageResponseSchema = z.strictObject({
  dm: CommunityWireDirectMessageSchema,
});
/** `GET /dms`: the caller's direct messages, a person's or an agent's, oldest first. */
export const CommunityWireDirectMessageListResponseSchema = z.strictObject({
  dms: z.array(CommunityWireDirectMessageSchema),
});
/** `PUT /agents/:id/dms`: whether this agent takes direct messages. Its owner's alone to set. */
export const CommunityWireAgentDirectMessagesRequestSchema = z.strictObject({
  accepts: z.boolean(),
});
/** The agent's setting as it now stands. */
export const CommunityWireAgentDirectMessagesResponseSchema = z.strictObject({
  agentId: id,
  acceptsDms: z.boolean(),
});
