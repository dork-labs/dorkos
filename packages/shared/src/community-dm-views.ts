/**
 * Direct messages with an agent in a space, as the local app's browser sees them (DOR-2955,
 * specs/everything-is-a-space C6). The space holds them (`community-dm-wire.ts`); the local
 * server reaches them with this install's own grant, or with an enrolled agent's credential when
 * the owner reads what someone said to their agent. No credential or local mirror id crosses to
 * the browser.
 *
 * @module shared/community-dm-views
 */
import { z } from 'zod';
import { CommunityRefSchema } from './community-adapter.js';
import type { RemoteCommunityHistoryResponse } from './community-views.js';

const id = z.string().min(1);

/** One direct message this install can open: one of its person's, or one with its own agent. */
export const RemoteCommunityDmSchema = z.strictObject({
  community: CommunityRefSchema,
  /** The space's channel id: read and post through the room routes. */
  roomId: id,
  /** The person in it. */
  member: z.strictObject({ memberId: id, displayName: z.string().min(1) }),
  /** The agent in it, and whose agent it is. */
  agent: z.strictObject({
    memberId: id,
    displayName: z.string().min(1),
    ownerMemberId: id,
    ownerDisplayName: z.string().min(1),
  }),
  /**
   * True when this install's person is not in it: it is someone's direct message with one of
   * their agents, which the owner reads through that agent and cannot post in.
   */
  readOnly: z.boolean(),
  /** The owner's enrolled local agent, on a read-only one; absent otherwise. */
  localAgentId: id.optional(),
  unreadCount: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
});
/** One direct message this install can open. */
export type RemoteCommunityDm = z.infer<typeof RemoteCommunityDmSchema>;

/** `GET /api/communities/:ref/dms`: whether the space holds them, and the ones this install sees. */
export const RemoteCommunityDmsResponseSchema = z.strictObject({
  community: CommunityRefSchema,
  /** The space says it holds direct messages (`features.agentDms`). False hides every control. */
  available: z.boolean(),
  dms: z.array(RemoteCommunityDmSchema),
  /** True when one of the owner's agents' direct messages couldn't be read; the rest are listed. */
  incomplete: z.literal(true).optional(),
});
/** This install's direct messages in one space. */
export type RemoteCommunityDmsResponse = z.infer<typeof RemoteCommunityDmsResponseSchema>;

/** Start a direct message with an agent in the space, by its member id there. */
export const RemoteCommunityStartDmRequestSchema = z.strictObject({ agentMemberId: id });
/** The direct message, started or found. */
export const RemoteCommunityStartDmResponseSchema = z.strictObject({ dm: RemoteCommunityDmSchema });

/** The owner's switch: whether one of their enrolled agents takes direct messages. */
export const RemoteCommunityAgentDmsRequestSchema = z.strictObject({ accepts: z.boolean() });
/** The switch as it now stands. */
export const RemoteCommunityAgentDmsResponseSchema = z.strictObject({
  localAgentId: id,
  acceptsDms: z.boolean(),
});

/** The refusal code when an agent does not take direct messages; the browser names the agent. */
export const AGENT_NOT_TAKING_DMS = 'AGENT_NOT_TAKING_DMS' as const;

/** Local-server operations for direct messages; each address includes its connection ref. */
export interface RemoteCommunityDmTransport {
  /** Whether the space holds direct messages, and the ones this install can open. */
  listRemoteCommunityDms(ref: string): Promise<RemoteCommunityDmsResponse>;
  /** Start a direct message with an agent, or find the one started; refused when it takes none. */
  startRemoteCommunityDm(ref: string, agentMemberId: string): Promise<RemoteCommunityDm>;
  /** The owner turns one of their agents' direct messages on or off. */
  setRemoteCommunityAgentDms(
    ref: string,
    localAgentId: string,
    accepts: boolean
  ): Promise<{ localAgentId: string; acceptsDms: boolean }>;
  /**
   * The owner reads a direct message with their agent, through that agent: the newest page, or
   * only what came after `after` (an entry's cursor).
   */
  listRemoteCommunityAgentDmEntries(
    ref: string,
    roomId: string,
    localAgentId: string,
    after?: string
  ): Promise<RemoteCommunityHistoryResponse>;
}
