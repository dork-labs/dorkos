import type { Context, Hono } from 'hono';
import type { Pool } from 'pg';
import {
  CommunityWireAttentionResponseSchema,
  CommunityWireEventSchema,
  CommunityWireReadCursorRequestSchema,
  CommunityWireReadCursorResponseSchema,
  type CommunityWireEvent,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../../auth.js';
import type { CommunityConfig } from '../../config.js';
import { decodeCursor, encodeCursor } from '../../content/cursor.js';
import {
  assertPrincipalCurrent,
  assertPrincipalCurrentInTransaction,
  communityHeld,
  lockChannel,
  requireJoined,
  requirePrincipal,
  transaction,
  type Principal,
} from '../../data.js';
import { ApiError, ServiceBusy, json, readJson } from '../../http.js';
import { LiveStreamLimit, type LiveHub, type LiveStream } from '../../live/hub.js';
import { entryProjection, originKeyForPrincipal } from './entries.js';
import { attachmentsForEntries } from './attachments.js';
import { communityGoneReason } from '../../tenant-context.js';
import {
  channelWire,
  liveChannel,
  readStreamAccess,
  streamCloseReason,
  type LiveChannel,
  type OpenedSession,
  type StreamAccess,
  type StreamCloseReason,
} from './event-stream-access.js';

/** A quiet stream sends a comment this often so proxies keep the connection open. */
const HEARTBEAT_MS = 15_000;
/** What a refused stream is told to wait, in seconds, before it opens again. */
const STREAM_RETRY_SECONDS = 15;

/**
 * Register durable SSE replay and monotonic per-member read positions.
 *
 * Live streams wake on notices through `hub` rather than polling: each reads the channel once
 * per notice that names it, and rechecks its access once per notice that may have changed it.
 */
export function registerEventRoutes(
  app: Hono,
  {
    pool,
    auth,
    config,
    hub,
    hooks,
  }: {
    pool: Pool;
    auth: CommunityAuth;
    config: CommunityConfig;
    hub: LiveHub;
    hooks?: {
      afterSnapshotWatermark?: () => Promise<void>;
      afterEntryAttachmentLookup?: () => Promise<void>;
    };
  }
) {
  const fallbackMs = hub.options.fallbackMs;
  app.get('/attention', async (c) => {
    const principal = await requirePrincipal(c, auth, pool, 'read');
    if (principal.kind !== 'human')
      throw new ApiError(403, 'FORBIDDEN', 'Agents do not have personal attention summaries.');
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
      throw new ApiError(401, 'UNAUTHENTICATED', 'This sign-in is no longer valid.');
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
    // Reads go on through a hold; live updates wait for its release. Refuse before any event.
    const community = await pool.query<{ lifecycle: string }>(
      'SELECT lifecycle FROM communities WHERE id=$1',
      [principal.community_id]
    );
    if (community.rows[0]?.lifecycle === 'held') throw communityHeld();
    const openedSession = principal.credentialHash
      ? null
      : await auth.api.getSession({ headers: c.req.raw.headers });
    if (!principal.credentialHash && !openedSession)
      throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const channel = await liveChannel(pool, c.req.param('id'), principal);
    // A caller already gone holds no place: nothing would ever release it.
    if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
    let live: LiveStream;
    try {
      live = await hub.open({
        communityId: principal.community_id,
        channelId: channel.id,
        memberId: principal.kind === 'agent' ? principal.ownerMemberId : principal.id,
        agentId: principal.kind === 'agent' ? principal.id : undefined,
        userId: openedSession?.user.id,
      });
    } catch (error) {
      if (error instanceof LiveStreamLimit)
        throw new ServiceBusy('Live updates are busy. Try again shortly.', STREAM_RETRY_SECONDS);
      throw error;
    }
    // Check access once as soon as the stream starts: a revocation that committed while this
    // request was being authorized sent its notice before the stream was in the hub.
    live.access.raise();
    try {
      return await openStream(c, principal, openedSession, channel, live);
    } catch (error) {
      live.release();
      throw error;
    }
  });

  async function openStream(
    c: Context,
    principal: Principal,
    openedSession: OpenedSession,
    channel: LiveChannel,
    live: LiveStream
  ): Promise<Response> {
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
        throw new ApiError(401, 'UNAUTHENTICATED', 'This sign-in is no longer valid.');
    }
    const encoder = new TextEncoder();
    let closed = false;
    /**
     * Access ended while the reader was not taking events. The closed frame waits for its next
     * pull rather than being dropped: the reader learns why the stream ended.
     */
    let closeWhenRead: StreamCloseReason | null = null;
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
      if (closed) return;
      closed = true;
      live.release();
      // Wake both loops so each sees `closed` and returns instead of waiting out its timer.
      live.entries.raise();
      live.access.raise();
    };
    // A quiet stream re-reads anyway after the fallback interval, in case a notice was lost or
    // access ended in a way no notice announces (a session simply expiring). Jitter spreads the
    // re-reads of streams that opened together.
    const fallbackWait = () => Math.round(fallbackMs * (0.8 + Math.random() * 0.4));
    // A quiet stream rechecks only when a notice says its access may have changed, or after the
    // fallback interval; every entry is still checked fresh before it is sent.
    const checkAccess = () => readStreamAccess(pool, principal, openedSession, channel.id);
    // Nothing is visible to the stream's credential any more: tell a takedown and a finished
    // deletion apart from every other way access ends. Both are read after the access query,
    // and each is written in the transaction that ends access, so it is already there.
    const closeReason = async (state: StreamAccess | null | undefined) =>
      streamCloseReason(
        state,
        channel.epoch,
        state ? null : await communityGoneReason(pool, principal.community_id)
      );
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
          // Watches access while the stream is quiet, whether or not the reader is pulling:
          // a notice from any revocation source, or the fallback interval, rechecks it once.
          void (async () => {
            while (!closed) {
              await live.access.wait(fallbackWait());
              if (closed) return;
              const reason = await closeReason(await checkAccess());
              if (closed || !reason) continue;
              if (controller.desiredSize !== null && controller.desiredSize > 0) {
                stop();
                writeEvent(controller, {
                  type: 'closed',
                  reason,
                  cursor: currentCursor(),
                });
                controller.close();
              } else {
                // The reader is behind: `pull` sends the closed frame once it reads again, and
                // sends nothing else first.
                closeWhenRead = reason;
                // Its access has ended, so it gives back its place now, not when the frame goes.
                live.release();
                live.entries.raise();
              }
              return;
            }
          })().catch(() => {
            if (!closed) {
              stop();
              controller.error(new Error('Community stream unavailable'));
            }
          });
          if (c.req.raw.signal.aborted) {
            // The caller left while the snapshot was read: no abort event is coming.
            stop();
            controller.close();
            return;
          }
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
              if (closeWhenRead) {
                const reason = closeWhenRead;
                stop();
                writeEvent(controller, { type: 'closed', reason, cursor: currentCursor() });
                controller.close();
                return;
              }
              if (!replayComplete && position >= capturedSeq) {
                replayComplete = true;
                writeEvent(controller, {
                  type: 'replay_complete',
                  capturedSeq,
                  cursor: currentCursor(),
                });
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
                // Fresh, never cached: a notice arrives a moment after its commit, and an entry
                // must not slip out in that moment after access ended.
                const afterEnrichment = await closeReason(await checkAccess());
                if (closed) return;
                if (afterEnrichment) {
                  stop();
                  writeEvent(controller, {
                    type: 'closed',
                    reason: afterEnrichment,
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
                if (replayComplete)
                  hub.observeLag((Date.now() - new Date(row.created_at).getTime()) / 1000);
                return;
              }
              const sinceHeartbeat = Date.now() - lastHeartbeat;
              if (sinceHeartbeat >= HEARTBEAT_MS) {
                controller.enqueue(encoder.encode(': keepalive\n\n'));
                lastHeartbeat = Date.now();
                return;
              }
              await live.entries.wait(Math.min(fallbackWait(), HEARTBEAT_MS - sinceHeartbeat));
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
    // Left during the last await: `start` saw it, but make sure the place is given back.
    if (c.req.raw.signal.aborted) stop();
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      },
    });
  }
}
