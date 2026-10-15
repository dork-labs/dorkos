import type { Context, Hono } from 'hono';
import type { Pool } from 'pg';
import { CommunityWireEventSchema, type CommunityWireEvent } from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../../auth.js';
import type { CommunityConfig } from '../../config.js';
import { decodeCursor, encodeCursor } from '../../content/cursor.js';
import {
  assertPrincipalCurrent,
  communityHeld,
  requirePrincipal,
  type Principal,
} from '../../data.js';
import { ApiError, ServiceBusy } from '../../http.js';
import { LiveStreamLimit, type LiveHub, type LiveStream } from '../../live/hub.js';
import { ChannelFeeds, nextTick, type FeedItem } from '../../live/feed.js';
import {
  ENTRY_COLUMNS,
  entryProjection,
  originKeyForPrincipal,
  type EntryRow,
} from '../../content/entry-projection.js';
import { attachmentsForEntries } from './attachments.js';
import {
  entryFrame,
  readStreamEntries,
  streamEntryReader,
  type StreamEntry,
} from './event-feed.js';
import { communityGoneReason } from '../../tenant-context.js';
import { registerReadCursorRoutes } from './read-cursors.js';
import {
  CachedStreamAccess,
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
/** Entries one stream reads for itself at once, when it is behind what its feed keeps. */
const OWN_BATCH = 100;
/** How many fallback intervals a passing access check is trusted for; see its use. */
const TRUST_FACTOR = 1.25;
/** Entries one stream sends in one write. */
const SEND_BATCH = 50;
/** The channel feeds each hub's streams share; see `live/feed.ts`. */
const feedsByHub = new WeakMap<LiveHub, ChannelFeeds<StreamEntry>>();

/**
 * Register durable SSE replay, and (through `read-cursors.ts`) per-member read positions.
 *
 * Live streams wake on notices through `hub` rather than polling. Each new entry is read once
 * for every stream on its channel (`live/feed.ts`); each stream rechecks its own access once per
 * notice that may have changed it, and sends nothing until it has.
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
  registerReadCursorRoutes(app, { pool, auth, config });
  const fallbackMs = hub.options.fallbackMs;
  // One set of feeds per hub: an app that shares another's hub (as a test does) shares its feeds,
  // or the hub would hand each notice to only one of them.
  let feeds = feedsByHub.get(hub);
  if (!feeds) {
    feeds = new ChannelFeeds<StreamEntry>({
      read: streamEntryReader(
        pool,
        () => hooks?.afterEntryAttachmentLookup?.() ?? Promise.resolve()
      ),
      wake: (communityId, channelId) => hub.wakeChannel(communityId, channelId),
      hasStreams: (communityId, channelId) => hub.hasChannelStreams(communityId, channelId),
      fallbackMs,
      log: hub.options.log,
    });
    feedsByHub.set(hub, feeds);
    hub.useFanout(feeds);
  }
  const channelFeeds = feeds;
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
      await pool.query<EntryRow>(
        resume
          ? `SELECT ${ENTRY_COLUMNS}
             FROM entries e LEFT JOIN agents a ON a.id=e.author_agent_id WHERE e.channel_id=$1 AND e.seq>$2 AND e.seq<=$3 ORDER BY e.seq LIMIT 100`
          : `SELECT ${ENTRY_COLUMNS}
             FROM (SELECT * FROM entries WHERE channel_id=$1 AND seq<=$2 ORDER BY seq DESC LIMIT 100) e LEFT JOIN agents a ON a.id=e.author_agent_id ORDER BY e.seq`,
        resume ? [channel.id, position, capturedSeq] : [channel.id, position]
      )
    ).rows;
    if (snapshotRows.length) position = Number(snapshotRows.at(-1)!.seq);
    const snapshotAttachments = await attachmentsForEntries(
      pool,
      snapshotRows.map((row) => row.id)
    );
    await assertPrincipalCurrent(c, auth, pool, principal, 'read');
    if (openedSession) {
      const currentSession = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!currentSession || currentSession.session.id !== openedSession.session.id)
        throw new ApiError(401, 'UNAUTHENTICATED', 'This sign-in is no longer valid.');
    }
    const encoder = new TextEncoder();
    const reader = { epoch: channel.epoch, communityId: principal.community_id, principal };
    let closed = false;
    /**
     * Access ended while the reader was not taking events. The closed frame waits for its next
     * pull rather than being dropped: the reader learns why the stream ended.
     */
    let closeWhenRead: StreamCloseReason | null = null;
    let replayComplete = false;
    let lastHeartbeat = Date.now();
    /** Entries this stream read for itself, because it was behind what the feed keeps. */
    let own: FeedItem<StreamEntry>[] = [];
    /** The feed's version when `own` was read: a removal since means they may be stale. */
    let ownVersion = -1;
    let seeded = false;
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
    // A quiet stream rechecks its access after the fallback interval anyway, in case access ended
    // in a way no notice announces (a session simply expiring). Jitter spreads the rechecks of
    // streams that opened together. New entries a lost notice hid are found by the feed's own
    // fallback re-read, once per channel.
    const fallbackWait = () => Math.round(fallbackMs * (0.8 + Math.random() * 0.4));
    // Nothing is visible to the stream's credential any more: tell a takedown and a finished
    // deletion apart from every other way access ends. Both are read after the access query,
    // and each is written in the transaction that ends access, so it is already there.
    const closeReason = async (state: StreamAccess | null | undefined) =>
      streamCloseReason(
        state,
        channel.epoch,
        state ? null : await communityGoneReason(pool, principal.community_id)
      );
    // Trusted a little longer than the quiet-time watch below waits (at most 1.2 × the fallback),
    // so that watch, jittered per stream, refreshes it first. Trusted for exactly the fallback,
    // every stream that opened in the same moment rechecked in the same moment too: 5,000 at once
    // queued posts behind them for seconds.
    const access = new CachedStreamAccess(live, fallbackMs * TRUST_FACTOR, async () => {
      const state = await readStreamAccess(pool, principal, openedSession, channel.id);
      return { reason: await closeReason(state), expiresAt: state?.expires_at?.getTime() };
    });
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
              const reason = await access.check();
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
              const feed = channelFeeds.feed(principal.community_id, channel.id);
              if (!seeded) {
                seeded = true;
                feed.seed(capturedSeq);
              }
              let items: FeedItem<StreamEntry>[];
              let noticedThrough: number;
              if (own.length && ownVersion !== feed.version) own = [];
              if (own.length) {
                items = own.slice(0, SEND_BATCH);
                // Read without a notice: send only on access checked after the read.
                noticedThrough = -1;
              } else {
                const found = feed.after(position, SEND_BATCH);
                if (!found.covered) {
                  const version = feed.version;
                  const rows = await readStreamEntries(pool, channel.id, position, null, OWN_BATCH);
                  await hooks?.afterEntryAttachmentLookup?.();
                  if (closed) return;
                  const readAt = nextTick();
                  own = rows.map((value) => ({ seq: Number(value.row.seq), value, readAt }));
                  ownVersion = version;
                  // Caught up: the feed can carry this stream, and the next ones, from here.
                  if (rows.length < OWN_BATCH) feed.seed(own.at(-1)?.seq ?? position);
                  if (own.length) continue;
                }
                items = found.items;
                noticedThrough = found.noticedThrough;
              }
              if (!replayComplete) {
                // Replay ends at the watermark, with its own event, before any live entry.
                const replayed = items.filter((item) => item.seq <= capturedSeq);
                if (!replayed.length && items.length) {
                  replayComplete = true;
                  writeEvent(controller, {
                    type: 'replay_complete',
                    capturedSeq,
                    cursor: currentCursor(),
                  });
                  return;
                }
                items = replayed;
              }
              if (items.length) {
                // An entry a notice announced goes out on access no notice has questioned since
                // it was checked. One read without a notice needs a check made after that read.
                const after = Math.max(
                  0,
                  ...items.filter((item) => item.seq > noticedThrough).map((item) => item.readAt)
                );
                if (!access.allows(after)) {
                  const reason = await access.check(after);
                  if (closed) return;
                  if (reason) {
                    stop();
                    writeEvent(controller, { type: 'closed', reason, cursor: currentCursor() });
                    controller.close();
                    return;
                  }
                  // Look again: what the feed holds may have changed while the check ran.
                  continue;
                }
                const frames = items.map((item) => entryFrame(item.value, reader, config));
                controller.enqueue(frames.length === 1 ? frames[0] : joinFrames(frames));
                position = items.at(-1)!.seq;
                if (own.length) own = own.filter((item) => item.seq > position);
                if (replayComplete) {
                  const now = Date.now();
                  for (const item of items)
                    hub.observeLag((now - item.value.row.created_at.getTime()) / 1000);
                }
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

/** Several frames as one chunk: one write to the socket instead of one per entry. */
function joinFrames(frames: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const frame of frames) length += frame.length;
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const frame of frames) {
    joined.set(frame, offset);
    offset += frame.length;
  }
  return joined;
}
