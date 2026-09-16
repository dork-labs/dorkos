import type { Hono } from 'hono';
import type { Pool } from 'pg';
import {
  CommunityWireChannelSchema,
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
  lockChannel,
  requireJoined,
  requireMember,
  requirePrincipal,
  transaction,
  type Principal,
} from '../data.js';
import { ApiError, json, readJson } from '../http.js';
import { entryProjection } from './entries.js';
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
    hooks?: { afterSnapshotWatermark?: () => Promise<void> };
  }
) {
  app.get('/api/v1/channels/:id/read-cursor', async (c) => {
    const member = await requireMember(c, auth, pool);
    const channel = await liveChannel(pool, c.req.param('id'), {
      kind: 'human',
      id: member.id,
      ownerMemberId: member.id,
      display_name: member.display_name,
      community_id: member.community_id,
    });
    const currentMember = await requireMember(c, auth, pool);
    if (currentMember.id !== member.id)
      throw new ApiError(401, 'UNAUTHENTICATED', 'This session is unavailable.');
    const seq = Number(channel.read_seq);
    return json(c, CommunityWireReadCursorResponseSchema, {
      cursor: seq
        ? encodeCursor({ channelId: channel.id, thread: null, epoch: channel.epoch, seq }, config)
        : null,
      unreadCount: Math.max(0, Number(channel.last_seq) - seq),
    });
  });

  app.put('/api/v1/channels/:id/read-cursor', async (c) => {
    const member = await requireMember(c, auth, pool);
    const body = await readJson(c, CommunityWireReadCursorRequestSchema);
    const { channel, current } = await transaction(pool, async (client) => {
      const channel = await lockChannel(client, c.req.param('id'), member);
      requireJoined(channel);
      const currentMember = await requireMember(c, auth, pool);
      if (currentMember.id !== member.id)
        throw new ApiError(401, 'UNAUTHENTICATED', 'This session is unavailable.');
      const active = await client.query('SELECT 1 FROM members WHERE id=$1 AND active FOR SHARE', [
        member.id,
      ]);
      if (!active.rowCount) throw new ApiError(403, 'FORBIDDEN', 'Your membership has ended.');
      const seq = decodeCursor(
        body.cursor,
        { channelId: channel.id, thread: null, epoch: channel.epoch },
        config
      );
      if (seq > Number(channel.last_seq))
        throw new ApiError(409, 'STATE_CONFLICT', 'The cursor is ahead of channel history.');
      const result = await client.query<{ seq: string }>(
        `INSERT INTO read_cursors(channel_id,member_id,seq) VALUES($1,$2,$3)
         ON CONFLICT(channel_id,member_id) DO UPDATE SET seq=GREATEST(read_cursors.seq,EXCLUDED.seq),updated_at=now()
         RETURNING seq`,
        [channel.id, member.id, seq]
      );
      return { channel, current: Number(result.rows[0].seq) };
    });
    return json(c, CommunityWireReadCursorResponseSchema, {
      cursor: current
        ? encodeCursor(
            { channelId: channel.id, thread: null, epoch: channel.epoch, seq: current },
            config
          )
        : null,
      unreadCount: Math.max(0, Number(channel.last_seq) - current),
    });
  });

  app.get('/api/v1/channels/:id/events', async (c) => {
    const principal = await requirePrincipal(c, auth, pool, 'read');
    const openedSession = principal.credentialHash
      ? null
      : await auth.api.getSession({ headers: c.req.raw.headers });
    if (!principal.credentialHash && !openedSession)
      throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const channel = await liveChannel(pool, c.req.param('id'), principal);
    const resume = c.req.header('last-event-id');
    let position = resume
      ? decodeCursor(resume, { channelId: channel.id, thread: null, epoch: channel.epoch }, config)
      : Number(channel.last_seq);
    if (position > Number(channel.last_seq))
      throw new ApiError(410, 'CURSOR_STALE', 'This cursor is ahead of channel history.');
    await hooks?.afterSnapshotWatermark?.();
    const snapshotRows = resume
      ? []
      : (
          await pool.query(
            `SELECT id,channel_id,seq,COALESCE(author_member_id,author_agent_id) AS author_member_id,author_display_name,text,mentions,parent_entry_id,thread_root_entry_id,created_at
       FROM (SELECT * FROM entries WHERE channel_id=$1 AND seq<=$2 ORDER BY seq DESC LIMIT 100) e ORDER BY seq`,
            [channel.id, position]
          )
        ).rows;
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
    let lastHeartbeat = Date.now();
    const currentCursor = () =>
      encodeCursor(
        { channelId: channel.id, thread: null, epoch: channel.epoch, seq: position },
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
      if (openedSession) {
        const session = await auth.api.getSession({ headers: c.req.raw.headers });
        if (
          !session ||
          session.user.id !== openedSession.user.id ||
          session.session.id !== openedSession.session.id
        )
          return null;
      }
      try {
        const current = await requirePrincipal(c, auth, pool, 'read', false);
        if (
          current.id !== principal.id ||
          current.kind !== principal.kind ||
          current.credentialHash !== principal.credentialHash
        )
          return null;
      } catch {
        return null;
      }
      const active = await pool.query<{
        active: boolean;
        joined: boolean;
        archived: boolean;
        epoch: number;
      }>(
        principal.kind === 'agent'
          ? `SELECT (a.active AND owner.active) AS active,(cm.agent_id IS NOT NULL) AS joined,ch.archived,ch.epoch
           FROM agents a JOIN members owner ON owner.id=a.owner_member_id JOIN channels ch ON ch.id=$2
           LEFT JOIN agent_channel_members cm ON cm.channel_id=ch.id AND cm.agent_id=a.id WHERE a.id=$1`
          : `SELECT m.active,(cm.member_id IS NOT NULL) AS joined,ch.archived,ch.epoch
           FROM members m JOIN channels ch ON ch.id=$2
           LEFT JOIN channel_members cm ON cm.channel_id=ch.id AND cm.member_id=m.id WHERE m.id=$1`,
        [principal.id, channel.id]
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
              entryProjection(row, channel.epoch, config, snapshotAttachments.get(row.id))
            ),
            cursor: currentCursor(),
          });
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
                `SELECT id,channel_id,seq,COALESCE(author_member_id,author_agent_id) AS author_member_id,author_display_name,text,mentions,parent_entry_id,thread_root_entry_id,created_at
               FROM entries WHERE channel_id=$1 AND seq>$2 ORDER BY seq LIMIT 1`,
                [channel.id, position]
              );
              if (closed) return;
              const row = result.rows[0];
              if (row) {
                position = Number(row.seq);
                const attachmentMap = await attachmentsForEntries(pool, [row.id]);
                const entry = entryProjection(
                  row,
                  channel.epoch,
                  config,
                  attachmentMap.get(row.id)
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
