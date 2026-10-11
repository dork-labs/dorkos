/**
 * The channel a live stream reads and the access checks that keep it open: who may open one,
 * and why an open one must close. The stream itself is in `events.ts`.
 */
import type { Pool } from 'pg';
import { CommunityWireChannelSchema } from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../../auth.js';
import type { Principal } from '../../data.js';
import { ApiError } from '../../http.js';
import { isReadOnlyLifecycle } from '../../tenant-context.js';

/** A channel as a live stream or read cursor sees it, with the caller's membership and position. */
export interface LiveChannel {
  id: string;
  name: string;
  description: string | null;
  visibility: 'public' | 'private';
  archived: boolean;
  epoch: number;
  last_seq: string;
  created_at: Date;
  joined: boolean;
  read_seq: string;
}

/** The browser session a stream was opened with, or null for a bearer credential. */
export type OpenedSession = Awaited<ReturnType<CommunityAuth['api']['getSession']>>;

/** Why a live stream closed. */
export type StreamCloseReason = 'archived' | 'removed' | 'deleted' | 'taken_down';

/**
 * Read a channel the principal has joined, or refuse it as not found.
 *
 * @param pool - Database pool.
 * @param channelId - The channel to read.
 * @param principal - The member or agent asking.
 */
export async function liveChannel(
  pool: Pool,
  channelId: string,
  principal: Principal
): Promise<LiveChannel> {
  const agent = principal.kind === 'agent';
  const result = await pool.query<LiveChannel>(
    `SELECT c.id,c.name,c.description,c.visibility,c.archived,c.epoch,c.last_seq,c.created_at,
      (cm.${agent ? 'agent_id' : 'member_id'} IS NOT NULL) AS joined,COALESCE(rc.seq,0)::text AS read_seq
     FROM channels c
     LEFT JOIN ${agent ? 'agent_channel_members' : 'channel_members'} cm ON cm.channel_id=c.id AND cm.${agent ? 'agent_id' : 'member_id'}=$2
     LEFT JOIN read_cursors rc ON rc.channel_id=c.id AND rc.member_id=$2
     WHERE c.id=$1 AND c.community_id=$3`,
    [channelId, principal.id, principal.community_id]
  );
  const channel = result.rows[0];
  if (!channel || !channel.joined) throw new ApiError(404, 'NOT_FOUND', 'Channel not found.');
  return channel;
}

/** The wire form of a joined live channel, as a stream's snapshot carries it. */
export function channelWire(channel: LiveChannel) {
  return CommunityWireChannelSchema.parse({
    id: channel.id,
    name: channel.name,
    description: channel.description,
    visibility: channel.visibility,
    archived: channel.archived,
    createdAt: channel.created_at.toISOString(),
    joined: true,
    unreadCount: Math.max(0, Number(channel.last_seq) - Number(channel.read_seq)),
  });
}

/** One fresh look at a stream's credential, channel, and community. */
export interface StreamAccess {
  active: boolean;
  joined: boolean;
  archived: boolean;
  epoch: number;
  lifecycle: string;
  /** The host took the whole community down. */
  taken_down: boolean;
}

/**
 * Why a live stream must close now, or null to keep it open.
 *
 * A read-only community (archived by its owner or held by its host) closes the stream as
 * `archived`: the person can still read, just not live. A community its host took down closes
 * it as `taken_down`, and one whose deletion finished as `deleted`, whether or not the stream's
 * credential still reads (a takedown revokes every installation's). A missing credential, a
 * removal, or any other lifecycle (an ordinary pending deletion included) closes it as `removed`.
 *
 * @param state - The stream's access as last read, or nothing when the credential sees nothing.
 * @param epoch - The channel epoch the stream opened at.
 * @param gone - Why the community is gone, read only when the credential no longer sees it.
 */
export function streamCloseReason(
  state: StreamAccess | null | undefined,
  epoch: number,
  gone: 'taken_down' | 'deleted' | null
): StreamCloseReason | null {
  if (!state) return gone ?? 'removed';
  if (state.taken_down) return 'taken_down';
  if (state.lifecycle === 'active') {
    if (state.active && state.joined && !state.archived && state.epoch === epoch) return null;
    return state.archived ? 'archived' : 'removed';
  }
  return state.active && isReadOnlyLifecycle(state.lifecycle) ? 'archived' : 'removed';
}

/**
 * Read a stream's access fresh: its exact credential and its channel in one database snapshot.
 *
 * The opening request already verified the cookie signature or bearer. Revalidating that exact
 * credential and the channel in ONE fresh snapshot avoids calling Better Auth twice per entry,
 * which repeats unrelated account hydration and makes durable catch-up slower than incoming
 * traffic. Returns null for a cookie stream with no opened session.
 *
 * @param pool - Database pool.
 * @param principal - The member or agent the stream belongs to.
 * @param openedSession - The browser session the stream opened with, if it used a cookie.
 * @param channelId - The stream's channel.
 */
export async function readStreamAccess(
  pool: Pool,
  principal: Principal,
  openedSession: OpenedSession,
  channelId: string
): Promise<StreamAccess | null | undefined> {
  const credential =
    principal.kind === 'agent'
      ? `EXISTS (SELECT 1 FROM agent_credentials ac WHERE ac.agent_id=a.id
         AND ac.token_hash=$4 AND ac.revoked_at IS NULL)`
      : principal.credentialKind === 'grant'
        ? `EXISTS (SELECT 1 FROM connection_grants g WHERE g.member_id=m.id
           AND g.token_hash=$4 AND g.revoked_at IS NULL
           AND g.scopes @> ARRAY['read']::text[] AND NOT g.history_only)`
        : `EXISTS (SELECT 1 FROM session s WHERE s.id=$4 AND s."userId"=m.user_id
           AND s."userId"=$5 AND s.token=$6 AND s."expiresAt">now())`;
  const cookie = !principal.credentialHash;
  if (cookie && !openedSession) return null;
  const values: unknown[] = [
    principal.id,
    channelId,
    principal.community_id,
    principal.credentialHash ?? openedSession!.session.id,
  ];
  if (cookie) values.push(openedSession!.user.id, openedSession!.session.token);
  if (principal.kind === 'agent') values.push(principal.ownerMemberId);
  const active = await pool.query<StreamAccess>(
    principal.kind === 'agent'
      ? `SELECT (a.active AND owner.active) AS active,(cm.agent_id IS NOT NULL) AS joined,ch.archived,ch.epoch,co.lifecycle,
         (co.takedown_id IS NOT NULL) AS taken_down
       FROM agents a JOIN members owner ON owner.id=a.owner_member_id
       JOIN communities co ON co.id=a.community_id
       JOIN channels ch ON ch.id=$2
       LEFT JOIN agent_channel_members cm ON cm.channel_id=ch.id AND cm.agent_id=a.id
       WHERE a.id=$1 AND a.community_id=$3 AND ch.community_id=$3
         AND a.owner_member_id=$5 AND ${credential}`
      : `SELECT m.active,(cm.member_id IS NOT NULL) AS joined,ch.archived,ch.epoch,co.lifecycle,
         (co.takedown_id IS NOT NULL) AS taken_down
       FROM members m JOIN communities co ON co.id=m.community_id
       JOIN channels ch ON ch.id=$2
       LEFT JOIN channel_members cm ON cm.channel_id=ch.id AND cm.member_id=m.id
       WHERE m.id=$1 AND m.community_id=$3 AND ch.community_id=$3 AND ${credential}`,
    values
  );
  return active.rows[0];
}
