/**
 * Per-member read positions: the attention summary, and each channel's read cursor. Live
 * streams are in `events.ts`.
 */
import type { Hono } from 'hono';
import type { Pool } from 'pg';
import {
  CommunityWireAttentionResponseSchema,
  CommunityWireReadCursorRequestSchema,
  CommunityWireReadCursorResponseSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../../auth.js';
import type { CommunityConfig } from '../../config.js';
import { decodeCursor, encodeCursor } from '../../content/cursor.js';
import {
  assertPrincipalCurrent,
  assertPrincipalCurrentInTransaction,
  lockChannel,
  requireJoined,
  requirePrincipal,
  transaction,
} from '../../data.js';
import { ApiError, json, readJson } from '../../http.js';
import { liveChannel } from './event-stream-access.js';

/** Register the attention summary and monotonic per-member read positions. */
export function registerReadCursorRoutes(
  app: Hono,
  { pool, auth, config }: { pool: Pool; auth: CommunityAuth; config: CommunityConfig }
) {
  app.get('/attention', async (c) => {
    const principal = await requirePrincipal(c, auth, pool, 'read');
    if (principal.kind !== 'human')
      throw new ApiError(403, 'FORBIDDEN', 'Agents do not have personal attention summaries.');
    // Direct messages (DOR-2955) are left out until the DorkOS app can open them: an installed
    // app counts this summary into its badge and would show unread messages it cannot reach.
    const result = await pool.query<{ unread_count: string; mention_count: string }>(
      `SELECT
         COALESCE(SUM(GREATEST(channel.last_seq-COALESCE(cursor.seq,0),0)),0)::text AS unread_count,
         COALESCE(SUM((SELECT count(DISTINCT entry.id) FROM entries entry
           JOIN entry_mentions mention ON mention.entry_id=entry.id
           WHERE entry.channel_id=channel.id AND entry.community_id=$2 AND mention.community_id=$2
             AND entry.seq>COALESCE(cursor.seq,0) AND mention.mentioned_member_id=$1)),0)::text AS mention_count
       FROM channels channel
       LEFT JOIN channel_members membership ON membership.channel_id=channel.id AND membership.member_id=$1
       LEFT JOIN read_cursors cursor ON cursor.channel_id=channel.id AND cursor.member_id=$1
       WHERE channel.community_id=$2 AND channel.kind='channel'
         AND (channel.visibility='public' OR membership.member_id IS NOT NULL)`,
      [principal.id, principal.community_id]
    );
    await assertPrincipalCurrent(c, auth, pool, principal, 'read');
    const row = result.rows[0] ?? { unread_count: '0', mention_count: '0' };
    return json(c, CommunityWireAttentionResponseSchema, {
      unreadCount: Number(row.unread_count),
      mentionCount: Number(row.mention_count),
    });
  });

  app.get('/channels/:id/read-cursor', async (c) => {
    const member = await requirePrincipal(c, auth, pool, 'read');
    if (member.kind !== 'human')
      throw new ApiError(403, 'FORBIDDEN', 'Agents do not have read cursors.');
    const channel = await liveChannel(pool, c.req.param('id'), member);
    await assertPrincipalCurrent(c, auth, pool, member, 'read');
    const seq = Number(channel.read_seq);
    return json(c, CommunityWireReadCursorResponseSchema, {
      cursor: seq
        ? encodeCursor(
            {
              version: 1,
              communityId: member.community_id,
              channelId: channel.id,
              thread: null,
              epoch: channel.epoch,
              seq,
            },
            config
          )
        : null,
      unreadCount: Math.max(0, Number(channel.last_seq) - seq),
    });
  });

  app.put('/channels/:id/read-cursor', async (c) => {
    const member = await requirePrincipal(c, auth, pool, 'read');
    if (member.kind !== 'human')
      throw new ApiError(403, 'FORBIDDEN', 'Agents do not have read cursors.');
    const openedSession = member.credentialHash
      ? undefined
      : await auth.api.getSession({ headers: c.req.raw.headers });
    if (!member.credentialHash && !openedSession)
      throw new ApiError(401, 'UNAUTHENTICATED', 'This sign-in is no longer valid.');
    const body = await readJson(c, CommunityWireReadCursorRequestSchema);
    const { channel, current } = await transaction(pool, async (client) => {
      const channel = await lockChannel(client, c.req.param('id'), member, 'read', 'shared');
      requireJoined(channel);
      await assertPrincipalCurrentInTransaction(client, member, 'read', openedSession?.session.id);
      const seq = decodeCursor(
        body.cursor,
        {
          communityId: member.community_id,
          channelId: channel.id,
          thread: null,
          epoch: channel.epoch,
        },
        config
      );
      if (seq > Number(channel.last_seq))
        throw new ApiError(409, 'STATE_CONFLICT', 'The cursor is ahead of channel history.');
      const result = await client.query<{ seq: string }>(
        `INSERT INTO read_cursors(community_id,channel_id,member_id,seq) VALUES($1,$2,$3,$4)
         ON CONFLICT(channel_id,member_id) DO UPDATE SET seq=GREATEST(read_cursors.seq,EXCLUDED.seq),updated_at=now()
         RETURNING seq`,
        [member.community_id, channel.id, member.id, seq]
      );
      return { channel, current: Number(result.rows[0].seq) };
    });
    return json(c, CommunityWireReadCursorResponseSchema, {
      cursor: current
        ? encodeCursor(
            {
              version: 1,
              communityId: member.community_id,
              channelId: channel.id,
              thread: null,
              epoch: channel.epoch,
              seq: current,
            },
            config
          )
        : null,
      unreadCount: Math.max(0, Number(channel.last_seq) - current),
    });
  });
}
