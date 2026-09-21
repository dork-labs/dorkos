import type { Hono } from 'hono';
import type { Pool } from 'pg';
import {
  CommunityWireChannelSchema,
  CommunityWireAttentionResponseSchema,
  CommunityWireEventSchema,
  CommunityWireReadCursorRequestSchema,
  CommunityWireReadCursorResponseSchema,
  type CommunityWireEvent,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import type { CommunityConfig } from '../config.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import {
  assertPrincipalCurrent,
  assertPrincipalCurrentInTransaction,
  lockChannel,
  requireJoined,
  requirePrincipal,
  transaction,
  type Principal,
} from '../data.js';
import { ApiError, json, readJson } from '../http.js';
import { entryProjection, originKeyForPrincipal } from './entries.js';
import { attachmentsForEntries } from './attachments.js';

interface LiveChannel {
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

async function liveChannel(
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

function channelWire(channel: LiveChannel) {
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

/** Register durable SSE replay and monotonic per-member read positions. */
export function registerEventRoutes(
  app: Hono,
  {
    pool,
    auth,
    config,
    hooks,
  }: {
    pool: Pool;
    auth: CommunityAuth;
    config: CommunityConfig;
    hooks?: {
      afterSnapshotWatermark?: () => Promise<void>;
      afterEntryAttachmentLookup?: () => Promise<void>;
    };
  }
) {
  app.get('/attention', async (c) => {
    const principal = await requirePrincipal(c, auth, pool, 'read');
    if (principal.kind !== 'human')
      throw new ApiError(403, 'FORBIDDEN', 'Agents do not have personal attention summaries.');
    const result = await pool.query<{ unread_count: string; mention_count: string }>(
      `SELECT
         COALESCE(SUM(GREATEST(channel.last_seq-COALESCE(cursor.seq,0),0)),0)::text AS unread_count,
         COALESCE(SUM((SELECT count(DISTINCT entry.id) FROM entries entry
           JOIN entry_mentions mention ON mention.entry_id=entry.id
           WHERE entry.channel_id=channel.id AND entry.community_id=$2
             AND entry.seq>COALESCE(cursor.seq,0) AND mention.mentioned_member_id=$1)),0)::text AS mention_count
       FROM channels channel
       LEFT JOIN channel_members membership ON membership.channel_id=channel.id AND membership.member_id=$1
       LEFT JOIN read_cursors cursor ON cursor.channel_id=channel.id AND cursor.member_id=$1
       WHERE channel.community_id=$2 AND (channel.visibility='public' OR membership.member_id IS NOT NULL)`,
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
      throw new ApiError(401, 'UNAUTHENTICATED', 'This session is unavailable.');
    const body = await readJson(c, CommunityWireReadCursorRequestSchema);
    const { channel, current } = await transaction(pool, async (client) => {
      const channel = await lockChannel(client, c.req.param('id'), member, 'read');
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

  app.get('/channels/:id/events', async (c) => {
    const principal = await requirePrincipal(c, auth, pool, 'read');
    if (principal.credentialKind === 'grant' && principal.historyOnly)
      throw new ApiError(403, 'FORBIDDEN', 'This read-only connection cannot open live updates.');
    const openedSession = principal.credentialHash
      ? null
      : await auth.api.getSession({ headers: c.req.raw.headers });
    if (!principal.credentialHash && !openedSession)
      throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const channel = await liveChannel(pool, c.req.param('id'), principal);
    const resume = c.req.header('last-event-id');
    let position = resume
      ? decodeCursor(
          resume,
          {
            communityId: principal.community_id,
            channelId: channel.id,
            thread: null,
            epoch: channel.epoch,
          },
          config
        )
      : Number(channel.last_seq);
    const capturedSeq = Number(channel.last_seq);
    if (position > capturedSeq)
      throw new ApiError(410, 'CURSOR_STALE', 'This cursor is ahead of channel history.');
    await hooks?.afterSnapshotWatermark?.();
    const snapshotRows = (
      await pool.query(
        resume
          ? `SELECT e.id,e.channel_id,e.seq,COALESCE(e.author_member_id,e.author_agent_id) AS author_member_id,e.author_agent_id,e.author_display_name,e.text,COALESCE((SELECT array_agg(COALESCE(em.mentioned_member_id,em.mentioned_agent_id) ORDER BY em.position) FROM entry_mentions em WHERE em.entry_id=e.id),'{}'::uuid[]) AS mentions,e.parent_entry_id,e.thread_root_entry_id,e.created_at,e.idempotency_key,a.owner_member_id AS agent_owner_member_id
             FROM entries e LEFT JOIN agents a ON a.id=e.author_agent_id WHERE e.channel_id=$1 AND e.seq>$2 AND e.seq<=$3 ORDER BY e.seq LIMIT 100`
          : `SELECT e.id,e.channel_id,e.seq,COALESCE(e.author_member_id,e.author_agent_id) AS author_member_id,e.author_agent_id,e.author_display_name,e.text,COALESCE((SELECT array_agg(COALESCE(em.mentioned_member_id,em.mentioned_agent_id) ORDER BY em.position) FROM entry_mentions em WHERE em.entry_id=e.id),'{}'::uuid[]) AS mentions,e.parent_entry_id,e.thread_root_entry_id,e.created_at,e.idempotency_key,a.owner_member_id AS agent_owner_member_id
             FROM (SELECT * FROM entries WHERE channel_id=$1 AND seq<=$2 ORDER BY seq DESC LIMIT 100) e LEFT JOIN agents a ON a.id=e.author_agent_id ORDER BY e.seq`,
        resume ? [channel.id, position, capturedSeq] : [channel.id, position]
      )
    ).rows;
    if (snapshotRows.length) position = Number(snapshotRows.at(-1).seq);
    const snapshotAttachments = await attachmentsForEntries(
      pool,
      snapshotRows.map((row: { id: string }) => row.id)
    );
    await assertPrincipalCurrent(c, auth, pool, principal, 'read');
    if (openedSession) {
      const currentSession = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!currentSession || currentSession.session.id !== openedSession.session.id)
        throw new ApiError(401, 'UNAUTHENTICATED', 'This session is unavailable.');
    }
    const encoder = new TextEncoder();
    let revocationTimer: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let replayComplete = false;
    let lastHeartbeat = Date.now();
    const currentCursor = () =>
      encodeCursor(
        {
          version: 1,
          communityId: principal.community_id,
          channelId: channel.id,
          thread: null,
          epoch: channel.epoch,
          seq: position,
        },
        config
      );
    const writeEvent = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      event: CommunityWireEvent
    ) => {
      const parsed = CommunityWireEventSchema.parse(event);
      controller.enqueue(
        encoder.encode(
          `id: ${parsed.cursor}\nevent: ${parsed.type}\ndata: ${JSON.stringify(parsed)}\n\n`
        )
      );
    };
    const stop = () => {
      closed = true;
      if (revocationTimer) clearInterval(revocationTimer);
    };
    const checkAccess = async () => {
      // The opening request already verified the cookie signature or bearer.
      // Revalidate that exact credential and the channel in ONE fresh database
      // snapshot. Calling Better Auth twice per entry repeats unrelated account
      // hydration and makes durable catch-up slower than incoming traffic.
      // Nothing is cached: this query also runs after attachment enrichment.
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
        channel.id,
        principal.community_id,
        principal.credentialHash ?? openedSession!.session.id,
      ];
      if (cookie) values.push(openedSession!.user.id, openedSession!.session.token);
      if (principal.kind === 'agent') values.push(principal.ownerMemberId);
      const active = await pool.query<{
        active: boolean;
        joined: boolean;
        archived: boolean;
        epoch: number;
      }>(
        principal.kind === 'agent'
          ? `SELECT (a.active AND owner.active) AS active,(cm.agent_id IS NOT NULL) AS joined,ch.archived,ch.epoch
           FROM agents a JOIN members owner ON owner.id=a.owner_member_id
           JOIN communities co ON co.id=a.community_id AND co.lifecycle='active'
           JOIN channels ch ON ch.id=$2
           LEFT JOIN agent_channel_members cm ON cm.channel_id=ch.id AND cm.agent_id=a.id
           WHERE a.id=$1 AND a.community_id=$3 AND ch.community_id=$3
             AND a.owner_member_id=$5 AND ${credential}`
          : `SELECT m.active,(cm.member_id IS NOT NULL) AS joined,ch.archived,ch.epoch
           FROM members m JOIN communities co ON co.id=m.community_id AND co.lifecycle='active'
           JOIN channels ch ON ch.id=$2
           LEFT JOIN channel_members cm ON cm.channel_id=ch.id AND cm.member_id=m.id
           WHERE m.id=$1 AND m.community_id=$3 AND ch.community_id=$3 AND ${credential}`,
        values
      );
      return active.rows[0];
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          writeEvent(controller, {
            type: 'snapshot',
            channel: channelWire(channel),
            entries: snapshotRows.map((row) =>
              entryProjection(
                row,
                channel.epoch,
                config,
                snapshotAttachments.get(row.id),
                principal.community_id,
                originKeyForPrincipal(row, principal)
              )
            ),
            capturedSeq,
            cursor: currentCursor(),
          });
          if (position >= capturedSeq) {
            replayComplete = true;
            writeEvent(controller, {
              type: 'replay_complete',
              capturedSeq,
              cursor: currentCursor(),
            });
          }
          revocationTimer = setInterval(() => {
            void checkAccess()
              .then((state) => {
                if (
                  closed ||
                  (state?.active &&
                    state.joined &&
                    !state.archived &&
                    state.epoch === channel.epoch)
                )
                  return;
                stop();
                if (controller.desiredSize !== null && controller.desiredSize > 0) {
                  writeEvent(controller, {
                    type: 'closed',
                    reason: state?.archived ? 'archived' : 'removed',
                    cursor: currentCursor(),
                  });
                  controller.close();
                } else {
                  controller.error(new Error('Community stream access ended'));
                }
              })
              .catch(() => {
                if (!closed) {
                  stop();
                  controller.error(new Error('Community stream unavailable'));
                }
              });
          }, 250);
          c.req.raw.signal.addEventListener(
            'abort',
            () => {
              if (!closed) {
                stop();
                controller.close();
              }
            },
            { once: true }
          );
        },
        async pull(controller) {
          if (closed) return;
          try {
            while (!closed) {
              if (!replayComplete && position >= capturedSeq) {
                replayComplete = true;
                writeEvent(controller, {
                  type: 'replay_complete',
                  capturedSeq,
                  cursor: currentCursor(),
                });
                return;
              }
              const state = await checkAccess();
              if (closed) return;
              if (
                !state?.active ||
                !state.joined ||
                state.archived ||
                state.epoch !== channel.epoch
              ) {
                stop();
                writeEvent(controller, {
                  type: 'closed',
                  reason: state?.archived ? 'archived' : 'removed',
                  cursor: currentCursor(),
                });
                controller.close();
                return;
              }
              const result = await pool.query(
                `SELECT e.id,e.channel_id,e.seq,COALESCE(e.author_member_id,e.author_agent_id) AS author_member_id,e.author_agent_id,e.author_display_name,e.text,COALESCE((SELECT array_agg(COALESCE(em.mentioned_member_id,em.mentioned_agent_id) ORDER BY em.position) FROM entry_mentions em WHERE em.entry_id=e.id),'{}'::uuid[]) AS mentions,e.parent_entry_id,e.thread_root_entry_id,e.created_at,e.idempotency_key,a.owner_member_id AS agent_owner_member_id
               FROM entries e LEFT JOIN agents a ON a.id=e.author_agent_id WHERE e.channel_id=$1 AND e.seq>$2 ORDER BY e.seq LIMIT 1`,
                [channel.id, position]
              );
              if (closed) return;
              const row = result.rows[0];
              if (row) {
                position = Number(row.seq);
                const attachmentMap = await attachmentsForEntries(pool, [row.id]);
                await hooks?.afterEntryAttachmentLookup?.();
                const afterEnrichment = await checkAccess();
                if (closed) return;
                if (
                  !afterEnrichment?.active ||
                  !afterEnrichment.joined ||
                  afterEnrichment.archived ||
                  afterEnrichment.epoch !== channel.epoch
                ) {
                  stop();
                  writeEvent(controller, {
                    type: 'closed',
                    reason: afterEnrichment?.archived ? 'archived' : 'removed',
                    cursor: currentCursor(),
                  });
                  controller.close();
                  return;
                }
                const entry = entryProjection(
                  row,
                  channel.epoch,
                  config,
                  attachmentMap.get(row.id),
                  principal.community_id,
                  originKeyForPrincipal(row, principal)
                );
                writeEvent(controller, { type: 'entry', entry, cursor: entry.cursor });
                return;
              }
              if (Date.now() - lastHeartbeat >= 15_000) {
                controller.enqueue(encoder.encode(': keepalive\n\n'));
                lastHeartbeat = Date.now();
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          } catch {
            if (!closed) {
              stop();
              controller.error(new Error('Community stream unavailable'));
            }
          }
        },
        cancel() {
          stop();
        },
      },
      { highWaterMark: 1 }
    );
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      },
    });
  });
}
